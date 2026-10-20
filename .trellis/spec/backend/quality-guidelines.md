# Quality Guidelines

> Code quality standards for backend development.

---

## Overview

本项目是 DSH 插件：**一个没有构建步骤的 npm 包**，同时被 Node（宿主半边）和浏览器（客户端半边）加载。质量的红线都是围绕这两件事展开的——加载期不能崩，鉴权期不能漏。

---

## Forbidden Patterns

1. **引入运行时依赖。** 宿主半边只用 Node 内置模块（`node:crypto`、`node:fs`、`node:path`、`node:os`、`node:http`、`node:net`）。唯一允许的是宿主提供的可选模块（如 `@deepseek-ai/schemastery`，按 `dsh-git-panel` 的方式动态可选加载，缺失时降级）。
   **没有例外。** WebSocket 透传用裸 `node:net`：自己写升级请求行 + 双向 pipe，不解析帧（`src/host/gateway/wsproxy.js`）。`ws`、`node:http2`、`jsonwebtoken`、`jose`、`jws` 都被 `tests/package.test.mjs` 明确禁止——那不是「暂时用不上」，而是零依赖这条设计决策本身（JWT 只有两个 base64url 段加一次 HMAC，手写面比库小）。

2. **新增构建步骤。** 客户端半边是手写 ESM，保留 `window.__ModuleLoader__.load({ id, factory })` 单入口包装，禁止出现第二个 client entry 或编译产物目录。

3. **`shell: true` / 命令拼接。** 除下面这一条例外，本项目不执行外部命令；将来需要时一律 argv 数组，禁止 `exec`。
   **唯一例外（2026-10-20）**：`src/host/tunnel.js` 可以 `import 'node:child_process'`，用于拉起 `cloudflared`。例外只覆盖这一个模块，并且只能以 `spawnImpl(binary, args, { shell: false, windowsHide: true })` 的形式使用；`binary` 必须来自 `resolveTunnelBinary()`（自定义路径 / PATH / 本插件下载的副本），`args` 必须是数组，Token 走 `--token-file` 而不是 argv/env。`tests/package.test.mjs` 断言「只有这一个文件 import `node:child_process`」，任何扩散都会变红。

4. **`console.log` 作为日志。** 宿主用 `ctx.logger`。

5. **静默降级。** 缺少可选能力时降级可以，但必须 `warn` 一次并在 UI 上可见，不允许"看起来在工作，实际没生效"。

6. **在日志/响应里出现令牌、Cookie、配对码、消息正文。**

7. **`chmod` 失败即抛错（Windows）。** 0600 是 POSIX 语义，Windows 上是 no-op，不得因此让插件启动失败。

---

## Required Patterns

1. **可注入的副作用。** 文件系统根目录、时钟、随机源作为参数传入。测试不碰真实 `~/.dsh`，不等待真实时间。

2. **原子写。** `devices.json` 写入必须是「临时文件 → fsync → rename」，任何时刻读到的都是完整文件。

3. **常量时间比较，且用在真正的热路径上。** 凭据比对两侧先各自 sha256 再 `crypto.timingSafeEqual`，保证长度恒等，避免长度侧信道与「长度不等就抛错」（`tokens.js#sameBytes` / `#sameTokenHash`）。
   **但只做到这一步是不够的**：阶段 1 复核发现 `tokens.js` 是常量时间的，而当时真正被调用的 `findActiveDeviceByTokenHash` 却用 `===` 早退——等于白做（该函数已随 JWT 改造移除）。
   现状：鉴权热路径是 `gateway/auth.js` → `verifyDeviceToken()` 的 HMAC 比对；`hashToken` / `sameTokenHash` / `verifyToken` 只剩旧 `tokenHash` 行的兼容路径，**不在鉴权链路上**。任何**比对凭据**的地方都必须走常量时间原语，不许 `===`。

4. **接受凭据的一方必须校验格式。** `verifyToken` 的可信侧（存储的 `tokenHash`）必须是 `^[0-9a-f]{64}$`，否则直接返回 false。
   阶段 1 复核发现的真实缺陷：旧实现把非摘要也走一遍 hash，导致 `verifyToken('hunter2','hunter2') === true`；配合存储接受任意非空字符串，**手写一个字段进 `devices.json` 就能用该字面量认证**，完全绕过「只存哈希」。这条要一直记着。

5. **注入的随机源要防御。** `random()` 是可注入的，就必须检查返回的字节数；短缓冲会静默产出 `undefined` 拼成的码。抛 `pairing/entropy`，不要静默修补。

6. **`ctx.effect()` 清理。** 任何监听端口、定时器、事件订阅都必须在 effect 的 disposer 里释放。热加载与禁用插件后不得残留监听。

7. **单向依赖。** 见 `directory-structure.md`：领域模块不得 import `gateway/*`。

8. **固定顺序的鉴权判定。** loopback 豁免 → 设备 Cookie → Origin → 吊销状态。顺序写死在一处（`gateway/auth.js`），不要散落在多个 handler 里。
   **但「豁免」只免凭证，不免 Origin 判定。** 阶段 2 复核发现的真实缺陷：`authorize` 的回环分支直接 `return ALLOW`，围栏没跑；而网关正是「注入内层 `dsh-auth-*` + 剥离 `Origin`/`Sec-Fetch-*`」那一跳，于是任意网页对本机网关发一个**免预检**的 `POST`（`text/plain` 表单，浏览器 `Host` 由 URL 决定就是回环）就能得到 200 且已对 DSH 执行——官方围栏本来会拒的请求被网关洗成了认证请求。`SameSite=Lax` 救不了，因为豁免本就不要求 Cookie。
   **任何「跳过某个检查直接放行」的分支，都要先问：这个网关自己会不会补上攻击者缺少的那部分？** 会，就不能跳。

9. **代理自己合成的头，绝不能让客户端决定。** 阶段 2 复核发现的真实缺陷：`forwardingHeaders` 只在 peer 地址是字符串时才写 `x-forwarded-for`，而 `peerAddress` 在 socket 无 `remoteAddress` 时返回 `undefined`，于是客户端自带的 `x-forwarded-for` 原样透传，可任选上游与审计以为的来源 IP。规则：`x-forwarded-*` / `x-real-ip` / `forwarded` 等一律**先丢再写**，不做「有就保留」。

10. **凡是有超时的地方，想想它对整个网关的爆炸半径。** 阶段 2 复核发现：内层凭证兑换的 `fetch` 没有 signal，而并发调用被合并到同一个 in-flight promise，所以上游「接了连接但不回」会永久挂起**每一个**远程请求（实测 3 个并发全悬挂），而 `upstreamTimeoutMs` 覆盖不到那一跳。合并 in-flight 的设计会把单点故障放大成全站故障，必须配 deadline。

11. **`pipe()` 的两端都要有错误出口，且「断开」不一定走 `error`。** 实测客户端在响应头之前中断，`req`/`res` 只发 `end`/`close`，**不发 `error`**；只监听 `error` 会让上游 socket 一直连到 head 超时（默认 120s），局域网客户端可「开一个丢一个」批量扣住上游连接。等待上游响应头的那一段必须额外绑到 `res` 的 `close`。

12. **`fetch` 的 `set-cookie` 不是数组。** undici 的 `headers.get('set-cookie')` 返回的是 `", "` 拼接串（实测），只有 `getSetCookie()` 才是数组。把拼接串当单条 Cookie 解析，凭证不在第一位就永远找不到 → 表现为永久静默 401。取 `set-cookie` 一律优先 `getSetCookie()`。

13. **`flush` / `dispose` 这类「最终落盘」路径：写入成功后才清 pending。** 阶段 2 复核发现 `activity.flush` 先 `delete` 再 `touch`，写盘抛错就把该设备从 pending 丢掉——正好是「进程退出时保住最后 30 秒活动」这条要防的事。反过来，节流路径（`record`）**故意**先打时间戳再写，这是对的：它要防的是对坏文件系统的写风暴。两条路径的取舍方向相反，别互相抄。

14. **attacker-reachable 的 Map 要能自己收敛。** 阶段 2 复核发现 `pairing` 的源级失败表只清「被查询的那一条」，扫过即弃的源永久占位。收敛策略只允许删**已过期**的条目；按容量驱逐仍有效的条目等于把限流上限变成绕过手段。

15. **短写必须处理。** `writeSync` 的返回值不能忽略，要按 offset 循环。否则短写会通过 `rename` 发布一个被截断的文档——正好是临时文件那套机制要防的事。

16. **版本一致。** `package.json` 与 `dsh.plugin.json` 的 `version` 必须相等，且 `files` 列出的每个产物必须真实存在。
    `engines.dsh` 必须与**实测**的宿主版本对齐（用 `dsh --version` 复验，不要从二手信息推断——阶段 1 复核曾误判一次）。
    发布侧的完整约束（标签文法、CHANGELOG 契约、dist-tag、幂等重试、打包边界）见 `../release/tag-and-release.md`。

17. **「对某种请求够用」的宽松规则，不能给语义不同的请求复用。** 阶段 3 前置发现的真实缺陷：`origin.js` 的读请求分支对 GET 只在 `Sec-Fetch-Site: cross-site` 时才拒，带了 Origin 但不带该头时**放行**（对只读请求勉强可接受）。而 **WebSocket 升级本身就是一个 GET**，且不受 CORS 预检约束、浏览器发 `ws://` 时一定带 `Origin` 却不保证带 `Sec-Fetch-Site` —— 于是这个宽松分支直接把跨站 WebSocket 劫持（CSWSH）放了进来。
    **规矩**：给升级/长连接这类语义不同的请求，写**独立**的判定入口，不要去改已有入口来「顺便复用」。升级路径的 Origin 校验必须更严：只要有 `Origin` 就必须与 `Host` 同源，不能像读请求那样可以忽略。
    已实测的正确分支见 `research/official-connection-fence.md` §9.2。

18. **一个语义完整的动作，只暴露一个入口。** `gateway.revokeDevice(id)` 同时完成「写存储」+「关闭该设备的活动 socket」。**阶段 4 的管理 API 必须调它，不得直接调 `store.revokeDevice()`** —— 否则就只吊销了新请求，已经建立的流式连接还活着，PRD 约束 5「吊销必须即时生效」只满足一半。同理，任何「状态变更 + 副作用」的组合都应该是单一函数，而不是让调用方记得依次调用两件事。

19. **「断开」有四种表现，`error` 只是其中一种。** 阶段 3 实测补全：客户端中断可能只发 `end`（等待 `101` 期间客户端 socket 处于 paused 状态，此时 `destroy()` 在服务端**只触发 `end`**，没有 `close` 也没有 `error`）。所以凡是要感知「对端没了」的地方，`error` / `close` / `end` 三个都要绑，只绑一个就会漏。
    另外两个同源事实：交给 `'upgrade'` 监听器的 socket 是 `allowHalfOpen: true`（普通 net 服务端是 `false`），对端只发 FIN 时本地只有 `end` 没有 `close`；而对端 socket 若没人读（paused）则**永远观察不到 FIN**。写测试桩模拟真实 ws 对端时，要 `resume()` 并在 `end` 时主动 destroy，否则测的是桩不是实现。

20. **测试桩也是代码，先怀疑它再怀疑实现。** 阶段 3 那条失败的测试，根因在测试桩（paused 对端观察不到 FIN），不在代理。但排查过程反而挖出了真 bug（`end` 未绑定）。**结论：测试变红时既不能直接改实现迁就断言，也不能直接改断言迁就实现** —— 要把桩和实现各自对着协议规范核一遍。真正的修法往往需要两半。

21. **代理改动过的字段，不能再用作下游的信任输入。** 阶段 4 发现的真实缺陷：网关为满足上游鉴权必须把 `Host` 改写成 `127.0.0.1:<官方端口>`（§4.4 的 A 步骤），而管理 API 的「仅本机」判定恰好依赖「回环 socket + 回环 Host」。于是**一条被转发的管理请求到达官方端口时，正好满足那条判定** —— 规则由攻击者自己那一跳自证成立。实测：远程请求 `isLoopback=false`，经网关转发后 `isLoopback=true`。
    修法是网关在转发前显式拒绝 `ADMIN_API_PREFIX`，而**这道拒绝不是纵深防御的附加项，它就是让规则成立的那一层**。
    排查清单：凡「基于请求属性判断来源」的规则，先问该属性有没有可能是我自己或上一跳写上去的。本项目已核实：`Host`（网关改写，已由前缀拒绝兜住）、`Origin`/`Sec-Fetch-*`（网关剥离，管理 API 不经网关所以可用）、`X-Forwarded-For`（本跳重写，已改成先丢再写）、内层 `Cookie`（网关注入，已用 `dsh-rc-device` 前缀区分）。

22. **写「路径 → 语义」的映射前，先对真实宿主验证一遍。** 阶段 4 发现 `design.md` §6 初稿写的 `sendMessage` 在本机根本不存在（真实的是 `session/prompt`、`session/cancel`、`$events/result`）。照抄设计文档写分类器，会让**所有真实的发消息动作静默错标成 `unknown`** —— 审计看起来在工作，实际什么都没记对。
    同型问题：`classifyUpgrade('/api/remote.mux')` 一度被放进 HTTP 规则表，但纯 HTTP GET 打这个路径上游是 404，那条规则永远不会命中。**映射表的每一条都必须可达**，写个「每条规则都能被触发」的测试来守。

23. **先给字段归类：显示层事实，还是判定输入？** 阶段 5 的 `settings.access`（`prd.md` R2/R3）是一条只决定面板渲染哪个链接的字符串：它不进网关绑定（仍是 `GATEWAY_BIND_HOST`）、不与设备比对、不参与任何鉴权。归类决定校验的**目的**：显示层事实的校验是为了「存进去别是垃圾」（带路径/查询/userinfo、端口越界、超长、重复 id 一律拒），能接受的最坏结果是链接打不开（`prd.md` 约束 4「宁可链接不可用」）；判定输入的校验是为了「挡住谁」，写错一条就是一个洞。把两类混起来是本项目最贵的事故模式：§21 的 `Host` 就是被误当成判定输入的一个代理合成字段。
    推论：显示层字段**不许**因为写错而改变服务行为。`effectiveAddress` 的回退只在拼链接时发生、从不写盘——网线拔了再插回来，用户的选择不该被他没做过的操作改掉；`GET /state` 同时返回「存储的选择」与「此刻的网卡列表」，由客户端解释。

24. **严格与宽松共用一次遍历，不要写两套规则。** 同一个 `settings.access` 有两个读者：`store.js`（读磁盘，必须在手改过的文件上永不失败 → `normalizeAccess`，非法字段逐个回默认、非法条目丢弃、超限截断）与 `POST /settings`（必须告诉调用方而不是偷偷改写输入 → `validateAccess`，第一条错误转成 `400 admin/invalid-access` 且**一个字节都不写盘**）。两者共享同一个 `readAccess()` 收集错误，只是策略不同；若各写一份规则，其中一份迟早漂移，而漂移从两侧都看不出来。测试要同时验「严格拒了」「宽松收了」「拒绝时文件字节未变」。

25. **默认值/排序规则必须拿真机数据验一次，别只信推理。** 阶段 6 的网卡排序按设计写成「私网优先、其余靠后」，单测全绿；真机上 Windows 同时报了 Hyper-V `vEthernet (Default Switch)` `172.29.240.1`、WSL `vEthernet` `172.30.192.1` 与真实网卡 `192.168.9.77`，按这条规则**默认值正好落在手机连不上的虚拟交换机上** —— 也就是这个面板存在的意义被默认值抵消了。修法是给排序加一层「物理网卡先于虚拟网卡」的启发式（按网卡名猜，Node 只暴露这个名字；猜错的代价只是下拉里一行位置）。教训：**凡是「替用户选一个默认值」的逻辑，都要在真实枚举结果上看一眼第一名是谁**，单测里的假数据永远比真机干净。

26. **发布前的校验要前置到可单测的脚本里，而不是散在 workflow 的 shell 片段中。** 打标签发布这条链路出错时，代价是「一个不可回滚的已发布版本」或「npm 与 GitHub Release 内容不一致」，而 workflow 里的 `if`/`grep` 只能在真实推送时才知道对错。`scripts/prepare-release.mjs` 把所有能静态判定的东西收进一个纯函数：标签文法、tag ↔ `package.json` ↔ `dsh.plugin.json` 三方版本、仓库地址（npm provenance 绑它）、`CHANGELOG.md` 对应段落非空。workflow 只做编排。**并且这些断言必须能被变异测试打红**：首发版本的测试里，`v01.1.0`、`v0.1.0-beta.01` 这类用例会因为「版本不一致」先被拒绝，于是删掉文法/前导零规则测试依然全绿——检查代理用 11 个变异体验证，修好前有 2 个存活、修好后 0 个存活。教训：**断言要钉住「因为哪个原因被拒」，只钉「被拒了」等于没测**。
    这条规范的落地细节（标签文法表、dist-tag、幂等重试、打包边界、本地能验到第几层）见 `../release/tag-and-release.md`。

27. **分页游标必须带「同一时刻内的序号」，只用时间戳会漏或重。** 审计明细端点用 `"<ts>.<seq>"`（毫秒 + 按天序放大的行号）。理由是实测的：同一毫秒可以写入两条记录（同一批并发连接），只用时间戳作游标时「严格早于游标」把两条一起排除 → **丢一条**；放宽成「不晚于」→ **重一条**。页码/偏移更糟：审计是追加日志，翻页期间的新写入让偏移整体位移。实现要点：**游标的比较顺序必须与排序顺序完全一致**（按 `(ts, seq)` 排就按 `(ts, seq)` 比），否则「一致性」只是巧合；`seq` 还必须跨文件单调，否则同一毫秒的两条记录落在不同日期文件时，排序与游标会各自成立却互相矛盾。测试必须包含「同一毫秒写多条 + `limit=1` 逐页翻完，每条恰好出现一次」——把并列比较删掉，这条要变红。

28. **读取路径要按写入白名单**再**投影一次，而不是信任文件。** 写入侧（`record` / `sanitizeMeta`）拒绝自由文本，但审计文件是明文，用户或以该用户身份运行的任何进程都能改。所以 `readEvents` 把每行**重建**成 `ts`/`event`/`deviceId`/`ip`：重新校验事件闭集、重解析 `ts`、`deviceId`/`ip` 各过一遍写入侧同一套文法。手写的 `"meta": {"text": "…"}` 或 token 形状的值因此**没有落点**——不是被过滤，而是不存在于构造出来的对象里。注意这与 §24 方向不同、**不要**把两侧投影抽成一个函数共用：写入侧校验「调用方的输入」，读取侧忽略「文件作者写的一切」，共用会让「能写什么」绑住「能显示什么」，而读取侧必须天然更严。单字段非法时省略该字段而不是丢弃整条记录——丢整条会让审计链路悄悄变短。

29. **「改完要重启才生效」的设置，等于没生效。** 阶段 7 的真实缺陷：面板的「启用远程接入」与「端口」写盘后只回 `requiresReload: true`，把重启 `dsh` 当成用户的事——而那个 socket 是本插件自己持有的，它完全有能力解绑重绑。修法三条，缺一不可：① 变更只走一个入口（`index.js#applyListenerChange`，开关与端口是同一件事），`api.js` 不自己碰 listener；② **先绑新端口再释放旧端口**，绑定失败时旧监听仍在服务，且 `api.js` 把设置**回滚**（`revertSettings`），绝不让磁盘写着进程没在听的端口——否则 `POST /settings` 与下一次 `GET /state` 会互相打脸；③ 监听器只注册一个 `ctx.effect` disposer（`startGateway({ registerEffect: false })` + 上层持有），否则每切换一次就多一个 disposer，热重载时同一端口被关两次。测试要钉住「关闭后端口真的连不上」「换端口后旧端口真的释放」「端口被占用时返回 409 且旧监听没掉」，只断言响应字段会漏掉真正的副作用。

30. **外部进程是可选的降级能力，不是新的启动前提。** Cloudflare Tunnel（2026-10-20）引入了本包唯一一个外部进程，规则是：
    - **进程只属于一个模块**（`src/host/tunnel.js`），生命周期只属于一个所有者（`src/index.js`）。`api.js` 只发动作与读状态，不 spawn；`gateway/*` 完全不知道隧道存在。
    - **spawn 用 argv 数组 + `shell: false` + `windowsHide: true`**，程序路径只能来自 `resolveTunnelBinary()`（自定义路径 / PATH / 本插件下载的副本）。用户填的自定义路径等价于「用户自己运行这个程序」，属于本机信任级别；不接受任意命令拼接。
    - **失败不致命。** `apply` 不因 cloudflared 缺失、Token 错、网络失败而 reject：局域网网关继续工作，面板显示 `failed` + 稳定错误码。这与「启动失败要大声」（`error-handling.md`）不矛盾——那条约束的是**核心能力**（监听端口、存储），隧道是可选能力。
    - **不自动重启、不自动安装、不自动更新。** 进程退出只报告；二进制只在用户点「下载」时安装；下载来源固定 `github.com/cloudflare/cloudflared`，并且**必须有 release API 给出的 sha256**，摘要缺失就拒绝安装。临时文件 → 校验 → rename，任何失败都不留下半份可执行文件。
    - **Token 是凭据，不是配置。** 不进 `devices.json`、不进响应、不进日志、不进 argv、不进子进程环境；用 `0600` 文件 + `--token-file`。API 只回 `tokenSet: boolean`。
    - **运行时事实不写进设置。** 快速隧道的 URL 每次启动都会变，所以 `access.mode = 'tunnel'` 在拼链接时读运行时 URL，而不是把它持久化成一个很快过期的字符串（同 §23 的「显示层事实」）。
    - **第三方必须显式披露。** 启用隧道后流量经 Cloudflare；默认安装仍然没有第三方。README 与面板都要写，不能把「可选」说成「没有」。
    - **测试不得真的拉起 cloudflared 或联网**：`spawnImpl` / `fetchImpl` / 超时 / 平台 / 环境全部注入；用假 ChildProcess 驱动状态机，用假 fetch 驱动资产选择与摘要校验。


---

## Testing Requirements

- 测试运行方式：`npm test`（内部 `node --test "tests/*.test.mjs"`）。不引入测试框架依赖，用 `node:test` + `node:assert/strict`。
  **注意**：`node --test tests/` 在 Node 21+ 失效（目录参数被当字面 glob，目录本身被当测试文件执行，[nodejs/node#64555](https://github.com/nodejs/node/issues/64555)）。裸 `node --test` 可用。
- 必有单测覆盖（阶段 1 起逐阶段累积）：
  - 配对：兑换成功、重复兑换失败、过期失败。
  - 令牌：正确令牌通过、错误令牌失败、长度不同的令牌不抛错只失败、**非摘要的「哈希」被拒**。
  - 存储：原子写后可读回、损坏文件报 `store/corrupt`、Windows 下 chmod 不抛错、**非法 tokenHash 被拒**。
  - 审计：追加格式合法、30 天清理、导出不含正文。
- **文件级不变量测试**：断言 manifest 与 package 版本一致、`files` 全存在、客户端只有一个 ModuleLoader 入口、宿主半边只有 `src/host/tunnel.js` 可以 import `node:child_process`，且任何文件都不出现 `exec(`／`shell: true`。
- **验证测试真的能失败**：写完一条断言，故意改坏实现确认它变红，再还原。阶段 1 复核发现过 `assert.ok(() => JSON.parse(raw))` 这种永真式（函数对象恒为真值，根本没解析）。
- 真机验证（手机扫码、流式输出、吊销即时生效）不属于 `npm test`，由 `implement.md` 阶段 6 单独执行并记录结论。

## Code Review Checklist

- [ ] 鉴权判定是否只在 `gateway/auth.js` 一处？有没有 handler 自己判断 Cookie？
- [ ] **有没有哪个「直接放行」的分支跳过了某项检查，而网关自己会补上攻击者缺的那部分？**（阶段 2 真实缺陷：回环豁免跳过 Origin 围栏，而网关恰好注入内层凭证并剥离 Origin）
- [ ] 代理自己合成的头（`x-forwarded-*` 等）是不是「先丢再写」，而不是「有就保留」？
- [ ] 每个可能挂住的 `await` / `fetch` / 上游等待都有 deadline 吗？合并 in-flight 的那一处失败会不会放大成全站？
- [ ] `pipe()` 的源与目标是否都监听了 `error`，并且**等待阶段**是否也绑定了 `close`（断开不一定走 `error`）？
- [ ] `set-cookie` 是不是优先用 `getSetCookie()`？（`get()` 返回的是逗号拼接串）
- [ ] 内层 Cookie 是否只存在于网关→上游这一跳？有没有可能出现在响应头或日志里？
- [ ] 每个 `register*` / `listen` / `setInterval` 都有对应 disposer？
- [ ] 新增的 `catch` 是否吞掉了不该吞的错误？
- [ ] 响应体里有没有泄漏路径、URL、摘要？
- [ ] 测试是否真的能失败？（把断言改坏能不能红）
- [ ] `package.json` 与 `dsh.plugin.json` 版本是否一致？`engines.dsh` 与 `dsh --version` 是否对得上？
- [ ] **可信侧的凭据格式校验了吗？**（`verifyToken` 的 expectedHash 必须是摘要，否则手写字段即认证）
- [ ] 新增的字段是显示层事实还是判定输入？显示层字段有没有被误接进绑定/鉴权/服务决策？
- [ ] 严格校验（API，拒绝）与宽松归一化（读盘，丢弃）是不是共用同一段规则、同一次遍历？
- [ ] 枚举本机网卡/环境的那类副作用，有没有做成可注入的参数，让测试不依赖跑测的机器？
- [ ] **「替用户选默认值」的逻辑，有没有在真机枚举结果上看过第一名是谁？**（单测里的假数据永远比真机干净）
- [ ] **比对凭据摘要的每一处都走常量时间了吗？**（不是只有一个模块做对就算）
- [ ] 注入的 `random()` 返回短缓冲时会不会静默产出畸形值？
- [ ] `writeSync` 的返回值用了吗？
- [ ] 发布相关的断言是否钉住了**拒绝原因**（只断言「抛了」会被别的校验掩盖，等于没测）？
