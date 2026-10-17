# 技术设计：远程控制插件

本设计对应 `prd.md` 中已定稿的 D1–D6 决策。目标是在不改动 DSH 内部接口的前提下，为 `dsh web` 增加一条受配对门控的远程接入通道。

## 1. 总体架构

```
                 ┌──────────────────────────────────────┐
   手机 / 另一台  │  Remote Gateway（插件自建监听端口）    │
   电脑（已配对）─┼─▶ ① 认证/Cookie ② Origin 校验        │
                 │  ③ 审计记账  ④ 反向代理 + WS 升级      │
                 └───────────────┬──────────────────────┘
                                 │ loopback 转发
                                 ▼
                 ┌──────────────────────────────────────┐
                 │  官方 dsh web（127.0.0.1:3080，不变）  │
                 └──────────────────────────────────────┘

   本机桌面浏览器 ──────────────────────────▶ 官方端口（绕过网关，无需配对）
```

关键点：

- 官方端口**不对外暴露**，插件自建端口是唯一远程入口。未配对请求在到达 DSH 前即被拒绝。
- 本机回环访问完全不走网关，保证"不开启时行为与原生一致"和"本机无需配对"。
- 网关是纯代理 + 鉴权，**不理解 DSH 业务语义**，因此 DSH 升级不会破坏它。

## 2. 进程内组件

插件是单个 Cordis 插件（`apply(ctx)`），宿主侧包含以下模块：

| 模块 | 职责 | 关键约束 |
|---|---|---|
| `gateway/server` | 自建 `http.Server`，监听 `0.0.0.0:<remotePort>` | 端口可配，默认关闭；`ctx.effect()` 注册清理 |
| `gateway/auth` | 解析 Cookie、校验设备令牌、判断本机回环 | 令牌比对用 `crypto.timingSafeEqual` |
| `gateway/origin` | 校验 `Origin` / `Sec-Fetch-Site` | 缺失 `Origin` 的写请求一律拒绝 |
| `gateway/proxy` | HTTP 反向代理 | 流式响应必须边读边写，不能缓冲 |
| `gateway/wsproxy` | WebSocket 升级透传 | 必须处理 `/api/remote.mux` 多路复用连接 |
| `gateway/inner-auth` | 兑换并缓存官方端口的浏览器会话 Cookie | 见 §4.4；令牌等价整个实例，绝不下发给客户端 |
| `pairing` | 配对码生成、兑换、过期 | 一次性；兑换成功即作废 |
| `devices` | 设备存储与吊销 | 原子写；权限 0600 |
| `audit` | JSONL 记账与轮转 | 只记动作与时间，不记正文 |
| `api` | `/remote-control/api/*` 管理接口 | 仅 loopback 可访问 |

### 依赖注入

宿主侧声明 `export const inject = ['webServer']`，用于：

1. 通过 `ctx.webServer.port` 获取官方端口（网关转发目标）。
2. 在自己的端口上独立监听，不复用官方 `WebServer` 实例。

> 不向官方 `WebServer` 注册任何路由——官方端口对外不可达，注册路由没有意义，还会增加与官方路由冲突的风险。

## 3. 认证流程

### 3.1 配对

1. 用户在桌面端打开设备面板，点击"添加设备"。
2. 宿主生成配对码：`code`（8 位 base32，一次性）+ `pairId`，TTL 默认 120 秒。
3. 面板展示二维码，内容形如 `http://<lan-ip>:<port>/remote-control/pair#<pairId>:<code>`。
   - 片段（`#` 之后）不会发送到服务器，避免配对码进访问日志。
4. 手机扫码后，页面把片段里的 `pairId:code` POST 到 `/remote-control/pair`。
5. 宿主校验码有效且未过期 → 生成设备记录与高熵令牌（32 字节随机）→ 通过 `Set-Cookie` 下发 → 作废配对码。
6. 审计记录 `pair`（设备名、来源 IP、UA）。

**设备名**：从 UA 推断（如 "iPhone · Safari"），允许用户在面板中重命名。

### 3.2 请求鉴权

每个远程请求依次判定：

```
1. 来源是本机回环？        → 放行（不要求 Cookie）
2. Cookie 携带有效令牌？    → 进入 3
   否则                    → 401（HTML 导航则重定向到 /remote-control/pair-required 提示页）
3. Origin 校验：
   写请求必须有 Origin 且在同源白名单内
   无 Origin 的写请求一律拒绝（防 CSRF）
4. 令牌对应设备未被吊销？   → 放行，记审计
   已吊销                  → 401 + 清除 Cookie
```

**Cookie 属性**：`HttpOnly; SameSite=Lax; Path=/; Max-Age=<长有效期>`。
不加 `Secure`——局域网是 HTTP，加了 Cookie 根本不会被发送。这一点必须在 README 里明确写出安全边界。

### 3.3 WebSocket 鉴权

WebSocket 升级无法携带自定义头，且浏览器会自动带上 Cookie，因此：

- 升级请求同样走 3.2 的判定（Cookie + Origin）。
- 校验失败直接 `socket.destroy()`，不做 401 响应体。
- 代理侧**不使用 `ws` 库**：网关只做字节透传、不解析帧，用裸 `node:net` 连上游、手写升级请求行、拿到 `101` 后双向 pipe 即可（已实测，见 `research/official-connection-fence.md` §6.1）。这样保持零运行时依赖。
- 上游升级请求同样要带 Host 改写与内层 Cookie（§4.4）。

## 4. 反向代理细节

### 4.1 HTTP

- 上游固定 `http://127.0.0.1:<官方端口>`，**不信任客户端传入的 Host**。
- 转发时改写 `Host` 为上游地址；保留 `X-Forwarded-For` 供审计。
- 请求体直接管道转发，不缓冲。
- 响应：`text/event-stream`、`chunked` 必须透传，禁止启用压缩缓冲。注意官方已支持 gzip，代理要正确处理 `Content-Encoding`，避免二次解压。

### 4.4 内层凭证（官方端口自带鉴权）

**这一节是实测得出的硬约束，实现时不可省。** 详细取证见 `research/official-connection-fence.md`。

官方端口并不裸奔：`@deepseek-ai/dsh-client-connection` 在 `webServer` 之上叠了两道判定，覆盖 `/api`、`/api/remote.mux` 升级、以及 index 响应。远程请求若原样转发，会在这里被拒：

| 判定 | 失败结果 | 触发条件 |
|---|---|---|
| `isTrustedApiRequest` | 403 | Host 非回环且不在 `trustedHosts`；或 `Origin.host ≠ Host` |
| `BrowserAuth.isAuthenticated` | 401 | 缺少 authority 绑定的 `dsh-auth-*` 签名 Cookie（**无回环豁免**） |

所以网关在转发前必须做三件事：

| # | 动作 | 说明 |
|---|---|---|
| A | 把上游 `Host` 改写为 `127.0.0.1:<官方端口>` | 满足回环 Host |
| B | 剥离客户端 `Origin` / `Sec-Fetch-Site` | 否则跨源判定必然失败 |
| C | 注入内层 Cookie `dsh-auth-*` | 由 `ctx.connection.authenticatedUrl()` 兑换 |

**兑换流程**（`gateway/inner-auth`）：

```
url    = ctx.connection.authenticatedUrl(`http://127.0.0.1:${officialPort}/`)
resp   = await fetch(url, { redirect: 'manual' })      // 必须 manual，否则 Set-Cookie 丢失
cookie = resp.headers['set-cookie'] 中以 'dsh-auth-' 开头的 name=value
```

- 兑换出的 Cookie 绑定 `127.0.0.1:<port>`，正好是转发 authority，**可长期缓存复用**。
- 上游返回 401 时失效缓存并重兑**一次**（有界重试，防止死循环）。
- `ctx.connection` 不可用（旧版本）时：不注入 Cookie，401 如实透传给客户端，并在日志里记一次降级告警。

> **安全红线**：内层 Cookie 等价于整个 DSH 实例的完全访问权。它只存在于「网关进程 → 上游」这一跳，**必须**在转发前覆盖掉客户端自带的任何 `Cookie` 中同名项，且不得出现在审计、日志、错误响应中。

### 4.2 WebSocket

- 官方通道：`/api/remote.mux`（`WebSocketServer({ noServer: true })`，由 `registerUpgrade` 独占）。
- 代理需逐条处理 `upgrade` 事件，与上游建立 `ws` 连接后双向 pipe，并转发 `close` / `error`。
- 心跳：官方有 ping/pong 机制，代理必须透传控制帧，不能自己吞掉。

### 4.3 已知风险

- **连接数**：官方单 WebSocket 多路复用，代理每条远程连接对应一条上游连接，数量线性增长，可接受。
- **事件回放**：断线重连依赖官方机制，代理不实现缓冲；重连后由客户端重新拉取。这是 MVP 的明确限制。
- **内层凭证失效**：DSH 重启后启动令牌变化，缓存的内层 Cookie 失效。表现为上游返回 401；`inner-auth` 失效缓存并重兑一次即可恢复，无需重启网关。

## 5. 数据模型

`~/.dsh/remote-control/devices.json`（权限 0600）：

```jsonc
{
  "version": 1,
  "devices": [
    {
      "id": "dev_xxx",
      "name": "iPhone · Safari",
      "tokenHash": "<sha256>",      // 不存明文令牌
      "ua": "...",
      "createdAt": "2026-10-17T...",
      "lastSeenAt": "2026-10-17T...",
      "revokedAt": null
    }
  ],
  "settings": {
    "enabled": false,
    "port": 3090
  }
}
```

- 令牌以哈希存储，明文只在下发时出现一次。
- 写入使用临时文件 + rename 保证原子性。
- 预留 `capabilities` 字段位置但不使用（对应 PRD D6）。

## 6. 审计

`~/.dsh/remote-control/audit-YYYY-MM-DD.jsonl`，每行一个事件：

```jsonc
{ "ts": "...", "event": "send_message", "deviceId": "dev_xxx", "ip": "192.168.1.7", "meta": { "sessionId": "..." } }
```

- 事件类型：`pair`、`connect`、`disconnect`、`send_message`、`stop_task`、`approval_answer`、`revoke`。
- **不记录消息正文、工具参数、文件内容**。
- 保留 30 天，启动时与每日定时各清理一次。
- 导出：面板提供"导出审计"按钮，把记录打包为单个 JSONL 下载（仅 loopback）。

`send_message` / `stop_task` / `approval_answer` 如何识别：网关不认识 DSH 业务语义，**通过匹配路径前缀 + 方法**判定（如 `POST /api/...sendMessage`）。若官方路径变更，审计会降级为 `unknown`——这是有意的取舍，宁可漏记也不耦合内部接口。

## 7. 客户端（Web UI）

- 通过 `package.json` 的 `dsh.client.inject` 注册，宿主导出 `src/index.js`，客户端 `src/client.js`。
- 侧边栏底部常驻图标（对应 PRD 决策），点击打开设备面板抽屉。
- 面板内容：
  1. 开关（启用远程接入）+ 端口设置
  2. 局域网地址展示与可达性提示
  3. "添加设备" → 二维码 + 文本码 + 倒计时
  4. 已授权设备列表：名称、最后在线、来源 IP、吊销按钮
  5. 审计摘要与导出
- 所有管理接口走 `/remote-control/api/*`，**仅接受 loopback 请求**，远程设备即使已配对也不能管理设备。

## 8. 安全边界（必须写进 README）

1. 局域网 HTTP 无传输加密，同网段的被动监听者可看到会话内容。**这是 MVP 的已知限制**，需要 TLS 请自行套反向代理或使用 Tailscale。
2. 令牌等价于该设备的完整操作权（D6 未实现能力白名单）。
3. `SameSite=Lax` + Origin 校验能挡住跨站写请求，但不能挡住同站 XSS 或本机恶意程序。
4. 撤销设备只让新请求失败并关闭其活动连接，不追溯已发生的操作。
5. 关闭插件或杀死进程后，远程端口不再监听；不会留下遗留监听。

## 9. 与官方扩展点的关系

| 官方能力 | 本插件用法 |
|---|---|
| `webServer.register` | **不使用**（官方端口不对外） |
| `webServer.registerUpgrade` | **不使用**（同上） |
| `webServer.port` | 读取，作为上游目标 |
| `ctx.connection.authenticatedUrl` | 用于兑换内层浏览器会话 Cookie（§4.4） |
| `ctx.authorization` | **不使用**（面向凭证获取对话，非请求鉴权） |
| `dsh.bundle.patch` | 用于安装 |
| `dsh.client.inject` | 用于注册 UI |

## 10. 未决与后续

- 能力白名单（PRD 未来版本）：在 `devices[].capabilities` 与网关判定点预留扩展位，实现时只需在 3.2 第 4 步后追加能力判定，无需重构。
- 端到端加密、Relay、外网穿透：不在本项目范围。
- 移动端布局优化：跟随上游，不在此项目内重构。
