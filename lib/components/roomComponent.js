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
  start (cb) {
    this.roomService.start(cb)
  }

  /**
   * Pomelo stop lifecycle callback.
   * @param {boolean} force
   * @param {function} cb
   */
  stop (force, cb) {
    this.roomService.stop(force, cb)
  }
}

module.exports = function (app, opts) {
  const component = new RoomComponent(app, opts)
  app.set('roomComponent', component, true)
  return component
}
