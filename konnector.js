const xml2js = require('xml2js')
const request = require('request')
const async = require('async')
const moment = require('moment')
const _ = require('lodash')

const updateOrCreate = require('./lib/update_or_create')
// TODO localization = require '../lib/localization_manager'
const konnectorLibs = require('cozy-konnector-libs')
const { fetcher, filterExisting } = konnectorLibs
const BaseKonnector = konnectorLibs.baseKonnector

const saveDataAndFile = require('./lib/save_data_and_file')
const Bill = konnectorLibs.models.bill

const Client = require('./models/client')
const Contract = require('./models/contract')
const PaymentTerms = require('./models/payment_terms')
const ConsumptionStatement = require('./models/consumption_statement')
const Home = require('./models/home')
const EnergyBreakdown = require('./models/EnergyBreakdown')

const parser = new xml2js.Parser()
const builder = new xml2js.Builder({ headless: true })

const logger = require('printit')({
  prefix: 'EDF',
  date: true
})

const CONTRACT_CODES = {
  GN_2: 'Offre Gaz naturel',
  MCGN_2: 'Mon Contrat gaz naturel',
  MCGN_PRIX_FIXE_1: 'Mon Contrat Gaz Naturel a prix fixe',
  ELECTRICITE_PRO: 'Electricite Pro',
  ELEC_DEREGULE: 'Mon Contrat Electricite',
  ELEC_PRO_PX_FIXE_1: 'Electricite Pro a Prix Fixe',
  ESSENTIEL_PRO: 'Essentiel Pro',
  OFFRE_HC_SOUPLES: 'Heures Creuses Souples',
  PRESENCE_PRO: 'Presence Pro',
  SOUPLESSE_PRO: 'Souplesse Pro',
  TARIF_BLEU: 'Tarif Bleu',
  TARIF_BLEU_PART: 'Tarif Bleu',
  ESSENTIEL_GAZ: 'Essentiel Gaz',
  GAZ: 'Mon Contrat Gaz Naturel',
  GAZ_2: 'Mon Contrat Gaz Naturel',
  GAZ_NAT_PX_FIXE_1: 'Gaz Naturel a Prix Fixe',
  PRESENCE_GAZ: 'Presence Gaz',
  SOUPLESSE_GAZ: 'Souplesse Gaz',
  TARIF_BLEU_GAZ: 'Gaz Naturel',
  TARIF_EJP_PART: 'EJP',
  OFFRE_TPN: 'TPN'
}

const POWER_CODES = {
  PUI00: '0 kVA',
  PUI03: '3 kVA',
  PUI06: '6 kVA',
  PUI09: '9 kVA',
  PUI12: '12 kVA',
  PUI15: '15 kVA',
  PUI18: '18 kVA',
  PUI24: '24 kVA',
  PUI30: '30 kVA',
  PUI36: '36 kVA'
}

const ENERGY_CODES = {
  ELECTRICITE: 'Électricité',
  GAZ: 'Gaz'
}

const DOMAIN = 'https://ws-mobile-particuliers.edf.com'
// Requests

const getEDFToken = function (requiredFields, entries, data, callback) {
  K.logger.info('getEDFToken')
  const path = '/ws/authentifierUnClientParticulier_rest_V3-0/invoke'
  const body = {
    'tns:msgRequete': {
      $: {
        'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
        'xmlns:tns': 'http://www.edf.fr/commerce/passerelle/pas001/authentifierUnClientParticulier/service/v3',
        'xsi:schemaLocation': 'http://www.edf.fr/commerce/passerelle/pas001/authentifierUnClientParticulier/service/v3 authentifierUnClientParticulier.xsd'
      },
      'tns:enteteEntree': [{ 'tns:idCanal': 5 }],
      'tns:corpsEntree': [
        {
          'tns:idAppelant': requiredFields.email,
          'tns:password': requiredFields.password
        }
      ]
    }
  }

  return edfRequestPost(path, body, function (err, result) {
    if (err) {
      return callback(err)
    }

    const errorCode = getF(
      result['tns:msgReponse'],
      'tns:enteteSortie',
      'ent:codeRetour'
    )
    if (errorCode && errorCode !== '0000') {
      K.logger.error(getF(result, 'tns:enteteSortie', 'ent:libelleRetour '))
    }

    const token = getF(result['tns:msgReponse'], 'tns:corpsSortie', 'tns:jeton')

    if (token != null) {
      K.logger.info('EDF token fetched')
      data.edfToken = token
      return callback()
    } else {
      K.logger.error("Can't fetch EDF token")
      return callback('token not found')
    }
  })
}

const fetchListerContratClientParticulier = function (
  reqFields,
  entries,
  data,
  callback
) {
  K.logger.info('fetch listerContratClientParticulier')

  const path = '/ws/listerContratClientParticulier_rest_V3-0/invoke'
  const body = {
    'tns:msgRequete': {
      $: {
        'xmlns:tns': 'http://www.edf.fr/commerce/passerelle/pas072/listerContratClientParticulier/service/v3',
        'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
        'xsi:schemaLocation': 'http://www.edf.fr/commerce/passerelle/pas072/listerContratClientParticulier/service/v3 listerContratClientParticulier_rest_V3-0.xsd '
      },
      'tns:EnteteEntree': { 'tns:Jeton': data.edfToken },
      'tns:CorpsEntree': { 'tns:SynchroniserSI': true }
    }
  }

  return edfRequestPost(path, body, function (err, result) {
    if (err) {
      return callback(err)
    }
    try {
      const response = result['tns:msgReponse']
      const errorCode = getF(response, 'tns:EnteteSortie', 'tns:CodeErreur')
      if (errorCode && errorCode !== 'PSC0000') {
        K.logger.error(getF(response, 'tns:EnteteSortie', 'tns:LibelleErreur'))

        return callback('request error')
      }

      const accords = getF(response, 'tns:CorpsSortie')['tns:AccordCo'].slice(0, 1)

      K.logger.info(`Number EDF contracts ${accords.length}`)

      const clientContracts = accords.map(parseAccord)
      clientContracts.forEach(({ client, contract }) => {
        entries.contracts.push(contract)
        entries.clients.push(client)
      })

      K.logger.info('Fetched listerContratClientParticulier')

      return callback()
    } catch (e) {
      K.logger.error('While fetching listerContratClientParticulier', e)
      return callback(e)
    }
  })
}

const fetchVisualiserPartenaire = function (
  requiredFields,
  entries,
  data,
  callback
) {
  K.logger.info('fetchVisualiserPartenaire')

  const path = '/ws/visualiserPartenaire_rest_V2-0/invoke'
  const body = {
    msgRequete: {
      $: {
        'xsi:schemaLocation': 'http://www.edf.fr/commerce/passerelle/css/visualiserPartenaire/service/v2 C:\\HMN\\EDFMoiV2\\WSDL\\passerelle\\passerelle\\css\\visualiserPartenaire\\service\\v2\\visualiserPartenaire.xsd',
        'xmlns': 'http://www.edf.fr/commerce/passerelle/css/visualiserPartenaire/service/v2',
        'xmlns:ent': 'http://www.edf.fr/commerce/passerelle/commun/v2/entete',
        'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance'
      },

      enteteEntree: {
        'ent:jeton': data.edfToken
      },

      corpsEntree: {
        numeroBp: entries.clients[0].clientId
      }
    }
  }

  return edfRequestPost(path, body, function (err, result) {
    if (err) {
      return callback(err)
    }
    if (!result) {
      return callback()
    }
    try {
      const errorCode = getF(result, 'ns:enteteSortie', 'ent:codeRetour')
      if (errorCode && errorCode !== '0') {
        K.logger.error(getF(result, 'tns:enteteSortie', 'tns:libelleRetour'))

        return callback() // Continue on error.
      }

      const partnerElem = getF(
        result['ns:msgReponse'],
        'ns:corpsSortie',
        'ns:partenaire'
      )
      const client = {}
      const coordonneesElem = getF(partnerElem, 'ns:coordonnees')
      client.cellPhone = getF(coordonneesElem, 'ns:NumTelMobile')
      client.homePhone = getF(coordonneesElem, 'ns:NumTelFixe')
      client.email = getF(coordonneesElem, 'ns:Email')
      client.loginEmail = getF(coordonneesElem, 'ns:EmailAEL')

      const contactElem = getF(partnerElem, 'ns:centreContact')
      const contact = {}
      contact.title = getF(contactElem, 'ns:gsr')
      contact.phone = getF(contactElem, 'ns:telephone')

      const addressElem = getF(contactElem, 'ns:adresse')
      if (addressElem) {
        const address = {}
        address.street = getF(addressElem, 'ns:nomRue')
        address.postcode = getF(addressElem, 'ns:codePostal')
        address.city = getF(addressElem, 'ns:ville')
        address.formated =
          `${address.street}` + `\n${address.postcode} ${address.city}`
        contact.address = address
      }

      client.commercialContact = contact

      entries.clients[0] = _.extend(entries.clients[0], client)

      K.logger.info('Fetched visualiserPartenaire.')
      return callback()
    } catch (e) {
      K.logger.error('While fetching visualiserPartenaire.')
      K.logger.error(e)
      return callback(e)
    }
  })
}

const fetchVisualiserAccordCommercial = function (
  requiredFields,
  entries,
  data,
  callback
) {
  K.logger.info('fetchVisualiserAccordCommercial')

  const path = '/ws/visualiserAccordCommercial_rest_sso_V3-0/invoke'
  const body = {
    visualiserAccordCommercialRequest: {
      $: {
        xmlns: 'http://www.edf.fr/psc/0122/v3/visualiserAccordCommercial',
        'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
        'xsi:schemaLocation': 'http://www.edf.fr/psc/0122/v3/visualiserAccordCommercial visualiserAccordCommercial.xsd'
      },
      jeton: data.edfToken,
      numeroBp: entries.clients[0].clientId,
      numeroAcc: entries.clients[0].numeroAcc,
      applicationAppelante: 'EDFETMOI'
    }
  }

  return edfRequestPost(path, body, function (err, result) {
    if (err) {
      return callback(err)
    }

    const accordCommResp = result['tns:visualiserAccordCommercialResponse']
    const webServiceResp = getF(accordCommResp, 'tns:responseWebService')
    try {
      const errorCode = getF(webServiceResp, 'tns:CodeEtatService')
      if (errorCode && errorCode !== 'PSC0000') {
        K.logger.error(getF(webServiceResp, 'tns:LibelleEtatService'))
        return callback() // Continue on error.
      }

      const acoElem = getF(
        webServiceResp,
        'tns:listeAccordsCommerciaux',
        'tns:item'
      )

      const getFAccordCom = getF.bind(null, acoElem)
      const getFBanque = getFAccordCom.bind(null, 'tns:banque')
      const getFDetail = getFAccordCom.bind(null, 'tns:detail')
      const getFDernierReg = getFAccordCom.bind(null, 'tns:dernierReglement')

      const bankAddress = {
        street: getFBanque('tns:numNomRue'),
        city: getFBanque('tns:codePostalVille'),
        // postcode ?
        country: getFBanque('tns:pays')
      }
      bankAddress.formated = `${bankAddress.street}\n${bankAddress.city} ${bankAddress.country}`

      const bankDetails = {
        iban: getFBanque('tns:iban'),
        holder: getF(acoElem, 'tns:compte', 'tns:titulaire'),
        bank: getFBanque('tns:nom'),
        bankAddress: bankAddress
      }

      const paymentTerms = {
        vendor: 'EDF',
        clientId: entries.clients[0].clientId,
        docTypeVersion: K.docTypeVersion,
        encryptedBankDetails: JSON.stringify(bankDetails),
        balance: getFDetail('tns:solde'),
        paymentMeans: getFDetail('tns:modeEncaissement'),
        modifBankDetailsAllowed: getFDetail('tns:modifIBANAutorisee'),
        billFrequency: getFAccordCom('tns:facturation', 'tns:periodicite'),
        dernierReglement: {
          date: getFDernierReg('tns:date'),
          amount: getFDernierReg('tns:montant'),
          type: getFDernierReg('tns:type')
        },
        idPayer: getFAccordCom('tns:numeroPayeur'),
        payerDivergent: getFAccordCom('tns:payeurDivergent')
      }

      // accountNumber: getF acoElem, 'ns:detail', 'ns:numeroEtendu'
      paymentTerms.nextBillDate = getF(acoElem)

      // paymentTerms.mensuSansSurprise = getF acoElem, 'tns:mensuSansSurprise'

      const servicesElem = getFAccordCom('tns:services')['tns:item']
      const services = servicesElem.map(function (serviceElem) {
        return {
          name: getF(serviceElem, 'tns:nomService'),
          status: getF(serviceElem, 'tns:etat'),
          valueSubscribed: getF(serviceElem, 'tns:valeurSouscrite'),
          valuesAvailable: serviceElem['tns:valeursPossibles']
        }
      })

      entries.paymenttermss.push(paymentTerms)
      entries.contracts.forEach(
        contract => (contract.services = contract.services.concat(services))
      )

      K.logger.info('Fetched visualiserAccordCommercial.')
      return callback()
    } catch (e) {
      K.logger.error('While fetching visualiserAccordCommercial.')
      K.logger.error(e)
      return callback(e)
    }
  })
}

const fetchVisualiserCalendrierPaiement = function (
  requiredFields,
  entries,
  data,
  callback
) {
  K.logger.info('fetchVisualiserCalendrierPaiement')
  const path = '/ws/visualiserCalendrierPaiement_rest_V2-0/invoke'
  const body = {
    'message:msgRequete': {
      $: {
        'xsi:schemaLocation': 'http://www.edf.fr/commerce/passerelle/css/visualiserCalendrierPaiement/service/v2 C:\\HMN\\EDFMoiV2\\WSDL\\passerelle\\passerelle\\css\\visualiserCalendrierPaiement\\service\\v2\\visualiserCalendrierPaiement.xsd',
        'xmlns:message': 'http://www.edf.fr/commerce/passerelle/css/visualiserCalendrierPaiement/service/v2',
        'xmlns:ent': 'http://www.edf.fr/commerce/passerelle/commun/v2/entete',
        'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance'
      },

      'message:enteteEntree': {
        'ent:jeton': data.edfToken
      },

      'message:corpsEntree': {
        'message:numeroBp': entries.clients[0].clientId,
        'message:numeroAcc': entries.clients[0].numeroAcc
      }
    }
  }

  return edfRequestPost(path, body, function (err, result) {
    if (err) {
      return callback(err)
    }
    if (!result) {
      return
    }
    try {
      // Does API send an error ?
      const errorCode = getF(
        result,
        'ns:msgReponse',
        'ns:enteteSortie',
        'ent:codeRetour'
      )
      if (errorCode && errorCode !== '0') {
        K.logger.error(
          getF(result, 'ns:msgReponse', 'ns:enteteSortie', 'ent:libelleRetour')
        )
        return callback() // Continue, whitout error.
      }

      let listeEcheances = getF(
        result['ns:msgReponse'],
        'ns:corpsSortie',
        'ns:calendrierDePaiement'
      )

      if (
        !(listeEcheances &&
          listeEcheances['ns:listeEcheances'] &&
          listeEcheances['ns:listeEcheances'].length > 0)
      ) {
        K.logger.warn('No payment schedules')
        return callback() // Continue whithout errors.
      }

      listeEcheances = listeEcheances['ns:listeEcheances']

      // TODO : if no gaz and elec !?
      const paymentSchedules = listeEcheances.map(function (echeance) {
        let amountGaz = parseFloat(getF(echeance, 'ns:montantGaz'))
        let amountElec = parseFloat(getF(echeance, 'ns:montantElec'))

        if (isNaN(amountGaz)) {
          amountGaz = 0
        }
        if (isNaN(amountElec)) {
          amountElec = 0
        }

        const doc = {
          number: parseInt(getF(echeance, 'ns:numeroEcheance')),
          receiptDate: getF(echeance, 'ns:dateEncaissement'),
          scheduleDate: getF(echeance, 'ns:DateEcheance'),
          paid: getF(echeance, 'ns:paiement') === 'EFFECTUE',
          amount: amountGaz + amountElec,
          amountGas: amountGaz,
          amountElectricity: amountElec
        }
        return doc
      })

      if (!entries.paymenttermss[0]) {
        entries.paymenttermss[0] = {
          vendor: 'EDF',
          clientId: entries.clients[0].clientId,
          docTypeVersion: K.docTypeVersion
        }
      }

      entries.paymenttermss[0].paymentSchedules = paymentSchedules
      K.logger.info(
        `Fetched ${paymentSchedules.length} ` +
          'from fetchVisualiserCalendrierPaiement'
      )
      return callback()
    } catch (e) {
      K.logger.error('While fetchVisualiserCalendrierPaiement')
      K.logger.error(e)
      return callback(e)
    }
  })
}

const fetchVisualiserFacture = function (reqFields, entries, data, callback) {
  K.logger.info('fetchVisualiserFacture')
  const path = '/ws/visualiserFacture_rest_V3-0/invoke'
  const body = {
    'tns:msgRequete': {
      $: {
        'xmlns:tns': 'http://www.edf.fr/commerce/passerelle/pas023/visualiserFacture/service/v2'
      },
      visualiserFactureRequest: {
        numeroBp: entries.clients[0].clientId,
        jeton: data.edfToken,
        numeroAcc: entries.clients[0].numeroAcc,
        dateRecherche: '1900-01-01'
      }
    }
  }

  return edfRequestPost(path, body, function (err, result) {
    if (err) {
      return callback(err)
    }

    let bills = []
    try {
      const errorCode = getF(
        result['tns:msgReponse'],
        'visualiserFactureResponse',
        'responseWebService',
        'codeErreur'
      )
      if (errorCode && errorCode !== '0') {
        K.logger.error(
          getF(
            result['tns:msgReponse'],
            'visualiserFactureResponse',
            'responseWebService',
            'libelleErreur'
          )
        )
        return callback() // Continue, whitout error.
      }

      const documents = getF(
        result['tns:msgReponse'],
        'visualiserFactureResponse',
        'responseWebService',
        'listeFactures'
      )['item']

      bills = documents.map(function (elem) {
        const details = getF(elem, 'resume')
        const bill = {
          vendor: 'EDF',
          clientId: entries.clients[0].clientId,
          title: getF(details, 'type'),
          number: getF(elem, 'numeroFacture'),
          date: moment(getF(details, 'dateEmission'), 'YYYY-MM-DD'),
          paymentDueDate: getF(details, 'dateEcheance'),
          scheduledPaymentDate: getF(details, 'datePrelevement'),
          totalPaymentDue: getF(details, 'montantFactureFraiche'),
          value: getF(details, 'montantReclame'),
          balanceBeforeInvoice: getF(details, 'soldeAvantFacture'),

          // TODO: hack to force download, bad because duplicate URL !
          pdfurl: DOMAIN +
            '/ws/recupererDocumentContractuelGet_rest_V1-0/invoke',
          docTypeVersion: K.docTypeVersion
        }

        return bill
      })

      entries.fetched = bills
      K.logger.info(`Fetched ${bills.length} bills`)
      return callback()
    } catch (e) {
      K.logger.error('While fetchVisualiserFacture')
      K.logger.error(e)
      return callback(e)
    }
  })
}

const fetchVisualiserHistoConso = function (
  requiredFields,
  entries,
  data,
  callback
) {
  K.logger.info('fetchVisualiserHistoConso')
  return async.mapSeries(
    entries.contracts,
    function (contract, cb) {
      const path = '/ws/visualiserHistoConso_rest_V3-0/invoke'
      const basePasserelle = 'http://www.edf.fr/commerce/passerelle'
      const baseVisualiserHistoConso = `${basePasserelle}/css/visualiserHistoConso`
      const body = {
        'message:msgRequete': {
          $: {
            'xsi:schemaLocation': `${baseVisualiserHistoConso}/service/v2 C:\\HMN\\EDFMoiV2\\WSDL\\passerelle\\passerelle\\css\\visualiserHistoConso\\service\\v2\\visualiserHistoConso.xsd`,
            'xmlns:message': `${basePasserelle}/css/visualiserHistoConso/service/v2`,
            'xmlns:ent': `${basePasserelle}/commun/v2/entete`,
            'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance'
          },

          'message:enteteEntree': {
            'ent:jeton': data.edfToken
          },

          'message:corpsEntree': {
            'message:numeroBp': entries.clients[0].clientId,
            'message:numeroContrat': contract.number
          }
        }
      }

      return edfRequestPost(path, body, function (err, result) {
        if (err) {
          return callback(err)
        }
        try {
          const getFSortie = getF.bind(null, result, 'ns:enteteSortie')
          const errorCode = getFSortie('ent:codeRetour')
          if (errorCode && errorCode !== '0') {
            K.logger.error(getFSortie('tns:libelleRetour'))
            // Continue on error.
            return callback()
          }

          if (!('ns:corpsSortie' in result['ns:msgReponse'])) {
            K.logger.info('No histoConsos to fetch')
            return callback(null, [])
          }

          const consoElems =
            result['ns:msgReponse']['ns:corpsSortie'][0]['ns:listeHistoDeConso']

          const res = consoElems.map(function (consoElem) {
            const doc = {
              contractNumber: contract.number,
              billNumber: getF(consoElem, 'ns:numeroFacture'),
              start: getF(consoElem, 'ns:dateDebut'),
              end: getF(consoElem, 'ns:dateFin'),
              value: getF(consoElem, 'ns:listeConsommation', 'ns:valeur'),
              // unit: getF conso, 'ns:listeConsommation', 'ns:cadran'
              statementType: getF(consoElem, 'ns:typeReleve'),
              statementCategory: getF(consoElem, 'ns:categorieReleve'),
              statementReason: getF(consoElem, 'ns:motifReleve'),
              docTypeVersion: K.docTypeVersion
            }

            return doc
          })

          return cb(null, res)
        } catch (e) {
          K.logger.error('While fetching visualiserHistoConso.')
          K.logger.error(e)
          return cb(e)
        }
      })
    },
    function (err, results) {
      if (err) {
        return callback(err)
      }

      entries.consumptionstatements = results.reduce(
        (agg, result) => agg.concat(result),
        []
      )

      K.logger.info(
        `Fetched ${entries.consumptionstatements.length}` +
          ' consumptionStatements'
      )
      return callback()
    }
  )
}

const saveBills = function (requiredFields, entries, data, callback) {
  const options = {}
  options.vendor = 'edf'

  options.requestoptions = function (bill) {
    const path = '/ws/recupererDocumentContractuelGet_rest_V1-0/invoke'
    const body = {
      'dico:getRequest': {
        $: {
          'xmlns:dico': 'http://www.edf.fr/psc/pscma100/recupererDocumentContractuel/service/v1',
          'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
          'xsi:schemaLocation': 'http://www.edf.fr/psc/pscma100/recupererDocumentContractuel/service/v1 recupererDocumentContractuel.xsd'
        },
        getRequest: {
          options: [
            { cle: 'id', valeur: 'pscedfmoi' },
            { cle: 2, valeur: entries.clients[0].clientId },
            { cle: 4, valeur: bill.number },
            { cle: 6, valeur: 'Facture' }
          ]
        },
        numeroBp: entries.clients[0].clientId,
        jeton: data.edfToken
      }
    }

    return _edfRequestOptions(path, body)
  }

  options.parseoptions = data =>
    new Promise(function (resolve, reject) {
      return parser.parseString(data, function (err, result) {
        if (err) {
          return reject('request error')
        }

        const base64PDF = getF(
          result['rdc:getResponse'],
          'getResponse',
          'docubase',
          'documentPDF',
          'pdf'
        )
        return resolve({ data: base64PDF, contentType: 'application/pdf' })
      })
    })

  return saveDataAndFile(logger, Bill, options, ['EDF'])(
    requiredFields,
    entries,
    data,
    callback
  )
}

// #
// Edelia
// #

const fetchEdeliaToken = function (requiredFields, entries, data, callback) {
  K.logger.info('fetchEdeliaToken')

  const formData = {
    client_id: 'sha1pae0Pahngee6uwiphooDie7thaiquahf2xohd6IeFeiphi9ziu0uw3am',
    grant_type: 'edf_sso',
    jeton_sso: data.edfToken,
    bp: entries.clients[0].clientId,
    pdl: data.contract.pdl
  }

  return request.post(
    'https://api.edelia.fr/authorization-server/oauth/token',
    {
      form: formData,
      json: true
    },
    function (err, response, result) {
      if (err) {
        K.logger.error('While fetching edelia token.')
        K.logger.error(err)
        return callback(err)
      }

      K.logger.info('Fetched edelia token')
      data.edeliaToken = result.access_token
      return callback()
    }
  )
}

const fetchEdeliaProfile = function (requiredFields, entries, data, callback) {
  K.logger.info('fetchEdeliaProfile')
  return getEdelia(
    data.edeliaToken,
    '/sites/-/profiles/simple?ts=' + new Date().toISOString(),
    function (err, response, obj) {
      let error = null
      try {
        if (!err && !obj) {
          err = 'no import performed'
        }

        if (err) {
          K.logger.error('While fetchEdeliaProfile')
          K.logger.error(err)
          throw err
        }

        if (obj.errorCode && obj.errorCode === '403') {
          data.noEdelia = true
          K.logger.warn(`No edelia: ${obj.errorDescription}`)
          throw new Error('no edelia')
        }

        const doc = {
          pdl: data.pdl,
          beginTs: obj.beginTs,
          isProfileValidated: obj.isProfileValidated,
          housingType: obj.housingType,
          residenceType: obj.residenceType,
          occupationType: obj.occupationType,
          constructionDate: obj.constructionDate,
          isBBC: obj.isBBC,
          surface: obj.surfaceInSqMeter,
          occupantsCount: obj.noOfOccupants,
          principalHeatingSystemType: obj.principalHeatingSystemType,
          sanitoryHotWaterType: obj.sanitoryHotWaterType,
          docTypeVersion: K.docTypeVersion
        }

        entries.homes.push(doc)
        return K.logger.info('Fetched fetchEdeliaProfile')
      } catch (e) {
        return (error = e)
      } finally {
        callback(error)
      }
    }
  )
}

// #
// Edelia electricite
// #

const fetchEdeliaMonthlyElecConsumptions = function (
  requiredFields,
  entries,
  data,
  callback
) {
  if (data.noEdelia) {
    return callback()
  }

  K.logger.info('fetchEdeliaMonthlyElecConsumptions')
  return getEdelia(
    data.edeliaToken,
    '/sites/-/monthly-elec-consumptions?' +
      'begin-month=2012-01&' +
      `end-month=${moment().add(1, 'month').format('YYYY-MM')}&ended=false`,
    function (err, response, obj) {
      let error = null
      try {
        if (response.statusCode === 404 || response.statusCode === 500) {
          K.logger.warn('No EdeliaMonthlyElecConsumptions')
          data.noElec = true
          throw null
        }

        if (err) {
          K.logger.error('Wihle fetchEdeliaMonthlyElecConsumptions')
          K.logger.error(err)
          throw err
        }

        let statements = []

        data.consumptionStatementByMonth = {}

        statements = statements.concat(
          obj.monthlyElecEnergies.map(function (mee) {
            const doc = {
              docTypeVersion: K.docTypeVersion,
              contractNumber: data.contract.number,
              start: mee.beginDay,
              end: mee.endDay,
              value: mee.consumption.energy,
              statementType: 'estime',
              statementCategory: 'edelia',
              statementReason: 'EdeliaMonthlyElecConsumption',
              period: mee.month,
              cost: mee.totalCost,
              costsByCategory: mee.consumption.costsByTariffHeading,
              valuesByCategory: mee.consumption.energiesByTariffHeading
            }

            doc.costsByCategory.standing = mee.standingCharge
            data.consumptionStatementByMonth[mee.month] = doc

            return doc
          })
        )

        // Convenient structure to enhance data later.
        data.consumptionStatementByYear = {}

        statements = statements.concat(
          obj.yearlyElecEnergies.map(function (yee) {
            const doc = {
              docTypeVersion: K.docTypeVersion,
              contractNumber: data.contract.number,
              start: yee.beginDay,
              end: yee.endDay,
              value: yee.consumption.energy,
              statementType: 'estime',
              statementCategory: 'edelia',
              statementReason: 'EdeliaYearlyElecConsumption',
              period: yee.year,
              cost: yee.totalCost,
              costsByCategory: yee.consumption.costsByTariffHeading,
              valuesByCategory: yee.consumption.energiesByTariffHeading
            }

            doc.costsByCategory.standing = yee.standingCharge

            // Add to a convenient structure to enhance them with comparisons
            data.consumptionStatementByYear[yee.year] = doc
            return doc
          })
        )

        if (statements.length !== 0) {
          entries.consumptionstatements = entries.consumptionstatements.concat(
            statements
          )
        }

        return K.logger.info('Fetched fetchEdeliaMonthlyElecConsumptions')
      } catch (e) {
        return (error = e)
      } finally {
        callback(error)
      }
    }
  )
}

const fetchEdeliaSimilarHomeYearlyElecComparisions = function (
  requiredFields,
  entries,
  data,
  callback
) {
  if (data.noEdelia || data.noElec) {
    return callback()
  }

  K.logger.info('fetchEdeliaSimilarHomeYearlyElecComparisions')
  return getEdelia(
    data.edeliaToken,
    '/sites/-/similar-home-yearly-elec-comparisons?begin-year=2012',
    function (err, response, objs) {
      let error = null
      try {
        if (response.statusCode === 404 || response.statusCode === 500) {
          K.logger.warn('No EdeliaSimilarHomeYearlyElecComparisions')
          data.noElec = true
          throw null
        }
        if (err) {
          K.logger.error('While fetchEdeliaSimilarHomeYearlyElecComparisions')
          K.logger.error(err)
          throw err
        }

        objs.forEach(function (obj) {
          const statement = data.consumptionStatementByYear[obj.year]
          if (!statement) {
            K.logger.warn(`No yearly statement for ${obj.date.year}`)
            return
          }
          return (statement.similarHomes = {
            site: obj.energies.site,
            average: obj.energies.similarHomes.SH_AVERAGE_CONSUMING,
            least: obj.energies.similarHomes.SH_LEAST_CONSUMING
          })
        })

        K.logger.info('Fetched fetchEdeliaSimilarHomeYearlyElecComparisions')
      } catch (e) {
        error = e
      }

      delete data.consumptionStatementByYear
      return callback(error)
    }
  )
}

const fetchEdeliaElecIndexes = function (
  requiredFields,
  entries,
  data,
  callback
) {
  if (data.noEdelia || data.noElec) {
    return callback()
  }
  K.logger.info('fetchEdeliaElecIndexes')
  return getEdelia(
    data.edeliaToken,
    '/sites/-/elec-indexes?begin-date=2012-01-01&' +
      `end-date=${moment().format('YYYY-MM-DD')}&types=`,
    function (err, response, objs) {
      let error = null
      try {
        if (response.statusCode === 404) {
          K.logger.warn('No EdeliaElecIndexes')
          throw null
        }

        if (err) {
          K.logger.error('Wihle fetchEdeliaElecIndexes')
          K.logger.error(err)
          throw err
        }

        objs.forEach(function (obj) {
          const statement =
            data.consumptionStatementByMonth[obj.date.slice(0, 7)]
          if (!statement) {
            K.logger.warn(`No monthly statement for ${obj.date.slice(0, 7)}`)
            return
          }

          statement.statements = statement.statements || []
          return statement.statements.push(obj)
        })

        K.logger.info('Fetched fetchEdeliaElecIndexes')
      } catch (e) {
        error = e
      }

      delete data.consumptionStatementByMonth
      return callback(error)
    }
  )
}

// #
// Edelia Gas
// #

const fetchEdeliaMonthlyGasConsumptions = function (
  requiredFields,
  entries,
  data,
  callback
) {
  if (data.noEdelia) {
    return callback()
  }
  K.logger.info('fetchEdeliaMonthlyGasConsumptions')
  return getEdelia(
    data.edeliaToken,
    '/sites/-/monthly-gas-consumptions?begin-month=2012-01&' +
      `end-month=${moment().add(1, 'month').format('YYYY-MM')}&ended=false`,
    function (err, response, obj) {
      let error = null
      try {
        if (response.statusCode === 404) {
          K.logger.warn('No EdeliaMonthlyGasConsumptions')
          data.noGas = true
          throw null
        }

        if (err) {
          K.logger.error('Wihle fetchEdeliaMonthlyGasConsumptions')
          K.logger.error(err)
          throw err
        }

        let statements = []

        data.consumptionStatementByMonth = {}

        statements = obj.monthlyGasEnergies != null
          ? obj.monthlyGasEnergies.map(function (mee) {
            const doc = {
              docTypeVersion: K.docTypeVersion,
              contractNumber: data.contract.number,
              start: mee.beginDay,
              end: mee.endDay,
              value: mee.consumption.energy,
              statementType: 'estime',
              statementCategory: 'edelia',
              statementReason: 'EdeliaMonthlyGasConsumption',
              period: mee.month,
              cost: mee.totalCost,
              costsByCategory: {
                consumption: mee.consumption.cost,
                standing: mee.standingCharge
              }
            }

            data.consumptionStatementByMonth[mee.month] = mee
            return doc
          })
          : undefined

        // Convenient structure to enhance data later.
        data.consumptionStatementByYear = {}

        statements = statements.concat(
          obj.yearlyGasEnergies.map(function (yee) {
            const doc = {
              docTypeVersion: K.docTypeVersion,
              contractNumber: data.contract.number,
              start: yee.beginDay,
              end: yee.endDay,
              value: yee.consumption.energy,
              statementType: 'estime',
              statementCategory: 'edelia',
              statementReason: 'EdeliaYearlyGasConsumption',
              period: yee.year,
              cost: yee.totalCost,
              costsByCategory: {
                consumption: yee.consumption.cost,
                standing: yee.standingCharge
              }
            }

            // Add to a convenient structure to enhance them with comparisons
            data.consumptionStatementByYear[yee.year] = doc
            return doc
          })
        )

        if (statements.length !== 0) {
          entries.consumptionstatements = entries.consumptionstatements.concat(
            statements
          )
        }

        K.logger.info('Fetched fetchEdeliaMonthlyGasConsumptions')
      } catch (e) {
        error = e
      }

      return callback(error)
    }
  )
}

const fetchEdeliaSimilarHomeYearlyGasComparisions = function (
  requiredFields,
  entries,
  data,
  callback
) {
  if (data.noEdelia || data.noGas) {
    return callback()
  }

  K.logger.info('fetchEdeliaSimilarHomeYearlyGasComparisions')
  return getEdelia(
    data.edeliaToken,
    '/sites/-/similar-home-yearly-gas-comparisons?begin-year=2012',
    function (err, response, objs) {
      let error = null
      try {
        if (response.statusCode === 404 || response.statusCode === 500) {
          K.logger.warn('No EdeliaSimilarHomeYearlyGasComparisions')
          throw null
        }

        if (err) {
          K.logger.error('While fetchEdeliaSimilarHomeYearlyGasComparisions')
          K.logger.error(err)
          throw err
        }

        objs.forEach(function (obj) {
          const statement = data.consumptionStatementByYear[obj.year]
          if (!statement) {
            K.logger.warn(`No yearly statement for ${obj.date.year}`)
            return
          }

          return (statement.similarHomes = {
            site: obj.energies.site,
            average: obj.energies.similarHomes.SH_AVERAGE_CONSUMING,
            least: obj.energies.similarHomes.SH_LEAST_CONSUMING
          })
        })

        K.logger.info('Fetched fetchEdeliaSimilarHomeYearlyGasComparisions')
      } catch (e) {
        error = e
      }

      return callback(error)
    }
  )
}

const fetchEdeliaGasIndexes = function (
  requiredFields,
  entries,
  data,
  callback
) {
  if (data.noEdelia || data.noGas) {
    return callback()
  }

  K.logger.info('fetchEdeliaGasIndexes')

  const end = moment().format('YYYY-MM-DD')
  const path = `/sites/-/gas-indexes?begin-date=2012-01-01&end-date=${end}&types=`
  return getEdelia(data.edeliaToken, path, function (err, response, objs) {
    let error = null
    try {
      if (response.statusCode === 404) {
        K.logger.warn('No EdeliaGasIndexes')
        throw null
      }

      if (err) {
        K.logger.error('Wihle fetchEdeliaGasIndexes')
        K.logger.error(err)
        throw err
      }

      objs.forEach(function (obj) {
        const monthKey = obj.date.slice(0, 7)
        const statement = data.consumptionStatementByMonth[monthKey]
        if (!statement) {
          K.logger.warn(`No monthly statement for ${monthKey}`)
          return
        }
        statement.statements = statement.statements || []
        return statement.statements.push(obj)
      })

      K.logger.info('Fetched fetchEdeliaGasIndexes')
    } catch (e) {
      error = e
    }

    return callback(error)
  })
}

const makeEdeliaFetcher = function (name, options) {
  const { parse, getPath, bail } = options

  return function (requiredFields, entries, data, callback) {
    if (bail && bail()) {
      callback()
    }
    K.logger.info(`Fetching ${name}`)
    getEdelia(data.edeliaToken, getPath(), function (err, response, objs) {
      if (err) {
        K.logger.error(`Error during ${name}`)
        K.logger.error(err)
        return callback(err)
      }
      try {
        parse(entries, data, objs, response)
        K.logger.info(`Fetched ${name}`)
        callback()
      } catch (e) {
        K.logger.error(`Error during ${name}`)
        callback(e)
      }
    })
  }
}

const jsonlog = function (d) {
  K.logger.info(JSON.stringify(d, null, 2))
}

const fetchEdeliaElectricityUsageBreakdowns = makeEdeliaFetcher(
  'Edelia usage breakdowns',
  {
    getPath: path => {
      const now = new Date()
      return `sites/-/elec-usage-breakdowns?ts=${now.toISOString()}`
    },
    parse: (entries, data, energyBreakdown, response) => {
      if (response.statusCode != 200) {
        throw new Error('Status code != 200')
      }
      const breakdown = _.extend(
        {
          vendor: 'EDF',
          clientId: data.contract.clientId,
          contractNumber: data.contract.number,
          energyType: 'electricity'
        },
        energyBreakdown
      )
      entries.energybreakdowns.push(breakdown)
    }
  }
)

const fetchEdeliaGasUsageBreakdowns = makeEdeliaFetcher(
  'Edelia usage breakdowns',
  {
    getPath: path => {
      const now = new Date()
      return `sites/-/gas-usage-breakdowns?ts=${now.toISOString()}`
    },
    parse: (entries, data, energyBreakdown, response) => {
      if (response.statusCode != 200) {
        throw new Error('Status code != 200')
      }
      const breakdown = _.extend(
        {
          vendor: 'EDF',
          clientId: data.contract.clientId,
          contractNumber: data.contract.number,
          energyType: 'gas'
        },
        energyBreakdown
      )
      entries.energybreakdowns.push(breakdown)
    }
  }
)

const checkRequiredFields = function (requiredFields, entries, data, next) {
  if (!requiredFields.email || !requiredFields.password) {
    throw new Error('You need to pass `email` and `password` in your requiredFields')
  }
  return next()
}

const prepareEntries = function (requiredFields, entries, data, next) {
  entries.homes = []
  entries.consumptionstatements = []
  entries.contracts = []
  entries.fetched = []
  entries.clients = []
  entries.paymenttermss = []
  entries.energybreakdowns = []
  return next()
}

const buildNotifContent = function (requiredFields, entries, data, next) {
  // data.updated: we don't speak about update, beacause we don't now if the
  // update actually changes the data or not.

  // Signal all add of document.
  const addedList = []
  for (const docsName in data.created) {
    const count = data.created[docsName]
    if (count > 0) {
      const message = localization.t(`notification ${docsName}`, {
        smart_count: count
      })

      addedList.push(message)
    }
  }

  if (addedList.length > 0) {
    // avoid empty message, as join always return String
    entries.notifContent = addedList.join(', ')
  }

  return next()
}

const displayData = function (requiredFields, entries, data, next) {
  K.logger.info('display data')
  K.logger.info(JSON.stringify(entries, null, 2))
  K.logger.info(JSON.stringify(data, null, 2))

  return next()
}

const fetchEdeliaData = (requiredFields, entries, data, next) => {
  K.logger.info(`Number of Edelia contracts ${entries.contracts.length}`)
  async.eachSeries(
    entries.contracts,
    function (contract, callback) {
      data.contract = contract
      const importer = fetcher.new()
      const operations = [
        fetchEdeliaToken,
        fetchEdeliaElectricityUsageBreakdowns,
        fetchEdeliaGasUsageBreakdowns,
        fetchEdeliaProfile,
        fetchEdeliaMonthlyElecConsumptions,
        fetchEdeliaSimilarHomeYearlyElecComparisions,
        fetchEdeliaElecIndexes,
        fetchEdeliaMonthlyGasConsumptions,
        fetchEdeliaSimilarHomeYearlyGasComparisions,
        fetchEdeliaGasIndexes
      ]
      operations.forEach(operation => importer.use(operation))
      importer.args(requiredFields, entries, data)
      return importer.fetch(function (err, fields, entries) {
        if (err && err.message !== 'no edelia') {
          K.logger.error('Error while fetching Edelia data')
          K.logger.error(err)
        }
        // Continue on error.
        return callback()
      })
    },
    next
  )
}

// Konnector
var K = (module.exports = BaseKonnector.createNew({
  name: 'EDF',
  slug: 'edf',
  description: 'konnector description edf',
  vendorLink: 'https://particulier.edf.fr/fr',
  category: 'energy',
  color: {
    hex: '#FE5815',
    css: '#FE5815'
  },
  fields: {
    email: {
      type: 'text'
    },
    password: {
      type: 'password'
    },
    folderPath: {
      type: 'folder',
      advanced: true
    }
  },
  dataType: [
    'bill',
    'contract',
    'consumption'
    // TODO : put all data !
  ],

  // TODO : get one edeliaClientId: 'text'

  models: [Client, Contract, PaymentTerms, Home, ConsumptionStatement, Bill],

  fetchOperations: [
    checkRequiredFields,
    prepareEntries,

    getEDFToken,
    fetchListerContratClientParticulier,
    fetchVisualiserPartenaire,
    fetchVisualiserAccordCommercial,
    fetchVisualiserCalendrierPaiement,
    fetchVisualiserFacture,
    fetchVisualiserHistoConso,

    fetchEdeliaData,

    updateOrCreate(logger, Client, ['clientId', 'vendor']),
    updateOrCreate(logger, Contract, ['number', 'vendor']),
    updateOrCreate(logger, PaymentTerms, ['vendor', 'clientId']),
    updateOrCreate(logger, Home, ['pdl']),
    updateOrCreate(logger, EnergyBreakdown, ['contractId', 'vendor', 'energyType']),
    updateOrCreate(logger, ConsumptionStatement, [
      'contractNumber',
      'statementType',
      'statementReason',
      'statementCategory',
      'start'
    ]),
    // displayData
    filterExisting(logger, Bill, undefined, 'EDF'),
    saveBills
  ]
}))

// Helpers
var getF = function (node, ...fields) {
  try {
    for (const field of Array.from(fields)) {
      node = node[field][0]
    }
  } catch (e) {
    return null
  }

  return node
}

var translate = function (dict, name) {
  if (name in dict) {
    return dict[name]
  }
  return name
}

var edfRequestPost = (path, body, callback) =>
  async.retry(
    { times: 5, interval: 2000 },
    cb => _edfRequestPost(path, body, cb),
    callback
  )

var _edfRequestOptions = function (path, body) {
  const xmlBody = builder.buildObject(body)
  const options = {
    // url: 'https://rce-mobile.edf.com' + path
    url: DOMAIN + path,
    method: 'POST',
    headers: {
      // Server needs Capitalize headers, and request use lower case...
      // 'Host': 'rce-mobile.edf.com'
      Host: 'ws-mobile-particuliers.edf.com',
      'Content-Type': 'text/xml',
      Authorization: 'Basic QUVMTU9CSUxFX2lQaG9uZV9WMTpBRUxNT0JJTEVfaVBob25lX1Yx',
      'Accept-Encoding': 'gzip, deflate',
      'Content-Length': xmlBody.length
    },
    body: xmlBody,
    gzip: true
  }

  return options
}

var _edfRequestPost = function (path, body, callback) {
  K.logger.debug('called edfRequestPost')
  return request(_edfRequestOptions(path, body), function (err, response, data) {
    if (err) {
      K.logger.error(JSON.stringify(err))
    }
    if (err) {
      return callback('request error')
    }
    return parser.parseString(data, function (err, result) {
      if (err) {
        return callback('request error')
      }
      return callback(null, result)
    })
  })
}

function parseAccord (accordObj) {
  const client = parseClient(accordObj)

  // Contracts
  const contratElem = accordObj['tns:Contrat'][0]
  const vieContratObj = getF(contratElem, 'tns:VieDuContrat')
  const offre = getF(contratElem, 'tns:OffreSouscrite')

  const getFContrat = getF.bind(null, contratElem)
  const getFVie = getF.bind(null, vieContratObj)
  const getFOffre = getF.bind(null, offre)

  const energyObj = getFOffre('tns:Energie')

  const contract = {
    vendor: 'EDF',
    clientId: client.clientId,
    docTypeVersion: K.docTypeVersion,
    number: getFContrat('tns:Numero'),
    pdl: getFContrat('tns:NumeroPDL'),
    start: getFVie('tns:DateDebut'),
    status: getFVie('tns:Statut'),
    end: getFVie('tns:DateFin'),
    terminationGrounds: getFVie('tns:MotifResiliation'),
    energie: translate(ENERGY_CODES, energyObj),
    name: translate(CONTRACT_CODES, getFOffre('tns:NomOffre')),
    troubleshootingPhone: getFOffre('tns:NumeroDepannageContrat')
  }

  switch (contract.energie) {
    case 'Électricité':
      contract.power = translate(POWER_CODES, getFOffre('tns:Puissance'))
      contract.contractSubcategory1 = getFOffre('tns:StructureTarifaire')
      break

    case 'Gaz':
      contract.contractSubcategory2 = getFOffre('tns:OptionPrix')
      break
  }

  const cadranElem = getFContrat('tns:ListeCadran')
  if (cadranElem) {
    const getFCadran = getF.bind(null, cadranElem)
    contract.counter = {
      comptage: getFCadran('tns:Type'),
      nombreRoues: getFCadran('tns:NombreRoues'),
      dernierIndex: getFCadran('tns:DernierIndex'),
      type: getFContrat('tns:DonneesTechniques', 'tns:TypeCompteur'),
      annualConsumption: getFCadran('tns:ConsommationAnnuelle'),
      peakHours: getFCadran('tns:DonneesTechniques', 'tns:HorrairesHC')
    }
  }

  const releveElem = getFContrat('tns:Releve')
  if (releveElem) {
    const statement = {}

    const releveMapping = {
      prochaineReleve: 'tns:ProchaineDateReleveReelle',
      saisieReleveConfiance: 'tns:SaisieRC',
      dateFermetureReleveConfiance: 'tns:DateFermetureRC',
      prochaineDateOuvertureReleveConfiance: 'tns:ProchaineDateOuvertureRC',
      prochaineDateFermetureReleveConfiance: 'tns:ProchaineDateFermetureRC',
      prochaineDateFermetureReelle: 'tns:ProchaineDateFermetureReelle',
      saisieSuiviConso: 'tns:SaisieSC',
      prochaineDateOuvertureSaisieConso: 'tns:ProchaineDateOuvertureSC'
    }

    for (const key of Object.keys(releveMapping)) {
      statement[key] = getF(releveElem, releveMapping[key])
    }

    contract.statement = statement
  }

  let services
  contract.services = []
  if (contratElem['tns:ServicesSouscrits']) {
    services = contratElem['tns:ServicesSouscrits'].map(serviceElem => {
      return {
        nom: getF(serviceElem, 'tns:NomService'),
        activ: getF(serviceElem, 'tns:Etat')
      }
    })
    contract.services = contract.services.concat(services)
  }

  if (accordObj['tns:ServicesSouscrits']) {
    services = accordObj['tns:ServicesSouscrits'].map(serviceElem => {
      return {
        nom: getF(serviceElem, 'tns:nomService'),
        // TODO : to UTC
        start: getF(serviceElem, 'tns:dateSouscription'),
        activ: getF(serviceElem, 'tns:statut')
      }
    })

    contract.services = contract.services.concat(services)
  }

  return { contract, client }
}

function parseAddr (addrElem) {
  // Put address in cozy-contact like format, two lines :
  // First: Postbox, appartment and street adress on first
  // Second: Locality, region, postcode, country
  const getFAddr = getF.bind(null, addrElem)

  if (addrElem) {
    const numRue = getFAddr('tns:NumRue') || ''
    const nomRue = getFAddr('tns:NomRue') || ''
    const codePostal = getFAddr('tns:CodePostal') || ''
    const ville = getFAddr('tns:Ville') || ''

    return {
      street: `${numRue} ${nomRue}`,
      city: ville,
      postcode: codePostal,
      country: 'FRANCE',
      formated: `${numRue} ${nomRue}\n${codePostal} ${ville}`
    }
  }
}

function parseClientName (identiteElem) {
  // name in cozy-contact like format !
  const getFIdentite = getF.bind(null, identiteElem)
  const civilite = getFIdentite('tns:Civilite') || ''
  const nom = getFIdentite('tns:Nom') || ''
  const prenom = getFIdentite('tns:Prenom') || ''
  return {
    prefix: civilite,
    family: nom,
    given: prenom,
    formated: `${prenom} ${nom}`
  }
}

function parseClient (resBody) {
  const client = {
    vendor: 'EDF',
    docTypeVersion: K.docTypeVersion
  }

  const bpObject = getF(resBody, 'tns:BP')

  // numeroAcc and numeroBD are mandatory.
  client.numeroAcc = getF(resBody, 'tns:Numero')
  client.clientId = getF(bpObject, 'tns:Numero')
  client.address = parseAddr(getF(resBody, 'tns:Adresse'))
  client.name = parseClientName(getF(bpObject, 'tns:Identite'))

  const coTitulaireElem = getF(bpObject, 'tns:IdentitePart')
  if (coTitulaireElem) {
    const coHolder = {
      family: getF(coTitulaireElem, 'tns:NomCoTitulaire'),
      given: getF(coTitulaireElem, 'tns:PrenomCoTitulaire')
    }

    coHolder.formated = `${coHolder.given} ${coHolder.family}`
    client.coHolder = coHolder
  }

  client.email = getF(bpObject, 'tns:Coordonnees', 'tns:Email')
  client.cellPhone = getF(bpObject, 'tns:Coordonnees', 'tns:NumTelMobile')
  return client
}

var getEdelia = (accessToken, path, callback) =>
  request.get(
    `https://api.edelia.fr/authorization-proxy/api/v1/${path}`,
    {
      auth: {
        bearer: accessToken
      },
      json: true
    },
    callback
  )
