# Quality Guidelines

> Code quality standards for the browser half.

---

## Overview

客户端半边的质量红线只有三条，但每条都曾让同类插件线上出过问题：**加载期不能崩、副作用必须可清理、结果不能骗人**。

没有 lint 工具链（不引入 eslint/prettier）：`node --check` + `node --test` + 人工 review 是全部的关卡。这是因为插件没有构建步骤，引入 lint 配置会制造两套事实来源。

---

## Forbidden Patterns

1. **任何顶层 `import` / `export` 语句。** 客户端半边是 `window.__ModuleLoader__.load({ factory })` 的工厂体，依赖来自 `factory(require)` 参数。顶层 import 会同时破坏 `node --check` 与浏览器加载。

2. **第二个 client entry。** `exports["./client"]` 永远只指向 `src/client.js`。

3. **模块作用域的 EventSource / WebSocket / setInterval。** 必须活在组件 effect 内并在 cleanup 关闭。

4. **写死颜色。** 只用 `--dsw-alias-*` 主题 token。

5. **硬编码 API 绝对路径**（以 `/` 开头）。用挂载相对路径。

6. **乐观更新吊销列表。** 必须等服务端确认。

7. **在 UI 上假装成功。** 请求失败、403、409 都必须渲染成明确的错误态。

---

## Required Patterns

1. **单入口包装**：`window.__ModuleLoader__.load({ id: '@misaka10091/dsh-remote-control', factory })`。

2. **座位注册带 cleanup**：`ctx.slots.inject(...)` 的返回值要能释放；热加载或禁用插件后不得残留图标。

3. **可选能力探测**：
   ```js
   let primitives = null
   try { primitives = require('@deepseek-ai/dsh-client-ui-primitives') } catch { /* 旧宿主降级 */ }
   ```
   消费前必须判空。

4. **错误态要具体**：区分「网络不可达」「403 仅本机可用」「409 网关未监听」「服务端错误」，不要统一显示"失败"。

5. **配对同时给二维码与纯文本码**（PRD D2），文本码可复制。

---

## Testing Requirements

客户端没有 DOM 测试环境（不引入 jsdom）。可测的部分约束在**文件级不变量**，已落地在 `tests/package.test.mjs`：

- `src/client.js` 里恰好出现一次 `__ModuleLoader__.load(`。
- `src/client.js` 不含 `^\s*import` / `^\s*export` 行。
- `src/client.js` 的 `id:` 等于包名。
- `src/client.js` 里每个 `require('x')` 都在客户端 baseline 白名单内。
- `package.json` 的 `exports["./client"]` 指向的文件存在。
- `locale/zh.json` 与 `locale/en.json` 的键集合相同。
- 宿主与客户端 `package.json` / `dsh.plugin.json` 版本一致。

> **实测教训（务必记住）**：`node --check src/client.js` **不会**因为顶层 `import` 报错——顶层 import 本身是合法 ESM 语法。但它会破坏 `__ModuleLoader__` 的工厂契约（依赖应来自 `factory(require)`）。所以这条**只能靠测试守**，不能靠语法检查。已验证：注入一行顶层 import 后 `node --check` 仍通过，而 `tests/package.test.mjs` 变红。

交互行为（配对流程、吊销即时生效）靠 `implement.md` 阶段 5/6 的**真机验证**覆盖，并在报告里写明验证到了什么程度——不把"模拟宿主通过"说成"真实 GUI 已验证"。

## Code Review Checklist

- [ ] 有没有顶层 `import` / `export`？**用测试验，别信 `node --check`**（见上）
- [ ] 每个 EventSource / 定时器都有 cleanup？
- [ ] 有没有写死颜色或绝对路径？
- [ ] 错误态是否区分了 403 / 409 / 网络失败？
- [ ] 吊销是否等服务端确认才改列表？
- [ ] 二维码之外是否还有纯文本配对码？
- [ ] 词典两种语言键集是否一致？
