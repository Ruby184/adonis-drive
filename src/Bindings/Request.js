'use strict'

const FormFields = require('@adonisjs/bodyparser/src/FormFields')
const { pipeline, Transform } = require('stream')
const { imageSize } = require('image-size')
const mediaTyper = require('media-typer')
const DEFAULT_LIMIT = 128 * 1024

function createValidationStream (file, fileTypeFromBuffer) {
  const { size, width, height, types } = file.validationOptions
  let buffer = Buffer.alloc(0)
  const detectDimensions = Boolean(width || height) || (Array.isArray(types) && types.includes('image'))
  let lastError = null

  const setFileError = (message, type = 'fatal') => {
    file.setError(message, type)
    buffer = null
    return file.error()
  }

  return new Transform({
    async transform (chunk, _, callback) {
      file.size += chunk.length

      if (size && file.size > size) {
        return callback(setFileError(`File size should be less than ${size} bytes`, 'size'))
      }

      if (buffer && file.size < DEFAULT_LIMIT) {
        buffer = Buffer.concat([buffer, chunk], file.size)

        if (detectDimensions && !file.dimensions) {
          try {
            file.dimensions = imageSize(buffer)
  
            if ((width && file.dimensions.width > width) || (height && file.dimensions.height > height)) {
              return callback(setFileError(`Image dimensions should be no more than ${width}x${height}`, 'dimension'))
            }
          } catch (err) {
            lastError = err
          }
        }

        if (!file.mime) {
          try {
            const fileType = await fileTypeFromBuffer(buffer)
  
            if (fileType) {
              const parsedTypes = mediaTyper.parse(fileType.mime)

              file.mime = fileType.mime
              file.extname = fileType.ext
              file.type = parsedTypes.type
              file.subtype = parsedTypes.subtype

              await file.runValidations()

              if (file.status === 'error') {
                buffer = null
                return callback(file.error())
              }
            }
          } catch (err) {
            return callback(setFileError(err.message))
          }
        }
      } else if (detectDimensions && !file.dimensions) {
        return callback(setFileError(lastError ? lastError.message : 'Reached the limit before detecting image type', 'dimension'))
      } else {
        buffer = null
      }

      callback(null, chunk)
    },
    flush (callback) {
      if (detectDimensions && !file.dimensions) {
        if (file.size === 0) {
          return callback(setFileError('No bytes received'))
        }

        return callback(setFileError(lastError ? lastError.message : 'Could not detect image dimensions', 'dimension'))
      }

      if (!file.mime) {
        file.mime = file.headers['content-type']
      }

      return callback()
    }
  })
}

module.exports = async function (request, disk, filesOptions, fileTypeFromBuffer) {
  const files = new FormFields()
  const fields = new FormFields()

  request.multipart.field((name, value) => {
    fields.add(name, value)
  })
  
  for (const options of filesOptions) {
    request.multipart.file(options.name, options.rules || {}, (file) => {
      return new Promise(async (resolve, reject) => {
        try {
          const result = typeof options.validate === 'function' ? await options.validate({ file, fields: fields.get() }) : null

          if (result) {
            file.setOptions(Object.assign({}, options.rules || {}, result))
          }
  
          await file.runValidations()
  
          if (file.status === 'error') {
            return reject(file.error())
          }
    
          const location = options.location
            ? await options.location({ request, file, fields: fields.get(), result })
            : (result && result.location ? result.location : `${options.name}/${file.clientName}`)

          const stream = createValidationStream(file, fileTypeFromBuffer)
          const promise = disk.upload(location, stream, { ContentType: file.headers['content-type'] })
  
          pipeline(file.stream, stream, (err) => {
            if (err) {
              reject(err)
              promise.cancel()
            }
          })
  
          promise.then(
            (url) => {
              file.fileName = location
              file.url = url
              file.status = 'moved'
              files.add(file.fieldName, file)
              resolve()
            },
            reject
          )
        } catch (err) {
          reject(err)
        }
      })
    })
  }

  await request.multipart.process()

  request._files = files.get()
  request.body = fields.get()

  return { disk, files: files.get(), fields: fields.get() }
}