class Room {
  /**
   * Represents a single room for data synchronization.
   * @param {RoomManager} manager - The RoomManager instance.
   * @param {object} subClient - The redis client for pub/sub.
   * @param {string} name - The name of the room, e.g., 'match:123' or 'chat:*'.
   * @param {{fullDataKey: string, historyKey: string, channelKey: string}} keys - Redis keys for the room.
   * @param {object} [opts] - Room options.
   */
  constructor (manager, subClient, name, keys, opts = {}) {
    this.manager = manager
    this.subClient = subClient
    this.name = name
    this.keys = keys

    this.opts = {
      historyLength: 0,
      enableFullData: true,
      cleanOnStartUp: false, // This option is only effective on the first publish of a producer room.
      enablePublish: false,
      ...opts
    }

    this.patternMode = name.includes('*')

    this.callbacks = new Map() // <userId, { onDataCB, extraData }>
    this.fullData = {}
    this.historyData = []
    this.isInitialized = false
    this.isCleaned = !this.opts.cleanOnStartUp

    this.initializationPromise = null
    this.idleSince = null
    this.messageHandler = null
  }

  /**
   * Publishes new data to the room. (Producer-side)
   * This is a convenience method that calls the central publish implementation in RoomManager.
   * @param {object} data - The data to publish.
   * @param {object} [opts] - Temporary options to override room's default opts for this publish.
   */
  async publish (data, opts = {}) {
    if (!this.opts.enablePublish) {
      throw new Error('This room is not a producer. Publishing is not allowed.')
    }

    // cleanOnStartUp logic is handled here, by the stateful Room instance.
    if (!this.isCleaned) {
      const promises = []
      if (this.opts.enableFullData) {
        promises.push(this.manager.redisClient.del(this.keys.fullDataKey))
      }
      if (this.opts.historyLength > 0) {
        promises.push(this.manager.redisClient.del(this.keys.historyKey))
      }
      if (promises.length > 0) {
        await Promise.all(promises)
      }
      this.isCleaned = true
    }

    // Delegate the actual publishing to the manager.
    const finalOpts = { ...this.opts, ...opts }
    await this.manager.publish(this.name, data, finalOpts)
  }

  /**
   * Joins a user to the room to receive data updates. (Consumer-side)
   * @param {string|number} userId - The unique identifier for the user.
   * @param {function} onDataCB - Callback: (fullData, newData, extraData) => {}.
   * @param {*} [extraData] - Extra data to be passed to the callback.
   */
  async join (userId, onDataCB, extraData = null) {
    this.idleSince = null // Joining cancels any idle state.
    this.callbacks.set(userId, { onDataCB, extraData })

    await this._ensureInitialized()

    // Always provide the most current data upon joining.
    onDataCB(this.fullData, null, extraData)
  }

  /**
   * A user leaves the room.
   * @param {string|number} userId - The user identifier.
   */
  async leave (userId) {
    this.callbacks.delete(userId)
    if (this.callbacks.size === 0 && this.isInitialized) {
      this.idleSince = Date.now()
    }
  }

  /**
   * Gets the latest full data snapshot.
   * @returns {Promise<object>}
   */
  async getFullData () {
    await this._ensureInitialized()
    return this.fullData
  }

  /**
   * Gets the latest history data.
   * @returns {Promise<Array>}
   */
  async getHistoryData () {
    await this._ensureInitialized()
    return this.historyData
  }

  /**
   * Cleans up all resources used by the room.
   */
  async destroy () {
    if (this.isInitialized) {
      await this._unsubscribe()
    }
    this.callbacks.clear()
    this.initializationPromise = null
    this.isInitialized = false
    this.messageHandler = null
  }

  /**
   * Ensures the room is initialized, handling concurrent calls safely.
   * This private helper centralizes the initialization logic.
   */
  async _ensureInitialized () {
    if (this.isInitialized) {
      return // Already initialized, do nothing.
    }
    if (!this.initializationPromise) {
      this.initializationPromise = this._initialize()
    }
    await this.initializationPromise
  }

  async _initialize () {
    try {
      await this._fetchInitialData()
      await this._subscribe()
      this.isInitialized = true
    } catch (err) {
      console.error(`Failed to initialize room ${this.keys.channelKey}:`, err)
      // On failure, reset state to allow for a retry on the next call.
      this.isInitialized = false
      this.initializationPromise = null
      throw err
    }
  }

  async _fetchInitialData () {
    if (!this.patternMode) {
      const promises = []
      if (this.opts.enableFullData) {
        promises.push(this.manager.redisClient.hGetAll(this.keys.fullDataKey))
      }
      if (this.opts.historyLength > 0) {
        promises.push(this.manager.redisClient.lRange(this.keys.historyKey, 0, -1))
      }

      const [hashResult, listResult] = await Promise.all(promises)

      if (this.opts.enableFullData && hashResult) {
        for (const key in hashResult) {
          const value = hashResult[key]
          if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
            try {
              hashResult[key] = JSON.parse(value)
            } catch (e) {
              // Not valid JSON, leave as is.
            }
          }
        }
      }

      this.fullData = this.opts.enableFullData ? (hashResult || {}) : {}
      this.historyData = this.opts.historyLength > 0 ? (listResult || []).map(item => JSON.parse(item)) : []
    } else {
      const hashPattern = this.keys.channelKey.replace(/:channel$/, ':hash')
      const listPattern = this.keys.channelKey.replace(/:channel$/, ':list')

      const [hashData, listData] = await Promise.all([
        this.opts.enableFullData ? this._scanAndFetchHashes(hashPattern) : Promise.resolve({}),
        this.opts.historyLength > 0 ? this._scanAndFetchLists(listPattern) : Promise.resolve([])
      ])
      this.fullData = hashData
      this.historyData = listData
    }
  }

  async _scanKeys (pattern) {
    const keys = []
    for await (const key of this.manager.redisClient.scanIterator({ MATCH: pattern, COUNT: 100 })) {
      keys.push(key)
    }
    return keys.flat()
  }

  async _scanAndFetchHashes (pattern) {
    const keys = await this._scanKeys(pattern)
    const mergedHash = {}
    for (const key of keys) {
      try {
        const data = await this.manager.redisClient.hGetAll(key)
        for (const field in data) {
          const value = data[field]
          if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
            try {
              data[field] = JSON.parse(value)
            } catch (e) {
              // Not valid JSON, leave as is.
            }
          }
        }
        Object.assign(mergedHash, data)
      } catch (e) { console.error(`Error fetching hash ${key}:`, e) }
    }
    return mergedHash
  }

  async _scanAndFetchLists (pattern) {
    const keys = await this._scanKeys(pattern)
    let mergedList = []
    for (const key of keys) {
      try {
        const arr = await this.manager.redisClient.lRange(key, 0, -1)
        mergedList.push(...arr.map(item => JSON.parse(item)).filter(Boolean))
      } catch (e) { console.error(`Error fetching list ${key}:`, e) }
    }

    if (mergedList.length > 0 && mergedList[0]?.timestamp) {
      mergedList.sort((a, b) => b.timestamp - a.timestamp)
    }
    return this.opts.historyLength > 0 ? mergedList.slice(0, this.opts.historyLength) : mergedList
  }

  async _subscribe () {
    if (!this.messageHandler) {
      this.messageHandler = (message, channel) => {
        try {
          const newData = JSON.parse(message)
          this._mergeAndDispatch(newData)
        } catch (e) {
          console.error('Error parsing message or dispatching data:', e)
        }
      }
    }

    if (this.patternMode) {
      await this.subClient.pSubscribe(this.keys.channelKey, this.messageHandler)
    } else {
      await this.subClient.subscribe(this.keys.channelKey, this.messageHandler)
    }
  }

  async _unsubscribe () {
    if (this.subClient && this.subClient.isOpen && this.messageHandler) {
      if (this.patternMode) {
        await this.subClient.pUnsubscribe(this.keys.channelKey, this.messageHandler)
      } else {
        await this.subClient.unsubscribe(this.keys.channelKey, this.messageHandler)
      }
    }
  }

  _mergeAndDispatch (newData) {
    if (this.opts.enableFullData) {
      for (const key in newData) {
        if (Object.prototype.hasOwnProperty.call(newData, key) && newData[key] !== null && newData[key] !== undefined) {
          this.fullData[key] = newData[key]
        }
      }
    }

    if (this.opts.historyLength > 0) {
      this.historyData.unshift(newData)
      if (this.historyData.length > this.opts.historyLength) {
        this.historyData.pop()
      }
    }

    const safeFullData = JSON.parse(JSON.stringify(this.fullData))

    for (const { onDataCB, extraData } of this.callbacks.values()) {
      try {
        onDataCB(safeFullData, newData, extraData)
      } catch (e) {
        console.error('Error in room data callback:', e)
      }
    }
  }
}

module.exports = Room
