# Error Handling

> How errors are handled in this project.

---

## Overview

本项目的错误处理有两条完全不同的路径，不要混用：

1. **网关请求路径**（`src/host/gateway/*`）——错误是**响应**，不是异常。任何拒绝都要变成确定的状态码，绝不能让异常冒泡到 `http.Server` 的顶层。
2. **插件启动路径**（`src/index.js` 的 `apply`）——错误是**致命**的。配置非法、端口占用必须在启动时大声失败，不能静默降级让用户以为远程可用。

---

## Error Types

不自定义 Error 子类。用**带 `code` 字段的普通 Error**，`code` 是稳定的字符串常量：

```js
const error = new Error('pairing code expired')
error.code = 'pairing/expired'
throw error
```

理由：错误要跨进程/跨日志边界读取，`instanceof` 在动态加载场景不可靠，`code` 可序列化、可断言。

`code` 命名用 `模块/原因` 形式。模块前缀是固定几个（源码里可按 `'$prefix/$reason'` 枚举出来，不要新造同类前缀），真实取值由各模块的构造点定义：

| 前缀 | 真实例子 |
|---|---|
| `pairing/` | `expired`、`used`、`invalid-code`、`locked`、`source-locked`、`entropy`、`body-too-large`、`unsupported-media-type` |
| `store/` | `corrupt`、`version-unsupported`、`unreadable`、`write-failed`、`invalid-device`、`duplicate-device` |
| `token/` | `claims`、`entropy`、`key` |
| `audit/` | `invalid-action`、`invalid-cursor`、`invalid-limit`、`unknown-event`、`write-failed`、`no-directory` |
| `gateway/` | `unauthenticated`、`cross-origin`、`untrusted-origin`、`device-revoked`、`admin-not-here`、`upstream-timeout`、`upstream-unreachable`、`proxy-failed`、`invalid-upstream`、`pairing-disabled` |
| `tunnel/` | `binary-missing`、`token-missing`、`token-invalid`、`url-missing`、`no-port`、`spawn-failed`、`start-timeout`、`exited`、`busy`、`download-failed`、`unsupported-platform`、`storage` |
| `admin/` | `loopback-only`、`cross-origin`、`invalid-access`、`invalid-settings`、`invalid-tunnel`、`tunnel-action`、`tunnel-no-gateway`、`tunnel-busy`、`tunnel-download-failed`、`tunnel-storage`、`tunnel-unavailable`、`unknown-device`、`listener-failed`、`body-too-large`、`method-not-allowed` |

新增 code 之前先确认语义落在这六个前缀里的哪一个：同一个语义在两个前缀下各叫一次，排查时就会被当成两件事。

---

## Error Handling Patterns

### 网关请求路径

每个请求的判定顺序固定，拒绝即返回，不再往下走：

```js
// 1. 鉴权失败 → 401，HTML 导航则 302 到提示页
// 2. Origin 校验失败 → 403
// 3. 上游失败 → 502，透传上游状态码而非吞掉
```

规则：

- **不得**把内部错误信息（文件路径、上游 URL、令牌摘要）写进响应体。响应体只放人类可读的一句 + 错误码。
- 代理转发时响应 `.pipe()` 的 `error` 事件必须监听，否则连接泄漏；出错时 `res.destroy()`。
- 已 `headersSent` 时不能再 `writeHead`，改为 `res.destroy()`。
- WebSocket 鉴权失败直接 `socket.destroy()`，不发响应体。
- 管理 API 的 Origin 判定走 `origin.js#checkAdminOrigin`，比网关的 `checkOrigin` 多一条「无 `Origin` 时接受面板标记头 `x-dsh-remote-control-panel`」分支（桌面壳转发会删掉 `Origin`）。网关侧**绝不** re-export 它（`gateway/origin.js` 的注释与测试都守这条），因为网关对局域网可达、且会替调用方补齐内层凭证。

### 插件启动路径

`apply` 中凡是不满足前提的，抛错让 Cordis 记录 FAILED fiber，不要 `try/catch` 后继续：

```js
// 对：端口被占用 → 启动失败，用户立刻知道
// 错：catch 后 console.warn，用户以为远程开着其实没监听
```

唯一允许降级的是**可选能力**：`ctx.connection` 缺失（内层凭证降级）与 Cloudflare Tunnel 起不来（外部进程/网络/Token 问题）。降级时必须在日志里 `warn` 一次，并让该能力在面板上显示为不可用，而不是假装工作。隧道失败的状态走 `GET /tunnel` 的 `state: "failed"` + `error.code`，**不是** HTTP 500：请求本身成功了（设置已保存、尝试已做出）。

---

## API Error Responses

`/remote-control/api/*` 统一返回：

```jsonc
{ "ok": false, "error": { "code": "pairing/expired", "message": "配对码已过期" } }
```

成功：

```jsonc
{ "ok": true, "data": { } }
```

字段名固定 `ok` / `data` / `error`，与 `dsh-git-panel` 的 `/dsh-git-panel/api` 保持一致，便于复用客户端习惯。

---

## Common Mistakes

- **在代理路径里 `throw`。** 请求上下文里抛异常只会打到 `http.Server` 顶层，客户端拿到的是连接重置而不是可诊断的状态码。
- **把上游 401 当成自己的鉴权失败。** 官方 401 说明内层凭证失效（见 `research/official-connection-fence.md`），应重兑一次；把它当设备未授权会误导排查方向。
- **`writeHead` 之后再 `writeHead`。** 必须判断 `res.headersSent`。
- **静默吞掉 store 读取失败。** `devices.json` 损坏时应报 `store/corrupt` 并拒绝启动远程能力，而不是当成空设备表——那等于静默放行/静默锁死。
- **错误信息里带令牌。** 任何 `message` 都不得包含设备令牌、内层 Cookie、配对码明文。
