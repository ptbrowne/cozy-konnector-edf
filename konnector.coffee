xml2js = require 'xml2js'
request = require 'request'
async = require 'async'
moment = require 'moment'

updateOrCreate = require './lib/update_or_create'
# TODO localization = require '../lib/localization_manager'
konnectorLibs = require 'cozy-konnector-libs'
fetcher = konnectorLibs.fetcher
BaseKonnector = konnectorLibs.baseKonnector

saveDataAndFile = require './lib/save_data_and_file'
filterExisting = konnectorLibs.filterExisting
Bill = konnectorLibs.models.bill
Client = require './models/client'
Contract = require './models/contract'
PaymentTerms = require './models/payment_terms'
ConsumptionStatement = require './models/consumption_statement'
Home = require './models/home'

parser = new xml2js.Parser()
builder = new xml2js.Builder headless: true

logger = require('printit') {
    prefix: 'EDF'
    date: true
}

DOMAIN = 'https://ws-mobile-particuliers.edf.com'
# Requests

getEDFToken = (requiredFields, entries, data, callback) ->
    K.logger.info 'getEDFToken'
    path = "/ws/authentifierUnClientParticulier_rest_V3-0/invoke"
    body = {
        "tns:msgRequete": {
            "$": {
                "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
                "xmlns:tns": "http://www.edf.fr/commerce/passerelle/pas001/authentifierUnClientParticulier/service/v3",
                "xsi:schemaLocation": "http://www.edf.fr/commerce/passerelle/pas001/authentifierUnClientParticulier/service/v3 authentifierUnClientParticulier.xsd",
            },
            "tns:enteteEntree": [
              { "tns:idCanal": 5 }
            ],
            "tns:corpsEntree": [ {
                "tns:idAppelant": requiredFields.email,
                "tns:password": requiredFields.password
              }
            ]
        }
    }

    edfRequestPost path, body, (err, result) ->
        return callback err if err

        errorCode = getF(result['tns:msgReponse'], 'tns:enteteSortie', 'ent:codeRetour')
        if errorCode and errorCode isnt '0000'
            K.logger.error getF result, \
                'tns:enteteSortie', 'ent:libelleRetour '

        token = getF result['tns:msgReponse'], 'tns:corpsSortie', 'tns:jeton'

        if token?
            K.logger.info "EDF token fetched"
            data.edfToken = token
            callback()
        else
            K.logger.error "Can't fetch EDF token"
            callback 'token not found'

fetchListerContratClientParticulier = (reqFields, entries, data, callback) ->
    K.logger.info "fetch listerContratClientParticulier"

    path = '/ws/listerContratClientParticulier_rest_V3-0/invoke'
    body = {
        "tns:msgRequete": {
            "$": {
                "xmlns:tns": "http://www.edf.fr/commerce/passerelle/pas072/listerContratClientParticulier/service/v3",
                "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
                "xsi:schemaLocation": "http://www.edf.fr/commerce/passerelle/pas072/listerContratClientParticulier/service/v3 listerContratClientParticulier_rest_V3-0.xsd "
            },
            "tns:EnteteEntree": { 'tns:Jeton': data.edfToken },
            "tns:CorpsEntree": { "tns:SynchroniserSI": true }
        }
    }

    edfRequestPost path, body, (err, result) ->
        return callback err if err
        try
            errorCode = getF result['tns:msgReponse'], 'tns:EnteteSortie', 'tns:CodeErreur'
            if errorCode and errorCode isnt 'PSC0000'
                K.logger.error getF result['tns:mgsReponse'], \
                    'tns:EnteteSortie', 'tns:LibelleErreur'

                return callback 'request error'


            client =
                vendor: 'EDF'
                docTypeVersion: K.docTypeVersion

            resBody = getF result["tns:msgReponse"], \
                      "tns:CorpsSortie", 'tns:AccordCo'

            # numeroAcc and numeroBD are mandatory.
            client.numeroAcc = getF resBody, 'tns:Numero'

            bpObject = getF resBody, 'tns:BP'
            client.clientId = getF bpObject, 'tns:Numero'


            # Put address in cozy-contact like format, two lines :
            # First: Postbox, appartment and street adress on first
            # Second: Locality, region, postcode, country
            addressObject = getF resBody, 'tns:Adresse'
            if addressObject
                numRue = getF(addressObject, 'tns:NumRue') or ""
                nomRue = getF(addressObject, 'tns:NomRue') or ""
                codePostal = getF(addressObject, 'tns:CodePostal') or ""
                ville = getF(addressObject, 'tns:Ville') or ""

                client.address =
                    street: "#{numRue} #{nomRue}"
                    city: ville
                    postcode: codePostal
                    country: 'FRANCE'
                    formated: "#{numRue} #{nomRue}\n#{codePostal} #{ville}"

            # name in cozy-contact like format !
            identiteObj = getF bpObject, 'tns:Identite'
            civilite = getF(identiteObj, 'tns:Civilite') or ''
            nom = getF(identiteObj, 'tns:Nom') or ''
            prenom = getF(identiteObj, 'tns:Prenom') or ''
            client.name =
                prefix: civilite
                family: nom
                given: prenom
                formated: "#{prenom} #{nom}"


            coTitulaireElem = getF bpObject, 'tns:IdentitePart'
            if coTitulaireElem
                coHolder =
                    family: getF coTitulaireElem, 'tns:NomCoTitulaire'
                    given: getF coTitulaireElem, 'tns:PrenomCoTitulaire'

                coHolder.formated = "#{coHolder.given} #{coHolder.family}"
                client.coHolder = coHolder

            client.email = getF bpObject, 'tns:Coordonnees', 'tns:Email'
            client.cellPhone = getF bpObject, 'tns:Coordonnees'
                                        , 'tns:NumTelMobile'

            # Contracts
            contratElems = resBody['tns:Contrat']

            contracts = contratElems.map (contratElem) ->
                contract =
                    vendor: 'EDF'
                    clientId: client.clientId
                    docTypeVersion: K.docTypeVersion

                contract.number = getF contratElem, 'tns:Numero'
                contract.pdl = getF contratElem, 'tns:NumeroPDL'
                vieContratObj = getF contratElem, 'tns:VieDuContrat'
                contract.start = getF vieContratObj, 'tns:DateDebut'
                contract.status = getF vieContratObj, 'tns:Statut'

                contract.end = getF vieContratObj, 'tns:DateFin'
                contract.terminationGrounds = getF vieContratObj
                , 'tns:MotifResiliation'

                offreSouscriteObj = getF contratElem, 'tns:OffreSouscrite'

                contract.energie = translate
                    ELECTRICITE: 'Électricité'
                    GAZ: 'Gaz'
                , getF(offreSouscriteObj, 'tns:Energie')

                contract.name = translate
                    GN_2: 'Offre Gaz naturel'
                    MCGN_2: 'Mon Contrat gaz naturel'
                    MCGN_PRIX_FIXE_1: 'Mon Contrat Gaz Naturel a prix fixe'
                    ELECTRICITE_PRO: 'Electricite Pro'
                    ELEC_DEREGULE: 'Mon Contrat Electricite'
                    ELEC_PRO_PX_FIXE_1: 'Electricite Pro a Prix Fixe'
                    ESSENTIEL_PRO: 'Essentiel Pro'
                    OFFRE_HC_SOUPLES: 'Heures Creuses Souples'
                    PRESENCE_PRO: 'Presence Pro'
                    SOUPLESSE_PRO: 'Souplesse Pro'
                    TARIF_BLEU: 'Tarif Bleu'
                    TARIF_BLEU_PART: 'Tarif Bleu'
                    ESSENTIEL_GAZ: 'Essentiel Gaz'
                    GAZ: 'Mon Contrat Gaz Naturel'
                    GAZ_2: 'Mon Contrat Gaz Naturel'
                    GAZ_NAT_PX_FIXE_1: 'Gaz Naturel a Prix Fixe'
                    PRESENCE_GAZ: 'Presence Gaz'
                    SOUPLESSE_GAZ: 'Souplesse Gaz'
                    TARIF_BLEU_GAZ: 'Gaz Naturel'
                    TARIF_EJP_PART: 'EJP'
                    OFFRE_TPN: 'TPN'
                , getF(offreSouscriteObj, 'tns:NomOffre')

                contract.troubleshootingPhone = getF offreSouscriteObj
                , 'tns:NumeroDepannageContrat'

                switch contract.energie
                    when 'Électricité'
                        contract.power = translate
                            PUI00: '0 kVA'
                            PUI03: '3 kVA'
                            PUI06: '6 kVA'
                            PUI09: '9 kVA'
                            PUI12: '12 kVA'
                            PUI15: '15 kVA'
                            PUI18: '18 kVA'
                            PUI24: '24 kVA'
                            PUI30: '30 kVA'
                            PUI36: '36 kVA'
                        , getF(offreSouscriteObj, 'tns:Puissance')
                        contract.contractSubcategory1 = getF offreSouscriteObj
                        , 'tns:StructureTarifaire'

                    when 'Gaz'
                        contract.contractSubcategory2 = getF offreSouscriteObj
                                                    , 'tns:OptionPrix'

                cadranElem = getF contratElem, 'tns:ListeCadran'
                if cadranElem
                    counter = {}
                    counter.comptage = getF cadranElem, 'tns:Type'
                    counter.nombreRoues = getF cadranElem, 'tns:NombreRoues'
                    counter.dernierIndex = getF cadranElem, 'tns:DernierIndex'

                    counter.type = getF contratElem, 'tns:DonneesTechniques'
                                            , 'tns:TypeCompteur'

                    contract.counter = counter

                    contract.annualConsumption = getF cadranElem
                    , 'tns:ConsommationAnnuelle'

                contract.peakHours = getF contratElem
                , 'tns:DonneesTechniques', 'tns:HorrairesHC'

                releveElem = getF contratElem, 'tns:Releve'

                if releveElem
                    statement = {}
                    statement.prochaineReleve = getF releveElem
                    , 'tns:ProchaineDateReleveReelle'
                    statement.saisieReleveConfiance = getF releveElem
                        , 'tns:SaisieRC'
                    statement.dateFermetureReleveConfiance = getF releveElem
                    , 'tns:DateFermetureRC'
                    statement.prochaineDateOuvertureReleveConfiance = getF(
                        releveElem, 'tns:ProchaineDateOuvertureRC')
                    statement.prochaineDateFermetureReleveConfiance = getF(
                        releveElem, 'tns:ProchaineDateFermetureRC')
                    statement.prochaineDateFermetureReelle = getF releveElem
                    , 'tns:ProchaineDateFermetureReelle'
                    statement.saisieSuiviConso = getF releveElem, 'tns:SaisieSC'
                    statement.prochaineDateOuvertureSaisieConso = getF(
                        releveElem, 'tns:ProchaineDateOuvertureSC')

                    contract.statement = statement

                contract.services = []
                if contratElem['tns:ServicesSouscrits']
                    services = contratElem['tns:ServicesSouscrits']
                    .map (serviceElem) ->
                        service =
                            nom: getF serviceElem, 'tns:NomService'
                            activ: getF serviceElem, 'tns:Etat'
                        return service
                    contract.services = contract.services.concat services

                if resBody['tns:ServicesSouscrits']

                    services = resBody['tns:ServicesSouscrits']
                    .map (serviceElem) ->
                        service =
                            nom: getF serviceElem, 'tns:nomService'
                            # TODO : to UTC
                            start: getF serviceElem, 'tns:dateSouscription'
                            activ: getF serviceElem, 'tns:statut'
                        return service

                    contract.services = contract.services.concat services

                return contract

            K.logger.info "Fetched listerContratClientParticulier"
            entries.clients.push client
            entries.contracts = contracts

            callback()

        catch e
            K.logger.error "While fetching listerContratClientParticulier", e
            return callback e


fetchVisualiserPartenaire = (requiredFields, entries, data, callback) ->
    K.logger.info "fetchVisualiserPartenaire"

    path = '/ws/visualiserPartenaire_rest_V2-0/invoke'
    body =
        'msgRequete':
            '$':
                'xsi:schemaLocation': "http://www.edf.fr/commerce/passerelle/" +
                "css/visualiserPartenaire/service/v2 C:\\HMN\\EDFMoiV2\\WSDL" +
                "\\passerelle\\passerelle\\css\\visualiserPartenaire\\service" +
                "\\v2\\visualiserPartenaire.xsd"
                'xmlns': "http://www.edf.fr/commerce/passerelle/css/" +
                "visualiserPartenaire/service/v2"
                'xmlns:ent': "http://www.edf.fr/commerce/passerelle/commun/" +
                "v2/entete"
                'xmlns:xsi': "http://www.w3.org/2001/XMLSchema-instance"

            'enteteEntree':
                'ent:jeton': data.edfToken

            'corpsEntree':
                'numeroBp': entries.clients[0].clientId

    edfRequestPost path, body, (err, result) ->
        return callback err if err
        try
            errorCode = getF result, 'ns:enteteSortie', 'ent:codeRetour'
            if errorCode and errorCode isnt '0'
                K.logger.error getF result, \
                    'tns:enteteSortie', 'tns:libelleRetour'

                return callback() # Continue on error.


            partnerElem = getF result["ns:msgReponse"], \
                        "ns:corpsSortie", "ns:partenaire"
            client = {}
            coordonneesElem = getF partnerElem, 'ns:coordonnees'
            client.cellPhone = getF coordonneesElem, 'ns:NumTelMobile'
            client.homePhone = getF coordonneesElem, 'ns:NumTelFixe'
            client.email = getF coordonneesElem, 'ns:Email'
            client.loginEmail = getF coordonneesElem, 'ns:EmailAEL'

            contactElem = getF partnerElem, 'ns:centreContact'
            contact = {}
            contact.title = getF contactElem, 'ns:gsr'
            contact.phone = getF contactElem, 'ns:telephone'

            addressElem = getF contactElem, 'ns:adresse'
            if addressElem
                address = {}
                address.street = getF addressElem, 'ns:nomRue'
                address.postcode = getF addressElem, 'ns:codePostal'
                address.city = getF addressElem, 'ns:ville'
                address.formated = "#{address.street}" +
                    "\n#{address.postcode} #{address.city}"
                contact.address = address

            client.commercialContact = contact

            entries.clients[0] = _extend entries.clients[0], client

            K.logger.info "Fetched visualiserPartenaire."
            callback()

        catch e
            K.logger.error "While fetching visualiserPartenaire."
            K.logger.error e
            return callback e


fetchVisualiserAccordCommercial = (requiredFields, entries, data, callback) ->
    K.logger.info "fetchVisualiserAccordCommercial"

    path = '/ws/visualiserAccordCommercial_rest_sso_V3-0/invoke'
    body = {
      "visualiserAccordCommercialRequest": {
        "$": {
          "xmlns": "http://www.edf.fr/psc/0122/v3/visualiserAccordCommercial",
          "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
          "xsi:schemaLocation": "http://www.edf.fr/psc/0122/v3/visualiserAccordCommercial visualiserAccordCommercial.xsd"
        },
        "jeton": data.edfToken,
        "numeroBp": entries.clients[0].clientId,
        "numeroAcc": entries.clients[0].numeroAcc,
        "applicationAppelante": "EDFETMOI"
      }
    }

    edfRequestPost path, body, (err, result) ->
        return callback err if err
        try
            errorCode = getF result['tns:visualiserAccordCommercialResponse'], "tns:responseWebService", "tns:CodeEtatService"
            if errorCode and errorCode isnt 'PSC0000'
                K.logger.error getF result['tns:visualiserAccordCommercialResponse'], "tns:responseWebService", "tns:LibelleEtatService"

                return callback() # Continue on error.


            acoElem = getF result['tns:visualiserAccordCommercialResponse'], "tns:responseWebService", "tns:listeAccordsCommerciaux", "tns:item"

            paymentTerms =
                vendor: 'EDF'
                clientId: entries.clients[0].clientId
                docTypeVersion: K.docTypeVersion

            bankDetails =
                iban: getF(acoElem, 'tns:banque', 'tns:iban')
                holder: getF(acoElem, 'tns:compte', 'tns:titulaire')
                bank: getF(acoElem, "tns:banque", "tns:nom")

            bankAddress =
                street: getF(acoElem, 'tns:banque', 'tns:numNomRue')
                city: getF(acoElem, 'tns:banque', 'tns:codePostalVille')
                # postcode ?
                country: getF(acoElem, 'tns:banque', 'tns:pays')

            bankAddress.formated = "#{bankAddress.street}" +
                "\n#{bankAddress.city} #{bankAddress.country}"

            bankDetails.bankAddress = bankAddress
            paymentTerms.encryptedBankDetails = JSON.stringify bankDetails

            paymentTerms.balance = getF acoElem, 'tns:detail', 'tns:solde'
            paymentTerms.paymentMeans = getF acoElem, 'tns:detail'
            , 'tns:modeEncaissement'
            paymentTerms.modifBankDetailsAllowed = getF acoElem, 'tns:detail'
            , 'tns:modifIBANAutorisee'
            #accountNumber: getF acoElem, 'ns:detail', 'ns:numeroEtendu'
            paymentTerms.dernierReglement =
                    date: getF acoElem, 'tns:dernierReglement', 'tns:date'
                    amount: getF acoElem, 'tns:dernierReglement', 'tns:montant'
                    type: getF acoElem, 'tns:dernierReglement', 'tns:type'
            paymentTerms.billFrequency = getF acoElem, 'tns:facturation', \
                                    'tns:periodicite'
            paymentTerms.nextBillDate = getF acoElem

            paymentTerms.idPayer = getF acoElem, 'tns:numeroPayeur'
            paymentTerms.payerDivergent = getF acoElem, 'tns:payeurDivergent'
            # paymentTerms.mensuSansSurprise = getF acoElem, 'tns:mensuSansSurprise'

            servicesElem = getF(acoElem, 'tns:services')['tns:item']
            services = servicesElem.map (serviceElem) ->
                service = {}
                service.name = getF serviceElem, 'tns:nomService'
                service.status = getF serviceElem, 'tns:etat'
                service.valueSubscribed = getF serviceElem, 'tns:valeurSouscrite'
                service.valuesAvailable = serviceElem['tns:valeursPossibles']

                return service


            entries.paymenttermss.push paymentTerms
            entries.contracts.forEach (contract) ->
                contract.services = contract.services.concat services

            K.logger.info "Fetched visualiserAccordCommercial."
            callback()

        catch e
            K.logger.error "While fetching visualiserAccordCommercial."
            K.logger.error e
            callback e


fetchVisualiserCalendrierPaiement = (requiredFields, entries, data, callback) ->
    K.logger.info "fetchVisualiserCalendrierPaiement"
    path = '/ws/visualiserCalendrierPaiement_rest_V2-0/invoke'
    body =
        'message:msgRequete':
            '$':
                'xsi:schemaLocation': "http://www.edf.fr/commerce/passerelle/" +
                "css/visualiserCalendrierPaiement/service/v2 C:\\HMN\\" +
                "EDFMoiV2\\WSDL\\passerelle\\passerelle\\css\\" +
                "visualiserCalendrierPaiement\\service\\v2\\" +
                "visualiserCalendrierPaiement.xsd"
                'xmlns:message': "http://www.edf.fr/commerce/passerelle/css/" +
                "visualiserCalendrierPaiement/service/v2"
                'xmlns:ent': "http://www.edf.fr/commerce/passerelle/commun/" +
                "v2/entete"
                'xmlns:xsi': "http://www.w3.org/2001/XMLSchema-instance"

            'message:enteteEntree':
                'ent:jeton': data.edfToken

            'message:corpsEntree':
                'message:numeroBp': entries.clients[0].clientId
                'message:numeroAcc': entries.clients[0].numeroAcc

    edfRequestPost path, body, (err, result) ->
        return callback err if err
        try
            # Does API send an error ?
            errorCode = getF result, 'ns:msgReponse', 'ns:enteteSortie', \
                 'ent:codeRetour'
            if errorCode and errorCode isnt '0'
                K.logger.error getF result, 'ns:msgReponse', \
                    'ns:enteteSortie' , 'ent:libelleRetour'
                return callback() # Continue, whitout error.

            listeEcheances = getF result["ns:msgReponse"], "ns:corpsSortie"
            , "ns:calendrierDePaiement"

            if not (listeEcheances and
            listeEcheances['ns:listeEcheances'] and
            listeEcheances['ns:listeEcheances'].length > 0)
                K.logger.warn 'No payment schedules'
                return callback() # Continue whithout errors.

            listeEcheances = listeEcheances["ns:listeEcheances"]

            # TODO : if no gaz and elec !?
            paymentSchedules = listeEcheances.map (echeance) ->
                amountGaz = parseFloat getF echeance, "ns:montantGaz"
                amountElec = parseFloat getF echeance, "ns:montantElec"

                if isNaN amountGaz then amountGaz = 0
                if isNaN amountElec then amountElec = 0

                doc =
                    number: parseInt getF echeance, "ns:numeroEcheance"
                    receiptDate: getF echeance, "ns:dateEncaissement"
                    scheduleDate: getF echeance, "ns:DateEcheance"
                    paid: getF(echeance, "ns:paiement") is 'EFFECTUE'
                    amount: amountGaz + amountElec
                    amountGas: amountGaz
                    amountElectricity: amountElec
                return doc

            unless entries.paymenttermss[0]
                entries.paymenttermss[0] =
                    vendor: 'EDF'
                    clientId: entries.clients[0].clientId
                    docTypeVersion: K.docTypeVersion

            entries.paymenttermss[0].paymentSchedules = paymentSchedules
            K.logger.info "Fetched #{paymentSchedules.length} " +
            "from fetchVisualiserCalendrierPaiement"
            callback()

        catch e
            K.logger.error "While fetchVisualiserCalendrierPaiement"
            K.logger.error e
            callback e


fetchVisualiserFacture = (reqFields, entries, data, callback) ->
    K.logger.info "fetchVisualiserFacture"
    path = '/ws/visualiserFacture_rest_V3-0/invoke'
    body = {
      "tns:msgRequete": {
        "$": {
            "xmlns:tns": "http://www.edf.fr/commerce/passerelle/pas023/visualiserFacture/service/v2",
        },
        "visualiserFactureRequest": {
          "numeroBp": entries.clients[0].clientId,
          "jeton": data.edfToken,
          "numeroAcc": entries.clients[0].numeroAcc,
          "dateRecherche": "1900-01-01"
        }
      }
    }

    edfRequestPost path, body, (err, result) ->
        return callback err if err

        bills = []
        try
            errorCode = getF result["tns:msgReponse"], "visualiserFactureResponse", "responseWebService", "codeErreur"
            if errorCode and errorCode isnt '0'
                K.logger.error getF result["tns:msgReponse"], "visualiserFactureResponse", "responseWebService", "libelleErreur"
                return callback() # Continue, whitout error.

            documents = getF(result["tns:msgReponse"], "visualiserFactureResponse", "responseWebService", "listeFactures")["item"]

            bills = documents.map (elem) ->
                details = getF elem, "resume"
                bill =
                    vendor: 'EDF'
                    clientId: entries.clients[0].clientId
                    title: getF(details, "type")
                    number: getF elem, "numeroFacture"
                    date: moment getF(details, "dateEmission"), 'YYYY-MM-DD'
                    paymentDueDate: getF(details, "dateEcheance")
                    scheduledPaymentDate: getF(details, "datePrelevement")
                    totalPaymentDue: getF(details, "montantFactureFraiche")
                    value: getF(details, "montantReclame")
                    balanceBeforeInvoice: getF(details, "soldeAvantFacture")

                    # TODO: hack to force download, bad because duplicate URL !
                    pdfurl: DOMAIN + '/ws/recupererDocumentContractuelGet_rest_V1-0/invoke'
                    docTypeVersion: K.docTypeVersion

                return bill

            entries.fetched = bills
            K.logger.info "Fetched #{bills.length} bills"
            callback()
        catch e
            K.logger.error "While fetchVisualiserFacture"
            K.logger.error e
            callback e


fetchVisualiserHistoConso = (requiredFields, entries, data, callback) ->
    K.logger.info "fetchVisualiserHistoConso"
    async.mapSeries entries.contracts, (contract, cb) ->
        path = '/ws/visualiserHistoConso_rest_V3-0/invoke'
        body =
            'message:msgRequete':
                '$':
                    'xsi:schemaLocation': "http://www.edf.fr/commerce/" +
                    "passerelle/css/visualiserHistoConso/service/v2 C:\\HMN" +
                    "\\EDFMoiV2\\WSDL\\passerelle\\passerelle\\css" +
                    "\\visualiserHistoConso\\service\\v2\\" +
                    "visualiserHistoConso.xsd"
                    'xmlns:message': "http://www.edf.fr/commerce/passerelle/" +
                    "css/visualiserHistoConso/service/v2"
                    'xmlns:ent': "http://www.edf.fr/commerce/passerelle/" +
                    "commun/v2/entete"
                    'xmlns:xsi': "http://www.w3.org/2001/XMLSchema-instance"

                'message:enteteEntree':
                    'ent:jeton': data.edfToken

                'message:corpsEntree':
                    'message:numeroBp': entries.clients[0].clientId
                    'message:numeroContrat': contract.number

        edfRequestPost path, body, (err, result) ->
            return callback err if err
            try

                errorCode = getF result, 'ns:enteteSortie', 'ent:codeRetour'
                if errorCode and errorCode isnt '0'
                    K.logger.error getF result, \
                        'tns:enteteSortie', 'tns:libelleRetour'
                    # Continue on error.
                    return callback()


                unless "ns:corpsSortie" of result["ns:msgReponse"]
                    K.logger.info "No histoConsos to fetch"
                    return callback null, []

                consoElems = result["ns:msgReponse"]["ns:corpsSortie"][0]\
                    ["ns:listeHistoDeConso"]

                res = consoElems.map (consoElem) ->
                    doc =
                        contractNumber: contract.number
                        billNumber: getF consoElem, 'ns:numeroFacture'
                        start: getF consoElem, 'ns:dateDebut'
                        end: getF consoElem, 'ns:dateFin'
                        value: getF consoElem, 'ns:listeConsommation'
                        , 'ns:valeur'
                        # unit: getF conso, 'ns:listeConsommation', 'ns:cadran'
                        statementType: getF consoElem, 'ns:typeReleve'
                        statementCategory: getF consoElem, 'ns:categorieReleve'
                        statementReason: getF consoElem, 'ns:motifReleve'
                        docTypeVersion: K.docTypeVersion

                    return doc

                cb null, res
            catch e
                K.logger.error "While fetching visualiserHistoConso."
                K.logger.error e
                cb e

    , (err, results) ->
        return callback err if err

        entries.consumptionstatements = results.reduce (agg, result) ->
            return agg.concat result
        , []

        K.logger.info "Fetched #{entries.consumptionstatements.length}"+
            " consumptionStatements"
        callback()


saveBills = (requiredFields, entries, data, callback) ->

    options = {}
    options.vendor = 'edf'

    options.requestoptions = (bill) ->
        path = '/ws/recupererDocumentContractuelGet_rest_V1-0/invoke'
        body = {
          "dico:getRequest": {
            "$": {
              "xmlns:dico": "http://www.edf.fr/psc/pscma100/recupererDocumentContractuel/service/v1",
              "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
              "xsi:schemaLocation": "http://www.edf.fr/psc/pscma100/recupererDocumentContractuel/service/v1 recupererDocumentContractuel.xsd"
            },
            "getRequest": {
              "options": [
                { "cle": "id", "valeur": "pscedfmoi" },
                { "cle": 2, "valeur": entries.clients[0].clientId },
                { "cle": 4, "valeur": bill.number },
                { "cle": 6, "valeur": "Facture" }
              ]
            },
            "numeroBp": entries.clients[0].clientId,
            "jeton": data.edfToken
          }
        }

        return _edfRequestOptions path, body

    options.parseoptions = (data) ->
        return new Promise (resolve, reject) ->
            parser.parseString data, (err, result) ->
                return reject 'request error' if err

                base64PDF = getF result['rdc:getResponse'], 'getResponse', \
                            'docubase', 'documentPDF', 'pdf'
                resolve { data: base64PDF, contentType: "application/pdf" }

    saveDataAndFile(logger, Bill, options, ['EDF'])(requiredFields, entries, data, callback)

##
# Edelia
##

fetchEdeliaToken = (requiredFields, entries, data, callback) ->
    K.logger.info "fetchEdeliaToken"
    request.post 'https://api.edelia.fr/authorization-server/oauth/token',
        form:
            client_id:
                'sha1pae0Pahngee6uwiphooDie7thaiquahf2xohd6IeFeiphi9ziu0uw3am'
            grant_type: 'edf_sso'
            jeton_sso: data.edfToken
            bp: entries.clients[0].clientId
            pdl: data.contract.pdl
        json: true
    , (err, response, result) ->
        if err
            K.logger.error 'While fetching edelia token.'
            K.logger.error err
            return callback err

        K.logger.info 'Fetched edelia token'
        data.edeliaToken = result.access_token
        callback()


fetchEdeliaProfile = (requiredFields, entries, data, callback) ->
    K.logger.info "fetchEdeliaProfile"
    getEdelia data.edeliaToken, '/sites/-/profiles/simple?ts=' +
    new Date().toISOString(), (err, response, obj) ->
        error = null
        try
            err = 'no import performed' if not err and not obj

            if err
                K.logger.error 'While fetchEdeliaProfile'
                K.logger.error err
                throw err

            if obj.errorCode and obj.errorCode is "403"
                data.noEdelia = true
                K.logger.warn "No edelia: #{obj.errorDescription}"
                throw new Error('no edelia')

            doc =
                pdl: data.pdl
                beginTs: obj.beginTs
                isProfileValidated: obj.isProfileValidated
                housingType: obj.housingType
                residenceType: obj.residenceType
                occupationType: obj.occupationType
                constructionDate: obj.constructionDate
                isBBC: obj.isBBC
                surface: obj.surfaceInSqMeter
                occupantsCount: obj.noOfOccupants
                principalHeatingSystemType: obj.principalHeatingSystemType
                sanitoryHotWaterType: obj.sanitoryHotWaterType
                docTypeVersion: K.docTypeVersion

            entries.homes.push doc
            K.logger.info 'Fetched fetchEdeliaProfile'

        catch e
            error = e
        finally
            callback error


##
# Edelia electricite
##

fetchEdeliaMonthlyElecConsumptions = (
requiredFields, entries, data, callback) ->
    return callback() if data.noEdelia

    K.logger.info "fetchEdeliaMonthlyElecConsumptions"
    getEdelia data.edeliaToken, "/sites/-/monthly-elec-consumptions?" +
    "begin-month=2012-01&" +
    "end-month=#{moment().add(1, 'month').format('YYYY-MM')}&ended=false"
    , (err, response, obj) ->

        error = null
        try
            if response.statusCode is 404 or response.statusCode is 500
                K.logger.warn 'No EdeliaMonthlyElecConsumptions'
                data.noElec = true
                throw null

            if err
                K.logger.error 'Wihle fetchEdeliaMonthlyElecConsumptions'
                K.logger.error err
                throw err

            statements = []

            data.consumptionStatementByMonth = {}

            statements = statements.concat obj.monthlyElecEnergies.map (mee) ->
                doc =
                    docTypeVersion: K.docTypeVersion
                    contractNumber: data.contract.number
                    start: mee.beginDay
                    end: mee.endDay
                    value: mee.consumption.energy
                    statementType: 'estime'
                    statementCategory: 'edelia'
                    statementReason: 'EdeliaMonthlyElecConsumption'
                    period: mee.month
                    cost: mee.totalCost
                    costsByCategory: mee.consumption.costsByTariffHeading
                    valuesByCategory: mee.consumption.energiesByTariffHeading

                doc.costsByCategory.standing = mee.standingCharge
                data.consumptionStatementByMonth[mee.month] = doc

                return doc

            # Convenient structure to enhance data later.
            data.consumptionStatementByYear = {}

            statements = statements.concat obj.yearlyElecEnergies.map (yee) ->
                doc =
                    docTypeVersion: K.docTypeVersion
                    contractNumber: data.contract.number
                    start: yee.beginDay
                    end: yee.endDay
                    value: yee.consumption.energy
                    statementType: 'estime'
                    statementCategory: 'edelia'
                    statementReason: 'EdeliaYearlyElecConsumption'
                    period: yee.year
                    cost: yee.totalCost
                    costsByCategory: yee.consumption.costsByTariffHeading
                    valuesByCategory: yee.consumption.energiesByTariffHeading

                doc.costsByCategory.standing = yee.standingCharge

                # Add to a convenient structure to enhance them with comparisons
                data.consumptionStatementByYear[yee.year] = doc
                return doc

            if statements.length isnt 0
                entries.consumptionstatements = entries
                    .consumptionstatements.concat statements

            K.logger.info 'Fetched fetchEdeliaMonthlyElecConsumptions'

        catch e
            error = e
        finally
            callback error


fetchEdeliaSimilarHomeYearlyElecComparisions = (
requiredFields, entries, data, callback) ->
    return callback() if data.noEdelia or data.noElec

    K.logger.info "fetchEdeliaSimilarHomeYearlyElecComparisions"
    getEdelia data.edeliaToken
    , "/sites/-/similar-home-yearly-elec-comparisons?begin-year=2012"
    , (err, response, objs) ->
        error = null
        try
            if response.statusCode is 404 or response.statusCode is 500
                K.logger.warn 'No EdeliaSimilarHomeYearlyElecComparisions'
                data.noElec = true
                throw null
            if err
                K.logger.error(
                    'While fetchEdeliaSimilarHomeYearlyElecComparisions')
                K.logger.error err
                throw err

            objs.forEach (obj) ->
                statement = data.consumptionStatementByYear[obj.year]
                unless statement
                    K.logger.warn "No yearly statement for #{obj.date.year}"
                    return
                statement.similarHomes =
                    site: obj.energies.site
                    average: obj.energies.similarHomes.SH_AVERAGE_CONSUMING
                    least: obj.energies.similarHomes.SH_LEAST_CONSUMING

            K.logger.info 'Fetched fetchEdeliaSimilarHomeYearlyElecComparisions'
        catch e
            error = e

        delete data.consumptionStatementByYear
        callback error

fetchEdeliaElecIndexes = (requiredFields, entries, data, callback) ->
    return callback() if data.noEdelia or data.noElec
    K.logger.info "fetchEdeliaElecIndexes"
    getEdelia data.edeliaToken
    , "/sites/-/elec-indexes?begin-date=2012-01-01&" +
    "end-date=#{moment().format('YYYY-MM-DD')}&types="
    , (err, response, objs) ->

        error = null
        try
            if response.statusCode is 404
                K.logger.warn 'No EdeliaElecIndexes'
                throw null

            if err
                K.logger.error 'Wihle fetchEdeliaElecIndexes'
                K.logger.error err
                throw err

            objs.forEach (obj) ->
                statement = data
                    .consumptionStatementByMonth[obj.date.slice(0, 7)]
                unless statement
                    K.logger.warn "No monthly statement for\
                     #{obj.date.slice(0, 7)}"
                    return

                statement.statements = statement.statements || []
                statement.statements.push obj

            K.logger.info 'Fetched fetchEdeliaElecIndexes'
        catch e
            error = e

        delete data.consumptionStatementByMonth
        callback error

##
# Edelia Gas
##

fetchEdeliaMonthlyGasConsumptions = (requiredFields, entries, data, callback) ->
    return callback() if data.noEdelia
    K.logger.info "fetchEdeliaMonthlyGasConsumptions"
    getEdelia data.edeliaToken
    , "/sites/-/monthly-gas-consumptions?begin-month=2012-01&" +
    "end-month=#{moment().add(1, 'month').format('YYYY-MM')}&ended=false"
    , (err, response, obj) ->

        error = null
        try
            if response.statusCode is 404
                K.logger.warn 'No EdeliaMonthlyGasConsumptions'
                data.noGas = true
                throw null

            if err
                K.logger.error 'Wihle fetchEdeliaMonthlyGasConsumptions'
                K.logger.error err
                throw err

            statements = []

            data.consumptionStatementByMonth = {}

            statements = obj.monthlyGasEnergies?.map (mee) ->
                doc =
                    docTypeVersion: K.docTypeVersion
                    contractNumber: data.contract.number
                    start: mee.beginDay
                    end: mee.endDay
                    value: mee.consumption.energy
                    statementType: 'estime'
                    statementCategory: 'edelia'
                    statementReason: 'EdeliaMonthlyGasConsumption'
                    period: mee.month
                    cost: mee.totalCost
                    costsByCategory:
                        consumption: mee.consumption.cost
                        standing: mee.standingCharge

                data.consumptionStatementByMonth[mee.month] = mee
                return doc

            # Convenient structure to enhance data later.
            data.consumptionStatementByYear = {}

            statements = statements.concat obj.yearlyGasEnergies.map (yee) ->
                doc =
                    docTypeVersion: K.docTypeVersion
                    contractNumber: data.contract.number
                    start: yee.beginDay
                    end: yee.endDay
                    value: yee.consumption.energy
                    statementType: 'estime'
                    statementCategory: 'edelia'
                    statementReason: 'EdeliaYearlyGasConsumption'
                    period: yee.year
                    cost: yee.totalCost
                    costsByCategory:
                        consumption: yee.consumption.cost
                        standing: yee.standingCharge

                # Add to a convenient structure to enhance them with comparisons
                data.consumptionStatementByYear[yee.year] = doc
                return doc

            if (statements.length isnt 0)
                entries.consumptionstatements = entries
                .consumptionstatements.concat statements

            K.logger.info 'Fetched fetchEdeliaMonthlyGasConsumptions'

        catch e
            error = e

        callback error


fetchEdeliaSimilarHomeYearlyGasComparisions = (
requiredFields, entries, data, callback) ->
    return callback() if data.noEdelia or data.noGas

    K.logger.info "fetchEdeliaSimilarHomeYearlyGasComparisions"
    getEdelia data.edeliaToken
    , "/sites/-/similar-home-yearly-gas-comparisons?begin-year=2012"
    , (err, response, objs) ->

        error = null
        try
            if response.statusCode is 404 or response.statusCode is 500
                K.logger.warn 'No EdeliaSimilarHomeYearlyGasComparisions'
                throw null

            if err
                K.logger.error(
                    'While fetchEdeliaSimilarHomeYearlyGasComparisions')
                K.logger.error err
                throw err

            objs.forEach (obj) ->
                statement = data.consumptionStatementByYear[obj.year]
                unless statement
                    K.logger.warn "No yearly statement for #{obj.date.year}"
                    return

                statement.similarHomes =
                    site: obj.energies.site
                    average: obj.energies.similarHomes.SH_AVERAGE_CONSUMING
                    least: obj.energies.similarHomes.SH_LEAST_CONSUMING

            K.logger.info 'Fetched fetchEdeliaSimilarHomeYearlyGasComparisions'
        catch e
            error = e

        callback error


fetchEdeliaGasIndexes = (requiredFields, entries, data, callback) ->
    return callback() if data.noEdelia or data.noGas

    K.logger.info "fetchEdeliaGasIndexes"
    getEdelia data.edeliaToken
    , "/sites/-/gas-indexes?begin-date=2012-01-01&" +
    "end-date=#{moment().format('YYYY-MM-DD')}&types="
    , (err, response, objs) ->

        error = null
        try
            if response.statusCode is 404
                K.logger.warn 'No EdeliaGasIndexes'
                throw null

            if err
                K.logger.error 'Wihle fetchEdeliaGasIndexes'
                K.logger.error err
                throw err

            objs.forEach (obj) ->
                statement = data
                    .consumptionStatementByMonth[obj.date.slice(0, 7)]
                unless statement
                    K.logger.warn "No monthly statement for\
                     #{obj.date.slice(0, 7)}"
                    return
                statement.statements = statement.statements || []
                statement.statements.push obj

            K.logger.info 'Fetched fetchEdeliaGasIndexes'
        catch e
            error = e

        callback error


prepareEntries = (requiredFields, entries, data, next) ->
    entries.homes = []
    entries.consumptionstatements = []
    entries.contracts = []
    entries.fetched = []
    entries.clients = []
    entries.paymenttermss = []
    next()

buildNotifContent = (requiredFields, entries, data, next) ->
    # data.updated: we don't speak about update, beacause we don't now if the
    # update actually changes the data or not.

    # Signal all add of document.
    addedList = []
    for docsName, count of data.created
        if count > 0
            message = localization.t "notification #{docsName}"
            , smart_count: count

            addedList.push message

    if addedList.length > 0 # avoid empty message, as join always return String
        entries.notifContent = addedList.join ', '

    next()


displayData = (requiredFields, entries, data, next) ->
    K.logger.info "display data"
    K.logger.info JSON.stringify entries, null, 2
    K.logger.info JSON.stringify data, null, 2

    next()

fetchEdeliaData = (requiredFields, entries, data, next) ->
    async.eachSeries entries.contracts, (contract, callback) ->
        data.contract = contract
        importer = fetcher.new()
        operations = [
            fetchEdeliaToken
            fetchEdeliaProfile
            fetchEdeliaMonthlyElecConsumptions
            fetchEdeliaSimilarHomeYearlyElecComparisions
            fetchEdeliaElecIndexes
            fetchEdeliaMonthlyGasConsumptions
            fetchEdeliaSimilarHomeYearlyGasComparisions
            fetchEdeliaGasIndexes
        ]
        operations.forEach (operation) -> importer.use operation
        importer.args requiredFields, entries, data
        importer.fetch (err, fields, entries) ->
            if err and err.message isnt 'no edelia'
                K.logger.error 'Error while fetching Edelia data'
                K.logger.error err
                # Continue on error.
            callback()
    , next

# Konnector
K = module.exports = BaseKonnector.createNew
    name: 'EDF'
    slug: 'edf'
    description: 'konnector description edf'
    vendorLink: 'https://particulier.edf.fr/fr'
    category: 'energy',
    color:
        hex: '#FE5815'
        css: '#FE5815'
    fields:
        email:
            type: "text"
        password:
            type: "password"
        folderPath:
            type: "folder"
            advanced: true
    dataType: [
        'bill',
        'contract',
        'consumption'
        # TODO : put all data !
    ]

    # TODO : get one edeliaClientId: 'text'

    models: [
        Client,
        Contract,
        PaymentTerms,
        Home,
        ConsumptionStatement,
        Bill
    ]

    fetchOperations: [
        prepareEntries

        getEDFToken
        fetchListerContratClientParticulier
        fetchVisualiserPartenaire
        fetchVisualiserAccordCommercial
        fetchVisualiserCalendrierPaiement
        fetchVisualiserFacture
        fetchVisualiserHistoConso

        fetchEdeliaData

        updateOrCreate logger, Client, ['clientId', 'vendor']
        updateOrCreate logger, Contract, ['number', 'vendor']
        updateOrCreate logger, PaymentTerms, ['vendor', 'clientId']
        updateOrCreate logger, Home, ['pdl']
        updateOrCreate logger, ConsumptionStatement, ['contractNumber',
            'statementType', 'statementReason', 'statementCategory', 'start']
        #displayData
        filterExisting logger, Bill, undefined, 'EDF'
        saveBills
    ]

# Helpers

_extend = (a, b) ->
    for k, v of b
        if v?
            a[k] = v
    return a

getF = (node, fields...) ->
    try
        for field in fields
            node = node[field][0]
    catch e
        return null

    return node

translate = (dict, name) ->
    if name of dict
        return dict[name]
    return name

edfRequestPost = (path, body, callback) ->
    async.retry { times: 5, interval: 2000 }
    , (cb) ->
        _edfRequestPost(path, body, cb)
    , callback

_edfRequestOptions = (path, body) ->
    xmlBody = builder.buildObject body
    options =
        #url: 'https://rce-mobile.edf.com' + path
        url: DOMAIN + path
        method: 'POST'
        headers:
            # Server needs Capitalize headers, and request use lower case...
            #'Host': 'rce-mobile.edf.com'
            'Host': 'ws-mobile-particuliers.edf.com'
            'Content-Type': 'text/xml'
            'Authorization': 'Basic ' + 'QUVMTU9CSUxFX2lQaG9uZV9WMTpBRUxNT0JJTEVfaVBob25lX1Yx'
            'Accept-Encoding': 'gzip, deflate'
            'Content-Length': xmlBody.length
        body: xmlBody
        gzip: true

    return options

_edfRequestPost = (path, body, callback) ->
    K.logger.debug "called edfRequestPost"
    request _edfRequestOptions(path, body), (err, response, data) ->
        K.logger.error JSON.stringify(err) if err
        return callback 'request error' if err
        parser.parseString data, (err, result) ->
            return callback 'request error' if err
            callback null, result


getEdelia = (accessToken, path, callback) ->
    request.get 'https://api.edelia.fr/authorization-proxy/api/v1/' + path
    ,
        auth: bearer: accessToken
        json: true
    , callback
