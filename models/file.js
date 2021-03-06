const request = require('request-promise')
const log = require('debug')('konnectors:file')

const cozy = require('cozy-konnector-libs').cozyClient
//const cozy = require('../cozyclient')

module.exports = {
  isPresent(fullPath, callback) {
    cozy.files
      .statByPath(fullPath)
      .then(file => {
        callback(null, true)
      })
      .catch(err => callback(null, false))
  },
  createNew(fileName, path, url, tags, callback, requestoptions, parseoptions) {
    cozy.files
      .statByPath(path)
      .then(folder => {
        let options = {}
        if (requestoptions) {
          options = requestoptions
          if (typeof options.form === 'function') {
            options.form = options.form(options.entry)
          }
          options.uri = url
        } else {
          options = {
            uri: url,
            method: 'GET',
            jar: true
          }
        }

        log(`Downloading file at ${url}...`)
          return request(options)
            .then(function (data) {
              return parseoptions(data)
            })
            .then(file => {
              return cozy.files.create(file.data, {
                name: fileName,
                dirID: folder._id,
                contentType: file.contentType
              })
            })
      })
      .then(thefile => {

        callback(null, thefile)
      })
      .catch(err => callback(err))
  }
}
