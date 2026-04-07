'use strict'

const fsPromises = require('node:fs/promises')
const fs = require('node:fs')
const path = require('node:path')
const { createHmac, timingSafeEqual } = require('node:crypto')
const PCancelable = require('p-cancelable')
const { pipeline, Stream } = require('node:stream')
const mime = require('mime-types')
const {
  FileNotFound, PermissionMissing, InvalidConfig,
  UnknownException, MethodNotSupported, InvalidSignedUpload
} = require('../Exceptions')

function isReadableStream (stream) {
  return stream !== null
    && stream instanceof Stream
    && typeof stream._read === 'function'
    && stream.readable !== false
}

function createWriteStream(file, options = {}) {
  // If fd is already provided, the directory must already exist
  if (options.fd) {
    return fs.createWriteStream(file, options)
  }

  const dir = path.dirname(file)
  const _fs = options.fs || fs

  const customFs = {
    ..._fs,
    open: (...args) => {
      const callback = args.pop()

      _fs.mkdir(dir, { recursive: true }, (err) => {
        if (err) {
          return callback(err)
        }

        _fs.open(...args, callback)
      })
    },
  }

  return fs.createWriteStream(file, { ...options, fs: customFs })
}

class LocalFileSystem {
  constructor (config) {
    this.root = config.root
    this._url = config.url
    this._signedUpload = config.signedUpload
  }

  _handleError (err, path) {
    switch (err.code) {
      case 'ENOENT':
        return FileNotFound.file(err, path)
      case 'EPERM':
        return PermissionMissing.invoke(err, path)
      default:
        return UnknownException.invoke(err, err.code, path)
    }
  }

  _fullPath (relativePath) {
    return path.isAbsolute(relativePath) ? relativePath : path.join(this.root, relativePath)
  }

  driver () {
		return fsPromises
  }
  
  upload (location, stream, options = {}) {
    return new PCancelable((resolve, reject, onCancel) => {
      const fullPath = this._fullPath(location)
      const ws = createWriteStream(fullPath, options)

      onCancel(() => {
        ws.destroy()

        if (typeof ws.fd !== 'number') {
          ws.once('open', () => fs.unlink(ws.path, () => {}))
        } else {
          fs.unlink(ws.path, () => {})
        }
      })

      pipeline(stream, ws, (err) => {        
        if (err) {
          return reject(this._handleError(err, location))
        }

        return resolve(this._url && this.getUrl(location))
      })
    })
  }

  getUrl (location) {
    if (this._url) {
      return this._url.replace(/\/$/, '') + '/' + location.replace(/^\/+/, '')
    }

    throw MethodNotSupported.method('getUrl', 'local')
  }

  async getSignedUrl (location, { expiry = 900, ...params } = {}) {
    return this.getUrl(location)
  }

  _computeHMACSignature (payload) {
    if (!this._signedUpload || !this._signedUpload.secret) {
      throw InvalidConfig.missingConfigOption('signedUpload.secret')
    }

    return createHmac('sha256', this._signedUpload.secret).update(payload, 'utf8').digest('hex')
  }

  _getSignedUploadUrl () {
    if (!this._signedUpload || !this._signedUpload.url) {
      throw InvalidConfig.missingConfigOption('signedUpload.url')
    }

    const url = typeof this._signedUpload.url === 'function' ? this._signedUpload.url() : this._signedUpload.url

    if (url instanceof URL) {
      return url.href
    }

    return url
  }

  async getSignedUpload (location, { expiry = 900, size = 5242880, type } = {}) {
    const url = this._getSignedUploadUrl()
    const now = Math.floor(Date.now() / 1000)

    const conditions = {
      key: location,
      iat: now,
      exp: now + expiry,
      size,
      type,
    }

    const policy = Buffer.from(JSON.stringify(conditions), 'utf8').toString('base64')

    const fields = {
      policy,
      signature: this._computeHMACSignature(policy),
    }

    return { fields, url }
  }

  validateSignedUpload (fields) {
    for (const field of ['policy', 'signature']) {
      if (typeof fields[field] !== 'string') {
        throw InvalidSignedUpload.missingField(field)
      }
    }

    const receivedSignature = fields.signature
    const expectedSignature = this._computeHMACSignature(fields.policy)

    if (expectedSignature.length !== receivedSignature.length) {
      throw InvalidSignedUpload.invalidSignature()
    }

    const textEncoder = new TextEncoder()

    if (!timingSafeEqual(textEncoder.encode(expectedSignature), textEncoder.encode(receivedSignature))) {
      throw InvalidSignedUpload.invalidSignature()
    }

    const policy = JSON.parse(Buffer.from(fields.policy, 'base64').toString('utf8'))
    const now = Math.floor(Date.now() / 1000)

    if (now > policy.exp) {
      throw InvalidSignedUpload.requestExpired()
    }

    return policy
  }
  
  async stat (location) {
    try {
			const stat = await fsPromises.stat(this._fullPath(location))

      return {
        size: stat.size,
        modified: stat.mtime,
        mimetype: mime.lookup(path.extname(location)) || 'application/octet-stream',
        etag: `W/"${stat.size.toString(16)}-${stat.mtime.getTime().toString(16)}"`
      }
		} catch (err) {
      throw this._handleError(err, location)
		}
  }

  async *list (location, recursive = false) {
    try {
      const dirents = await fsPromises.readdir(this._fullPath(location), { withFileTypes: true })

      for (const dirent of dirents) {
        const res = {
          type: dirent.isDirectory() ? 'dir' : 'file',
          path: `${location}/${dirent.name}`.replace(/^\/+|\/+$/g, '')
        }

        yield res

        if (recursive && res.type === 'dir') {
          yield* this.list(res.path, true)
        }
      }
    } catch (err) {
      throw this._handleError(err, location)
    }
  }

  async exists (location) {
    return fsPromises.access(this._fullPath(location), fs.constants.F_OK).then(() => true).catch(() => false)
  }

  async get (location, options = {}) {
    try {
      return await fsPromises.readFile(this._fullPath(location), options)
    } catch (err) {
      throw this._handleError(err, location)
    }
  }

  getStream (location, options) {
    return fs.createReadStream(this._fullPath(location), options)
  }

  async put (location, content, options = {}) {
    if (isReadableStream(content)) {
      return new Promise((resolve, reject) => {
        const ws = createWriteStream(this._fullPath(location), options)

        pipeline(content, ws, (err) => {
          if (err) {
            return reject(this._handleError(err, location))
          }

          return resolve(true)
        })
      })
    }

    await fsPromises.writeFile(this._fullPath(location), content, options)

    return true
  }

  async delete (location) {
    await fsPromises.unlink(this._fullPath(location))

    return true
  }

  async move (src, dest, options = {}) {
    await fsPromises.rename(this._fullPath(src), this._fullPath(dest), options)

    return true
  }

  async copy (src, dest) {
    await fsPromises.copyFile(this._fullPath(src), this._fullPath(dest))

    return true
  }
}

module.exports = LocalFileSystem
