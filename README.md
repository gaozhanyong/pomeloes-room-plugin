# Pomeloes Room Plugin

一个为 Pomelo 框架设计的高性能房间数据同步插件。它利用 Redis 的 Pub/Sub、Hash 和 List 结构，在分布式服务器集群中高效地同步和管理房间状态，并能自动管理闲置房间的生命周期以节约资源。

## ✨ 功能特性

-   **实时数据同步**: 基于 Redis Pub/Sub 实现低延迟的房间数据广播。
-   **持久化状态存储**: 使用 Redis Hash 存储房间的最新全量状态。
-   **事件历史记录**: 可选地使用 Redis List 记录最近的 N 条发布事件，适用于需要历史回溯的场景。
-   **模式订阅 (Pattern Subscription)**: 支持使用通配符 (`*`) 订阅一类房间，聚合接收所有匹配房间的数据。
-   **自动化生命周期管理**: `RoomManager` 会自动巡检并清理长时间无人订阅的闲置房间，释放服务器和 Redis 资源。
-   **优雅的并发处理**: 内置初始化锁，能正确处理多个用户在同一时刻加入房间的并发竞争问题。
-   **单例房间实例**: 确保在单个服务器进程中，同一个房间 ID 只对应一个 `Room` 实例，保证了数据和状态的一致性。
-   **高度可配置**: 支持自定义 Redis 连接、Key 前缀、闲置超时时间等。
-   **清晰的 API**: 提供简洁的生产者 (`createRoom`) 和消费者 (`getRoom`) 模型。
-   **无状态发布支持**: 通过 `publish` 方法直接向房间发布数据，无需实例化房间。

## 🚀 安装

```bash
npm install git+ssh://git@github.com:<your-github-username>/pomeloes-room-plugin.git
```

> ⚠️ 本项目为私有项目，需确保你有对应仓库的访问权限，并已配置 SSH Key 到 GitHub 账户。

## ⚙️ 配置与使用

在您的 Pomelo 项目的 `app.js` 中，加载并配置插件。例如：

```js
// app.js
app.configure('production|development', function () {
    app.use(require('pomeloes-room-plugin'), {
        redis: { host: '127.0.0.1', port: 6379 },
        prefix: 'room',
        idleTimeout: 600, // 房间闲置超时秒数
    });
});
```

## 📖 API 参考

### 获取服务

在您的 handler 或 remote 中，通过 `app` 上下文获取 `roomService` 实例。

```js
const roomService = app.get('roomService');
```

### RoomService API

#### `roomService.createRoom(name, [opts])`

**生产者方法**。创建一个用于**发布数据**的房间实例。

-   `name` (string): 房间的唯一名称。
-   `opts` (object, 可选): 房间的特定配置。
    -   `enableFullData` (boolean): 是否启用全量数据存储。
    -   `historyLength` (number): 历史记录长度。
-   ✨ **生命周期**: 通过此方法创建的房间被视为“生产者”，**不会**因为没有订阅者而被闲置清理程序自动销毁。

#### `roomService.getRoom(name, [opts])`

**消费者方法**。获取一个用于**订阅数据**的房间实例。

-   `name` (string): 房间的唯一名称或模式（支持通配符 `*`）。
-   `opts` (object, 可选): 房间的特定配置。
    -   `enableFullData` (boolean): 是否启用全量数据存储。
    -   `historyLength` (number): 历史记录长度。
-   ✨ **模式订阅**: 当 `name` 包含通配符 (`*`) 时，插件会自动进入**模式订阅**模式。

#### `roomService.publish(name, data, [opts])`

直接向指定房间发布数据，无需实例化房间。

-   `name` (string): 房间的唯一名称。
-   `data` (object): 要发布的数据。
-   `opts` (object, 可选): 发布选项。

### Room 实例 API

#### `room.publish(data, [opts])`

**生产者方法**。向房间发布一条新数据。

-   `data` (object): 要发布的数据。
-   `opts` (object, 可选): 发布选项。

#### `room.join(userId, onDataCB, [extraData])`

**消费者方法**。让一个用户加入（订阅）房间以接收数据。

-   `userId` (string|number): 用户的唯一标识。
-   `onDataCB` (function): 数据回调函数，签名如下：
    -   `function(fullData, newData, extraData)`
        -   `fullData` (object): 最新的全量 Hash 数据。
        -   `newData` (object|null): 此次新收到的数据。在首次 `join` 成功时，此参数为 `null`。
        -   `extraData` (*): `join` 时透传的附加数据。
-   `extraData` (*, 可选): 希望在回调时透传的任何附加数据。

#### `room.leave(userId)`

**消费者方法**。让一个用户离开（取消订阅）房间。

-   `userId` (string|number): 用户的唯一标识。

#### `room.getFullData()`

获取该房间当前最新的**全量 Hash 数据**。

**返回**: `Promise<object>`

#### `room.getHistoryData()`

获取该房间当前最新的**全量 List 数据**。

**返回**: `Promise<Array>`

#### `room.destroy()`

销毁房间，释放资源。

## 💡 完整用法示例

### 普通房间

```js
// handler/chatHandler.js
module.exports = function(app) {
    return {
        send: async function(msg, session, next) {
            const roomService = app.get('roomService');
            const room = roomService.createRoom('chat', { enableFullData: true, historyLength: 20 });
            await room.publish({ userId: session.uid, text: msg.text });
            next(null, { code: 200 });
        },
        join: function(msg, session, next) {
            const roomService = app.get('roomService');
            const room = roomService.getRoom('chat', { enableFullData: true, historyLength: 20 });
            room.join(session.uid, (fullData, newData, extraData) => {
                console.log('全量数据:', fullData);
                console.log('新数据:', newData);
                console.log('额外数据:', extraData);
            });
            next(null, { code: 200 });
        }
    };
};
```

### Pattern 模式（订阅一类房间）

```js
// 订阅所有以 chat 开头的房间
const roomService = app.get('roomService');
const patternRoom = roomService.getRoom('chat*', { enableFullData: true, historyLength: 20 });
patternRoom.join('user1', (fullData, newData, extraData) => {
    console.log('聚合全量数据:', fullData);
    console.log('新数据:', newData);
});
```

## ✅ 测试

项目包含一套完整的单元测试和并发性能测试。

1. **安装依赖**

    ```bash
    npm install
    ```

2. **运行标准测试**

    ```bash
    npm test
    ```

3. **运行并发性能测试**

    脚本支持通过 `--concurrency` 参数指定并发用户数。

    ```bash
    node test/room.test.js --concurrency=100
    ```
