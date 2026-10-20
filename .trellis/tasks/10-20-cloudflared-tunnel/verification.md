# 验证记录（2026-10-20）

## 自动化

| 命令 | 结果 |
|---|---|
| `npm test` | 681 pass / 0 fail（新增 41 个隧道单测 + API/客户端/网关用例） |
| `npm run check:syntax` | 通过（24 个宿主文件 + `scripts/prepare-release.mjs`） |
| `npm pack --dry-run` | 33 个文件（新增 `src/host/tunnel.js`、`src/host/tunnel-binary.js`） |
| `git diff --check` | 无空白错误 |

关键断言（不是“跑通了”）：

- Token：`tunnel.test.mjs` 断言 Token 不在 argv、不在子进程 env、不在 `describe()` 输出；
  `admin-api.test.mjs` 断言响应体里没有 Token，只有 `tokenSet`。
- 下载：摘要缺失 / 不匹配 / 非 `github.com` 主机 / 平台不支持全部拒绝，且磁盘上不留可执行文件。
- 生命周期：URL 超时、进程提前退出、`stop` 打断等待中的启动、`dispose` 不等待启动、
  同配置不重复 spawn、换端口会重启。
- 来源 IP：回环 socket + `CF-Connecting-IP` 才采信；用真实请求验证审计里写的是
  203.0.113.9 而不是 127.0.0.1，且隧道 Host 不被当作本机豁免（未配对 401）。
- 包不变量：只有 `src/host/tunnel.js` 可以 import `node:child_process`，任何文件都不得
  `shell: true` / `exec(`；两个新模块都在 `files` 与 `check:syntax` 里。

## 真机 / 真实网络（本机 Windows）

1. **官方二进制下载**：`downloadTunnelBinary()` 走真实 GitHub API + 资产下载，
   5 秒安装 `cloudflared.exe`（2026.10.1），摘要校验通过；`--version` 输出
   `cloudflared version 2026.10.1 (built 2026-10-15T09:15 UTC)`。
2. **快速隧道端到端**：用 `createTunnel()` 启动真实 cloudflared 到本机临时 HTTP 服务，
   5 秒内得到 `https://<四词>.trycloudflare.com`，`quickTunnelUrl()` 正确识别；
   通过该公网 URL `fetch` 返回本地 stub 的 `tunnel-e2e-ok`（HTTP 200）。
   停止后进程退出，临时目录已清理。

**没有验证**：手机经隧道完成 DSH 会话（扫码 → 打开会话 → 流式输出 → 停止）、
具名隧道 + 真实 Cloudflare 账号/固定域名、macOS 的 tgz 解包真实链路
（只有单测覆盖）。这些不能写成“已验证”。

## 人工检查

- 面板：TunnelSection 的状态/URL/开关/模式/Token/公开主机名/二进制/下载/提示；
  地址段第三项在隧道未运行时禁用并给出「去接入启用」。
- 真机上未打开浏览器点过面板（当前会话没有 GUI 交互），DOM 行为靠文件级测试与
  source-level 断言覆盖；这一点与仓库既有客户端测试策略一致。
