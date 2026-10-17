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
- [ ] 失败兑换尝试进审计（见阶段 4 的 `pair_failed` 事件）
- **依据**：`research/official-connection-fence.md` §7.1（实测无任何限制，可无限尝试）

> **实施记录**：两条限制都在 `pairing.js` 内，仍然纯内存、`now`/`random` 可注入。新增错误码 `pairing/locked`（pair 级）与 `pairing/source-locked`（IP 级）。源级限制用滑动窗口（默认 60s / 20 次，`PAIRING_IP_MAX_FAILURES`、`PAIRING_IP_WINDOW_MS`），不是永久封禁。`resetSource(source)` 供阶段 4 面板解封误伤。审计事件留到阶段 4。
> 审计那条未勾是**故意**的：`pair_failed` 属于阶段 4 的 `audit.js`，本阶段没有审计写入器。

## 阶段 2 补充：`lastSeenAt` 写入节流（阶段 1 复盘遗留）

- [x] 网关不得逐请求调用 `store.touchDevice()`（实测 7.06 ms/次全量 fsync 写盘，吞吐会被锁死在约 140 req/s）
- [x] 改为进程内节流：`deviceId → 上次落盘时间`，不足 30s 只更新内存
- [x] 进程退出 / 吊销 / 面板读取时强制 flush
- **依据**：`research/official-connection-fence.md` §7.2

> **实施记录**：落在 `src/host/gateway/activity.js`，`createActivityTracker({ touch, now, intervalMs })`。网关只调 `record(id)`；`dispose()` 已挂进 `ctx.effect()` 的 disposer（进程退出/热重载都会 flush）。`flush(deviceId)` 与 `flush()` 供阶段 4 的吊销与面板读取使用。单测断言 100 次请求只产生 1 次写盘。


## 阶段 4：管理 API 与审计

- [ ] `src/host/api.js`：`/remote-control/api/*`，仅 loopback
- [ ] `src/host/audit.js`：JSONL 追加、30 天清理、导出
- [ ] 路径前缀 → 动作映射（`send_message` / `stop_task` / `approval_answer`），无法识别记 `unknown`
- [ ] 新增 `pair_failed` 事件类型（配对失败可被用户察觉）
- **验收**：管理接口从远程调用返回 403；审计文件正确轮转与清理

## 阶段 5：客户端 UI

- [ ] `src/client.js`：`window.__ModuleLoader__.load` 包装，注册侧边栏底部图标
- [ ] 设备面板：开关、端口、二维码、设备列表、吊销、审计导出
- [ ] 中英文案（`locale/`）
- **验收**：面板可完成一次完整配对；吊销后列表即时更新

## 阶段 6：验证与文档

- [ ] `tests/` 单测通过（`node --test`）
- [ ] 真机验证：手机扫码 → 打开会话 → 发消息 → 收流式 → 停止
- [ ] README（中英）：安装、使用、**安全边界**（局域网无 TLS、令牌等价完整控制权）
- [ ] CHANGELOG 首条记录
- [ ] `npm pack --dry-run` 产物完整

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
