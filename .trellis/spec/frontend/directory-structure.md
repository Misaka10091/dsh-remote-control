# Directory Structure

> How the browser half is organized.

---

## Overview

客户端半边是单文件入口 + 少量内部模块，全部手写 ESM，由 `window.__ModuleLoader__.load` 的 `factory(require)` 在浏览器里装配。**没有构建产物目录。**

---

## Directory Layout

```
src/
├── client.js             # 唯一客户端入口：__ModuleLoader__.load 包装
├── index.js              # 宿主入口（不属于前端，列在此仅为对照）
locale/
├── zh.json
└── en.json
```

**实测现状：`src/client.js` 约 4100 行 / 约 200 KB，仍是单文件单入口**，没有 `src/client/` 子目录。早期写的「超过约 1200 行就拆」并没有发生，也不该为了行数去拆：拆分要新增一份装配代码，而唯一的收益是阅读顺序。真需要拆时按下面的形态做，且 `package.json#exports["./client"]` 永远仍指向 `src/client.js`：

```
src/client/
├── panel.js              # 设备面板主体
├── seats.js              # 座位注册（侧边栏底部入口）
└── api.js                # 请求封装
```

`src/client.js` 只做装配（`__ModuleLoader__.load` + `factory(require)`），不新增第二个 client entry。拆出来的模块是工厂体内部的普通函数/组件，**不能**变成 ESM 模块（浏览器侧没有打包器，见 `quality-guidelines.md`）。

---

## Module Organization

- **座位注册**（`ctx.slots.register` / `ctx.slots.inject`）与**渲染**分开。注册代码短，渲染代码长；混在一起会让"这个插件到底占了几个座位"变得难以审查。
- 请求封装独立一处，组件不直接写 `fetch` URL。
- 词典放 `locale/*.json`，运行时通过 `ctx.locale` 绑定，不在组件里硬编码中文或英文。

## Naming Conventions

- 文件：小写 kebab-case。
- 组件函数：PascalCase（`RemoteControlPanel`）。
- hook：`useXxx`。
- 座位 id：`remote-control`；CSS class 前缀 `drc-`；浏览器存储键 `dsh-remote-control.*`。

## Examples

- 座位注册形态参考 `@linxin666/dsh-remote-web-ui` 的 `src/client/index.ts`（`ctx.slots.inject('sidebar.footer.action', ...)`）。
- 单文件 `__ModuleLoader__` 包装形态参考 `@misaka10091/dsh-git-panel` 的 `src/client.js`。
