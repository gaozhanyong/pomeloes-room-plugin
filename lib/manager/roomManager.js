const redis = require('redis')
const Room = require('./room')

class RoomManager {
  constructor (app, opts = {}) {
    this.app = app
    this.redisOpts = opts.redis || {}
    this.globalPrefix = opts.prefix || 'room'
    this.rooms = new Map()

    this.redisClient = null
    this.subClient = null

    this.idleTimeout = (opts.idleTimeout || 300) * 1000
    this.checkInterval = (opts.checkInterval || 60) * 1000
    this.checkIntervalId = null
  }

  async start () {
    this.redisClient = redis.createClient(this.redisOpts)
    this.subClient = redis.createClient(this.redisOpts)

    this.redisClient.on('error', err => console.error('RoomPlugin Redis Client Error', err))
    this.subClient.on('error', err => console.error('RoomPlugin Redis Sub Client Error', err))

    await Promise.all([
      this.redisClient.connect(),
      this.subClient.connect()
    ])
    console.log('RoomPlugin Redis clients connected.')

    this.checkIntervalId = setInterval(() => {
      this._periodicIdleCheck()
    }, this.checkInterval)
  }

  async stop () {
    if (this.checkIntervalId) {
      clearInterval(this.checkIntervalId)
      this.checkIntervalId = null
    }

    for (const room of this.rooms.values()) {
      await room.destroy()
    }
    this.rooms.clear()

    const disconnectPromises = []
    if (this.subClient?.isOpen) {
      disconnectPromises.push(this.subClient.disconnect())
    }
    if (this.redisClient?.isOpen) {
      disconnectPromises.push(this.redisClient.disconnect())
    }
    await Promise.all(disconnectPromises)

    console.log('RoomPlugin Redis clients disconnected.')
  }

  /**
   * Central publish implementation.
   * Can be called statelessly without a Room instance.
   * @param {string} name - The name of the room.
   * @param {object} data - The data to publish.
   * @param {object} opts - Options for this specific publish operation.
   */
  async publish (name, data, opts = {}) {
    if (typeof data !== 'object' || data === null) {
      console.error('Publish data must be a non-null object.')
      return
    }

    const finalOpts = { enableFullData: true, historyLength: 0, ...opts }
    const keys = this._generateKeys(name)
    const jsonData = JSON.stringify(data)
    const publishPromises = []

    if (finalOpts.enableFullData) {
      const stringifiedData = {}
      for (const key in data) {
        if (Object.prototype.hasOwnProperty.call(data, key)) {
          const value = data[key]
          if (value !== null && value !== undefined) {
            if (typeof value === 'object') {
              stringifiedData[key] = JSON.stringify(value)
            } else {
              stringifiedData[key] = String(value)
            }
          }
        }
      }
      if (Object.keys(stringifiedData).length > 0) {
        publishPromises.push(this.redisClient.hSet(keys.fullDataKey, stringifiedData))
      }
    }

    if (finalOpts.historyLength > 0) {
      const listPromise = this.redisClient.lPush(keys.historyKey, jsonData)
        .then(() => this.redisClient.lTrim(keys.historyKey, 0, finalOpts.historyLength - 1))
      publishPromises.push(listPromise)
    }

    if (publishPromises.length > 0) {
      await Promise.all(publishPromises)
    }

    await this.redisClient.publish(keys.channelKey, jsonData)
  }

  async _periodicIdleCheck () {
    try {
      if (this.rooms.size === 0) return

      const now = Date.now()
      const roomsToDestroy = []

      for (const [roomKey, room] of this.rooms.entries()) {
        // Producer rooms are exempt from idle cleanup.
        if (room.opts.enablePublish) continue

        if (room.callbacks.size === 0 && room.isInitialized && room.idleSince && (now - room.idleSince > this.idleTimeout)) {
          roomsToDestroy.push(roomKey)
        }
      }

      if (roomsToDestroy.length > 0) {
        console.log(`[RoomManager] Destroying ${roomsToDestroy.length} idle rooms.`)
        for (const roomKey of roomsToDestroy) {
          const room = this.rooms.get(roomKey)
          if (room) {
            await room.destroy()
            this.rooms.delete(roomKey)
          }
        }
      }
    } catch (err) {
      console.error('[RoomManager] Error during periodic idle check:', err)
    }
  }

  _generateKeys (name) {
    const isPattern = name.includes('*')
    const baseKey = `${this.globalPrefix}:${name}`
    return {
      fullDataKey: isPattern ? baseKey.replace('*', '{{*}}') + ':hash' : `${baseKey}:hash`,
      historyKey: isPattern ? baseKey.replace('*', '{{*}}') + ':list' : `${baseKey}:list`,
      channelKey: isPattern ? `${baseKey}:channel` : `${baseKey}:channel`
    }
  }

  /**
   * The single internal method for creating or updating a room instance.
   * It respects the `enablePublish` flag from the opts.
   * @param {string} name - The room name.
   * @param {object} [opts] - Room options.
   * @returns {Room}
   */
  createRoom (name, opts = {}) {
    if (name.includes('*') && opts.enablePublish) {
      throw new Error('Pattern name (*) is not allowed for a producer room.')
    }

    if (this.rooms.has(name)) {
      const room = this.rooms.get(name)
      // If the intent is to have a producer, upgrade the existing room if it's not one.
      if (opts.enablePublish && !room.opts.enablePublish) {
        room.opts.enablePublish = true
      }
      return room
    }

    // If the room doesn't exist, create it with the provided options.
    const keys = this._generateKeys(name)
    const room = new Room(this, this.subClient, name, keys, opts)
    this.rooms.set(name, room)
    return room
  }

  /**
   * Gets a room. If it doesn't exist, it delegates creation to `createRoom`.
   * @param {string} name - The room name, can be a pattern.
   * @param {object} [opts] - Room options.
   * @returns {Room}
   */
  getRoom (name, opts = {}) {
    if (this.rooms.has(name)) {
      return this.rooms.get(name)
    }
    // If room doesn't exist, always delegate to createRoom.
    // The provided opts will determine the new room's properties.
    return this.createRoom(name, opts)
  }
}

module.exports = RoomManager
