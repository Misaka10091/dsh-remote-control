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
├── client.js             # 客户端入口：window.__ModuleLoader__.load 包装
├── host/
│   ├── store.js          # devices.json 读写、原子写、权限
│   ├── pairing.js        # 配对码生成/兑换/过期
│   ├── tokens.js         # 令牌生成、sha256、timingSafeEqual
│   ├── audit.js          # 审计 JSONL 追加、清理、导出
│   ├── api.js            # /remote-control/api/*（仅 loopback）
│   └── gateway/
│       ├── server.js     # 自建 http.Server，监听与清理
│       ├── auth.js       # Cookie 解析、令牌校验、loopback 判定
│       ├── origin.js     # Origin / Sec-Fetch-Site 校验
│       ├── inner-auth.js # 内层 dsh-auth-* 兑换与缓存
│       ├── proxy.js      # HTTP 反向代理
│       └── wsproxy.js    # WebSocket 升级透传
locale/                   # 词典 json（zh / en）
tests/                    # node --test
```

两级划分的理由：`src/host/*.js` 是**与传输无关的领域模块**（存储、配对、令牌、审计），`src/host/gateway/*` 是**只在网关里成立的传输模块**。领域模块不得 import gateway 里的任何东西，否则它们就没法被 `/remote-control/api` 复用，也没法脱离 HTTP 单测。

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
