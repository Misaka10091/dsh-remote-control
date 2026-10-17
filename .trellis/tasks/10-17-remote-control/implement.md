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

## 阶段 3：网关 WebSocket 侧

- [ ] `src/host/gateway/wsproxy.js`：升级鉴权 + 双向帧透传
- [ ] 处理 `/api/remote.mux` 多路复用连接（upgrade 同样需要 Host 改写 + 内层 Cookie，见 `design.md` §4.4）
- [ ] ping/pong 控制帧透传
- **验收**：远程浏览器能收到流式输出；断线后重连可用

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
