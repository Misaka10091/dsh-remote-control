# 官方 `dsh web` 的鉴权层：实测结论与对设计的影响

> 调研时间：实施启动时（阶段 0 之前）
> 结论级别：**影响 architecture 的硬约束**，`design.md` §4.1 必须按本文修订。

## 1. 实测现象

直接对运行中的官方端口发请求：

```
GET http://127.0.0.1:19387/
→ 401
  body: "dsh web authentication required; reopen the URL printed by dsh web."
```

即：**官方端口并非"裸奔"，它自带一套浏览器鉴权**。这与 `design.md` §4.1 隐含的前提（网关只需反向代理即可）不一致。

## 2. 鉴权实现位置

不在 `@deepseek-ai/dsh-host-webserver` 里（那个包确实只做路由注册，`design.md` 对它的描述是对的），而在它上面叠的一层：

`@deepseek-ai/dsh-client-connection/lib/index.js`

两处判定，覆盖面很广：

| 位置 | 判定 |
|---|---|
| `/api` prefix 路由 | `connection.admit(req)` → 失败写 401 `unauthorized` / 403 `forbidden` |
| `/api/remote.mux` upgrade | `connection.admit(req)` → 失败 `rejectRemoteStreamUpgrade(socket, rejection)` |
| index 页面 | `connection.authorizeIndex(req, res)` |

### 2.1 第一道：Host / Origin 围栏 `isTrustedApiRequest`

```js
const host = headers.host;
if (host === undefined) return false;                    // 无 Host → 拒
if (!isLoopbackHostname(hostUrl.hostname)               // 必须是回环
    && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
if (headers['sec-fetch-site'] === 'cross-site') return false;
const origin = headers.origin;
if (origin === undefined) return true;                  // 无 Origin → 放行
return new URL(origin).host === hostUrl.host;           // Origin 必须同 Host
```

`trustedHosts` 是 connection 插件的 Config 字段（`z.array(String).default([])`），可按 `host` 或 `host:port` 声明。

### 2.2 第二道：浏览器会话 Cookie `BrowserAuth`

- Cookie 名：`dsh-auth-` + `base64url(sha256(authority))`，**绑定 authority（Host 头）**。
- 值：`v1.<base64url(payload)>.<base64url(HMAC-SHA256(secret, payload))>`，payload 含 `authority` / `issuedAt` / `expiresAt`。
- 签名 secret 持久化在 `credentials` 的 `client-connection/browser-session` 记录里，插件拿不到。
- **没有回环豁免**：`isAuthenticated()` 只比对 Cookie，不看 socket 来源。

进程内有一个**启动令牌**（launch token，`randomBytes(32)`，按 `ctx.root` 存在 WeakMap 里），兑换方式是：

```
GET /?token=<launchToken>   (Host 必须是目标 authority)
→ 303, Set-Cookie: dsh-auth-...=v1....
```

`authorizeIndex` 只在 `GET` + `pathname === '/'` + 恰好一个 `token` 参数时兑换。

### 2.3 可用的进程内接口

`ctx.connection`（Host 侧 Service）导出：

- `authenticatedUrl(baseUrl)` — 把启动令牌拼进 URL。
- `admit(req)` / `requestRejection(req)` / `authorizeIndex(req, res)`。

## 3. 对网关的直接影响

远程设备的请求转发到 `127.0.0.1:<官方端口>` 后，会**在官方层被 401**，因为：

1. 远程设备没有 `dsh-auth-*` Cookie，也拿不到签名 secret；
2. 浏览器发出的 `Origin` 是 `http://<lan-ip>:<gateway-port>`，与上游 authority 不一致，直接 403。

因此网关必须在转发前做三件事（缺一不可）：

| # | 动作 | 原因 |
|---|---|---|
| A | 把 `Host` 改写为 `127.0.0.1:<官方端口>` | 满足 `isLoopbackHostname`，避免 403 |
| B | 剥离 `Origin`、`Sec-Fetch-Site`（或置为同源安全值） | 否则 `origin.host !== hostUrl.host` → 403 |
| C | 注入**内层 Cookie**：用 `ctx.connection.authenticatedUrl()` 兑换一次启动令牌，缓存得到的 `dsh-auth-*` | 否则 `isAuthenticated()` 失败 → 401 |

### 3.1 内层 Cookie 的兑换与缓存

```
url  = ctx.connection.authenticatedUrl(`http://127.0.0.1:${officialPort}/`)
resp = GET url (redirect: 'manual')
cookie = 从 Set-Cookie 中取以 `dsh-auth-` 开头的那个 name=value
```

- 必须 `redirect: 'manual'`，否则 303 被跟随、Set-Cookie 丢失。
- Cookie 绑定 `127.0.0.1:<port>`，正好等于我们转发的 authority，因此**一次兑换可长期复用**。
- 进程重启后令牌变化 → 收到 401 时失效缓存并重兑一次（有界重试，避免死循环）。

这个模式在 `@linxin666/dsh-remote-web-ui` 的 `src/inner-auth.ts` 里有先例，注释明确了同样的原因：
「the connection plugin's route enforces the harness browser-auth cookie … a cookie minted for the device's own authority can never satisfy the inner check」。

### 3.2 WebSocket 同样需要

`/api/remote.mux` 的 `admit(req)` 与 HTTP 走同一套判定，所以 `wsproxy` 的升级请求也必须带上 A + B + C，否则 `socket.destroy()`。

## 4. 结论：设计需要修订的点

1. `design.md` §4.1 增补「内层凭证」小节，明确 A/B/C 三件事与兑换/重试策略。
2. `design.md` §2 组件表增补 `gateway/inner-auth` 模块（职责：兑换、缓存、失效重兑）。
3. `design.md` §9「与官方扩展点的关系」补一行：`ctx.connection.authenticatedUrl` 用于签发内层凭证。
4. `prd.md`「已确认的技术前提」中「现有路由注册后请求直接进入 handler，WebServer 本身没有请求拦截钩子」需修正为：WebServer 无钩子，但 **connection 插件在其上叠了 Host/Origin 围栏 + 浏览器会话 Cookie**，覆盖 `/api`、`/api/remote.mux`、index 三处。
5. 安全边界补充：内层 Cookie 是**整个 DSH 实例的完全访问凭证**，网关必须保证它绝不下发给远程客户端（只存在于服务端到上游之间）。审计与日志都不得打印它。

## 5. 待确认

- `remote-web-ui` 当前用 lan-bind 把官方 `webServer.host` 改成了 `0.0.0.0`，与 PRD D1「官方端口保持 127.0.0.1」冲突。本插件不负责改回（那是另一个插件的配置），但网关必须对「官方端口是否对外可达」保持无假设。

## 6. 实施期补充实测（可执行验证）

以下三条都是跑代码验证过的，不是推断。写代码时直接按结论执行。

### 6.1 WebSocket 代理不需要 `ws` 依赖

用裸 `node:net` 实测通过：

```
上游 http.Server 监听 'upgrade' → 网关手动写 GET /api/remote.mux HTTP/1.1 ... 到上游 TCP
→ 上游回 "HTTP/1.1 101 Switching Protocols"
→ 网关收到 101 与后续字节
```

结论：网关**只做字节透传，不解析帧**，所以 `ws` 库是多余的。`package.json` 保持**零运行时依赖**。

同时也验证了：同一个 `http.Server` 上，普通 HTTP 请求与 `'upgrade'` 事件互不干扰；拒绝升级时在 upgrade 处理器里手写一行 `HTTP/1.1 401 Unauthorized\r\n\r\n` 再 `socket.destroy()` 即可。

### 6.2 `timingSafeEqual` 必须先 hash

```
直接比较不同长度的 Buffer → 抛 ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH
先各自 sha256 再比较     → 返回 false，不抛错
```

这就是 `tokens.js` 必须「两侧都 hash 后再比」的原因——否则一个长度不正确的恶意令牌会变成未捕获异常。

### 6.3 Windows 上原子写可行，chmod 不可行

```
fs.renameSync(tmp, target) 覆盖已存在文件 → 成功（Windows 与 POSIX 行为一致）
```

但 `chmod 0600` 在 Windows 上是 no-op。`store.js` 必须吞掉 chmod 的错误，不能让它变成启动失败。

### 6.4 desktop profile 无法用 CLI 安装插件

```
dsh plugin --profile desktop add ... → error（rejectElectronProfile）
```

`desktop` profile 由 Electron 独占管理，CLI 里 `rejectElectronProfile` 直接拒绝。
**阶段 0 的安装验收必须用 `web` profile**：`dsh plugin --profile web add link:<repo 绝对路径>`。

## 7. 阶段 1 复盘：发现的安全缺口

### 7.1 配对码没有尝试次数限制（需在阶段 2/4 修复）

**实测**：对同一 `pairId` 连续提交 5 次错误 `code`，全部返回 `pairing/invalid-code`，**没有任何计数或锁定**；之后正确的 `code` 仍然可以兑换。

```
5 次错误尝试后: pairing/invalid-code  尝试计数= 5
正确 code 仍可兑换 -> 无限爆破可行
```

**风险量化**：

| 项 | 值 |
|---|---|
| `pairId` 熵 | 9 字节 = 72 bit（不可猜） |
| `code` 熵 | 32^8 = 40 bit（约 1.1e12） |
| 120s 内穷举所需速率 | 约 9.2e9 req/s（单机不可行） |

所以**全量穷举不成立**。真正的风险是另外三条：

1. **在线定向爆破**：若 `pairId` 从别处泄露（共享链接、截图、浏览器历史、Referer），40 bit 在已知 pairId 下变成可攻击面。
2. **无频率限制 = DoS 面**：`redeem` 是纯 CPU 的低成本路径，可被用来刷爆网关。
3. **爆破不可见**：失败的兑换尝试不进审计，用户无法察觉有人在试。

**修复要求**（写进阶段 2/4）：

- 每个 `pairId` 记录失败次数，超过阈值（建议 5 次）直接作废该 pair，返回 `pairing/locked`。
- 建立**来源 IP 级**的失败速率限制（与 pairId 级限制独立，防止换 pairId 绕过）。
- 失败的兑换尝试写审计 `unknown` 或新增 `pair_failed` 事件，便于用户发现异常。
- 这些状态目前都在 `pairing.js` 的内存 Map 里，加计数不会改变它的纯函数性质（`now` 已可注入）。

> 这条**不属于阶段 1 的交付范围**（阶段 1 只要求「兑换成功/重复兑换失败/过期失败/令牌比对」），但必须在阶段 2 网关落地时一并解决，否则等于带着已知缺口上线。
### 7.2 `touchDevice` 是每次全量同步写盘（阶段 2 必须处理）

**实测**（本机 Windows，200 次连续调用）：

```
200 次 touchDevice 耗时: 1411.8 ms => 7.06 ms/次
若网关每请求都调用，1000 req/s 就是 7059 ms/s 的纯磁盘同步开销
```

`touchDevice` 走的是 `read()` → 改字段 → `write()` 全量原子写（temp + fsync + rename）。这在「配对时写一次」的场景下完全正确，但网关的每个远程请求都要刷新 `lastSeenAt`（`design.md` §3.2 第 4 步、`prd.md` R4 要求展示「最后在线」），**逐请求调用等于把吞吐锁死在约 140 req/s**，而且每次都要 fsync，对 SSD 也不友好。

**修复方向**（阶段 2 实现网关时处理，不要在阶段 1 改）：

- `lastSeenAt` 改为**内存节流**：进程内记录 `deviceId → 上次落盘时间`，距上次落盘不足 N 秒（建议 30s）就只更新内存值、不写盘。
- 进程退出 / 设备吊销 / 面板打开时强制 flush 一次，保证用户看到的「最后在线」不会过时太多。
- 这也符合 `design.md` §4.3 的取向：网关是性能敏感路径，领域模块的正确性优先于调用便利。

> 同样属于「阶段 1 的接口在阶段 2 会暴露成瓶颈」的类型，和 §7.1 一起在阶段 2 处理。
### 7.3 时序侧信道评估（结论：不构成风险，不修）

**实测**（各 20000 次采样取中位数）：

```
未知 pairId 中位数: 900 ns
错误 code  中位数: 4200 ns   （4.67x）
```

差异来自「未知 pairId」走的是 Map 命中失败、而「错误 code」要走 `normalizePairingCode` + 两次 sha256 + `timingSafeEqual`。

**为什么不修**：

1. 差异只有 3.3 微秒，而远程一次请求要穿过 TCP 栈抖动（数十~数百微秒）、HTTP 解析（数十微秒）、事件循环调度（数十微秒~毫秒），信号被噪声淹没数十到数百倍，**远程无法可靠测量**。
2. 即便如此，错误码本身已经把「未知 pairId → `pairing/unknown`」与「错误 code → `pairing/invalid-code`」直接告诉了调用方——这是设计上有意区分的（便于用户排查是「码过期了」还是「码输错了」）。时序泄露的信息量不比错误码更多。
3. 真要消掉它，得给未知 pairId 也做一次假比较，纯属增加复杂度换一个已经被错误码公开的信息。

> 记录下来是为了避免后续 reviewer 把它当新发现反复提出。**这是已知且接受的取舍。**
## 8. 阶段 1 复核（trellis-check）结论与我的独立验证

复核发现 **1 个真实安全缺陷 + 7 处问题**，测试 71 → 82。以下是我逐项独立复验的结果。

### 8.1 已确认修复的安全缺陷：`verifyToken` 接受非哈希的「哈希」

**原缺陷**：`toDigest()` 把任何非摘要字符串也走一遍 `hashToken`，于是比对两侧同时被哈希：

```
verifyToken('hunter2', 'hunter2') === true     // 修复前
```

配合 `store.js` 当时接受任意非空字符串当 `tokenHash`，**手写一个字段进 `devices.json` 就能用该字面量认证**，完全绕过「只存哈希」的保证，且不留痕迹（因为从未签发过明文令牌）。

**复验（修复后）**：

```
verifyToken('hunter2','hunter2') = false       ✓
verifyToken('x','x')             = false       ✓
verifyToken('realtoken', hash)   = true        ✓
verifyToken('wrong', hash)       = false       ✓
store.addDevice({tokenHash:'hunter2'}) → store/invalid-device   ✓
```

补强：`findActiveDeviceByTokenHash` 原先用 `===` 比对摘要（早退），现已走 `sameTokenHash()` 的 `timingSafeEqual`。这一点很重要——`tokens.js` 常量时间、而真正跑在热路径上的那一处却非常量时间，等于白做。

### 8.2 已确认修复的其他问题（我抽查了两项）

| 问题 | 修复 | 我的复验 |
|---|---|---|
| 注入 RNG 返回短缓冲 → code 含字面量 `undefined` | 抛 `pairing/entropy` | 已复验：短缓冲抛 `pairing/entropy` ✓ |
| `assert.ok(() => JSON.parse(raw))` 是永真式 | 改为真实解析 + 内容断言 | 已复验：见 `tests/store.test.mjs:144` ✓ |
| `devices.map(normalizeDevice)` 把数组下标当第二参数 → `error.code === 0` | 具名箭头 + 内部防御 | 复核报告提供，未单独复验 |
| `writeSync` 忽略返回值，短写会发布截断文档 | 按 offset 循环 | 复核报告提供，未单独复验 |
| `pending()` 把已消费的 pair 也算进去 | 只计「活着且未用」 | 复核报告提供，未单独复验 |
| 加载行把已吊销设备算成已配对 | 只计 active | 复核报告提供，未单独复验 |

### 8.3 测试「能失败」的独立抽查

我自己做了一次（不是复述复核的结论）：

```
破坏 tokens.js 的 tokenHash 校验 → ℹ pass 71 / fail 11
还原                            → ℹ pass 82 / fail 0
```

### 8.4 `inject: ['webServer']` 声明但未使用 —— 安全，非加载风险

我用真实 Cordis 4.0.4 独立探测：

```
apply 执行次数: 0  (webServer 未提供时)
fiber state: 0     (PENDING，不是 FAILED)
```

即：注入的服务不可用时，插件**不会加载失败**，只是 `apply` 不执行、fiber 停在 PENDING。等 `webServer` 就绪后自动激活。所以阶段 0 就能安全地声明它。

### 8.5 复核报告的一处误判：版本号

复核称「实际安装的 dsh 是 0.1.5-rc.1，而 manifests 声明 `>=0.2.0-rc.2`，广告了一个与其运行宿主不兼容的下限」。

**这是读错了。** 实测：

```
dsh --version          → 0.2.0-rc.2
@deepseek-ai/dsh       → 0.2.0-rc.2
dsh-client-connection  → 0.2.0-rc.2
dsh-host-webserver     → 0.2.0-rc.2
cordis                 → 4.0.4
```

`engines.dsh: ">=0.2.0-rc.2"` 与实际宿主**完全一致，不需要改**。

> 教训：涉及版本号的结论必须用 `dsh --version` 或直接读 `package.json` 复验一次，不要从二手信息推断。