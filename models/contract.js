const baseModel = require('../lib/base_model')

module.exports = baseModel.createNew({
  displayName: 'Contract',
  name: 'org.fing.mesinfos.contract',

  // fields :
    // clientId: String # Client Id in EDF
    // vendor: String # EDF
    // number: String # Contract number
    // name: String # Name of the commercial offer
    // start: String # Start date of the contract
    // end: String # End date of the contract (if contract ended.)
    // status: String # Current state of the contract
    // terminationGrounds: String # if the contract is ended
    // services: [Object] # Additionnal services with the contract.

    // pdl: String # "Point de livraison" : id of the electric counter
    // energie: String # Type of energy
    // troubleshootingPhone: String # Phone number to get help from edf.
    // power: String # Power contracted.
    // contractSubcategory1: String # Sub category of the contract
    // contractSubcategory2: String # Sub category of the contract
    // counter: Object # Data about energy counter.
    // annualConsumption: Number # The previous annual energy consumption.
    // peakHours: String # For some offers, time of rpice shift.
    // statement: Object # Details about counter reading.
    // docTypeVersion: String
})
