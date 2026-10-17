# 执行计划：远程控制插件

对应 `prd.md`（需求）与 `design.md`（设计）。按阶段推进，每阶段有独立验收点。

## 阶段 0：工程骨架

- [ ] `package.json`：包名 `@misaka10091/dsh-remote-control`、`type: module`、`dsh.bundle.patch`、`dsh.client.inject`、`files` 清单
- [ ] `dsh.plugin.json`：id `dsh-external/dsh-remote-control`、`contributes`
- [ ] `cordis.patch.yml`：bundle patch 插入行
- [ ] 目录骨架 `src/host/`、`src/client/`、`tests/`
- [ ] `.gitignore` 补充运行时目录
- **验收**：`dsh plugin --profile web add <path>` 可安装，启动后打印一行加载日志，无报错

## 阶段 1：设备存储与配对

- [ ] `src/host/store.js`：`devices.json` 读写、原子写、0600 权限
- [ ] `src/host/pairing.js`：配对码生成（8 位 base32）、TTL、一次性兑换
- [ ] `src/host/tokens.js`：令牌生成（32 字节）、sha256 哈希、`timingSafeEqual` 比对
- **验收**：单测覆盖——兑换成功、重复兑换失败、过期失败、令牌比对正确

## 阶段 2：网关 HTTP 侧

- [x] `src/host/gateway/server.js`：自建 `http.Server`，可配置端口，`ctx.effect()` 清理
- [x] `src/host/gateway/auth.js`：Cookie 解析、令牌校验、loopback 判定
- [x] `src/host/gateway/origin.js`：Origin / Sec-Fetch-Site 校验，无 Origin 写请求拒绝
- [x] `src/host/gateway/inner-auth.js`：兑换/缓存/失效重兑内层 `dsh-auth-*` Cookie（见 `research/official-connection-fence.md`）
- [x] `src/host/gateway/proxy.js`：上游转发，Host 改写、Origin 剥离、内层 Cookie 注入，SSE/chunked 透传
- **验收**：curl 验证——无 Cookie 401、伪 Origin 403、带 Cookie 200 且内容与直连一致

> **注意**：跳过 `inner-auth` 时，带正确设备 Cookie 的请求仍会在官方层被 401（无回环豁免）。这是阶段 2 最容易被误判为"代理写错"的坑。

> **实施记录（阶段 2 完成）**：
> - 除上述五个模块外，另加两个：`activity.js`（`lastSeenAt` 节流，见下方补充）与 `wire.js`（响应写出、Cookie 序列化的统一出口，保证"绝不二次 `writeHead`"）。
> - **Origin 判定取舍**：`design.md` §3.2 的"无 Origin 写请求一律 403"如果按字面无条件执行，会把同源 POST 与 `curl` 一起打死。实际实现为四条分支：`Sec-Fetch-Site: cross-site` 无条件 403；有 Origin 时校验 `origin.host === Host`；无 Origin 但声明 `same-origin`/`same-site` 放行；无 Origin 且无 `Sec-Fetch-Site` 403。理由写在 `origin.js` 顶部注释里。
> - **端口覆盖**：`apply(ctx, config)` 支持 `config.port` / `config.host` 覆盖存储里的端口，测试用 `port: 0` 绑定 OS 分配端口，绝不占真实端口。
> - 测试 82 → 232。

> **阶段 2 复核（trellis-check）发现并修复 7 处，测试 232 → 249**：
>
> 1. **回环豁免绕过 Origin 围栏（安全，最严重）**：`authorize` 的回环分支直接 `return ALLOW`，围栏根本没跑。因为网关正是那条「注入 `dsh-auth-*` + 剥离 `Origin`/`Sec-Fetch-*`」的跳，于是任意网页向 `http://127.0.0.1:<网关端口>/api/…` 发一个**免预检**的 `POST`（`text/plain` 或 `enctype=text/plain` 表单，浏览器 `Host` 由 URL 决定、就是回环），实测返回 **200 且已对 DSH 执行**，上游收到的是带内层凭证、无 `Origin` 的已认证写。`SameSite=Lax` 无效——豁免本就不要求 Cookie。修法：回环分支仍然免**凭证**（`prd.md` R3 不变），但必须过围栏；本地读、本地同源写（`Sec-Fetch-Site: same-origin` 或 Origin 匹配）照常放行，只有「本机且未声明来源的写」被拒。
> 2. **`X-Forwarded-For` 可伪造**：`peerAddress` 在 socket 无 `remoteAddress` 时返回 `undefined`，而 `forwardingHeaders` 只在 peer 是字符串时才写该头，于是客户端自带的 `x-forwarded-for` 原样透传——实测可任选「上游与审计以为你来自哪个 IP」。修法：把所有 `x-forwarded-*` / `x-real-ip` / `forwarded` 等一律丢弃后由本跳重写。
> 3. **内层凭证兑换无超时**：`fetch` 没有 signal，而并发调用被合并到同一个 in-flight promise，所以上游「接了连接但不回」会让**每一个**远程请求永久挂起——实测 3 个并发请求全部悬挂。`upstreamTimeoutMs` 覆盖不到这一跳。修法：加 `AbortSignal.timeout`（`INNER_AUTH_EXCHANGE_TIMEOUT_MS`，5s）。
> 4. **客户端在响应头之前断开 → 上游 socket 被扣住**：实测 GET 客户端中断只触发 `req`/`res` 的 `end`/`close`，**不触发 `error`**，故原有的 `req.on('error')` 钩子不生效，上游 `ClientRequest` 一直连到它的 head 超时（默认 120s）。局域网客户端可以「开一个丢一个」把上游 socket 一个个扣两分钟。修法：等待阶段额外绑到 `res` 的 `close`。
> 5. **`extractInnerCookie` 解析不了逗号拼接的 `set-cookie`**：`headers.get('set-cookie')` 在 undici 上返回的是 `", "` 拼接串而非数组（实测），凭证不在第一位时永远找不到 → 表现为永久静默 401。修法：优先 `getSetCookie()`，回退时按逗号逐段扫描。
> 6. **`activity.flush` 静默丢失最后一次写盘**：原先先 `delete` 再 `touch`，写盘抛错就把该设备从 pending 里丢掉——正好是「进程退出时保住最后 30 秒活动」这条要防的事。修法：成功后才 `delete`，失败留在 pending 等下次。
> 7. **`pairing` 的源级失败表无界增长**：`pruneSource` 只清被查询的那一条，扫过即弃的源会永久占位。修法：记录失败时做一次全局过期清扫（只删已过窗口的条目，不可能放宽预算）。
>
> 另修：`isLoopbackHostname` 不认裸 `::1`（socket 侧就是这种拼写），IPv6 回环监听上的本机请求会被误要 Cookie。
>
> 测试能失败的抽查（各自单独破坏实现确认变红后还原）：回环围栏、转发头丢弃、兑换超时、`flush` 顺序、拼接 `set-cookie`、源级清扫——6 项全部变红。

## 阶段 3：网关 WebSocket 侧

- [x] `src/host/gateway/wsproxy.js`：升级鉴权 + 双向帧透传
- [x] 处理 `/api/remote.mux` 多路复用连接（upgrade 同样需要 Host 改写 + 内层 Cookie，见 `design.md` §4.4）
- [x] ping/pong 控制帧透传
- **验收**：远程浏览器能收到流式输出；断线后重连可用

> **实施记录（阶段 3 完成）**：
> - **不引入 `ws`**：`http.Server` 的 `'upgrade'` 事件 → `net.connect` 上游 → 手写请求行与头 → 收到 `101` 后双向 `pipe` 原始字节。网关不解析帧，因此控制帧（ping/pong/close）天然透传。零运行时依赖保持。
> - **升级 Origin 校验是独立且更严的入口**：`origin.js` 新增 `checkUpgradeOrigin()`，`checkOrigin()` 一行未改。差别只有一条，但它是关键的一条——**只要带了 `Origin` 就必须与 `Host` 同源**，不像读请求那样可以忽略。原因见下方 CSWSH 小节。`auth.js` 的 `authorize()` 新增 `upgrade` 参数，通过内部的 `fenceFor()` 选择围栏，**判定点仍然只有 `authorize()` 一处**。
> - **A/B/C 三件事复用 `proxy.js` 的 `upstreamHeaders()`**，不另写一份头构造器，避免两条路径的围栏要求漂移。升级路径额外补回本跳自己的 `connection: Upgrade` / `upgrade: websocket`，并删掉 `content-length` / `content-type`（握手没有 body）。
> - **吊销即时生效**：`createSocketRegistry()` 按 `deviceId` 记录活动 socket，**在第一个 `await` 之前**注册（否则凭证兑换窗口内吊销不生效）。`server.js` 暴露 `gateway.revokeDevice(id)`，一次调用完成「写存储 + 关活动 socket」，供阶段 4 面板调用。`close()` 也会 `closeAll()`——`server.closeAllConnections()` 明确不覆盖已升级的 socket。
> - 测试 249 → 282。

> **阶段 3 实测：WebSocket 特有的 CSWSH 漏洞（已修）**
>
> 升级请求就是一个 `GET`，而 `checkOrigin()` 对读请求是宽松的：只在 `Sec-Fetch-Site: cross-site` 时拒，**带了 Origin 但不带 Sec-Fetch-Site 时放行**。实测这三种组合：
>
> ```
> GET + Origin=http://evil.com (无 Sec-Fetch-Site)  -> {"ok":true}   ← 放行
> GET + Origin=evil + cross-site                    -> {"ok":false}
> GET + Origin 同源                                  -> {"ok":true}
> ```
>
> 对普通 HTTP GET 这只是读；但 WebSocket 有三点不同：**没有 CORS 预检**（浏览器直接连）、**一定带 Origin 但不保证带 Sec-Fetch-Site**、**连接是双向持久的**（可读走全部流式输出、可代表受害者发指令）。实测在 `'upgrade'` 事件里 `req.headers` 完整保留客户端头，且 `Sec-Fetch-Site` **确实缺失**：
>
> ```
> url=/api/remote.mux  host="127.0.0.1:65485"  origin="http://evil.com"  sfs=undefined
> ```
>
> 若升级路径复用读请求那套规则，任意网页可连上 `ws://127.0.0.1:<网关端口>/api/remote.mux`。修法：独立入口 `checkUpgradeOrigin()`，规则见上。表内每一行都有测试，其中「有 Origin、不同源、无 Sec-Fetch-Site」单独一条。

> **阶段 3 实测：升级 socket 的断开只发 `end`（规范 11 的加强版）**
>
> 规范 11 记的是「TCP 断开不一定走 `error`，要绑 `close`」。在升级路径上还多一层：等待 `101` 期间客户端 socket 处于 **paused**（还没人读它），此时客户端 `destroy()` 在服务端**只触发 `end`**——不触发 `close`，也不触发 `error`。只绑 `close`（HTTP 路径的修法）仍然会漏，表现是一个被丢弃的握手各扣住一条上游 socket 直到 head 超时。现在 `error` / `close` / `end` 三个都绑，`teardown` 幂等所以重叠无害。
>
> 另测出两个影响**测试写法**的事实（不是产品缺陷，但写错会得到假绿/假红）：
> 1. 对端 socket 若没人读（paused），**永远观察不到 FIN**。真实 `ws` 服务端挂上 `data` 监听所以是 flowing，桩必须 `resume()`，否则测的是桩而不是代理。
> 2. 交给 `'upgrade'` 监听器的 socket 是 **`allowHalfOpen: true`**（普通 `net` 服务端是 `false`），所以对端只发 FIN 时本地只有 `end`、没有 `close`。`ws` 在 `end` 时主动关，桩也照做。

## 阶段 2 补充：配对码防爆破（阶段 1 复盘遗留）

- [x] `pairing.js`：每个 `pairId` 记录失败次数，超过 5 次直接作废该 pair，返回 `pairing/locked`
- [x] 来源 IP 级失败速率限制（与 pairId 级独立，防止换 pairId 绕过）
- [x] 失败兑换尝试进审计（见阶段 4 的 `pair_failed` 事件）
- **依据**：`research/official-connection-fence.md` §7.1（实测无任何限制，可无限尝试）

> **实施记录**：两条限制都在 `pairing.js` 内，仍然纯内存、`now`/`random` 可注入。新增错误码 `pairing/locked`（pair 级）与 `pairing/source-locked`（IP 级）。源级限制用滑动窗口（默认 60s / 20 次，`PAIRING_IP_MAX_FAILURES`、`PAIRING_IP_WINDOW_MS`），不是永久封禁。`resetSource(source)` 供阶段 4 面板解封误伤。
> **审计那条已在阶段 4 补齐**：`pairing.js` 新增可选 `onFailure` 回调（模块仍不碰文件系统），`createRuntime` 接到 `audit.record({ event: 'pair_failed' })`。预算耗尽之后的尝试同样记录。

## 阶段 2 补充：`lastSeenAt` 写入节流（阶段 1 复盘遗留）

- [x] 网关不得逐请求调用 `store.touchDevice()`（实测 7.06 ms/次全量 fsync 写盘，吞吐会被锁死在约 140 req/s）
- [x] 改为进程内节流：`deviceId → 上次落盘时间`，不足 30s 只更新内存
- [x] 进程退出 / 吊销 / 面板读取时强制 flush
- **依据**：`research/official-connection-fence.md` §7.2

> **实施记录**：落在 `src/host/gateway/activity.js`，`createActivityTracker({ touch, now, intervalMs })`。网关只调 `record(id)`；`dispose()` 已挂进 `ctx.effect()` 的 disposer（进程退出/热重载都会 flush）。`flush(deviceId)` 与 `flush()` 供阶段 4 的吊销与面板读取使用。单测断言 100 次请求只产生 1 次写盘。


## 阶段 4：管理 API 与审计

- [x] `src/host/api.js`：`/remote-control/api/*`，仅 loopback
- [x] `src/host/audit.js`：JSONL 追加、30 天清理、导出
- [x] 路径前缀 → 动作映射（`send_message` / `stop_task` / `approval_answer`），无法识别记 `unknown`
- [x] 新增 `pair_failed` 事件类型（配对失败可被用户察觉）
- **验收**：管理接口从远程调用返回 403；审计文件正确轮转与清理

> **实施记录（阶段 4 完成）**：测试 283 → 366（+83）。

> **阶段 4 的两层边界（这是本阶段唯一定义性问题）**
>
> `prd.md` R4：配对只授予会话访问权，不授予管理权。因此管理 API 必须**两层**都成立，单靠任何一层都是可绕过的：
>
> 1. **不在网关端口上提供服务。** 注册在官方 `dsh web` 服务器（`ctx.webServer.register`），官方端口仍是 `127.0.0.1`。**关键点：网关必须显式拒绝这个前缀**，不是"顺手加一层"。原因很具体——网关转发前把 `Host` 改写成 `127.0.0.1:<官方端口>`（`design.md` §4.4 的 A 步骤），所以一条被转发的管理请求会以「回环 socket + 回环 Host」到达官方端口，**正好满足管理 API 自己的 loopback 判定**。也就是说，少了网关这道拒绝，"仅回环"会由攻击者自己那一跳来证明。`ADMIN_API_PREFIX` 是两边共用的常量，不会漂移。
> 2. **即使到了官方端口也判定。** `isLoopback` 要求 socket 与 `Host` **两半**同时成立（DNS rebinding），且 Origin 围栏在 loopback 分支上**照常执行**（规范 8）。API 的每条路由都改状态，这条不能省。
>
> **路径选择**：不放在 `/api` 下。`/api` 是 connection 插件的前缀，自带 Host/Origin 围栏与浏览器签名 Cookie，挂进去要么被它影子化、要么被迫让本机浏览器也带内层凭证。

> **阶段 4 的模块迁移（不是重构，是为了守规范 7）**
>
> 管理 API 在官方端口上，属于另一条传输路径，因此**不能 import `gateway/*`**（规范 7 单向依赖）。但 `isLoopback` 与 Origin 围栏原本都在 `gateway/` 里。做法是把**定义**下沉到领域层，**判定点**留在原处：
>
> - `src/host/loopback.js`：`isLoopbackHostname` / `peerAddress` / `isLoopbackSocket` / `isLoopback` / `headerValue`。
> - `src/host/origin.js`：`checkOrigin` / `checkUpgradeOrigin` / `isWriteMethod` / `authorityOf` / `headerOf`。
> - `gateway/auth.js` 与 `gateway/origin.js` 改为**再导出**，公开形态与语义一字未改（`gateway-auth.test.mjs` 28 条原样通过，含 DNS rebinding 那几条）。
>
> 判定仍然只有一处（`authorize()`），只是"定义"下沉了一层。两份 CSRF 围栏一定会漂移，而漂移就是漏洞。

> **路径 → 动作映射（`classify.js`），以及为什么不是 `sendMessage`**
>
> 实测本机宿主（`@deepseek-ai/dsh-0.2.0-rc.2`）：Web 传输是 `/api` 前缀上的 JSON-RPC，每个方法是 `<channel>/<namespace>/<method>`，一律 `POST`。
>
> | 匹配 | 事件 |
> |---|---|
> | `POST /api/session/prompt` | `send_message` |
> | `POST /api/session/cancel` | `stop_task` |
> | `POST /api/$events/result` | `approval_answer` |
> | 其他写请求 | `unknown` |
> | 任何读（GET/HEAD/OPTIONS） | 不记 |
>
> `design.md` §6 初稿写的示例是 `POST /api/...sendMessage`——**这条路径在本机不存在**。如果照抄，所有真实发消息都会被记成 `unknown`（静默错标）。这正是"宁可漏记也不耦合内部接口"这条取舍要防的事，宁可降级也不猜。
> `stop_task` 用的是 `session/cancel`，**不是** `session/control`（那是客户端打开的流，不表示"用户按了停止"）。`approval_answer` 落在 `$events/result`：客户端把 waterfall 结果 POST 到这个 gateway 内部端点，这是线上唯一表示"用户回答了"的写；它也用于 plan/question 的回复，所以事件名取文档里的动作类 `approval_answer`。
> 审计 `meta.path` 只记 pathname，**不记 query**（query 可能带提示词片段或文件路径）。

> **审计：内容永不出现在文件里（结构化强制，不是靠自觉）**
>
> 三层过滤，任一层单独都不够：
> 1. `AUDIT_EVENTS` 封闭集合，集合外的事件**拒绝写入**并上报，所以未来调用方无法顺手发明 `tool_output`。
> 2. `record()` 只拷贝五个文档字段，调用方多传 `{ ...request }` 也进不来。
> 3. `meta` 的**键**要走白名单，**值**还要过形状校验——`{ sessionId: 整段提示词 }` 是更现实的失误。
>
> 形状校验这里踩过一个真坑：最初的通用 `[\w.:/@+-]{1,120}` 会把 **43 字符 base64url 令牌**当成合法标识符，而 `ip` 用 `[0-9a-fA-F:.]` 时 `'A'.repeat(43)` 也能通过（`A` 是十六进制字符）。修法：`deviceId` 要求 `dev_` 前缀（`design.md` §5 的形状），`ip` 写成真正的地址文法（点分四段 / `[…]` / 含冒号），`meta` 值禁止 30 字符以上的连续字母数字串。`tests/audit.test.mjs` 有一条专门断言令牌形状进不了这三个位置。
>
> 保留 30 天，**只删自己命名的文件**：`audit-YYYY-MM-DD.jsonl` 且日期能往返校验（`audit-2026-02-31` 会被 `Date` 归一成 3 月 3 日，于是被拒）。`devices.json`、`notes.txt`、`*.jsonl.backup`、同名目录一律不动——因为共用一个目录而删掉用户的数据，比审计留得太久糟得多。
> 清理在**启动时**跑一次，之后按 `AUDIT_PRUNE_INTERVAL_MS`（6h）跑；两条都挂 `ctx.effect` 清理定时器。启动那次**不**受 `settings.enabled` 影响：用户关掉远程一个月回来，不该看到一堆过期文件。
> 导出是单个 JSONL 下载（`application/x-ndjson` + `content-disposition`），同样仅 loopback；坏行**丢弃而非转发**，否则消费者会在用户无法修复的数据上解析失败。

> **`pair_failed`（阶段 2 遗留的那一条）**
>
> `pairing.js` 保持不碰文件系统，新增可选的 `onFailure` 回调；`createRuntime` 把它接到 `audit.record({ event: 'pair_failed', … })`。
> 单点上报：每次猜错都在 `registerFailure` 同一处上报，预算与审计不会各自漂移。
> **预算耗尽之后的尝试照样记**——那是攻击最响的部分，只记到最后一次"还算数"的尝试等于在最关键处失明。
> `pairing/expired` / `pairing/used` **不记**：那是正常操作（TTL 到期、重复兑换），记进去会变成让人学会忽略的噪声，真攻击反而被淹。
> 配对码本身永远进不去：`pairing.js` 的失败路径里根本没有把 code 放进取景框，这是结构性保证而不是约定。

> **测试能失败的抽查**：写了 12 个变异逐个破坏实现确认变红后还原——管理 API 跳过 loopback 判定 / 跳过 Origin 围栏 / 只查 socket 半边 / 用 store 直插吊销 / 网关不再拒绝 admin 前缀 / 审计不过滤 meta / 接受集合外事件 / 按文件名而非解析日期裁剪 / 不过滤 deviceId / 分类器一律猜 `send_message` / 不记预算耗尽后的猜测 / 把过期记成失败。**12 个全部变红**。


## 阶段 5：客户端 UI

- [x] `src/client.js`：`window.__ModuleLoader__.load` 包装，注册侧边栏底部图标
- [x] 设备面板：开关、端口、二维码、设备列表、吊销、审计导出
- [x] 中英文案（`locale/`）
- **验收**：面板可完成一次完整配对；吊销后列表即时更新

> **阶段 5 收尾：配对流程的另一半（`gateway/pairing-route.js`）**
>
> 阶段 5 的面板能生成码、能画二维码，但**兑换那一半根本不存在**：
> `api.js#createPairing` 返回 `pairPath: '/remote-control/pair'`，而没有任何东西
> 服务这个路径；`pairing.redeem()` 除了单测没有任何调用点；`wire.deviceCookie()`
> 只经 `clearDeviceCookie`（吊销路径）被触达，从没有谁**下发**过
> `Set-Cookie: dsh-rc-device`。结果是「能生成码，永远用不掉」——手机扫码后被当作
> 无 cookie 请求 401。这是产品最后一个功能空洞。
>
> 补在新模块 `gateway/pairing-route.js` 里，**挂在网关端口**而不是管理 API 上
> （配对是设备在拥有任何凭证**之前**做的动作，管理 API 仅回环）。
>
> **`GET /remote-control/pair`**：自包含 HTML（无外部资源），从 `location.hash`
> 读 `<pairId>:<code>` 并 POST 回去（fragment 不进服务端，`design.md` §3.1 step 3）。
> 无 fragment 时显示手输表单（D2 的「纯文本码手输」）。页面回显任何参数，
> 也从不读 query string。
>
> **`POST /remote-control/pair`**：`{ pairId, code }` → `pairing.redeem(pairId, code, source)`；
> 成功后 `tokens.createDeviceToken()` → `store.addDevice`（只存哈希）→
> `Set-Cookie: dsh-rc-device=…; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax`
> （**无 `Secure`**）→ 审计 `pair` → `303` 到 `/`。
>
> **为什么这道「跳过 authorize()」的豁免不是第二个阶段 2 漏洞**：阶段 2 与阶段 3
> 的洞都是同一个形状——豁免让请求进了 `proxy.js`，而那一跳会注入实例级的
> `dsh-auth-*` 并剥掉 `Origin`，于是攻击者缺的证明由网关自己补上
> （`quality-guidelines.md` §8 的判据）。配对路径**从不经过 proxy**：没有
> `forward()`、没有 `innerAuth.header()`、没有 Header 改写，全部从进程内存应答。
> 所以豁免只免掉了它自己点名的凭证，Origin 围栏照跑（POST 是写），
> `settings.enabled` **逐请求重读**（面板关掉开关时监听还在，见 `api.js` 的
> `requiresReload: true`）。
>
> 未认证调用者在这里能做的事，逐条枚举在模块注释里：GET 一个常量文档（**故意不限流**
> —— 给它上预算等于让共享 NAT 后面的攻击者把合法用户锁在配对页外，而页面无状态、
> 无按输入分配、除「这里有网关」外不泄露任何东西，而每个其他路径的 401 已经说了这件事）；
> POST 一次猜测（花的是 `pairing.js` 已有的预算：5/pair、20/source/60s，**没有第二套限流**）；
> 畸形 body 400（不花预算——畸形请求猜不出码，客户端 bug 不该烧掉用户的地址）；
> 其他 405/404。它不能触达 DSH、不能在配对成功前创建设备、不能读设备表。
>
> **`pair_failed` 只在路由里审计一次，且不在这里写**：`pairing.js` 的 `onFailure`
> 已经在「预算被扣」的唯一那一点上报了一次，且**只对真正的猜测**上报
> ——`pairing/expired` / `pairing/used` 是正常操作，不记。路由若再记一次，每次猜测
> 会有两行，「一次尝试一行」就不成立了。
>
> 错误码 → 状态：`pairing/unknown` 404、`invalid-code` 403、`expired` 410、
> `used` 409、`locked`/`source-locked` 429、body 越界 413、非 JSON 415、
> `settings.enabled === false` 503（两条路由都拒）。
>
> **body 边界有个真坑**：`PAIRING_MAX_BODY_BYTES` 是 4 KB，跨过那一刻**继续 drain
> 但不继续缓存**。若在跨过时立刻应答 413，会和客户端仍在写的那一段抢跑，
> 客户端拿到的是 reset 而不是 413——输的是客户端。drain 不是 buffer：超出部分随到随丢，
> 内存恒定在边界上。
>
> **`GET` 与 `POST` 的围栏是刻意不对称的**（本模块唯一的判断题）。真实配对链接通常是
> 在聊天/邮件里**点开**的，浏览器把这种顶层导航报成 `Sec-Fetch-Site: cross-site`；
> 若对读也跑围栏，最常见的打开路径会被自己拒掉，而且换不到任何东西：
> 页面是一个**常量**（无状态、不回显输入），跨站读者拿到的就是仓库里那份文档，
> 而点开页面后那个 POST 是同源发出的、且**照跑完整围栏**；再加上
> `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'`，点击劫持这条也关死了。
> 所以：读宽松、写严格，两半各一条断言、同一个 `cross-site` 头
> （`tests/gateway-pairing.test.mjs`）——只测一半，将来「顺手收紧读」会打断真实使用，
> 「顺手放松写」就是 CSRF。
>
> **测试能失败的抽查**：写了 13 个变异逐个破坏实现确认变红后还原——
> 路线里再审计一次失败 / 把 expired·used 也记成失败 / 不查 `settings.enabled` /
> 接受任意 content-type / 去掉 body 大小边界 / 把配对路径当**前缀**匹配 /
> 在成功审计里记 code / 成功后不下发 cookie / 用 302 而不是 303 /
> 网关不再分发配对路径 / 在配对响应头里注入内层凭证 / 把 query 里的 pairId 回显进页面 /
> 把行内脚本改坏。**12 个变红；1 个（往 addDevice 记录里多塞一个明文字段）存活，
> 但那是真 no-op**——`store.normalizeDevice` 结构化重建记录，未知字段进不了盘
> （已单独复验：故意塞 `clearToken` 后 `devices.json` 里没有它）。
>
> 另加一条：**页面里的行内脚本必须能被解析**。`node --check` 看不见模板字符串里的
> JS，`npm test` 与 `check:syntax` 都覆盖不到它——脚本写坏了唯一症状是手机上永远停在
> 「Reading the pairing link…」。测试把 `<script>` 抠出来过一遍 `new Function` 编译。
>
> 测试 396 → 422（+26）。

## 阶段 6：验证与文档
- [ ] 真机验证：手机扫码 → 打开会话 → 发消息 → 收流式 → 停止
- [x] `npm test` / `npm run check:syntax` / `npm pack --dry-run` 三条全绿（421 tests）
- [ ] README（中英）补 `pairing-route.js` 与配对流程的中文对照
- [ ] CHANGELOG 首条记录
- [x] `npm pack --dry-run` 产物完整（`src/host/gateway/pairing-route.js` 已列入 `files`）

## 验证命令

```bash
npm test                 # 单测（内部为 node --test "tests/*.test.mjs"）
npm run check:syntax     # node --check 全部宿主模块
npm pack --dry-run       # 产物检查
```

> 两条已实测的坑，别踩：
>
> - **`node --test tests/` 在 Node 21+ 失效**：目录参数被当作字面 glob，目录本身被当测试文件执行 → `Cannot find module`（[nodejs/node#64555](https://github.com/nodejs/node/issues/64555)）。用 `npm test`（glob 形式），或**裸 `node --test`**（无参数，本机已验证可正确发现并跑完 71 个测试，且比 glob 更跨版本）。
> - **`dsh plugin --profile desktop` 会被拒绝**：desktop profile 由 Electron 独占管理（`rejectElectronProfile`）。安装验证一律用 `web` profile。

真机验证需在装有本插件的实例上进行，且**必须**验证：

1. 关闭开关时 `dsh web` 行为无变化
2. 未配对远程访问被拒
3. 配对后可操作同一会话
4. 吊销后立即失效
5. 审计记录完整且不含正文

## 回滚点

- 阶段 0 失败 → 直接删除，无副作用
- 阶段 2 完成但阶段 3 卡住 → 保留 HTTP 网关，WebSocket 降级为"不支持流式"，README 明示
- 任何阶段发现与 DSH 版本不兼容 → 停在该阶段，记录到 `research/`，不强行绕过

## 风险与对策

| 风险 | 对策 |
|---|---|
| 官方 WS 升级行为变化 | 代理不解析帧内容，只透传；升级失败时降级为不支持流式并记录 |
| 官方路径变更导致审计漏记 | 记 `unknown`，不耦合内部接口 |
| 局域网无 TLS | README 明确边界，推荐 Tailscale |
| 代理缓冲导致流式卡顿 | SSE 强制不缓冲，端到端验证 |
