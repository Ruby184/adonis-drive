'use strict'

/*
 * adonis-drive
 *
 * (c) Harminder Virk <virk@adonisjs.com>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
*/

const { ServiceProvider } = require('@adonisjs/fold')
const FlyDrive = require('@slynova/flydrive')
const DriveManager = require('../src/DriveManager')

class DriveProvider extends ServiceProvider {
  $registerManager () {
    this.app.singleton('Adonis/Addons/Drive', (app) => {
      const config = app.use('Adonis/Src/Config').get('drive')
      const flyDriverInstance = new FlyDrive(config)
      const { drivers } = DriveManager

      /**
       * Registering extended drivers with flydrive
       */
      Object.keys(drivers).forEach((driver) => {
        flyDriverInstance.extend(driver, drivers[driver])
      })

      return flyDriverInstance
    })

    this.app.alias('Adonis/Addons/Drive', 'Drive')
    this.app.manager('Adonis/Addons/Drive', DriveManager)
  }

  $extendDrivers () {
    this.app.extend('Adonis/Addons/Drive', 'local', () => require('../src/Drivers/LocalFileSystem'))
    this.app.extend('Adonis/Addons/Drive', 's3', () => require('../src/Drivers/AwsS3'))
  }
  
  register () {
    this.$registerManager()
    this.$extendDrivers()
  }
}

module.exports = DriveProvider
