'use strict'

const DriveManager = require('./DriveManager')
const CE = require('../Exceptions')

const proxyHandler = {
  get (target, name) {
    /**
     * if node is inspecting then stick to target properties
     */
    if (typeof (name) === 'symbol' || name === 'inspect') {
      return target[name]
    }

    /**
     * if value exists on target, return that
     */
    if (typeof (target[name]) !== 'undefined') {
      return target[name]
    }

    /**
     * Fallback to driver instance
     */
    const disk = target.disk()

    if (typeof (disk[name]) === 'function') {
      return disk[name].bind(disk)
    }

    return disk[name]
  },
}

class StorageManager {
  /**
   * Constructor.
   *
   * @param  {object} config
   */
  constructor (config) {
    this._config = config

    /**
     * Adding empty disk property to make future checks
     * simpler
     */
    this._config.disks = this._config.disks || {}

    /**
     * List of drivers extended
     *
     * @type {Object}
     */
    this._drivers = {}

    return new Proxy(this, proxyHandler)
  }

  /**
   * Get a disk instance.
   *
   * @param  {string} name
   * @param {Object} config
   * @return {object}
   */
  disk (name, config) {
    name = name || this._config.default

    /**
     * No name is defined and neither there
     * are any defaults.
     */
    if (!name) {
      throw CE.InvalidConfig.missingDiskName()
    }

    const diskConfig = this._config.disks[name]

    /**
     * Configuration for the defined disk is missing
     */
    if (!diskConfig) {
      throw CE.InvalidConfig.missingDiskConfig(name)
    }

    /**
     * There is no driver defined on disk configuration
     */
    if (!diskConfig.driver) {
      throw CE.InvalidConfig.missingDiskDriver(name)
    }

    return DriveManager.getDriver(Object.assign({}, diskConfig, config))
  }
}

module.exports = StorageManager
