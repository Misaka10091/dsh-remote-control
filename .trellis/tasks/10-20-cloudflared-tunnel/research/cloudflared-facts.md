# cloudflared 事实核查（2026-10-20）

> 来源全部是官方文档 / 官方 GitHub API 的原文，命令与字段按实测响应记录。
> 本文件只记录事实，设计取舍见 `../design.md`。

## 1. 快速隧道（Quick Tunnel）

官方文档：<https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/>

- 启动命令：

  ```
  cloudflared tunnel --url http://localhost:8080
  ```

- 不需要 Cloudflare 账号或域名；URL 形如 `https://<随机词>.trycloudflare.com`。
- **每次创建域名都会变**（原文：The hostname changes each time you create a Quick Tunnel）。
- 进程退出后 URL 立即失效。
- 限制（原文）：
  - 无可用性保证；
  - 每个快速隧道最多 200 个在途请求，超出返回 `429`；
  - **不支持 Server-Sent Events (SSE)**；
  - `--allowed-mail` 的邮件鉴权需要交互式浏览器会话，不支持非交互客户端。
- DSH 的流式输出走 `/api/remote.mux` 的 **WebSocket**（见仓库
  `10-17-remote-control/research/official-connection-fence.md`），不是 SSE，所以
  “不支持 SSE”这条不影响本项目的主链路；但快速隧道没有可用性保证，只能算临时通道。

## 2. 具名隧道（remotely-managed，Token）

官方文档：<https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/>

- 在 Cloudflare Zero Trust 控制台建隧道，选择 cloudflared 连接器，复制安装命令。
- 控制台命令的本质是：

  ```
  cloudflared tunnel run --token <token>
  ```

- 公开主机名（Published application）在控制台里配置，指向 `http://localhost:<port>`；
  插件从日志里拿不到它，所以本设计把它作为 `settings.tunnel.publicUrl` 由用户填写。
- 隧道 Token 是机密：它是「以该隧道身份连接 Cloudflare」的凭据。

### 2.1 Token 如何传给进程（已核对源码）

文件：`cmd/cloudflared/tunnel/subcommands.go`（master，2026-10-20 抓取）

```
TunnelTokenFileFlag = "token-file"
Usage: "The Tunnel token. When provided along with credentials, this will take precedence. Also takes precedence over token-file"
Name: "token", EnvVars: []string{"TUNNEL_TOKEN"}
EnvVars: []string{"TUNNEL_TOKEN_FILE"}
```

结论：Token 可以放环境变量（`TUNNEL_TOKEN`）、`--token`、`--token-file`。
本设计选 `--token-file`：Token 不进 argv（`ps` 可见），也不进子进程环境（`/proc/<pid>/environ`
同用户可见）；只在 0600 文件里，且该文件本来就在插件数据目录。

## 3. Release 资产与摘要（实测 API 响应）

`GET https://api.github.com/repos/cloudflare/cloudflared/releases/latest` → HTTP 200，
抓取时 `tag_name = 2026.10.1`，`assets[].digest` 字段形如：

```
"digest": "sha256:4d2490e74082c5d48dbfedaf92576fa5bd1702379ab88eb7faa0cfbe8dc891b6"
```

Release body 同时给出 `### SHA256 Checksums` 列表（两份信息一致，实测）。

与本项目相关的资产名（实测存在）：

| 平台 / 架构 | 资产名 | 形态 |
|---|---|---|
| win32 x64 | `cloudflared-windows-amd64.exe` | 单文件 exe |
| win32 ia32 | `cloudflared-windows-386.exe` | 单文件 exe |
| linux x64 | `cloudflared-linux-amd64` | 单文件二进制 |
| linux arm64 | `cloudflared-linux-arm64` | 单文件二进制 |
| linux arm | `cloudflared-linux-arm` | 单文件二进制 |
| darwin x64 | `cloudflared-darwin-amd64.tgz` | tar.gz，内含 `cloudflared` |
| darwin arm64 | `cloudflared-darwin-arm64.tgz` | tar.gz，内含 `cloudflared` |

推论：

- Windows / Linux 下载后直接可用；macOS 需要 gunzip + 解 tar 取出单文件。
- 摘要来自同一份 API 响应的 `digest` 字段，**不用**自己再找 checksum 文件；
  若某天响应里没有 `digest`，按设计拒绝安装（不把“未校验的可执行文件”写进数据目录）。
- 下载 URL 用资产自带的 `browser_download_url`，主机固定 `github.com`；元数据主机固定
  `api.github.com`。两处都不接受用户输入。

## 4. 与本项目网关的衔接事实

- `cloudflared` 的目标写 `http://127.0.0.1:<gatewayPort>`：网关默认绑 `0.0.0.0`，
  回环一定覆盖；若 profile 把 `config.host` 改成别的地址，隧道就连不上（文档里写明）。
- 经隧道到达网关的请求：TCP 来源是 `127.0.0.1`，`Host` 是隧道域名。
  - `isLoopback(req)` 要求 socket 与 Host 都是回环，所以不会被误判为“本机豁免”，
    仍要求设备 Cookie —— 正确。
  - `checkOrigin` 的 `Origin` 与 `Host` 都是隧道域名，同源判定通过。
- Cloudflare 边缘会加 `CF-Connecting-IP`（真实客户端 IP），并在本机回环这一跳保持该头。
  直连局域网的请求 socket 不是回环，因此**不能**采信该头，否则来源 IP 可伪造。
- 反向代理转发上游前会先丢弃客户端的 `x-forwarded-*`（`gateway/proxy.js`）；
  `cf-connecting-ip` 属于同类“转发头”，也要加入丢弃列表，免得客户端控制的值进入 DSH。

## 5. 本机实测（2026-10-20，Windows）

- `downloadTunnelBinary()` 走真实 GitHub API + 资产下载：5 秒拿到
  `cloudflared.exe`，sha256 摘要校验通过，`--version` 输出
  `cloudflared version 2026.10.1 (built 2026-10-15T09:15 UTC)`。
- 真实快速隧道：`cloudflared tunnel --no-autoupdate --url http://127.0.0.1:<port>`
  约 5 秒给出 `https://<四个词>.trycloudflare.com`，本项目的
  `quickTunnelUrl()` 从 stderr 中正确识别；通过该公网 URL 成功取回本机 stub
  服务的响应（HTTP 200）。
- 具名隧道（Token）只做了单元测试与参数断言，**没有**真实 Cloudflare 账号验证。
- 手机经隧道打开 DSH 会话、流式输出、吊销即时生效：**未验证**。

## 6. 待人工验证的部分

- 真实设备经快速隧道扫码 → 打开会话 → 发消息 → 收流式输出 → 停止（同 README「尚未验证」一节）。
- 具名隧道 + 固定域名的完整链路（需要真实 Cloudflare 账号与域名）。
- macOS 下载路径只在实现中被单测覆盖（本机是 Windows，不能实跑）。
