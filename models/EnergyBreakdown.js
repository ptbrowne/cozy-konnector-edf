const baseModel = require('../lib/base_model')

module.exports = baseModel.createNew({
  displayName: 'EnergyBreakdown',
  name: 'org.fing.mesinfos.energybreakdown',

  /*
      Fields :
        vendor: String # EDF
        clientId: String # Client id from EDF,
        contractNumber: String # ContractId from EDF
        beginMonth: String[YYYY-MM]
        endMonth:String[YYYY-MM]
        totalCost: Number
        usageBreakdowns: Array[{
            usage: String, { 'US_HEATING'}
            cost: Number,
            percent: Number
        }]


      Example:
      { vendor: 'EDF',
        clientId: '',
        beginMonth: '2016-04',
        endMonth: '2017-03',
        totalCost: 942,
        usageBreakdowns:
         [ { usage: 'US_HEATING', cost: 45, percent: 5 },
           { usage: 'US_SANITARY_HOT_WATER', cost: 99, percent: 11 },
           { usage: 'US_WASHING_DRYING', cost: 72, percent: 8 },
           { usage: 'US_FRIDGE_FREEZER', cost: 198, percent: 22 },
           { usage: 'US_COOKING', cost: 81, percent: 9 },
           { usage: 'US_LIGHTING', cost: 312, percent: 30 },
           { usage: 'US_OTHERS', cost: 135, percent: 15 },
           { usage: 'US_GLOBAL', cost: 942, percent: 100 } ] }
  */
})


