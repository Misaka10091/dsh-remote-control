# Directory Structure

> How backend code is organized in this project.

---

## Overview

插件是**单包、双端**结构：宿主半边（Node）与客户端半边（浏览器）在同一个 npm 包里，靠 `package.json` 的 `main` 与 `exports["./client"]` 分开加载。没有构建步骤。

---

## Directory Layout

```
src/
├── index.js              # 宿主入口：Cordis 插件（name / inject / apply）
├── client.js             # 客户端入口：window.__ModuleLoader__.load 包装（见 ../frontend/）
└── host/                 # 与传输无关的领域模块
    ├── constants.js      # 磁盘布局、数据模型版本、TTL、JWT 声明、文件权限
    ├── store.js          # devices.json 读写、原子写、0600
    ├── addresses.js      # 接入地址的归一化（store 与 api 共用）
    ├── tunnel.js         # Cloudflare Tunnel 配置文法、Token 文件与 cloudflared 进程控制器
    ├── tunnel-binary.js  # cloudflared 的定位、下载与 sha256 校验
    ├── pairing.js        # 8 位 base32 配对码、120s TTL、一次性兑换、锁定
    ├── tokens.js         # 设备凭证：HS256 JWT 签发/校验，手写实现
    ├── jwt-key.js        # 加载/创建 32 字节 HS256 密钥，0600，损坏时大声失败
    ├── loopback.js       # 两种传输共用的回环判定
    ├── origin.js         # Origin / Sec-Fetch-Site 围栏（含 checkAdminOrigin）
    ├── audit.js          # JSONL 审计写入、按天清理、导出、分页读取
    ├── classify.js       # 路径 + 方法 -> 审计事件
    ├── api.js            # /remote-control/api/*，仅回环
    └── gateway/          # 只在网关里成立的传输模块
        ├── server.js     # 自建 http.Server、ctx.effect 清理、状态映射
        ├── auth.js       # 唯一的鉴权决定（回环 / JWT / Origin / 吊销）
        ├── origin.js     # 转出 ../origin.js，保留公开形状（不转出 checkAdminOrigin）
        ├── inner-auth.js # 兑换并缓存上游的 dsh-auth-* cookie
        ├── proxy.js      # HTTP 反向代理：Host/Origin/Cookie 改写、SSE 透传
        ├── wsproxy.js    # WebSocket 升级透传，裸 node:net，不用 `ws`
        ├── pairing-route.js # GET/POST /remote-control/pair
        ├── activity.js   # lastSeenAt 节流落盘
        └── wire.js       # 响应写入器、cookie 序列化
locale/                   # 词典 json（zh / en）
tests/                    # node:test（npm test = node --test "tests/*.test.mjs"）
scripts/
└── prepare-release.mjs   # 发布校验的纯函数 + CLI（见 ../release/）
```

`src/host/*.js` 是**与传输无关的领域模块**（存储、地址、隧道、配对、令牌、审计），`src/host/gateway/*` 是**只在网关里成立的传输模块**。领域模块不得 import gateway 里的任何东西，否则它们就没法被 `/remote-control/api` 复用，也没法脱离 HTTP 单测。

`tunnel.js` 是本包唯一允许 import `node:child_process` 的模块（见 [Quality Guidelines](./quality-guidelines.md) §30），生命周期由 `src/index.js` 持有；`api.js` 只通过注入的 `getTunnel` / `applyTunnelChange` 读状态、发动作，自己从不 spawn。`gateway/*` 不 import 隧道模块：隧道只是「另一个到达网关的入口」，鉴权链路不变。

`scripts/` 与 `.github/` 属于发布链路，**不在 npm 包内**（`package.json#files` 未列）。新增工具脚本时先想清楚它属于「发布/仓库」还是「运行时」：只有后者才进 `files`。

---

## Module Organization

- 一个文件一个关注点。`pairing.js` 不碰文件系统，`store.js` 不生成随机数，`tokens.js` 不决定 TTL。
- 依赖方向单向：`index.js` → `gateway/*` 与 `api.js` → `store/pairing/tokens/audit`。反向依赖一律禁止。
- 每个模块导出**具名函数**，不导出 class（`store` 若需要持有路径，导出一个 `createStore(baseDir)` 工厂函数返回对象）。
- 所有副作用（文件系统根目录、随机源、时钟）必须可注入，测试不得触碰真实 `~/.dsh`，也不得依赖真实时间流逝。

## Naming Conventions

- 文件：小写 kebab-case（`inner-auth.js`、`wsproxy.js`）。
- 导出函数：动词开头 camelCase（`readDevices`、`redeemPairingCode`、`verifyToken`）。
- 常量：`UPPER_SNAKE`（`PAIRING_TTL_MS`、`DEVICES_FILE_MODE`）。
- 环境相关路径只在 `store.js` 里用 `os.homedir()` 解析，其余模块只接收 `baseDir` 参数。

## Examples

- 打包与 manifest 形态参考 `@misaka10091/dsh-git-panel`（已安装于 `~/.dsh/profiles/desktop/node_modules/`）。
- 网关内层凭证的兑换模式参考 `@linxin666/dsh-remote-web-ui` 的 `src/inner-auth.ts`。
