# Frontend Development Guidelines

> 本项目的浏览器侧（客户端半边）开发规范。

---

## Overview

`src/client.js` 是一个**无构建步骤**的浏览器模块，由 DSH 的模块加载器按 `package.json` 的 `exports["./client"]` 装载。它只做一件事：在侧边栏底部注册一个入口，打开后是设备管理面板。

它**不拥有**会话数据，也不接管 DSH 自己的 WebSocket 通道——那个通道由宿主侧网关做透明代理。

**文档语言：本目录下的规范用中文书写**；代码注释与标识符用英文。

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | 单入口 + 子模块的拆分规则 | Done |
| [Component Guidelines](./component-guidelines.md) | `__ModuleLoader__` 包装、样式、可访问性 | Done |
| [Hook Guidelines](./hook-guidelines.md) | 内置 hooks、请求封装、订阅生命周期 | Done |
| [State Management](./state-management.md) | 组件内状态、不做全局状态的理由 | Done |
| [Quality Guidelines](./quality-guidelines.md) | 禁止模式、文件级不变量测试 | Done |
| [Type Safety](./type-safety.md) | 不用 TS 的类型责任分配 | Done |

---

## Pre-Development Checklist

写客户端代码前，逐条确认：

- [ ] 读 `../tasks/10-17-remote-control/design.md` §7（客户端 UI）
- [ ] 确认本次改动只在 `src/client.js`（或它拆出的 `src/client/*`），且没有引入第二个 client entry
- [ ] 确认没有任何顶层 `import` / `export` 语句
- [ ] 确认新增的 EventSource / 定时器 / 座位注册都有 cleanup
- [ ] 确认 API 用挂载相对路径（不以 `/` 开头）
- [ ] 确认错误态区分了 403（仅本机）/ 409（网关未监听）/ 网络失败
- [ ] 确认二维码之外还提供了可复制的纯文本配对码

## Quality Check

```bash
node --check src/client.js
node --test tests/          # 含文件级不变量：单入口、无顶层 import、词典键集一致
npm pack --dry-run          # 确认 lib/src/locale 都被打进产物
```

外加人工过 [Quality Guidelines 的 Code Review Checklist](./quality-guidelines.md#code-review-checklist)。

---

## 关键事实（不在别处重复）

- 客户端半边**不是独立应用**，它只是往宿主页面注册一个座位；不要试图自己接管路由或连接。
- 面板的所有管理接口是 `/remote-control/api/*`，**仅 loopback 可用**。远程设备即使已配对也打不开管理面板——这是有意设计（PRD R4 的安全边界），面板要能把这个 403 解释清楚，而不是显示"加载失败"。
- 移动端布局依赖上游，本插件不重构官方 CSS（PRD 明确不在 MVP 内）。
