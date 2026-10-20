# 实施计划：内置 Cloudflare Tunnel

> 设计见 `design.md`。每一步都给出可验证的落点；顺序按依赖排，回滚点标在每段末尾。

## 0. 准备

- [ ] 读 `research/cloudflared-facts.md`，确认资产名、`--token-file`、快速隧道限制。
- [ ] 确认 `node -v` ≥ 18（`AbortSignal.timeout` 只作为可选，不依赖）。
- 回滚点：无代码改动。

## 1. 常量与配置文法

- [ ] `src/host/constants.js`
  - `TUNNEL_MODES`、`TUNNEL_TOKEN_FILE_NAME`、`TUNNEL_TOKEN_MAX`、
    `TUNNEL_BINARY_PATH_MAX`、`TUNNEL_START_TIMEOUT_MS`、`TUNNEL_READY_GRACE_MS`、
    `TUNNEL_STOP_TIMEOUT_MS`、`TUNNEL_DOWNLOAD_TIMEOUT_MS`、`TUNNEL_DOWNLOAD_MAX_BYTES`、
    `TUNNEL_LOG_LINES_MAX`、`TUNNEL_RELEASE_API`、`TUNNEL_QUICK_HOST_SUFFIX`、
    `CF_CONNECTING_IP_HEADER`。
  - `ACCESS_MODES` 增加 `tunnel`（`addresses.js` 的 `readAccess` 自动接受）。
- [ ] `src/host/addresses.js`
  - `effectiveAddress(access, lan, tunnelUrl)` 增加第三参，`tunnel` 模式取 URL。
  - 头注释补 `tunnel` 的一行说明；现有 lan/public 行为不变。
- [ ] `src/host/tunnel.js`（先只放纯函数）
  - `defaultTunnel()` / `normalizeTunnel()` / `validateTunnel()`：一次遍历、两种策略。
  - `quickTunnelUrl(line)`：`String#match`，不用 `.exec(`（package 测试禁）。
- 验证：`node --check src/host/constants.js src/host/addresses.js src/host/tunnel.js`。
- 回滚点：这三处是纯增量，`git diff` 可单独回退。

## 2. 存储

- [ ] `src/host/store.js`
  - `emptyDocument()` 加 `settings.tunnel = defaultTunnel()`。
  - `normalizeDocument()` 用 `normalizeTunnel(settings.tunnel)` 回填。
  - `updateSettings()` 支持 `patch.tunnel`（整体替换、先归一化）。
- [ ] 旧文件兼容：不升 `version`；读取缺字段文件后写回应带默认 tunnel。
- 验证：`node --test "tests/store.test.mjs"`（先跑旧用例，确认没打穿）。

## 3. 审计来源

- [ ] `src/host/loopback.js#clientAddress(req)`：
  - socket 非回环 → `peerAddress`；
  - socket 回环 + `cf-connecting-ip` 合法 → 该地址；
  - 否则 `peerAddress`。IP 合法性用 `node:net#isIP`。
- [ ] `src/host/gateway/server.js`：`peer` 改用 `clientAddress(req)`（HTTP 与 upgrade 两处）。
- [ ] `src/host/gateway/pairing-route.js`：限速来源改用 `clientAddress(req)`。
- [ ] `src/host/gateway/proxy.js`：丢弃列表加 `cf-connecting-ip` / `cf-ray` / `cf-visitor` /
  `cf-ipcountry` / `cdn-loop`。
- 验证：`node --test "tests/gateway-*.test.mjs"` 全绿；新增单测覆盖“LAN socket 不采信 CF 头”。
- 回滚点：这一节与隧道可分离，出问题先整体回退这四处。

## 4. 二进制管理（`src/host/tunnel-binary.js`）

- [ ] `resolveTunnelBinary({ baseDir, binaryPath, platform, arch, env })`
  → `{ available, source, path }`；顺序 custom → PATH → downloaded；自定义缺失不回退。
- [ ] PATH 扫描：Windows PATHEXT，POSIX 可执行位；找不到返回 `missing`。
- [ ] `downloadTunnelBinary({ baseDir, platform, arch, fetchImpl, timeoutMs })`
  - 固定 release API；资产名映射表；`digest` 必填；`browser_download_url` 必须是
    `https://github.com/cloudflare/...`。
  - 下载 → 长度上限 → sha256 → 解 tgz（macOS）→ 原子 rename → POSIX chmod 0755。
  - 任何失败：删临时文件，抛带 `tunnel/*` code 的普通 Error。
- 验证：`node --check`；下一步的单测。
- 回滚点：新文件，删掉即可；`package.json` 的 files/check:syntax 同步回退。

## 5. 进程控制器（`src/host/tunnel.js`）

- [ ] Token 文件：`readTunnelToken(baseDir)` / `writeTunnelToken(baseDir, token)`（0600、原子写）。
- [ ] `createTunnel(options)`：
  - `describe()`：状态 + 二进制信息 + `tokenSet`，不碰进程；
  - `start({ settings, port })`：校验 → 定位二进制 → 读 Token（token 模式）→ spawn →
    扫描 URL / grace → `running`；失败落 `failed` 并返回状态（不抛）；
  - `stop()` / `dispose()`：幂等、超时强杀、状态 `stopped`；
  - `download()`：运行中拒绝；成功后返回 `{ path, version }`；
  - `writeToken(token)`：写/删 Token 文件；
  - 相同指纹且在运行 → 直接返回；
  - 所有动作串行化（内部 promise 链）。
- [ ] `start` 的 argv 用数组，`shell: false`，`windowsHide: true`；Token 只经
  `--token-file`。
- 验证：`node --check`；单测在步骤 8 补齐。
- 回滚点：新文件 + 常量；删除即回到“没有隧道”。

## 6. 插件生命周期（`src/index.js`）

- [ ] 创建控制器；`config.tunnelSpawnImpl` / `config.tunnelFetchImpl` 作为测试注入缝。
- [ ] `startAdminApi({ getTunnel, applyTunnelChange })`。
- [ ] `startListener` 成功后异步启动隧道；`stopListener` 先停隧道；换端口后用新 bound port 重启。
- [ ] `ctx.effect` 注册 `remote-control: cloudflared tunnel` disposer。
- [ ] 失败只 log + 状态；**不得**让 `apply` reject。
- 验证：`node --test "tests/plugin.test.mjs"`；新增用例覆盖自动启动 / 关闭 / 换端口。

## 7. 管理 API（`src/host/api.js`）

- [ ] `getState()` 增加 `tunnel: getTunnel()?.describe() ?? null`。
- [ ] 路由：`GET /tunnel`、`POST /tunnel`（start/stop/restart）、`POST /tunnel/config`、
  `POST /tunnel/download`。
- [ ] 错误码与状态映射：`admin/invalid-tunnel`(400)、`admin/tunnel-action`(400)、
  `admin/tunnel-no-gateway`(409)、`admin/tunnel-busy`(409)、`admin/tunnel-download-failed`(502)。
- [ ] 响应永不含 Token / stderr。
- 验证：`node --test "tests/admin-api.test.mjs"`；新增 4 条路由用例。

## 8. 宿主测试

- [ ] `tests/tunnel.test.mjs`：配置文法、Token 文件、URL 解析、状态机（假 spawn）、
  并发、stop 超时、clientAddress。
- [ ] `tests/tunnel-binary.test.mjs`：资产映射、摘要校验、tgz、原子安装、平台不支持。
- [ ] `tests/addresses.test.mjs`：`tunnel` 模式矩阵（空 URL / 有 URL / 非法输入）。
- [ ] `tests/package.test.mjs`：新文件进 `files` 与 `check:syntax`；`node:child_process`
  仅允许两个隧道模块；`shell: true` 仍全局禁止；下载主机固定。
- 验证：`npm test`。

## 9. 面板（`src/client.js` + `locale/*.json`）

- [ ] `accessOf` 接受 `tunnel`；`effectiveAddress` 增加第三参，与宿主同矩阵。
- [ ] 快照读取并行 `GET /tunnel`；`tunnel` 进面板状态。
- [ ] 「接入」tab 的 Cloudflare 卡片（状态 / URL / 开关 / 模式 / Token / 公开主机名 /
  二进制 / 下载 / 提示）。
- [ ] 配对 tab 地址段增加「隧道」，未运行时禁用并提示。
- [ ] 词典：`locale/zh.json`、`locale/en.json`、`src/client.js` 内置回退词典三处同步。
- 验证：`node --check src/client.js`；`node --test "tests/client.test.mjs"`；
  文件级断言（单入口、无顶层 import/export、key 集一致）。

## 10. 文档

- [ ] `README.md`：功能表、快速开始加“公网访问”、安全边界加 Cloudflare 第三方与快速隧道
  域名变化、数据与配置加 Token 文件、开发命令的文件数。
- [ ] `CHANGELOG.md`：`## Unreleased` 下加 `### Added`。
- [ ] `package.json#files` 与 `check:syntax` 同步；`npm pack --dry-run` 记录新文件数。
- 回滚点：文档可单独回退。

## 11. 规范回写（Phase 3.3）

- [ ] `.trellis/spec/backend/quality-guidelines.md`：新增“外部进程集成”一条；更新
  Forbidden 3 与 Testing Requirements。
- [ ] `.trellis/spec/backend/directory-structure.md`：加两个模块。
- [ ] `.trellis/spec/backend/error-handling.md`：加 `tunnel/` 前缀与管理 API code。
- [ ] `.trellis/spec/backend/logging-guidelines.md`：隧道日志边界（如适用）。

## 12. 质量门

```bash
npm test
npm run check:syntax
npm pack --dry-run
```

- [ ] 全绿；失败用例逐条定位，不靠放宽断言过门。
- [ ] 人工过 `quality-guidelines.md` 的 Code Review Checklist，重点：
  - 鉴权仍只在 `gateway/auth.js`；
  - Token / 内层 Cookie 不出现在日志、响应、argv；
  - 每个 spawn / timer / 监听都有 disposer；
  - 隧道失败不会让 `apply` reject。
- [ ] 不能实跑的项（真机扫码过隧道、macOS 下载）在报告与 CHANGELOG 里写成“未验证”，
  不写成“已验证”。

## 13. 提交（Phase 3.4）

- [ ] 列 dirty 文件，区分本任务改动与既有未跟踪目录（`.tmp-asar/`、`.agents/` 删除项），
  **不**把无关改动混进提交。
- [ ] 按“实现 / 测试 / 文档+规范”分组提交；等待用户确认后再执行。
