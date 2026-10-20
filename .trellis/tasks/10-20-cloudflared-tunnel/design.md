# 设计：内置 Cloudflare Tunnel

> 配套事实见 `research/cloudflared-facts.md`；需求与验收见 `prd.md`。

## 1. 结论先行

- 新增两个宿主模块：`src/host/tunnel.js`（配置文法 + Token 文件 + cloudflared 进程控制器）
  与 `src/host/tunnel-binary.js`（定位 / 下载 / 校验）。
- 设置新增 `settings.tunnel`（**不含 Token**）；Token 单独存 `cloudflared-token`（0600）。
- 接入地址新增 `mode: 'tunnel'`，运行时 URL 由隧道状态提供；配对链接不补网关端口。
- 生命周期由 `src/index.js` 持有：网关启动 / 停止 / 换端口时联动，`ctx.effect` 兜底。
- 新增 4 条仅回环的管理 API；面板「接入」tab 增加 Cloudflare 卡片。
- **宿主半边的“不拉起外部进程”不变量被收窄，而不是删除**：只有 `tunnel.js` /
  `tunnel-binary.js` 可以 `import 'node:child_process'`，且只允许 argv 数组、`shell: false`、
  固定程序名。`tests/package.test.mjs` 继续守这条更窄的规则。

## 2. 模块边界与依赖方向

```
index.js ──► tunnel.js ──► tunnel-binary.js
   │            │
   │            └──► constants.js
   ├──► api.js ──► tunnel.js（只读状态 / 动作 / 写 Token，不 import gateway）
   └──► gateway/*（不感知隧道）

store.js ──► addresses.js ──► constants.js   （access 增加 tunnel 模式）
loopback.js ──► clientAddress()               （CF-Connecting-IP 的来源判定）
```

- `tunnel.js` 是**领域模块**：它不认识 HTTP、不 import `gateway/*`；`api.js` 与 `index.js`
  都能用它。
- 进程/网络副作用全部可注入：`spawnImpl`、`fetchImpl`、`platform`、`arch`、`env`、`now`、
  `baseDir`。测试不启动真实 cloudflared，也不联网。
- `gateway/*` 不 import 隧道模块：隧道只是“另一个到达网关的入口”，鉴权链路不变。

## 3. 数据模型

### 3.1 `settings.tunnel`

```jsonc
{
  "enabled": false,       // 是否随网关自动运行；面板开关
  "mode": "quick",        // "quick" | "token"
  "binaryPath": "",       // 空 = 自动（PATH / 数据目录里的下载副本）
  "publicUrl": ""         // 仅 token 模式：控制台里配置的公开主机名
}
```

- **默认值**：`null` / 缺字段 / 旧文件一律补齐成上表（`store.js#normalizeDocument`）。
- **文法等一次遍历、两种策略**（沿用 `addresses.js` 的既定模式）：
  - `normalizeTunnel(input)` 宽松：丢弃非法字段、回默认、永不抛；读盘用。
  - `validateTunnel(input)` 严格：第一条错误转成 `400 admin/invalid-tunnel`；写 API 用。
- 字段规则：
  - `enabled`：只认 `true`；
  - `mode`：`TUNNEL_MODES` 之一；
  - `binaryPath`：trim 后 ≤ `TUNNEL_BINARY_PATH_MAX`，不含 NUL / 换行；非空时必须是
    绝对路径或带分隔符的路径（裸名字允许，按 PATH 解析）；**配置了但不存在时不回退到 PATH**，
    状态直接报 `tunnel/binary-missing`（否则打错路径会被 PATH 里的旧版本悄悄兜住）。
  - `publicUrl`：走 `addresses.js#parseAddress`；没有 scheme 时补 `https://`（Cloudflare
    公开主机名一定是 TLS 终止）；有路径 / 查询 / userinfo 一律拒。
- `settings.version` 不升：这是**新增字段**，旧文件按默认值补齐即可。

### 3.2 Token 文件

- 路径：`<baseDir>/cloudflared-token`，模式 `0600`（Windows 上 chmod 是 no-op，不得抛）。
- 写入：临时文件 → `fsync` → `rename`，与 `store.js` 相同；空 Token = 删除文件。
- 读取：返回 `{ token, present, valid }`；文件存在但内容非法时 `valid: false`，
  启动报 `tunnel/token-invalid`，**不回显内容**。
- API / 状态只暴露 `tokenSet: boolean`，永远不返回 Token。
- 启动参数用 `--token-file <path>`（事实核查 §2.1）：Token 不进 argv、不进子进程环境。

### 3.3 接入地址：`mode: 'tunnel'`

```jsonc
{ "mode": "lan" | "public" | "tunnel", "lanAddress": "", "public": [], "selectedPublicId": null }
```

`effectiveAddress(access, lan, tunnelUrl)`：

| mode | 结果 |
|---|---|
| `lan` | 现有规则（存储值仍在列表里则用它，否则第一条；空列表 → null） |
| `public` | 现有规则（选中行或第一条） |
| `tunnel` | `tunnelUrl`（trim 后非空），否则 null |

- 隧道 URL 是**运行时事实**，不写盘。所以 `GET /state` 同时返回 `settings.access`
  与 `tunnel.url`，由客户端/宿主在拼链接时解析。
- 配对链接：`mode === 'lan'` 才补网关端口；`public` / `tunnel` 按填写的原样使用
  （隧道 URL 自带 `https://`，端口由 Cloudflare 边缘决定）。
- 切换地址不消耗配对码（既有行为不变）。

## 4. 进程控制器（`tunnel.js`）

### 4.1 状态机

```
            start()                 URL observed / grace elapsed
  stopped ──────────► starting ─────────────────────────────► running
     ▲                   │                                      │
     │                   │ spawn error / exit / timeout         │ exit
     │                   ▼                                      ▼
     └──── stop() ──── failed ◄──────────────────────────── failed
```

- 只有四个对外状态：`stopped` / `starting` / `running` / `failed`。
- `failed` 保留 `error: { code, message }`；下一次 `start()` 覆盖。
- **不自动重启**：进程退出就是退出，面板显示 `failed`，由用户点「重启」。

### 4.2 启动

```js
const child = spawnImpl(binaryPath, args, {
  env,                      // 继承宿主环境；token 走 --token-file，不写 env
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  shell: false,             // 显式写出，测试会断言
})
```

| 模式 | argv |
|---|---|
| quick | `['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:<port>']` |
| token | `['tunnel', '--no-autoupdate', 'run', '--token-file', '<baseDir>/cloudflared-token']` |

- 快速隧道：扫描 stdout + stderr 的每一行，匹配
  `/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i`（`quickTunnelUrl(line)`，纯函数）。
  首次匹配 → `url` 写入状态、状态转 `running`、等待者 resolve；超过
  `TUNNEL_START_TIMEOUT_MS`（30 s）→ 杀掉进程并报 `tunnel/start-timeout`。
- 具名隧道：spawn 成功后等 `TUNNEL_READY_GRACE_MS`（1.5 s）；这期间退出 → `failed`；
  否则 `running`，`url = publicUrl`（不再从日志猜）。
- **并发**：`start()` 串行化；相同指纹（mode + port + binaryPath + publicUrl + token）
  且已在运行 → 直接返回现有状态，不重复拉起。
- 目标端口来自网关的 **bound port**（`live.port`），不是设置里请求的端口
  （`config.port: 0` 时两者不同）。

### 4.3 停止

- 幂等。`SIGTERM` → 等 `TUNNEL_STOP_TIMEOUT_MS`（5 s）→ `SIGKILL`；无论是否优雅退出，
  最终状态 `stopped`、`url = ''`。
- `dispose()` = `stop()`，绝不抛；插件卸载 / 热重载都走它。

### 4.4 输出与日志

- 只保留最近 `TUNNEL_LOG_LINES_MAX` 行在内存，**不返回给 API**，也不写审计。
- 日志只记状态迁移与错误码，例如
  `[remote-control] cloudflared running (quick)` /
  `[remote-control] cloudflared failed (tunnel/start-timeout)`。
- 永不打印 Token、`--token-file` 内容、完整 stderr。

### 4.5 二进制定位（`tunnel-binary.js`）

顺序（`custom` → `path` → `downloaded`）：

1. `settings.tunnel.binaryPath`：trim 非空 → 若存在且是文件 → `custom`；不存在 →
   `missing`（**不回退**）。
2. PATH 扫描：Windows 按 `;` 拆、按 `PATHEXT`（默认 `.COM;.EXE;.BAT;.CMD`）试扩展名；
   POSIX 按 `:` 拆、检查可执行位。命中 → `path`。
3. 数据目录里的下载副本 `<baseDir>/cloudflared(.exe)` → `downloaded`。
4. 都没有 → `missing`。

### 4.6 下载

`downloadTunnelBinary({ baseDir, platform, arch, fetchImpl, timeoutMs })`：

1. `GET https://api.github.com/repos/cloudflare/cloudflared/releases/latest`
   （固定常量，不接受用户 URL）。
2. 按平台/架构选资产（表见研究文件）；不支持的组合 → `tunnel/unsupported-platform`。
3. 资产必须有 `digest: "sha256:<hex>"`；**没有摘要就拒绝安装**（`tunnel/download-failed`）。
4. `browser_download_url` 必须是 `https://github.com/...`；下载后先校验长度上限
   （`TUNNEL_DOWNLOAD_MAX_BYTES`）与 sha256，再落盘。
5. macOS 的 `.tgz`：先校验压缩包摘要，再 `gunzipSync` + 最小 ustar 解析取第一个普通文件；
   解析失败 → `tunnel/download-failed`。
6. 原子安装：同目录临时文件 → `fsync` → `rename`；POSIX `chmod 0755`。
   任何失败都删临时文件，绝不留下半份可执行文件。
7. 正在运行 / 正在启动时拒绝（`tunnel/busy`）——Windows 上替换使用中的 exe 会失败，
   而且“下载成功但还在跑旧版本”是骗人的状态。

下载是一次**显式的用户动作**，不在启动流程里自动触发；失败不影响远程接入本身。

## 5. 生命周期归属（`src/index.js`）

- `apply` 创建控制器（`baseDir` 来自 store），把 `getTunnel` / `applyTunnelChange` 交给
  `startAdminApi`；注册一个 `ctx.effect` 专门释放隧道进程。
- **网关启动成功后**（`startListener` 返回）：若 `settings.tunnel.enabled`，异步
  `start()`，失败只 log + 状态 `failed`，**不影响网关**。`apply` 的返回值仍然只等监听器。
- **网关停止 / 换端口**（`stopListener` / `applyListenerChange`）：
  - 停止前先 `await tunnel.stop()`，避免它在端口消失后反复重连；
  - 换端口时，新监听绑定成功后用新 `bound port` 重启隧道。
- **隧道设置变化**（`applyTunnelChange`）：`enabled` 关 → 停；开 → 起；其余字段变化且
  正在运行 → 重启；网关没在监听 → 不启动，只保存设置并如实返回 `stopped`。
- 所有启动/停止都串行化（复用 `reconfigureListener` 的 promise 链思路，隧道自己的链）。
- 失败策略：**隧道是可选的降级能力**。`apply` 不因 spawn / 下载 / 网络失败而失败，
  但面板必须显示 `failed` + 错误码（`quality-guidelines.md` §5 的“不许静默降级”）。

## 6. 管理 API

全部注册在官方回环服务器上，`guard(req)`（loopback + `checkAdminOrigin`）照旧先跑。

### `GET /remote-control/api/tunnel`

```jsonc
{ "ok": true, "data": { "tunnel": {
  "enabled": true, "mode": "quick", "publicUrl": "",
  "state": "running", "url": "https://xxx.trycloudflare.com",
  "error": null, "tokenSet": false,
  "binary": { "available": true, "source": "path", "path": "C:\\...\\cloudflared.exe" },
  "startedAt": "2026-10-20T00:00:00.000Z"
} } }
```

`GET /state` 的 `tunnel` 字段是同一份（面板一次读取即可拼链接）。

### `POST /tunnel`

```jsonc
{ "action": "start" | "stop" | "restart" }
```

- `start`：`enabled = true` 写盘后启动；网关未监听 → `409 admin/tunnel-no-gateway`。
- `stop`：`enabled = false` 写盘后停止。
- `restart`：`enabled = true`，先停再起。
- 隧道自身启动失败 → **200 + `state: "failed"` + `error`**（设置已保存，状态是事实），
  只有“没能开始尝试”才是 HTTP 错误。

### `POST /tunnel/config`

```jsonc
{ "mode": "token", "binaryPath": "", "publicUrl": "https://dsh.example.com",
  "token": "…" }   // token 缺省 = 不变；null / "" = 清除
```

- 严格校验合并后的候选对象；失败 `400 admin/invalid-tunnel`，一个字节都不写盘。
- Token 单独写文件；响应只回 `tokenSet`。
- 写完后调用 `applyTunnelChange`；返回最新状态。

### `POST /tunnel/download`

- 运行中 → `409 admin/tunnel-busy`。
- 成功 → `{ binary, version }`；失败 → `502 admin/tunnel-download-failed`。

错误码：`admin/invalid-tunnel`(400)、`admin/tunnel-no-gateway`(409)、
`admin/tunnel-busy`(409)、`admin/tunnel-action`(400)、`admin/tunnel-download-failed`(502)。
隧道内部错误码统一 `tunnel/*`（`error-handling.md` 增加该前缀）。

## 7. 审计来源：`CF-Connecting-IP`

新增 `loopback.js#clientAddress(req)`：

```
socket peer 不是回环            → peerAddress(socket)（LAN 直连，不采信任何头）
socket peer 是回环 + 无 CF 头   → peerAddress(socket) = 127.0.0.1
socket peer 是回环 + 有合法 IP  → CF-Connecting-IP
```

- 用在：`gateway/server.js` 的审计 `ip` 与 `x-forwarded-for`、`pairing-route.js` 的限速来源。
- 不在 `api.js` 使用（管理 API 只可能来自本机；没有“真实公网来源”这回事）。
- `gateway/proxy.js` 的转发头丢弃列表加入 `cf-connecting-ip`、`cf-ray`、`cf-visitor`、
  `cf-ipcountry`、`cdn-loop`：这些是上一跳（Cloudflare / 客户端）合成的，不能让它们进 DSH。
- 威胁模型：能伪造该头的只有本机进程（本地已被攻破的信任级别）；LAN 客户端 socket 不是
  回环，伪造无效。用 `node:net#isIP` 校验，非法值退回 socket 地址。

## 8. 面板（`src/client.js`）

### 8.1 数据读取

面板首次读取时并行请求 `GET /state` 与 `GET /tunnel`；`tunnel` 状态与 `settings` 一起进
快照。某个请求失败时隧道卡片显示明确错误，不影响其余 tab（现有 `readState` 的错误态机制）。

### 8.2 「接入」tab 的 Cloudflare 卡片

内容（自上而下）：

1. 标题 + 状态行：`未启用` / `已启动，正在等待公网地址…` / `运行中` / `启动失败（错误码）`。
2. 运行中：URL（只读文本 + 复制按钮）+ 快速隧道提示“域名每次启动都会变，已配对设备需重新配对”。
3. 按钮：`启用隧道` / `关闭隧道` / `重新启动`（busy 时禁用）。
4. 模式单选：快速隧道 / 具名隧道（Token）。
5. 具名模式：公开主机名输入（`https://…`）、Token 密码输入（占位符显示“已保存/未保存”），
   保存按钮；Token 从不回填。
6. 二进制行：`已找到（来源：PATH / 自定义 / 已下载）` 或 `未找到`；下载按钮（仅未找到时）；
   自定义路径输入 + 保存。
7. 说明：流量经 Cloudflare；快速隧道无可用性保证；具名隧道需在控制台配置公开主机名。

### 8.3 配对 tab 的地址选择

- 地址段从两段变三段：局域网 / 公网 / Cloudflare。
- 隧道段在 `tunnel.state === 'running'` 时可用；否则禁用并提示“先在接入页启用隧道”。
- 选中隧道 → `POST /settings { access: { mode: 'tunnel', … } }`；链接立即用隧道 URL。
- 预计地址为空时给出 `pair.tunnelDown` 提示，不生成二维码。

### 8.4 词典

新增 key（中/英 + `src/client.js` 内置回退词典三处同步）：
`address.modeTunnel`、`tunnel.heading`、`tunnel.state.*`、`tunnel.enable`、`tunnel.disable`、
`tunnel.restart`、`tunnel.mode.quick`、`tunnel.mode.token`、`tunnel.publicUrl`、`tunnel.token`、
`tunnel.tokenSet`、`tunnel.tokenUnset`、`tunnel.binary.*`、`tunnel.download`、`tunnel.downloading`、
`tunnel.hint.quick`、`tunnel.hint.token`、`tunnel.error.*`、`pair.tunnelDown` 等。
`tests/package.test.mjs` 的“zh/en 键集相同”继续守；客户端回退词典也要覆盖同一组 key
（`tests/client.test.mjs` 的文件级断言）。

## 9. 安全分析

| 问题 | 结论 |
|---|---|
| 隧道是否绕过鉴权？ | 不。流量到网关后仍走 `authorize`：未配对 401、Origin 围栏、吊销、审计全部照旧。管理 API 仍只服务回环，网关仍显式拒绝该前缀。 |
| Token 泄露面？ | 只在 0600 文件；不进 `devices.json`、响应、日志、argv、子进程 env。 |
| 下载供应链？ | 固定 GitHub 官方仓库；HTTPS；GitHub API 的 sha256 摘要；摘要缺失即拒绝；原子安装；仅用户点击触发。 |
| 外部进程执行？ | 只有 cloudflared；argv 数组、`shell:false`、`windowsHide:true`；程序路径来自设置 / PATH / 下载副本。设置自定义路径等价于用户自己运行该程序（本机信任级别）。 |
| 公网暴露配对页？ | 与“用户自己配公网地址”时相同：配对路由按设计无凭证可达，但受开关、Origin、限速约束，且从不接触 DSH。 |
| 快速隧道域名变化？ | 新域名 = 新 cookie 作用域，已配对设备需重新配对。这是快速隧道固有属性，UI 与 README 明说。 |
| 审计来源伪造？ | 仅本机进程可伪造 `CF-Connecting-IP`（已在本机信任级别内）；LAN 直连不采信该头。 |
| 第三方中转？ | 启用隧道后流量经 Cloudflare。README 从“没有第三方服务”改为“默认没有；启用 Cloudflare Tunnel 后流量经过 Cloudflare”，不藏。 |

## 10. 兼容与回滚

- 旧 `devices.json`：新增 `settings.tunnel` 缺省补齐；`access.mode` 旧值不变；
  不升 `version`，旧版本插件读新文件仍能加载（未知字段被投影丢弃）。
- 关闭隧道（默认）时行为与现在完全一致：不 spawn、不联网、不新增监听。
- 回滚：删除两个模块 + 反向改 `store/addresses/api/client`；进程在卸载时由 disposer 停掉，
  不会留下孤儿。

## 11. 测试设计

| 文件 | 覆盖 |
|---|---|
| `tests/tunnel.test.mjs`（新） | 配置文法矩阵；Token 文件原子写 / 非法内容；URL 解析；二进制定位（自定义缺失不回退、PATH、下载副本、Windows PATHEXT）；用假 `spawn` 跑状态机（running / timeout / exit / stop / 并发）；**断言 Token 不在 argv**；`clientAddress` 的回环+CF 头规则 |
| `tests/tunnel-binary.test.mjs` 或并入上者 | 资产选择矩阵；摘要缺失 / 不匹配拒绝；macOS tgz 解包；原子安装与临时文件清理；不支持平台 |
| `tests/admin-api.test.mjs` | 4 条路由的成功 / 400 / 409 / 502；响应不含 Token；`GET /state` 带 `tunnel` |
| `tests/plugin.test.mjs` | 网关启动 → 隧道自动启动（假 spawn）；关总开关 → 进程被停；换端口 → 用新端口重启 |
| `tests/addresses.test.mjs` / `tests/client.test.mjs` | `mode: 'tunnel'` 的 `effectiveAddress` 双端矩阵；常量与 key 集 |
| `tests/package.test.mjs` | 新模块进 `files` / `check:syntax`；`node:child_process` 只允许出现在两个隧道模块；`shell: true` 仍全局禁止；下载主机固定 |

## 12. 不做的事（与 prd 对齐）

- 不自动下载 / 不自动重启 / 不自动更新。
- 不把隧道 URL 写进公网地址簿（避免“运行时事实”被持久化成过期字符串）。
- 不做可达性探测：`running` 只表示“进程起来了 / 拿到了 URL”，**不表示**一定可达。
- 不改网关绑定地址、不改鉴权顺序、不把管理 API 暴露到隧道。
