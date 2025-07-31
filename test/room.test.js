const { expect } = require('chai')
const { describe, it, before, after, beforeEach, afterEach } = require('mocha')
const redis = require('redis')
const RoomService = require('../lib/service/roomService')

// Parse concurrency level from command-line arguments
const getConcurrencyLevel = () => {
  const arg = process.argv.find(a => a.startsWith('--concurrency='))
  return arg ? (parseInt(arg.split('=')[1], 10) || 10) : 10
}

const CONCURRENCY_LEVEL = getConcurrencyLevel()

describe('Pomeloes Room Plugin Tests (Refactored)', function () {
  // Increase timeout for async tests, especially performance tests
  this.timeout(20000)

  let roomService
  let redisClient // A separate Redis client for verification
  const mockApp = { set: () => {}, get: () => {} } // Simple mock for Pomelo App

  const ROOM_PREFIX = 'test-match'
  let testCounter = 0

  before(async () => {
    // Initialize RoomService with test-optimized settings
    roomService = new RoomService(mockApp, {
      redis: {}, // Use local default Redis config
      idleTimeout: 2, // 2-second idle timeout for fast testing
      checkInterval: 1 // 1-second check interval
    })
    await roomService.start()

    // Initialize a separate Redis client to assert data in Redis
    redisClient = redis.createClient()
    await redisClient.connect()
  })

  after(async () => {
    await roomService.stop()
    await redisClient.disconnect()
  })

  // Before each test, generate a unique room name and store it in the test context
  beforeEach(function () {
    // Note: using 'function' not '() =>' to access Mocha's 'this' context
    this.roomName = `${ROOM_PREFIX}:room-${testCounter++}`
  })

  // After each test, automatically clean up Redis data created by that test
  afterEach(async function () {
    if (this.roomName) {
      const keys = roomService.manager._generateKeys(this.roomName)
      const keysToDelete = [keys.fullDataKey, keys.historyKey]
      if (keysToDelete.length > 0) {
        await redisClient.del(keysToDelete)
      }
    }
  })

  describe('Basic Functionality', () => {
    it('should create a room and publish data to fullData and history', async function () {
      const room = roomService.createRoom(this.roomName, {
        enableFullData: true,
        historyLength: 10
      })
      const data = { user: 'gemini', score: 100 }
      await room.publish(data)

      // Verify with the separate Redis client
      const keys = roomService.manager._generateKeys(this.roomName)
      const hashData = await redisClient.hGetAll(keys.fullDataKey)
      const listData = await redisClient.lRange(keys.historyKey, 0, -1)

      expect(hashData.user).to.equal('gemini')
      expect(hashData.score).to.equal('100') // Primitive numbers are stored as strings
      expect(listData).to.have.lengthOf(1)
      expect(JSON.parse(listData[0])).to.deep.equal(data)
    })

    it('should publish data statelessly via roomService', async function () {
      const data = { event: 'start', timestamp: Date.now() }
      await roomService.publish(this.roomName, data, {
        enableFullData: true,
        historyLength: 5
      })

      // Verify with the separate Redis client
      const keys = roomService.manager._generateKeys(this.roomName)
      const hashData = await redisClient.hGetAll(keys.fullDataKey)
      const listData = await redisClient.lRange(keys.historyKey, 0, -1)

      expect(hashData.event).to.equal('start')
      expect(listData).to.have.lengthOf(1)
    })

    it('should join a room and receive initial data and subsequent updates', function (done) {
      const room = roomService.createRoom(this.roomName, { enableFullData: true })
      const initialData = { state: 'waiting' }
      const updateData = { state: 'playing' }
      let callCount = 0

      room.publish(initialData).then(() => {
        room.join('user1', async (fullData, newData, extraData) => {
          try {
            callCount++
            if (callCount === 1) { // First call: initial data
              expect(newData).to.be.null
              expect(fullData).to.deep.equal({ state: 'waiting' })
              expect(extraData).to.equal('extra-info')
              // After receiving initial data, publish an update
              await room.publish(updateData)
            } else if (callCount === 2) { // Second call: update
              expect(newData).to.deep.equal(updateData)
              expect(fullData).to.deep.equal({ state: 'playing' })
              done() // Test successful
            }
          } catch (err) {
            done(err) // Fail test if assertions fail
          }
        }, 'extra-info')
      })
    })

    it('should get full data and history data without joining', async function () {
      const room = roomService.createRoom(this.roomName, { enableFullData: true, historyLength: 5 })
      await room.publish({ p1: 1 })
      await room.publish({ p2: 2 })

      const fullData = await room.getFullData()
      const historyData = await room.getHistoryData()

      expect(fullData).to.deep.equal({ p1: '1', p2: '2' })
      expect(historyData).to.have.lengthOf(2)
      expect(historyData[0]).to.deep.equal({ p2: 2 }) // List is LIFO
    })

    it('should correctly handle publishing and retrieving complex, multi-level objects', async function () {
      const room = roomService.createRoom(this.roomName, {
        enableFullData: true,
        historyLength: 5
      })

      const complexData = {
        id: 'game-123',
        status: 'in-progress',
        players: [
          { id: 'p1', name: 'Alice', score: 150 },
          { id: 'p2', name: 'Bob', score: 99 }
        ],
        metadata: {
          map: 'forest_glade',
          settings: {
            timeLimit: 300,
            friendlyFire: false
          }
        },
        rounds: 3
      }

      await room.publish(complexData)

      // 1. Verify via getFullData and getHistoryData
      const fullData = await room.getFullData()
      const historyData = await room.getHistoryData()

      // 2. Assert fullData (from Hash) is correctly structured
      const expectedFullData = {
        id: 'game-123',
        status: 'in-progress',
        players: [ // This is now an object because of the fix
          { id: 'p1', name: 'Alice', score: 150 },
          { id: 'p2', name: 'Bob', score: 99 }
        ],
        metadata: { // This is now an object because of the fix
          map: 'forest_glade',
          settings: {
            timeLimit: 300,
            friendlyFire: false
          }
        },
        rounds: '3' // Primitive numbers are still stored as strings in Redis Hashes
      }
      expect(fullData).to.deep.equal(expectedFullData)

      // 3. Assert historyData (from List) is correctly structured
      expect(historyData).to.have.lengthOf(1)
      expect(historyData[0]).to.deep.equal(complexData) // List stores the exact object
    })

    it('should retry initialization if the first attempt fails', async function () {
      const room = roomService.getRoom(this.roomName)

      // Spy on console.error to suppress the expected error log during this test
      const originalConsoleError = console.error
      let consoleErrorCalled = false
      console.error = () => { consoleErrorCalled = true }

      // 1. Sabotage the initial data fetch to simulate a failure
      const originalFetch = room._fetchInitialData
      let fetchAttempt = 0
      room._fetchInitialData = async () => {
        fetchAttempt++
        if (fetchAttempt === 1) {
          // On the first attempt, throw an error
          throw new Error('Simulated Redis connection error')
        }
        // On subsequent attempts, call the original method
        return originalFetch.call(room)
      }

      try {
        // 2. First attempt: Expect it to fail
        await room.getFullData()
        // If it reaches here, the test fails because an error was expected
        expect.fail('First getFullData call should have thrown an error.')
      } catch (err) {
        expect(err.message).to.equal('Simulated Redis connection error')
        // Optionally, assert that our spy was called, confirming the error was logged
        expect(consoleErrorCalled).to.be.true
      } finally {
        // Restore the original console.error to not affect other tests
        console.error = originalConsoleError
      }

      // Verify that the room's state reflects the failed attempt
      expect(room.isInitialized).to.be.false
      expect(room.initializationPromise).to.be.null

      // 3. Publish some data to Redis so the second attempt has something to fetch
      await roomService.publish(this.roomName, { state: 'ready' })

      // 4. Second attempt: Expect it to succeed
      const fullData = await room.getFullData()

      // Assert that the retry was successful
      expect(fullData).to.deep.equal({ state: 'ready' })
      expect(room.isInitialized).to.be.true
      expect(fetchAttempt).to.equal(2) // Ensure it was attempted twice

      // 5. Restore the original method
      room._fetchInitialData = originalFetch
    })
  })

  describe('Concurrency and Performance', () => {
    it(`should handle ${CONCURRENCY_LEVEL} concurrent joins correctly`, async function () {
      console.log(`  Running concurrency test with ${CONCURRENCY_LEVEL} users...`)
      const room = roomService.createRoom(this.roomName, { enableFullData: true })
      await room.publish({ round: 1 })

      const joinPromises = Array.from({ length: CONCURRENCY_LEVEL }, (_, i) => {
        return new Promise((resolve, reject) => {
          room.join(`concurrent-user-${i}`, (fullData, newData) => {
            try {
              expect(fullData).to.deep.equal({ round: '1' })
              expect(newData).to.be.null
              resolve()
            } catch (err) {
              reject(err)
            }
          }).catch(reject)
        })
      })

      await Promise.all(joinPromises)
      expect(joinPromises).to.have.lengthOf(CONCURRENCY_LEVEL)
    })
  })

  describe('Idle Room Cleanup', () => {
    // Helper function for this describe block to avoid repetition
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

    it('should destroy an idle room after the timeout', async function () {
      const room = roomService.getRoom(this.roomName, { historyLength: 1 }) // Create a consumer room

      // A user joins and immediately leaves, making the room idle
      await room.join('temp-user', () => {})
      await room.leave('temp-user')

      // Verify the room is now idle but still exists in the manager
      expect(room.idleSince).to.be.a('number')
      expect(roomService.manager.rooms.has(this.roomName)).to.be.true

      // Wait for a duration longer than the idle timeout + check interval
      await sleep(3000) // Wait 3s (timeout 2s, interval 1s)

      // Verify the room has been destroyed and removed from the manager
      expect(roomService.manager.rooms.has(this.roomName)).to.be.false
    })

    it('should not destroy a room if a user re-joins during the idle period', async function () {
      const room = roomService.getRoom(this.roomName)

      // User A joins and leaves, making the room idle
      await room.join('user-a', () => {})
      await room.leave('user-a')
      expect(room.idleSince).to.be.a('number')

      // Before timeout, User B joins, canceling the idle state
      await sleep(500) // Wait less than the timeout
      await room.join('user-b', () => {})
      expect(room.idleSince).to.be.null

      // Wait for a long time to confirm the cleanup logic doesn't trigger incorrectly
      await sleep(3000)

      // Verify the room still exists because it became active again
      expect(roomService.manager.rooms.has(this.roomName)).to.be.true
    })

    it('should NOT destroy a room created via createRoom, even if it becomes idle', async function () {
      const room = roomService.createRoom(this.roomName)

      // A user joins and leaves, making the room idle
      await room.join('temp-user-producer', () => {})
      await room.leave('temp-user-producer')

      // Verify the room is now idle
      expect(room.idleSince).to.be.a('number')

      // Wait for a long time
      await sleep(3000)

      // Verify the room still exists because it's a producer and exempt from cleanup
      expect(roomService.manager.rooms.has(this.roomName)).to.be.true
    })

    it('should create a producer room via getRoom and NOT destroy it', async function () {
      // Create a producer room using getRoom with enablePublish: true
      const room = roomService.getRoom(this.roomName, { enablePublish: true })
      expect(room.opts.enablePublish).to.be.true

      // A user joins and leaves, making the room idle
      await room.join('temp-user-producer', () => {})
      await room.leave('temp-user-producer')
      expect(room.idleSince).to.be.a('number')

      // Wait for a long time
      await sleep(3000)

      // Verify the room still exists because it was created as a producer
      expect(roomService.manager.rooms.has(this.roomName)).to.be.true
    })
  })

  describe('Pattern Subscription', function () {
    const PATTERN_PREFIX = 'test-pattern'
    const ROOM_NAME_1 = `${PATTERN_PREFIX}:room-1`
    const ROOM_NAME_2 = `${PATTERN_PREFIX}:room-2`
    const PATTERN_NAME = `${PATTERN_PREFIX}:*`

    afterEach(async function () {
      // 1. Clean up Redis keys using non-blocking SCAN (best practice)
      const keysToDelete = []
      const pattern = `${roomService.manager.globalPrefix}:${PATTERN_PREFIX}:*`
      for await (const key of redisClient.scanIterator({ MATCH: pattern, COUNT: 100 })) {
        keysToDelete.push(key)
      }
      const flattenedKeys = keysToDelete.flat()

      if (flattenedKeys.length > 0) {
        await redisClient.del(flattenedKeys)
      }

      // 2. Clean up in-memory Room instances to ensure test isolation
      for (const roomKey of Array.from(roomService.manager.rooms.keys())) {
        if (roomKey.startsWith(PATTERN_PREFIX)) {
          const room = roomService.manager.rooms.get(roomKey)
          if (room) await room.destroy() // Ensure Redis unsubscribes
          roomService.manager.rooms.delete(roomKey)
        }
      }
    })

    it('should not allow creating a producer room with a pattern name', async function () {
      expect(() => {
        roomService.createRoom(PATTERN_NAME)
      }).to.throw('Pattern name (*) is not allowed for a producer room.')
    })

    it('should not allow publishing to a pattern room', async function () {
      const patternRoom = roomService.getRoom(PATTERN_NAME)
      try {
        await patternRoom.publish({ data: 'should-fail' })
        // This line should not be reached
        throw new Error('Publishing to a pattern room should have failed but it did not.')
      } catch (err) {
        expect(err.message).to.equal('This room is not a producer. Publishing is not allowed.')
      }
    })

    it('should join a pattern and receive aggregated initial data', async function () {
      // 1. Create and publish to two separate rooms matching the pattern
      const room1 = roomService.createRoom(ROOM_NAME_1, { enableFullData: true })
      const room2 = roomService.createRoom(ROOM_NAME_2, { enableFullData: true })
      await room1.publish({ val1: 100 })
      await room2.publish({ val2: 200 })

      // 2. Get a pattern room that covers the two rooms above
      const patternRoom = roomService.getRoom(PATTERN_NAME, { enableFullData: true })

      // 3. Join the pattern room and verify the initial data is aggregated
      await new Promise((resolve, reject) => {
        patternRoom.join('pattern-user-1', (fullData, newData) => {
          try {
            expect(newData).to.be.null // No "new" data on initial join
            const expectedFullData = { val1: '100', val2: '200' }
            expect(fullData).to.deep.equal(expectedFullData)
            resolve()
          } catch (err) {
            reject(err)
          }
        })
      })
    })

    it('should receive subsequent updates from all matching rooms', function (done) {
      const room1 = roomService.createRoom(ROOM_NAME_1, { enableFullData: true })
      const room2 = roomService.createRoom(ROOM_NAME_2, { enableFullData: true })
      const patternRoom = roomService.getRoom(PATTERN_NAME, { enableFullData: true })

      const update1 = { val1: 111 }
      const update2 = { val2: 222 }

      let callCount = 0

      patternRoom.join('pattern-user-2', async (fullData, newData) => {
        try {
          callCount++
          if (callCount === 1) { // Initial join (data is empty)
            expect(newData).to.be.null
            // Now, trigger an update from the first room
            await room1.publish(update1)
          } else if (callCount === 2) { // Received update from room1
            expect(newData).to.deep.equal(update1)
            expect(fullData).to.deep.equal({ val1: 111 })
            // Now, trigger an update from the second room
            await room2.publish(update2)
          } else if (callCount === 3) { // Received update from room2
            expect(newData).to.deep.equal(update2)
            expect(fullData).to.deep.equal({ val1: 111, val2: 222 })
            done()
          }
        } catch (err) {
          done(err)
        }
      })
    })
  })
})
