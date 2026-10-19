# Backend Development Guidelines

> 本项目的宿主侧（Node）开发规范。

---

## Overview

本项目是 DeepSeek Harness 插件 `@misaka10091/dsh-remote-control`。宿主半边是一个 Cordis 插件（`src/index.js` 导出 `name` / `inject` / `apply`），负责两件事：

1. 自建一条受配对门控的远程接入通道（反向代理到官方端口，含 WebSocket）。
2. 维护设备表、配对码、审计日志，并对外提供仅 loopback 可用的管理接口。

没有构建步骤，没有数据库，宿主侧只用 Node 内置模块。

**文档语言：本目录下的规范用中文书写**（与任务产物、提交信息保持一致）；代码注释与标识符用英文。

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | 模块划分与依赖方向 | Done |
| [Database Guidelines](./database-guidelines.md) | 本地文件持久化约定（无 DB） | Done |
| [Error Handling](./error-handling.md) | 错误码、网关响应、启动失败策略 | Done |
| [Quality Guidelines](./quality-guidelines.md) | 代码标准、禁止模式、测试要求 | Done |
| [Logging Guidelines](./logging-guidelines.md) | 诊断日志与审计日志的分工 | Done |

## 相关规范

- **发布与标签**：[`../release/index.md`](../release/index.md) —— 标签文法、三方版本一致、CHANGELOG 契约、npm/GitHub Release 流水线、打包边界。动 `package.json`、`dsh.plugin.json`、`CHANGELOG.md`、`.github/workflows/*` 或 `scripts/prepare-release.mjs` 时先读它。
- 跨层数据流与代码复用：[`../guides/index.md`](../guides/index.md)。

---

## Pre-Development Checklist

写宿主侧代码前，逐条确认：

- [ ] 读 `../tasks/10-17-remote-control/design.md` —— 尤其是 §3 鉴权流程与 §4.4 内层凭证
- [ ] 读 `../tasks/10-17-remote-control/research/official-connection-fence.md` —— 官方端口自带鉴权，不做内层凭证注入必然 401
- [ ] 确认本次改动落在 `src/host/`（领域）还是 `src/host/gateway/`（传输），依赖方向不能反向
- [ ] 确认所有副作用（文件根目录、时钟、随机源）都走参数注入，测试可脱离真实环境
- [ ] 确认新增的端口监听 / 定时器 / 订阅都有 `ctx.effect()` disposer
- [ ] 确认日志与响应体里不含令牌、Cookie、配对码、消息正文
- [ ] 若新增了源文件：它已进 `package.json#files` 与 `check:syntax`（`files` 是发布边界，见 [发布规范](../release/index.md)）

## Quality Check

提交前必须全绿：

```bash
npm test                # 内部是 node --test "tests/*.test.mjs"
npm run check:syntax    # 每个宿主模块 + scripts/prepare-release.mjs
npm pack --dry-run      # 产物完整性：31 个文件
```

> 不要写 `node --test tests/`：Node 21+ 会把目录参数当字面 glob，目录本身被当成测试文件执行（见 [Quality Guidelines](./quality-guidelines.md) 的 Testing Requirements）。`npm test` 传的是 glob，所有版本都能用。

外加人工过一遍 [Quality Guidelines 的 Code Review Checklist](./quality-guidelines.md#code-review-checklist)，其中最关键的三条：

1. 鉴权判定是否只在 `gateway/auth.js` 一处。
2. 内层 `dsh-auth-*` Cookie 是否绝不外泄给客户端。
3. 每个副作用是否都有 disposer。

---

## 关键事实（不在别处重复）

- 官方端口（默认 `127.0.0.1:19387`）**自带鉴权**，代理必须注入内层 Cookie、改写 Host、剥离 Origin。
- 本插件**不向官方 `webServer` 注册任何路由**，自建独立监听端口。
- 管理接口 `/remote-control/api/*` **仅接受 loopback**，已配对设备也不能管理设备。
