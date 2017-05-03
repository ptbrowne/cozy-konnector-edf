const xml2js = require("xml2js");
const request = require("request");
const async = require("async");
const moment = require("moment");

const updateOrCreate = require("./lib/update_or_create");
// TODO localization = require '../lib/localization_manager'
const konnectorLibs = require("cozy-konnector-libs");
const { fetcher, filterExisting } = konnectorLibs;
const BaseKonnector = konnectorLibs.baseKonnector;

const saveDataAndFile = require("./lib/save_data_and_file");
const Bill = konnectorLibs.models.bill;

const Client = require("./models/client");
const Contract = require("./models/contract");
const PaymentTerms = require("./models/payment_terms");
const ConsumptionStatement = require("./models/consumption_statement");
const Home = require("./models/home");

const parser = new xml2js.Parser();
const builder = new xml2js.Builder({ headless: true });

const logger = require("printit")({
  prefix: "EDF",
  date: true
});

const DOMAIN = "https://ws-mobile-particuliers.edf.com";
// Requests

let getEDFToken = function(requiredFields, entries, data, callback) {
  K.logger.info("getEDFToken");
  let path = "/ws/authentifierUnClientParticulier_rest_V3-0/invoke";
  let body = {
    "tns:msgRequete": {
      $: {
        "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
        "xmlns:tns": "http://www.edf.fr/commerce/passerelle/pas001/authentifierUnClientParticulier/service/v3",
        "xsi:schemaLocation": "http://www.edf.fr/commerce/passerelle/pas001/authentifierUnClientParticulier/service/v3 authentifierUnClientParticulier.xsd"
      },
      "tns:enteteEntree": [{ "tns:idCanal": 5 }],
      "tns:corpsEntree": [
        {
          "tns:idAppelant": requiredFields.email,
          "tns:password": requiredFields.password
        }
      ]
    }
  };

  return edfRequestPost(path, body, function(err, result) {
    if (err) {
      return callback(err);
    }

    let errorCode = getF(
      result["tns:msgReponse"],
      "tns:enteteSortie",
      "ent:codeRetour"
    );
    if (errorCode && errorCode !== "0000") {
      K.logger.error(getF(result, "tns:enteteSortie", "ent:libelleRetour "));
    }

    let token = getF(result["tns:msgReponse"], "tns:corpsSortie", "tns:jeton");

    if (token != null) {
      K.logger.info("EDF token fetched");
      data.edfToken = token;
      return callback();
    } else {
      K.logger.error("Can't fetch EDF token");
      return callback("token not found");
    }
  });
};

let fetchListerContratClientParticulier = function(
  reqFields,
  entries,
  data,
  callback
) {
  K.logger.info("fetch listerContratClientParticulier");

  let path = "/ws/listerContratClientParticulier_rest_V3-0/invoke";
  let body = {
    "tns:msgRequete": {
      $: {
        "xmlns:tns": "http://www.edf.fr/commerce/passerelle/pas072/listerContratClientParticulier/service/v3",
        "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
        "xsi:schemaLocation": "http://www.edf.fr/commerce/passerelle/pas072/listerContratClientParticulier/service/v3 listerContratClientParticulier_rest_V3-0.xsd "
      },
      "tns:EnteteEntree": { "tns:Jeton": data.edfToken },
      "tns:CorpsEntree": { "tns:SynchroniserSI": true }
    }
  };

  return edfRequestPost(path, body, function(err, result) {
    if (err) {
      return callback(err);
    }
    try {
      let errorCode = getF(
        result["tns:msgReponse"],
        "tns:EnteteSortie",
        "tns:CodeErreur"
      );
      if (errorCode && errorCode !== "PSC0000") {
        K.logger.error(
          getF(
            result["tns:mgsReponse"],
            "tns:EnteteSortie",
            "tns:LibelleErreur"
          )
        );

        return callback("request error");
      }

      let client = {
        vendor: "EDF",
        docTypeVersion: K.docTypeVersion
      };

      let resBody = getF(
        result["tns:msgReponse"],
        "tns:CorpsSortie",
        "tns:AccordCo"
      );

      // numeroAcc and numeroBD are mandatory.
      client.numeroAcc = getF(resBody, "tns:Numero");

      let bpObject = getF(resBody, "tns:BP");
      client.clientId = getF(bpObject, "tns:Numero");

      // Put address in cozy-contact like format, two lines :
      // First: Postbox, appartment and street adress on first
      // Second: Locality, region, postcode, country
      let addressObject = getF(resBody, "tns:Adresse");
      if (addressObject) {
        let numRue = getF(addressObject, "tns:NumRue") || "";
        let nomRue = getF(addressObject, "tns:NomRue") || "";
        let codePostal = getF(addressObject, "tns:CodePostal") || "";
        let ville = getF(addressObject, "tns:Ville") || "";

        client.address = {
          street: `${numRue} ${nomRue}`,
          city: ville,
          postcode: codePostal,
          country: "FRANCE",
          formated: `${numRue} ${nomRue}\n${codePostal} ${ville}`
        };
      }

      // name in cozy-contact like format !
      let identiteObj = getF(bpObject, "tns:Identite");
      let civilite = getF(identiteObj, "tns:Civilite") || "";
      let nom = getF(identiteObj, "tns:Nom") || "";
      let prenom = getF(identiteObj, "tns:Prenom") || "";
      client.name = {
        prefix: civilite,
        family: nom,
        given: prenom,
        formated: `${prenom} ${nom}`
      };

      let coTitulaireElem = getF(bpObject, "tns:IdentitePart");
      if (coTitulaireElem) {
        let coHolder = {
          family: getF(coTitulaireElem, "tns:NomCoTitulaire"),
          given: getF(coTitulaireElem, "tns:PrenomCoTitulaire")
        };

        coHolder.formated = `${coHolder.given} ${coHolder.family}`;
        client.coHolder = coHolder;
      }

      client.email = getF(bpObject, "tns:Coordonnees", "tns:Email");
      client.cellPhone = getF(bpObject, "tns:Coordonnees", "tns:NumTelMobile");

      // Contracts
      let contratElems = resBody["tns:Contrat"];

      let contracts = contratElems.map(function(contratElem) {
        let services;
        let contract = {
          vendor: "EDF",
          clientId: client.clientId,
          docTypeVersion: K.docTypeVersion
        };

        contract.number = getF(contratElem, "tns:Numero");
        contract.pdl = getF(contratElem, "tns:NumeroPDL");
        let vieContratObj = getF(contratElem, "tns:VieDuContrat");
        contract.start = getF(vieContratObj, "tns:DateDebut");
        contract.status = getF(vieContratObj, "tns:Statut");

        contract.end = getF(vieContratObj, "tns:DateFin");
        contract.terminationGrounds = getF(
          vieContratObj,
          "tns:MotifResiliation"
        );

        let offreSouscriteObj = getF(contratElem, "tns:OffreSouscrite");

        contract.energie = translate(
          {
            ELECTRICITE: "Électricité",
            GAZ: "Gaz"
          },
          getF(offreSouscriteObj, "tns:Energie")
        );

        contract.name = translate(
          {
            GN_2: "Offre Gaz naturel",
            MCGN_2: "Mon Contrat gaz naturel",
            MCGN_PRIX_FIXE_1: "Mon Contrat Gaz Naturel a prix fixe",
            ELECTRICITE_PRO: "Electricite Pro",
            ELEC_DEREGULE: "Mon Contrat Electricite",
            ELEC_PRO_PX_FIXE_1: "Electricite Pro a Prix Fixe",
            ESSENTIEL_PRO: "Essentiel Pro",
            OFFRE_HC_SOUPLES: "Heures Creuses Souples",
            PRESENCE_PRO: "Presence Pro",
            SOUPLESSE_PRO: "Souplesse Pro",
            TARIF_BLEU: "Tarif Bleu",
            TARIF_BLEU_PART: "Tarif Bleu",
            ESSENTIEL_GAZ: "Essentiel Gaz",
            GAZ: "Mon Contrat Gaz Naturel",
            GAZ_2: "Mon Contrat Gaz Naturel",
            GAZ_NAT_PX_FIXE_1: "Gaz Naturel a Prix Fixe",
            PRESENCE_GAZ: "Presence Gaz",
            SOUPLESSE_GAZ: "Souplesse Gaz",
            TARIF_BLEU_GAZ: "Gaz Naturel",
            TARIF_EJP_PART: "EJP",
            OFFRE_TPN: "TPN"
          },
          getF(offreSouscriteObj, "tns:NomOffre")
        );

        contract.troubleshootingPhone = getF(
          offreSouscriteObj,
          "tns:NumeroDepannageContrat"
        );

        switch (contract.energie) {
          case "Électricité":
            contract.power = translate(
              {
                PUI00: "0 kVA",
                PUI03: "3 kVA",
                PUI06: "6 kVA",
                PUI09: "9 kVA",
                PUI12: "12 kVA",
                PUI15: "15 kVA",
                PUI18: "18 kVA",
                PUI24: "24 kVA",
                PUI30: "30 kVA",
                PUI36: "36 kVA"
              },
              getF(offreSouscriteObj, "tns:Puissance")
            );
            contract.contractSubcategory1 = getF(
              offreSouscriteObj,
              "tns:StructureTarifaire"
            );
            break;

          case "Gaz":
            contract.contractSubcategory2 = getF(
              offreSouscriteObj,
              "tns:OptionPrix"
            );
            break;
        }

        let cadranElem = getF(contratElem, "tns:ListeCadran");
        if (cadranElem) {
          let counter = {};
          counter.comptage = getF(cadranElem, "tns:Type");
          counter.nombreRoues = getF(cadranElem, "tns:NombreRoues");
          counter.dernierIndex = getF(cadranElem, "tns:DernierIndex");

          counter.type = getF(
            contratElem,
            "tns:DonneesTechniques",
            "tns:TypeCompteur"
          );

          contract.counter = counter;

          contract.annualConsumption = getF(
            cadranElem,
            "tns:ConsommationAnnuelle"
          );
        }

        contract.peakHours = getF(
          contratElem,
          "tns:DonneesTechniques",
          "tns:HorrairesHC"
        );

        let releveElem = getF(contratElem, "tns:Releve");

        if (releveElem) {
          let statement = {};
          statement.prochaineReleve = getF(
            releveElem,
            "tns:ProchaineDateReleveReelle"
          );
          statement.saisieReleveConfiance = getF(releveElem, "tns:SaisieRC");
          statement.dateFermetureReleveConfiance = getF(
            releveElem,
            "tns:DateFermetureRC"
          );
          statement.prochaineDateOuvertureReleveConfiance = getF(
            releveElem,
            "tns:ProchaineDateOuvertureRC"
          );
          statement.prochaineDateFermetureReleveConfiance = getF(
            releveElem,
            "tns:ProchaineDateFermetureRC"
          );
          statement.prochaineDateFermetureReelle = getF(
            releveElem,
            "tns:ProchaineDateFermetureReelle"
          );
          statement.saisieSuiviConso = getF(releveElem, "tns:SaisieSC");
          statement.prochaineDateOuvertureSaisieConso = getF(
            releveElem,
            "tns:ProchaineDateOuvertureSC"
          );

          contract.statement = statement;
        }

        contract.services = [];
        if (contratElem["tns:ServicesSouscrits"]) {
          services = contratElem["tns:ServicesSouscrits"].map(function(
            serviceElem
          ) {
            let service = {
              nom: getF(serviceElem, "tns:NomService"),
              activ: getF(serviceElem, "tns:Etat")
            };
            return service;
          });
          contract.services = contract.services.concat(services);
        }

        if (resBody["tns:ServicesSouscrits"]) {
          services = resBody["tns:ServicesSouscrits"].map(function(
            serviceElem
          ) {
            let service = {
              nom: getF(serviceElem, "tns:nomService"),
              // TODO : to UTC
              start: getF(serviceElem, "tns:dateSouscription"),
              activ: getF(serviceElem, "tns:statut")
            };
            return service;
          });

          contract.services = contract.services.concat(services);
        }

        return contract;
      });

      K.logger.info("Fetched listerContratClientParticulier");
      entries.clients.push(client);
      entries.contracts = contracts;

      return callback();
    } catch (e) {
      K.logger.error("While fetching listerContratClientParticulier", e);
      return callback(e);
    }
  });
};

let fetchVisualiserPartenaire = function(
  requiredFields,
  entries,
  data,
  callback
) {
  K.logger.info("fetchVisualiserPartenaire");

  let path = "/ws/visualiserPartenaire_rest_V2-0/invoke";
  let body = {
    msgRequete: {
      $: {
        "xsi:schemaLocation": "http://www.edf.fr/commerce/passerelle/" +
          "css/visualiserPartenaire/service/v2 C:\\HMN\\EDFMoiV2\\WSDL" +
          "\\passerelle\\passerelle\\css\\visualiserPartenaire\\service" +
          "\\v2\\visualiserPartenaire.xsd",
        xmlns: "http://www.edf.fr/commerce/passerelle/css/" +
          "visualiserPartenaire/service/v2",
        "xmlns:ent": "http://www.edf.fr/commerce/passerelle/commun/" +
          "v2/entete",
        "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance"
      },

      enteteEntree: {
        "ent:jeton": data.edfToken
      },

      corpsEntree: {
        numeroBp: entries.clients[0].clientId
      }
    }
  };

  return edfRequestPost(path, body, function(err, result) {
    if (err) {
      return callback(err);
    }
    try {
      let errorCode = getF(result, "ns:enteteSortie", "ent:codeRetour");
      if (errorCode && errorCode !== "0") {
        K.logger.error(getF(result, "tns:enteteSortie", "tns:libelleRetour"));

        return callback(); // Continue on error.
      }

      let partnerElem = getF(
        result["ns:msgReponse"],
        "ns:corpsSortie",
        "ns:partenaire"
      );
      let client = {};
      let coordonneesElem = getF(partnerElem, "ns:coordonnees");
      client.cellPhone = getF(coordonneesElem, "ns:NumTelMobile");
      client.homePhone = getF(coordonneesElem, "ns:NumTelFixe");
      client.email = getF(coordonneesElem, "ns:Email");
      client.loginEmail = getF(coordonneesElem, "ns:EmailAEL");

      let contactElem = getF(partnerElem, "ns:centreContact");
      let contact = {};
      contact.title = getF(contactElem, "ns:gsr");
      contact.phone = getF(contactElem, "ns:telephone");

      let addressElem = getF(contactElem, "ns:adresse");
      if (addressElem) {
        let address = {};
        address.street = getF(addressElem, "ns:nomRue");
        address.postcode = getF(addressElem, "ns:codePostal");
        address.city = getF(addressElem, "ns:ville");
        address.formated =
          `${address.street}` + `\n${address.postcode} ${address.city}`;
        contact.address = address;
      }

      client.commercialContact = contact;

      entries.clients[0] = _extend(entries.clients[0], client);

      K.logger.info("Fetched visualiserPartenaire.");
      return callback();
    } catch (e) {
      K.logger.error("While fetching visualiserPartenaire.");
      K.logger.error(e);
      return callback(e);
    }
  });
};

let fetchVisualiserAccordCommercial = function(
  requiredFields,
  entries,
  data,
  callback
) {
  K.logger.info("fetchVisualiserAccordCommercial");

  let path = "/ws/visualiserAccordCommercial_rest_sso_V3-0/invoke";
  let body = {
    visualiserAccordCommercialRequest: {
      $: {
        xmlns: "http://www.edf.fr/psc/0122/v3/visualiserAccordCommercial",
        "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
        "xsi:schemaLocation": "http://www.edf.fr/psc/0122/v3/visualiserAccordCommercial visualiserAccordCommercial.xsd"
      },
      jeton: data.edfToken,
      numeroBp: entries.clients[0].clientId,
      numeroAcc: entries.clients[0].numeroAcc,
      applicationAppelante: "EDFETMOI"
    }
  };

  return edfRequestPost(path, body, function(err, result) {
    if (err) {
      return callback(err);
    }
    try {
      let errorCode = getF(
        result["tns:visualiserAccordCommercialResponse"],
        "tns:responseWebService",
        "tns:CodeEtatService"
      );
      if (errorCode && errorCode !== "PSC0000") {
        K.logger.error(
          getF(
            result["tns:visualiserAccordCommercialResponse"],
            "tns:responseWebService",
            "tns:LibelleEtatService"
          )
        );

        return callback(); // Continue on error.
      }

      let acoElem = getF(
        result["tns:visualiserAccordCommercialResponse"],
        "tns:responseWebService",
        "tns:listeAccordsCommerciaux",
        "tns:item"
      );

      let paymentTerms = {
        vendor: "EDF",
        clientId: entries.clients[0].clientId,
        docTypeVersion: K.docTypeVersion
      };

      let bankDetails = {
        iban: getF(acoElem, "tns:banque", "tns:iban"),
        holder: getF(acoElem, "tns:compte", "tns:titulaire"),
        bank: getF(acoElem, "tns:banque", "tns:nom")
      };

      let bankAddress = {
        street: getF(acoElem, "tns:banque", "tns:numNomRue"),
        city: getF(acoElem, "tns:banque", "tns:codePostalVille"),
        // postcode ?
        country: getF(acoElem, "tns:banque", "tns:pays")
      };

      bankAddress.formated =
        `${bankAddress.street}` +
        `\n${bankAddress.city} ${bankAddress.country}`;

      bankDetails.bankAddress = bankAddress;
      paymentTerms.encryptedBankDetails = JSON.stringify(bankDetails);

      paymentTerms.balance = getF(acoElem, "tns:detail", "tns:solde");
      paymentTerms.paymentMeans = getF(
        acoElem,
        "tns:detail",
        "tns:modeEncaissement"
      );
      paymentTerms.modifBankDetailsAllowed = getF(
        acoElem,
        "tns:detail",
        "tns:modifIBANAutorisee"
      );
      //accountNumber: getF acoElem, 'ns:detail', 'ns:numeroEtendu'
      paymentTerms.dernierReglement = {
        date: getF(acoElem, "tns:dernierReglement", "tns:date"),
        amount: getF(acoElem, "tns:dernierReglement", "tns:montant"),
        type: getF(acoElem, "tns:dernierReglement", "tns:type")
      };
      paymentTerms.billFrequency = getF(
        acoElem,
        "tns:facturation",
        "tns:periodicite"
      );
      paymentTerms.nextBillDate = getF(acoElem);

      paymentTerms.idPayer = getF(acoElem, "tns:numeroPayeur");
      paymentTerms.payerDivergent = getF(acoElem, "tns:payeurDivergent");
      // paymentTerms.mensuSansSurprise = getF acoElem, 'tns:mensuSansSurprise'

      let servicesElem = getF(acoElem, "tns:services")["tns:item"];
      let services = servicesElem.map(function(serviceElem) {
        let service = {};
        service.name = getF(serviceElem, "tns:nomService");
        service.status = getF(serviceElem, "tns:etat");
        service.valueSubscribed = getF(serviceElem, "tns:valeurSouscrite");
        service.valuesAvailable = serviceElem["tns:valeursPossibles"];

        return service;
      });

      entries.paymenttermss.push(paymentTerms);
      entries.contracts.forEach(
        contract => (contract.services = contract.services.concat(services))
      );

      K.logger.info("Fetched visualiserAccordCommercial.");
      return callback();
    } catch (e) {
      K.logger.error("While fetching visualiserAccordCommercial.");
      K.logger.error(e);
      return callback(e);
    }
  });
};

let fetchVisualiserCalendrierPaiement = function(
  requiredFields,
  entries,
  data,
  callback
) {
  K.logger.info("fetchVisualiserCalendrierPaiement");
  let path = "/ws/visualiserCalendrierPaiement_rest_V2-0/invoke";
  let body = {
    "message:msgRequete": {
      $: {
        "xsi:schemaLocation": "http://www.edf.fr/commerce/passerelle/" +
          "css/visualiserCalendrierPaiement/service/v2 C:\\HMN\\" +
          "EDFMoiV2\\WSDL\\passerelle\\passerelle\\css\\" +
          "visualiserCalendrierPaiement\\service\\v2\\" +
          "visualiserCalendrierPaiement.xsd",
        "xmlns:message": "http://www.edf.fr/commerce/passerelle/css/" +
          "visualiserCalendrierPaiement/service/v2",
        "xmlns:ent": "http://www.edf.fr/commerce/passerelle/commun/" +
          "v2/entete",
        "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance"
      },

      "message:enteteEntree": {
        "ent:jeton": data.edfToken
      },

      "message:corpsEntree": {
        "message:numeroBp": entries.clients[0].clientId,
        "message:numeroAcc": entries.clients[0].numeroAcc
      }
    }
  };

  return edfRequestPost(path, body, function(err, result) {
    if (err) {
      return callback(err);
    }
    try {
      // Does API send an error ?
      let errorCode = getF(
        result,
        "ns:msgReponse",
        "ns:enteteSortie",
        "ent:codeRetour"
      );
      if (errorCode && errorCode !== "0") {
        K.logger.error(
          getF(result, "ns:msgReponse", "ns:enteteSortie", "ent:libelleRetour")
        );
        return callback(); // Continue, whitout error.
      }

      let listeEcheances = getF(
        result["ns:msgReponse"],
        "ns:corpsSortie",
        "ns:calendrierDePaiement"
      );

      if (
        !(listeEcheances &&
          listeEcheances["ns:listeEcheances"] &&
          listeEcheances["ns:listeEcheances"].length > 0)
      ) {
        K.logger.warn("No payment schedules");
        return callback(); // Continue whithout errors.
      }

      listeEcheances = listeEcheances["ns:listeEcheances"];

      // TODO : if no gaz and elec !?
      let paymentSchedules = listeEcheances.map(function(echeance) {
        let amountGaz = parseFloat(getF(echeance, "ns:montantGaz"));
        let amountElec = parseFloat(getF(echeance, "ns:montantElec"));

        if (isNaN(amountGaz)) {
          amountGaz = 0;
        }
        if (isNaN(amountElec)) {
          amountElec = 0;
        }

        let doc = {
          number: parseInt(getF(echeance, "ns:numeroEcheance")),
          receiptDate: getF(echeance, "ns:dateEncaissement"),
          scheduleDate: getF(echeance, "ns:DateEcheance"),
          paid: getF(echeance, "ns:paiement") === "EFFECTUE",
          amount: amountGaz + amountElec,
          amountGas: amountGaz,
          amountElectricity: amountElec
        };
        return doc;
      });

      if (!entries.paymenttermss[0]) {
        entries.paymenttermss[0] = {
          vendor: "EDF",
          clientId: entries.clients[0].clientId,
          docTypeVersion: K.docTypeVersion
        };
      }

      entries.paymenttermss[0].paymentSchedules = paymentSchedules;
      K.logger.info(
        `Fetched ${paymentSchedules.length} ` +
          "from fetchVisualiserCalendrierPaiement"
      );
      return callback();
    } catch (e) {
      K.logger.error("While fetchVisualiserCalendrierPaiement");
      K.logger.error(e);
      return callback(e);
    }
  });
};

let fetchVisualiserFacture = function(reqFields, entries, data, callback) {
  K.logger.info("fetchVisualiserFacture");
  let path = "/ws/visualiserFacture_rest_V3-0/invoke";
  let body = {
    "tns:msgRequete": {
      $: {
        "xmlns:tns": "http://www.edf.fr/commerce/passerelle/pas023/visualiserFacture/service/v2"
      },
      visualiserFactureRequest: {
        numeroBp: entries.clients[0].clientId,
        jeton: data.edfToken,
        numeroAcc: entries.clients[0].numeroAcc,
        dateRecherche: "1900-01-01"
      }
    }
  };

  return edfRequestPost(path, body, function(err, result) {
    if (err) {
      return callback(err);
    }

    let bills = [];
    try {
      let errorCode = getF(
        result["tns:msgReponse"],
        "visualiserFactureResponse",
        "responseWebService",
        "codeErreur"
      );
      if (errorCode && errorCode !== "0") {
        K.logger.error(
          getF(
            result["tns:msgReponse"],
            "visualiserFactureResponse",
            "responseWebService",
            "libelleErreur"
          )
        );
        return callback(); // Continue, whitout error.
      }

      let documents = getF(
        result["tns:msgReponse"],
        "visualiserFactureResponse",
        "responseWebService",
        "listeFactures"
      )["item"];

      bills = documents.map(function(elem) {
        let details = getF(elem, "resume");
        let bill = {
          vendor: "EDF",
          clientId: entries.clients[0].clientId,
          title: getF(details, "type"),
          number: getF(elem, "numeroFacture"),
          date: moment(getF(details, "dateEmission"), "YYYY-MM-DD"),
          paymentDueDate: getF(details, "dateEcheance"),
          scheduledPaymentDate: getF(details, "datePrelevement"),
          totalPaymentDue: getF(details, "montantFactureFraiche"),
          value: getF(details, "montantReclame"),
          balanceBeforeInvoice: getF(details, "soldeAvantFacture"),

          // TODO: hack to force download, bad because duplicate URL !
          pdfurl: DOMAIN +
            "/ws/recupererDocumentContractuelGet_rest_V1-0/invoke",
          docTypeVersion: K.docTypeVersion
        };

        return bill;
      });

      entries.fetched = bills;
      K.logger.info(`Fetched ${bills.length} bills`);
      return callback();
    } catch (e) {
      K.logger.error("While fetchVisualiserFacture");
      K.logger.error(e);
      return callback(e);
    }
  });
};

let fetchVisualiserHistoConso = function(
  requiredFields,
  entries,
  data,
  callback
) {
  K.logger.info("fetchVisualiserHistoConso");
  return async.mapSeries(
    entries.contracts,
    function(contract, cb) {
      let path = "/ws/visualiserHistoConso_rest_V3-0/invoke";
      let body = {
        "message:msgRequete": {
          $: {
            "xsi:schemaLocation": "http://www.edf.fr/commerce/" +
              "passerelle/css/visualiserHistoConso/service/v2 C:\\HMN" +
              "\\EDFMoiV2\\WSDL\\passerelle\\passerelle\\css" +
              "\\visualiserHistoConso\\service\\v2\\" +
              "visualiserHistoConso.xsd",
            "xmlns:message": "http://www.edf.fr/commerce/passerelle/" +
              "css/visualiserHistoConso/service/v2",
            "xmlns:ent": "http://www.edf.fr/commerce/passerelle/" +
              "commun/v2/entete",
            "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance"
          },

          "message:enteteEntree": {
            "ent:jeton": data.edfToken
          },

          "message:corpsEntree": {
            "message:numeroBp": entries.clients[0].clientId,
            "message:numeroContrat": contract.number
          }
        }
      };

      return edfRequestPost(path, body, function(err, result) {
        if (err) {
          return callback(err);
        }
        try {
          let errorCode = getF(result, "ns:enteteSortie", "ent:codeRetour");
          if (errorCode && errorCode !== "0") {
            K.logger.error(
              getF(result, "tns:enteteSortie", "tns:libelleRetour")
            );
            // Continue on error.
            return callback();
          }

          if (!("ns:corpsSortie" in result["ns:msgReponse"])) {
            K.logger.info("No histoConsos to fetch");
            return callback(null, []);
          }

          let consoElems =
            result["ns:msgReponse"]["ns:corpsSortie"][0][
              "ns:listeHistoDeConso"
            ];

          let res = consoElems.map(function(consoElem) {
            let doc = {
              contractNumber: contract.number,
              billNumber: getF(consoElem, "ns:numeroFacture"),
              start: getF(consoElem, "ns:dateDebut"),
              end: getF(consoElem, "ns:dateFin"),
              value: getF(consoElem, "ns:listeConsommation", "ns:valeur"),
              // unit: getF conso, 'ns:listeConsommation', 'ns:cadran'
              statementType: getF(consoElem, "ns:typeReleve"),
              statementCategory: getF(consoElem, "ns:categorieReleve"),
              statementReason: getF(consoElem, "ns:motifReleve"),
              docTypeVersion: K.docTypeVersion
            };

            return doc;
          });

          return cb(null, res);
        } catch (e) {
          K.logger.error("While fetching visualiserHistoConso.");
          K.logger.error(e);
          return cb(e);
        }
      });
    },
    function(err, results) {
      if (err) {
        return callback(err);
      }

      entries.consumptionstatements = results.reduce(
        (agg, result) => agg.concat(result),
        []
      );

      K.logger.info(
        `Fetched ${entries.consumptionstatements.length}` +
          " consumptionStatements"
      );
      return callback();
    }
  );
};

let saveBills = function(requiredFields, entries, data, callback) {
  let options = {};
  options.vendor = "edf";

  options.requestoptions = function(bill) {
    let path = "/ws/recupererDocumentContractuelGet_rest_V1-0/invoke";
    let body = {
      "dico:getRequest": {
        $: {
          "xmlns:dico": "http://www.edf.fr/psc/pscma100/recupererDocumentContractuel/service/v1",
          "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
          "xsi:schemaLocation": "http://www.edf.fr/psc/pscma100/recupererDocumentContractuel/service/v1 recupererDocumentContractuel.xsd"
        },
        getRequest: {
          options: [
            { cle: "id", valeur: "pscedfmoi" },
            { cle: 2, valeur: entries.clients[0].clientId },
            { cle: 4, valeur: bill.number },
            { cle: 6, valeur: "Facture" }
          ]
        },
        numeroBp: entries.clients[0].clientId,
        jeton: data.edfToken
      }
    };

    return _edfRequestOptions(path, body);
  };

  options.parseoptions = data =>
    new Promise(function(resolve, reject) {
      return parser.parseString(data, function(err, result) {
        if (err) {
          return reject("request error");
        }

        let base64PDF = getF(
          result["rdc:getResponse"],
          "getResponse",
          "docubase",
          "documentPDF",
          "pdf"
        );
        return resolve({ data: base64PDF, contentType: "application/pdf" });
      });
    });

  return saveDataAndFile(logger, Bill, options, ["EDF"])(
    requiredFields,
    entries,
    data,
    callback
  );
};

//#
// Edelia
//#

let fetchEdeliaToken = function(requiredFields, entries, data, callback) {
  K.logger.info("fetchEdeliaToken");
  return request.post(
    "https://api.edelia.fr/authorization-server/oauth/token",
    {
      form: {
        client_id: "sha1pae0Pahngee6uwiphooDie7thaiquahf2xohd6IeFeiphi9ziu0uw3am",
        grant_type: "edf_sso",
        jeton_sso: data.edfToken,
        bp: entries.clients[0].clientId,
        pdl: data.contract.pdl
      },
      json: true
    },
    function(err, response, result) {
      if (err) {
        K.logger.error("While fetching edelia token.");
        K.logger.error(err);
        return callback(err);
      }

      K.logger.info("Fetched edelia token");
      data.edeliaToken = result.access_token;
      return callback();
    }
  );
};

let fetchEdeliaProfile = function(requiredFields, entries, data, callback) {
  K.logger.info("fetchEdeliaProfile");
  return getEdelia(
    data.edeliaToken,
    "/sites/-/profiles/simple?ts=" + new Date().toISOString(),
    function(err, response, obj) {
      let error = null;
      try {
        if (!err && !obj) {
          err = "no import performed";
        }

        if (err) {
          K.logger.error("While fetchEdeliaProfile");
          K.logger.error(err);
          throw err;
        }

        if (obj.errorCode && obj.errorCode === "403") {
          data.noEdelia = true;
          K.logger.warn(`No edelia: ${obj.errorDescription}`);
          throw new Error("no edelia");
        }

        let doc = {
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
        };

        entries.homes.push(doc);
        return K.logger.info("Fetched fetchEdeliaProfile");
      } catch (e) {
        return (error = e);
      } finally {
        callback(error);
      }
    }
  );
};

//#
// Edelia electricite
//#

let fetchEdeliaMonthlyElecConsumptions = function(
  requiredFields,
  entries,
  data,
  callback
) {
  if (data.noEdelia) {
    return callback();
  }

  K.logger.info("fetchEdeliaMonthlyElecConsumptions");
  return getEdelia(
    data.edeliaToken,
    "/sites/-/monthly-elec-consumptions?" +
      "begin-month=2012-01&" +
      `end-month=${moment().add(1, "month").format("YYYY-MM")}&ended=false`,
    function(err, response, obj) {
      let error = null;
      try {
        if (response.statusCode === 404 || response.statusCode === 500) {
          K.logger.warn("No EdeliaMonthlyElecConsumptions");
          data.noElec = true;
          throw null;
        }

        if (err) {
          K.logger.error("Wihle fetchEdeliaMonthlyElecConsumptions");
          K.logger.error(err);
          throw err;
        }

        let statements = [];

        data.consumptionStatementByMonth = {};

        statements = statements.concat(
          obj.monthlyElecEnergies.map(function(mee) {
            let doc = {
              docTypeVersion: K.docTypeVersion,
              contractNumber: data.contract.number,
              start: mee.beginDay,
              end: mee.endDay,
              value: mee.consumption.energy,
              statementType: "estime",
              statementCategory: "edelia",
              statementReason: "EdeliaMonthlyElecConsumption",
              period: mee.month,
              cost: mee.totalCost,
              costsByCategory: mee.consumption.costsByTariffHeading,
              valuesByCategory: mee.consumption.energiesByTariffHeading
            };

            doc.costsByCategory.standing = mee.standingCharge;
            data.consumptionStatementByMonth[mee.month] = doc;

            return doc;
          })
        );

        // Convenient structure to enhance data later.
        data.consumptionStatementByYear = {};

        statements = statements.concat(
          obj.yearlyElecEnergies.map(function(yee) {
            let doc = {
              docTypeVersion: K.docTypeVersion,
              contractNumber: data.contract.number,
              start: yee.beginDay,
              end: yee.endDay,
              value: yee.consumption.energy,
              statementType: "estime",
              statementCategory: "edelia",
              statementReason: "EdeliaYearlyElecConsumption",
              period: yee.year,
              cost: yee.totalCost,
              costsByCategory: yee.consumption.costsByTariffHeading,
              valuesByCategory: yee.consumption.energiesByTariffHeading
            };

            doc.costsByCategory.standing = yee.standingCharge;

            // Add to a convenient structure to enhance them with comparisons
            data.consumptionStatementByYear[yee.year] = doc;
            return doc;
          })
        );

        if (statements.length !== 0) {
          entries.consumptionstatements = entries.consumptionstatements.concat(
            statements
          );
        }

        return K.logger.info("Fetched fetchEdeliaMonthlyElecConsumptions");
      } catch (e) {
        return (error = e);
      } finally {
        callback(error);
      }
    }
  );
};

let fetchEdeliaSimilarHomeYearlyElecComparisions = function(
  requiredFields,
  entries,
  data,
  callback
) {
  if (data.noEdelia || data.noElec) {
    return callback();
  }

  K.logger.info("fetchEdeliaSimilarHomeYearlyElecComparisions");
  return getEdelia(
    data.edeliaToken,
    "/sites/-/similar-home-yearly-elec-comparisons?begin-year=2012",
    function(err, response, objs) {
      let error = null;
      try {
        if (response.statusCode === 404 || response.statusCode === 500) {
          K.logger.warn("No EdeliaSimilarHomeYearlyElecComparisions");
          data.noElec = true;
          throw null;
        }
        if (err) {
          K.logger.error("While fetchEdeliaSimilarHomeYearlyElecComparisions");
          K.logger.error(err);
          throw err;
        }

        objs.forEach(function(obj) {
          let statement = data.consumptionStatementByYear[obj.year];
          if (!statement) {
            K.logger.warn(`No yearly statement for ${obj.date.year}`);
            return;
          }
          return (statement.similarHomes = {
            site: obj.energies.site,
            average: obj.energies.similarHomes.SH_AVERAGE_CONSUMING,
            least: obj.energies.similarHomes.SH_LEAST_CONSUMING
          });
        });

        K.logger.info("Fetched fetchEdeliaSimilarHomeYearlyElecComparisions");
      } catch (e) {
        error = e;
      }

      delete data.consumptionStatementByYear;
      return callback(error);
    }
  );
};

let fetchEdeliaElecIndexes = function(requiredFields, entries, data, callback) {
  if (data.noEdelia || data.noElec) {
    return callback();
  }
  K.logger.info("fetchEdeliaElecIndexes");
  return getEdelia(
    data.edeliaToken,
    "/sites/-/elec-indexes?begin-date=2012-01-01&" +
      `end-date=${moment().format("YYYY-MM-DD")}&types=`,
    function(err, response, objs) {
      let error = null;
      try {
        if (response.statusCode === 404) {
          K.logger.warn("No EdeliaElecIndexes");
          throw null;
        }

        if (err) {
          K.logger.error("Wihle fetchEdeliaElecIndexes");
          K.logger.error(err);
          throw err;
        }

        objs.forEach(function(obj) {
          let statement =
            data.consumptionStatementByMonth[obj.date.slice(0, 7)];
          if (!statement) {
            K.logger.warn(
              `No monthly statement for\
${obj.date.slice(0, 7)}`
            );
            return;
          }

          statement.statements = statement.statements || [];
          return statement.statements.push(obj);
        });

        K.logger.info("Fetched fetchEdeliaElecIndexes");
      } catch (e) {
        error = e;
      }

      delete data.consumptionStatementByMonth;
      return callback(error);
    }
  );
};

//#
// Edelia Gas
//#

let fetchEdeliaMonthlyGasConsumptions = function(
  requiredFields,
  entries,
  data,
  callback
) {
  if (data.noEdelia) {
    return callback();
  }
  K.logger.info("fetchEdeliaMonthlyGasConsumptions");
  return getEdelia(
    data.edeliaToken,
    "/sites/-/monthly-gas-consumptions?begin-month=2012-01&" +
      `end-month=${moment().add(1, "month").format("YYYY-MM")}&ended=false`,
    function(err, response, obj) {
      let error = null;
      try {
        if (response.statusCode === 404) {
          K.logger.warn("No EdeliaMonthlyGasConsumptions");
          data.noGas = true;
          throw null;
        }

        if (err) {
          K.logger.error("Wihle fetchEdeliaMonthlyGasConsumptions");
          K.logger.error(err);
          throw err;
        }

        let statements = [];

        data.consumptionStatementByMonth = {};

        statements = obj.monthlyGasEnergies != null
          ? obj.monthlyGasEnergies.map(function(mee) {
              let doc = {
                docTypeVersion: K.docTypeVersion,
                contractNumber: data.contract.number,
                start: mee.beginDay,
                end: mee.endDay,
                value: mee.consumption.energy,
                statementType: "estime",
                statementCategory: "edelia",
                statementReason: "EdeliaMonthlyGasConsumption",
                period: mee.month,
                cost: mee.totalCost,
                costsByCategory: {
                  consumption: mee.consumption.cost,
                  standing: mee.standingCharge
                }
              };

              data.consumptionStatementByMonth[mee.month] = mee;
              return doc;
            })
          : undefined;

        // Convenient structure to enhance data later.
        data.consumptionStatementByYear = {};

        statements = statements.concat(
          obj.yearlyGasEnergies.map(function(yee) {
            let doc = {
              docTypeVersion: K.docTypeVersion,
              contractNumber: data.contract.number,
              start: yee.beginDay,
              end: yee.endDay,
              value: yee.consumption.energy,
              statementType: "estime",
              statementCategory: "edelia",
              statementReason: "EdeliaYearlyGasConsumption",
              period: yee.year,
              cost: yee.totalCost,
              costsByCategory: {
                consumption: yee.consumption.cost,
                standing: yee.standingCharge
              }
            };

            // Add to a convenient structure to enhance them with comparisons
            data.consumptionStatementByYear[yee.year] = doc;
            return doc;
          })
        );

        if (statements.length !== 0) {
          entries.consumptionstatements = entries.consumptionstatements.concat(
            statements
          );
        }

        K.logger.info("Fetched fetchEdeliaMonthlyGasConsumptions");
      } catch (e) {
        error = e;
      }

      return callback(error);
    }
  );
};

let fetchEdeliaSimilarHomeYearlyGasComparisions = function(
  requiredFields,
  entries,
  data,
  callback
) {
  if (data.noEdelia || data.noGas) {
    return callback();
  }

  K.logger.info("fetchEdeliaSimilarHomeYearlyGasComparisions");
  return getEdelia(
    data.edeliaToken,
    "/sites/-/similar-home-yearly-gas-comparisons?begin-year=2012",
    function(err, response, objs) {
      let error = null;
      try {
        if (response.statusCode === 404 || response.statusCode === 500) {
          K.logger.warn("No EdeliaSimilarHomeYearlyGasComparisions");
          throw null;
        }

        if (err) {
          K.logger.error("While fetchEdeliaSimilarHomeYearlyGasComparisions");
          K.logger.error(err);
          throw err;
        }

        objs.forEach(function(obj) {
          let statement = data.consumptionStatementByYear[obj.year];
          if (!statement) {
            K.logger.warn(`No yearly statement for ${obj.date.year}`);
            return;
          }

          return (statement.similarHomes = {
            site: obj.energies.site,
            average: obj.energies.similarHomes.SH_AVERAGE_CONSUMING,
            least: obj.energies.similarHomes.SH_LEAST_CONSUMING
          });
        });

        K.logger.info("Fetched fetchEdeliaSimilarHomeYearlyGasComparisions");
      } catch (e) {
        error = e;
      }

      return callback(error);
    }
  );
};

let fetchEdeliaGasIndexes = function(requiredFields, entries, data, callback) {
  if (data.noEdelia || data.noGas) {
    return callback();
  }

  K.logger.info("fetchEdeliaGasIndexes");
  return getEdelia(
    data.edeliaToken,
    "/sites/-/gas-indexes?begin-date=2012-01-01&" +
      `end-date=${moment().format("YYYY-MM-DD")}&types=`,
    function(err, response, objs) {
      let error = null;
      try {
        if (response.statusCode === 404) {
          K.logger.warn("No EdeliaGasIndexes");
          throw null;
        }

        if (err) {
          K.logger.error("Wihle fetchEdeliaGasIndexes");
          K.logger.error(err);
          throw err;
        }

        objs.forEach(function(obj) {
          let statement =
            data.consumptionStatementByMonth[obj.date.slice(0, 7)];
          if (!statement) {
            K.logger.warn(
              `No monthly statement for\
${obj.date.slice(0, 7)}`
            );
            return;
          }
          statement.statements = statement.statements || [];
          return statement.statements.push(obj);
        });

        K.logger.info("Fetched fetchEdeliaGasIndexes");
      } catch (e) {
        error = e;
      }

      return callback(error);
    }
  );
};

let prepareEntries = function(requiredFields, entries, data, next) {
  entries.homes = [];
  entries.consumptionstatements = [];
  entries.contracts = [];
  entries.fetched = [];
  entries.clients = [];
  entries.paymenttermss = [];
  return next();
};

let buildNotifContent = function(requiredFields, entries, data, next) {
  // data.updated: we don't speak about update, beacause we don't now if the
  // update actually changes the data or not.

  // Signal all add of document.
  let addedList = [];
  for (let docsName in data.created) {
    let count = data.created[docsName];
    if (count > 0) {
      let message = localization.t(`notification ${docsName}`, {
        smart_count: count
      });

      addedList.push(message);
    }
  }

  if (addedList.length > 0) {
    // avoid empty message, as join always return String
    entries.notifContent = addedList.join(", ");
  }

  return next();
};

let displayData = function(requiredFields, entries, data, next) {
  K.logger.info("display data");
  K.logger.info(JSON.stringify(entries, null, 2));
  K.logger.info(JSON.stringify(data, null, 2));

  return next();
};

let fetchEdeliaData = (requiredFields, entries, data, next) =>
  async.eachSeries(
    entries.contracts,
    function(contract, callback) {
      data.contract = contract;
      let importer = fetcher.new();
      let operations = [
        fetchEdeliaToken,
        fetchEdeliaProfile,
        fetchEdeliaMonthlyElecConsumptions,
        fetchEdeliaSimilarHomeYearlyElecComparisions,
        fetchEdeliaElecIndexes,
        fetchEdeliaMonthlyGasConsumptions,
        fetchEdeliaSimilarHomeYearlyGasComparisions,
        fetchEdeliaGasIndexes
      ];
      operations.forEach(operation => importer.use(operation));
      importer.args(requiredFields, entries, data);
      return importer.fetch(function(err, fields, entries) {
        if (err && err.message !== "no edelia") {
          K.logger.error("Error while fetching Edelia data");
          K.logger.error(err);
        }
        // Continue on error.
        return callback();
      });
    },
    next
  );

// Konnector
var K = (module.exports = BaseKonnector.createNew({
  name: "EDF",
  slug: "edf",
  description: "konnector description edf",
  vendorLink: "https://particulier.edf.fr/fr",
  category: "energy",
  color: {
    hex: "#FE5815",
    css: "#FE5815"
  },
  fields: {
    email: {
      type: "text"
    },
    password: {
      type: "password"
    },
    folderPath: {
      type: "folder",
      advanced: true
    }
  },
  dataType: [
    "bill",
    "contract",
    "consumption"
    // TODO : put all data !
  ],

  // TODO : get one edeliaClientId: 'text'

  models: [Client, Contract, PaymentTerms, Home, ConsumptionStatement, Bill],

  fetchOperations: [
    prepareEntries,

    getEDFToken,
    fetchListerContratClientParticulier,
    fetchVisualiserPartenaire,
    fetchVisualiserAccordCommercial,
    fetchVisualiserCalendrierPaiement,
    fetchVisualiserFacture,
    fetchVisualiserHistoConso,

    fetchEdeliaData,

    updateOrCreate(logger, Client, ["clientId", "vendor"]),
    updateOrCreate(logger, Contract, ["number", "vendor"]),
    updateOrCreate(logger, PaymentTerms, ["vendor", "clientId"]),
    updateOrCreate(logger, Home, ["pdl"]),
    updateOrCreate(logger, ConsumptionStatement, [
      "contractNumber",
      "statementType",
      "statementReason",
      "statementCategory",
      "start"
    ]),
    //displayData
    filterExisting(logger, Bill, undefined, "EDF"),
    saveBills
  ]
}));

// Helpers

var _extend = function(a, b) {
  for (let k in b) {
    let v = b[k];
    if (v != null) {
      a[k] = v;
    }
  }
  return a;
};

var getF = function(node, ...fields) {
  try {
    for (let field of Array.from(fields)) {
      node = node[field][0];
    }
  } catch (e) {
    return null;
  }

  return node;
};

var translate = function(dict, name) {
  if (name in dict) {
    return dict[name];
  }
  return name;
};

var edfRequestPost = (path, body, callback) =>
  async.retry(
    { times: 5, interval: 2000 },
    cb => _edfRequestPost(path, body, cb),
    callback
  );

var _edfRequestOptions = function(path, body) {
  let xmlBody = builder.buildObject(body);
  let options = {
    //url: 'https://rce-mobile.edf.com' + path
    url: DOMAIN + path,
    method: "POST",
    headers: {
      // Server needs Capitalize headers, and request use lower case...
      //'Host': 'rce-mobile.edf.com'
      Host: "ws-mobile-particuliers.edf.com",
      "Content-Type": "text/xml",
      Authorization: "Basic QUVMTU9CSUxFX2lQaG9uZV9WMTpBRUxNT0JJTEVfaVBob25lX1Yx",
      "Accept-Encoding": "gzip, deflate",
      "Content-Length": xmlBody.length
    },
    body: xmlBody,
    gzip: true
  };

  return options;
};

var _edfRequestPost = function(path, body, callback) {
  K.logger.debug("called edfRequestPost");
  return request(_edfRequestOptions(path, body), function(err, response, data) {
    if (err) {
      K.logger.error(JSON.stringify(err));
    }
    if (err) {
      return callback("request error");
    }
    return parser.parseString(data, function(err, result) {
      if (err) {
        return callback("request error");
      }
      return callback(null, result);
    });
  });
};

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
  );
