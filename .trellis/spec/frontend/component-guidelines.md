# Component Guidelines

> How the browser half of this plugin is built.

---

## Overview

客户端半边是**手写 ESM，无构建步骤**，在浏览器里由 DSH 的模块加载器执行。它必须能通过最简单的 `node --check`，且不产出任何编译产物。

入口唯一，形态固定（学 `dsh-git-panel`）：

```js
window.__ModuleLoader__.load({
  id: '@misaka10091/dsh-remote-control',
  factory: (require) => {
    const React = require('react')
    const E = React.createElement
    // ... 注册与组件定义
    return { apply }
  },
})
```

## Component Structure

- 组件用 `React.createElement` 手写（无 JSX，因为没有编译步骤）。可以把常用的 `h = React.createElement` 起个别名减少噪音，但**不要**在包里塞 JSX 运行时。
- 一个文件一个座位（seat）。注册进哪个 slot，就在那个文件里写清楚。
- 组件的 props 只用两种来源：座位提供的（如 `sidebar.footer.action` 给 `{ wide }`），以及组件自己的 `useState`。不要从全局变量读状态。

## Props Conventions

- 无 TypeScript，所以 props 结构靠**注释 + 运行时解构默认值**表达：

```js
/**
 * @param {object} props
 * @param {boolean} props.wide  侧栏是否为展开态（false = 56px 轨道）
 */
function Entry({ wide = false }) { /* ... */ }
```

- 可选座位 props 必须有默认值，宿主降级时不能崩。

## Styling Patterns

- **只用主题 token**，形如 `--dsw-alias-*`，不写死颜色。透明主题与背景插件要能透出来。
- 样式通过 `style` 内联或注入一段 `<style>`，不引入 CSS Modules（需要构建步骤）。若注入样式，必须在 effect 的 disposer 里移除。
- DOM class 前缀统一 `drc-`（dsh remote control），避免与别的插件撞名。

## Accessibility

- 图标按钮必须有 `aria-label` 与 `title`。
- 面板打开后焦点进入面板，`Esc` 关闭。
- 二维码必须同时提供**纯文本配对码**（PRD D2），不能只靠扫码。

## Common Mistakes

- **在客户端半边写 `import` 语句。** 这个文件是 `window.__ModuleLoader__.load` 包装的工厂函数，依赖靠参数 `require` 拿，不能有顶层 import（否则 `node --check` 与浏览器加载都会失败）。
- **硬编码 API 基址。** 用挂载相对路径（如 `remote-control/api`，无前导斜杠），让 `document.baseURI` 决定实际地址，否则子路径部署下会 404。
- **把 EventSource / WebSocket 留在模块作用域。** 必须放在组件 effect 里并在 cleanup 关闭，否则面板关闭后连接还在跑。
- **只渲染没有 disposer 的全局副作用。**
