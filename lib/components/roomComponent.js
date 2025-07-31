const RoomService = require('../service/roomService')

class RoomComponent {
  constructor (app, opts) {
    this.name = '__room__' // 组件名称
    this.app = app
    this.opts = opts || {}

    // 创建核心服务实例
    this.roomService = new RoomService(app, this.opts)
    // 将服务注册到 app 上下文，方便业务逻辑层调用
    this.app.set('roomService', this.roomService, true)
  }

  /**
   * Pomelo aync start lifecycle callback.
   * @param {function} cb
   */
  async start (cb) {
    await this.roomService.start()
    process.nextTick(cb)
  }

  /**
   * Pomelo stop lifecycle callback.
   * @param {boolean} force
   * @param {function} cb
   */
  async stop (force, cb) {
    await this.roomService.stop()
    process.nextTick(cb)
  }
}

module.exports = RoomComponent
