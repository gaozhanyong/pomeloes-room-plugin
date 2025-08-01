const RoomManager = require('../manager/roomManager')

class RoomService {
  constructor (app, opts) {
    this.app = app
    this.opts = opts
    this.manager = new RoomManager(app, this.opts)
  }

  /**
   * Start the service, connect to redis.
   */
  async start (cb) {
    await this.manager.start()
    process.nextTick(cb)
  }

  /**
   * Stop the service, disconnect from redis.
   */
  async stop (force, cb) {
    await this.manager.stop()
    process.nextTick(cb)
  }

  /**
   * Publishes data to a room without needing a room instance.
   * @param {string} name - The name of the room.
   * @param {object} data - The data to publish.
   * @param {object} [opts] - Options for this specific publish operation.
   */
  async publish (name, data, opts) {
    await this.manager.publish(name, data, opts)
  }

  /**
   * Creates a producer room instance.
   * @param {string} name - The name of the room.
   * @param {object} [opts] - Room specific options.
   * @returns {Room}
   */
  createRoom (name, opts = {}) {
    // The service layer enforces the "producer" intent
    // by explicitly setting enablePublish to true.
    const finalOpts = { ...opts, enablePublish: true }
    return this.manager.createRoom(name, finalOpts)
  }

  /**
   * Gets a consumer room instance.
   * @param {string} name - The name of the room, can be a pattern.
   * @param {object} [opts] - Room specific options.
   * @returns {Room}
   */
  getRoom (name, opts) {
    // This method simply passes the call through. The manager's getRoom
    // will create a consumer room by default if it doesn't exist.
    return this.manager.getRoom(name, opts)
  }
}

module.exports = RoomService
