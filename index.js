const RoomComponent = require('./lib/components/roomComponent')

module.exports = function (app, opts) {
  const component = new RoomComponent(app, opts)
  // 将组件实例注册到 app 上下文，使其生命周期由 pomelo 管理
  app.set('roomComponent', component, true)
  return component
}
