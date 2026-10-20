# 公网接入：内置 Cloudflare Tunnel（cloudflared）

## 背景

`10-19-panel-access-modes` 交付的「接入地址簿」把公网地址定义成**用户自己维护的字符串**：
本插件不内置穿透、不做可达性探测。用户要公网访问，得先自己装 frp / 反代 / 隧道，
再把域名抄进地址簿。这条边界是当时刻意的（`prd.md` D3），但对最常见的一条路——
Cloudflare Tunnel——它把一个可以一键完成的事留成了手工活。

`cloudflared` 是 Cloudflare 官方的隧道客户端：它在本机起一个出站连接，把
`https://<域名>` 的流量转发到本地端口，不需要公网 IP、不需要路由器端口映射。
本项目已经有的东西正好接得上：

- 网关监听 `0.0.0.0:<remotePort>`，`cloudflared` 只要把流量打到
  `http://127.0.0.1:<remotePort>` 即可；
- 鉴权、配对、审计都在网关这一层，隧道只是一个新的「怎么到达网关」；
- 地址簿里的「公网地址」已经能让配对链接指向任意域名。

所以本次要做的是：**在插件里管理 cloudflared 进程，并把它的公网 URL 接进接入地址与配对链接**，
而不是再教用户手工抄地址。

## 目标

1. 面板里能直接启用 / 停止 Cloudflare Tunnel，不需要离开 GUI。
2. 支持两种隧道：
   - **快速隧道（quick）**：`cloudflared tunnel --url http://127.0.0.1:<port>`，
     免账号，得到随机 `https://<words>.trycloudflare.com` 域名；
   - **具名隧道（token）**：用户在 Cloudflare 控制台建好隧道并配好公开主机名，
     把 Token 填进面板，插件以 `cloudflared tunnel run --token-file <file>` 启动。
3. `cloudflared` 可执行文件**两种来源都支持**：
   - 系统已安装（PATH，或面板里填的绝对路径）；
   - 面板里点「下载 cloudflared」，插件从 Cloudflare 官方 GitHub Release 下载到插件数据目录。
4. 隧道运行时，接入地址多一个「Cloudflare Tunnel」选项；选中后配对链接使用隧道 URL。
5. 生命周期跟随网关：远程接入关闭 / 端口变化 / 插件卸载时，隧道一起停止或重启。
6. 不改变安全模型：隧道只是把公网流量送到网关，配对、凭证、Origin 围栏、吊销、审计全部照旧。
7. 诚实：隧道没起来、cloudflared 没装、Token 没填，都要在面板上显示成明确状态，
   不假装「公网已就绪」。

## 范围

| # | 能力 | 说明 |
|---|---|---|
| R1 | 隧道设置 | `settings.tunnel`：`enabled` / `mode`（`quick`\|`token`）/ `binaryPath` / `publicUrl`；旧 `devices.json` 缺字段时按默认值补齐 |
| R2 | Token 保管 | 具名隧道的 Token 不写进 `devices.json`，单独存 `~/.dsh/remote-control/cloudflared-token`（0600），API 只回 `tokenSet` |
| R3 | 进程管理 | 启动 / 停止 / 重启；捕获 stdout/stderr 解析快速隧道 URL；进程异常退出后状态变 `failed` 并给出错误码，**不自动重启** |
| R4 | 二进制定位 | 自定义路径 → PATH 里的 `cloudflared` → 数据目录里下载的那份；都找不到时状态可读 |
| R5 | 二进制下载 | 从 `api.github.com/repos/cloudflare/cloudflared/releases/latest` 选当前平台资产，按 GitHub 给出的 sha256 摘要校验后原子落盘；摘要缺失则拒绝安装 |
| R6 | 地址联动 | `settings.access.mode` 增加 `tunnel`；`effectiveAddress` 在 `tunnel` 模式下取运行时隧道 URL；配对链接不补网关端口 |
| R7 | 管理 API | `GET /tunnel`、`POST /tunnel`（start/stop/restart）、`POST /tunnel/config`、`POST /tunnel/download`，全部仅回环 |
| R8 | 面板 | 「接入」tab 增加 Cloudflare 卡片：状态、URL、开关、模式、Token、公开主机名、二进制来源与下载；配对 tab 的地址选择增加「隧道」 |
| R9 | 审计真实来源 | 经隧道进来的请求，用 Cloudflare 的 `CF-Connecting-IP`（仅在 socket 是回环时采信）作为审计与配对限速的来源地址 |
| R10 | 文档与规范 | README 明确「启用后流量经过 Cloudflare 第三方」；CHANGELOG、`.trellis/spec` 同步 |

### 明确不在范围内

- 自动安装 / 自动更新 cloudflared（下载必须由用户点一次；不做版本检查与自动升级）。
- 自动重启守护（进程退出后只报告，不循环拉起）。
- Cloudflare Access / `--allowed-mail` 等边缘鉴权配置；Access 由用户在 Cloudflare 侧配置。
- 修改隧道目标以外的网络行为：不做端口映射、不做 DDNS、不做可达性探测。
- 把管理 API 暴露到隧道上（仍然只服务回环）。
- 支持 Windows 以外的「下载后自动运行」特殊处理（下载支持三平台，运行按各自平台原样）。

## 验收标准

1. `settings.tunnel` 默认 `{ enabled: false, mode: 'quick', binaryPath: '', publicUrl: '' }`；
   旧 `devices.json` 读取后自动补齐，写回不会丢字段。
2. `POST /remote-control/api/tunnel { action: 'start' }`：
   - 网关未监听 → `409 admin/tunnel-no-gateway`；
   - 找不到 cloudflared → 返回 `state: 'failed'` 且 `error.code === 'tunnel/binary-missing'`；
   - 快速隧道成功 → 30 秒内状态变 `running` 并带 `url`；失败 → `failed` + 稳定错误码；
   - 具名隧道填了 Token → 以 `--token-file` 启动，Token 不出现在 argv、响应、日志里。
3. 隧道运行时停掉网关（关总开关或换端口）：隧道先停；换端口后以新端口重启。
4. `GET /tunnel` 永不返回 Token、不返回完整 stderr；`tokenSet` 只说明「有没有」。
5. 下载：选择平台资产、校验摘要、原子替换；任何一步失败都不留下半份可执行文件；
   已有进程在跑时拒绝下载（`409 admin/tunnel-busy`）。
6. 接入地址：`mode: 'tunnel'` 时配对链接 = 隧道 URL + `/remote-control/pair#<pairId>:<code>`，
   **不补**网关端口；隧道未运行时链接为空、面板提示先启用隧道。
7. 经隧道访问：`Host` 是隧道域名也能通过鉴权（未配对仍 401），已配对设备可正常打开会话；
   审计里的来源 IP 是真实公网 IP 而不是 `127.0.0.1`。
8. 关闭隧道 / 关闭插件后：cloudflared 进程不再存在，端口不残留。
9. `npm test` 全绿（现有 + 新增），`npm run check:syntax` 通过，`npm pack --dry-run` 文件数更新。
10. 面板在 1024×700 与 601×1731 下不溢出；错误态覆盖「未安装 / 未填 Token / 启动失败 / 网关未开」。

## 关键约束

1. **零运行时依赖**不变；只新增 Node 内置模块（`node:child_process` 仅限隧道模块）。
2. **唯一允许的外部进程是 cloudflared**：argv 数组、`shell: false`、二进制路径只来自
   「设置里的自定义路径 / PATH / 我们下载的那份」，不接受任意命令拼接。
3. **Token 是机密**：不进 `devices.json`、不进响应、不进日志、不进 argv；用 0600 文件 + `--token-file`。
4. **隧道失败不得拖垮插件**：`apply` 不因 cloudflared 缺失或网络失败而失败；远程接入本身继续可用，
   面板把隧道状态显示为不可用。
5. **第三方事实必须写清楚**：README 的「没有第三方服务」要改成「默认没有；启用 Cloudflare Tunnel 后
   流量经过 Cloudflare」。快速隧道域名每次启动都会变，已配对设备需要重新配对。
6. 地址仍是**显示层事实**：隧道 URL 只决定链接，不参与鉴权；配置写错最坏结果是链接打不开。
7. 下载来源固定为 `github.com/cloudflare/cloudflared`（API + 资产），不接受用户提供的 URL。

## 已定稿的决策

| # | 问题 | 决策 |
|---|---|---|
| D1 | 隧道类型 | 快速隧道 + 具名 Token 隧道，二选一 |
| D2 | 二进制来源 | 系统已安装与插件下载都支持；下载必须用户显式点击 |
| D3 | 启动方式 | 跟随网关：总开关开 + 隧道开关开才运行；面板可单独启停 |
| D4 | 进程退出 | 报告 `failed`，不自动重启 |
| D5 | 地址接入 | 新增 `access.mode = 'tunnel'`，不做「自动把 URL 塞进公网地址簿」 |
| D6 | 审计来源 | 回环 socket + `CF-Connecting-IP` 时采信后者；LAN 直连不采信 |
| D7 | Token 存储 | 独立 `cloudflared-token` 文件，0600，API 只回 `tokenSet` |
