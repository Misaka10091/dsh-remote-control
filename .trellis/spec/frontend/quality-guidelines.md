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

8. **在插件对象上 `inject: [...]` 声明可选服务。** 缺任何一个都会让本行永远 PENDING，而 web boot 对「没激活的 entry」零容忍（见 Required 6）。可选能力一律在 `apply` 内用 `ctx.inject([...], cb)` 逐次申请。

9. **不捕获就读取服务。** Cordis 客户端上下文是 Proxy，**未声明的服务连属性读都会抛**（`cannot get property "locale" without inject`）：只给 `ctx.get()` 包 try/catch 是不够的，`ctx[name]` 那条兜底路径同样要包。

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

6. **`apply` 永不抛出。** web boot 只认「entry 是否 activated」：任何一行没激活，整页就只剩 `Failed to load plugins — web boot: N entries did not activate`，没有 per-plugin 豁免。所以 `apply` 体内所有失败都必须收敛成 console 报告 + 本面板缺席，**绝不能把异常抛给 Loader**（红线 1 的具体做法）。可选服务用 `withServices(ctx, ['slots'], cb)` 这类包装：服务不来就不执行回调，行照样 ACTIVE。

7. **浮层用 portal，不用定位或层级。** 座位的祖先容器带 `overflow`（侧栏）和可能的 `transform` 包含块，锚定在座位里的弹层一定被裁切，`z-index` 救不回来——2026-10-19 的真实 GUI 事故就是这么来的。规则：`createPortal` 到 `document.body`（`react-dom` 已在客户端 baseline 白名单），容器 `position:fixed;inset:0` + `align-items/justify-content:center`，卡片 `max-height:min(…,calc(100vh - 2*padding))` 且正文 `overflow-y:auto` 内部滚动（这样 1024×700 与 601×1731 都不会溢出）。**降级路径不许抛**：没有 `document` → 什么都不渲染（读它本身会 `ReferenceError`）；有 `document` 但没有 `body` 或没有 `react-dom` → 原位渲染（难看但能用）。源码级测试守住这三条，因为 DOM 渲染在这里测不了。

8. **模态只留显式关闭路径，且 `aria-modal` 必须配焦点陷阱。** 关闭按钮 + `Esc` 两条；遮罩**不绑**处理器（不是"绑了再 return 早退"——不存在的监听器才不会被事件顺序打败）。打开时把焦点移进面板（容器 `tabIndex:-1`），关闭时归还触发按钮；`role="dialog"` + `aria-modal="true"` + `aria-labelledby` 指向**可见**标题，不用会漂移的重复 `aria-label`。`aria-modal` 是对读屏器的承诺「外面是不可用的」，所以 `Tab` / `Shift+Tab` 必须在面板内循环（只拦两个边界，中间的浏览器顺序不动）；不写陷阱就别写 `aria-modal`。陷阱的 focusable 过滤要加 `node.tabIndex !== -1`，否则 roving tabindex 的 tab 会被算进循环边界，而浏览器其实跳过它。

9. **枚举常量只能有一个来源：客户端从宿主读，不要抄一份。** 审计动作闭集 `AUDIT_EVENTS` 经 `GET /state` 的 `audit.actions` 到达面板，`src/client.js` 里没有任何动作字面量，用「闭集里相邻两个动作名不得同时以引号字面量出现」守（单个名字不够——`unknown` 本身也是合法失败类型）。抄一份的代价不是多几行：漂移的表现是下拉里出现一个永远 400 的选项，或一个永远筛不出来的动作，而这两种从宿主和客户端两侧都看不出来。同理，页大小不在客户端写第二遍——不传 `limit`，由宿主常量决定。

10. **tab 切换不许丢操作状态。** 只渲染当前 section 会在每次切换时卸载其余 section，而它们持有草稿、`busy`、结果提示与吊销确认：请求可能仍在飞，切回来却是干净表单。做法是「访问过就保持挂载」——非当前 panel 用 `hidden` 隐藏（同时移出无障碍树与 Tab 顺序）而不卸载；未访问过的仍不挂载，避免打开面板就预先挂四个 section 的副作用。跨 tab 要保留的操作状态（例如配对倒计时）放在 `Panel` 层而不是 section 里，否则它跟着 section 一起被卸载。
11. **新增一种接入方式时，「地址」只做显示层事实，运行时值不进设置。** Cloudflare Tunnel 的快速隧道域名每次启动都会变，所以 `access.mode = 'tunnel'` 的地址来自 `GET /state.tunnel.url`（运行时），客户端 `effectiveAddress(access, lan, tunnelUrl)` 与宿主共用同一份矩阵；把 URL 持久化进 `settings.access` 只会制造一个很快过期的链接。
12. **第三方中转必须显式披露。** 任何会让流量经过第三方的开关（如 Cloudflare Tunnel），面板上必须写明「启用后流量经 X」，并且默认安装不能悄悄启用；快速隧道的「域名每次启动都变，已配对设备需重新配对」属于同一类诚实要求，不能只在 README 里写。测试至少断言这些文案键存在且中英键集一致。

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

> **实测教训二（2026-10-19，真实 GUI 事故）**：上线后整页变成 `Failed to load plugins — web boot: 1 entry did not activate — @misaka10091/dsh-remote-control: failed`。真因是 `apply` 读未声明的 `locale` 服务，Cordis Proxy 直接抛 `cannot get property "locale" without inject`；单元测试用普通对象假 ctx，属性读永远返回 `undefined`，**所以 486 个测试全绿也拦不住**。两条防线从此固定：
>
> 1. `tests/client.test.mjs` 用 `makeCordisContext()` 造真 Cordis 形状的上下文（未声明读就抛、`inject` 才会授权、服务缺失则回调不执行），并先断言该 fixture 确实会抛，避免它退化成第二个假 ctx。
> 2. `apply` 整体 try/catch 兜底；`serviceOf` 的 `get` 与属性读**都**包 try/catch。
>
> 事故定位手段（值得复用）：headless Chrome + CDP 直接抓页面 console，比在浏览器里手点 DevTools 快；宿主日志里拿不到的原始错误文案，只有这一步能读出来。临时给 `apply` 加一层 diag 包装、把错误写进 `globalThis`，再由 CDP 读回，是定位「Loader 吞掉异常」最快的一招。

> **实测教训三（2026-10-19，同一批）：把同一条规则抄成两份，就必须用一份共用矩阵同时喂两边。** 浏览器半边不能 import `src/host/*`（单入口工厂、无顶层 import），于是 `parseAddress` / `formatAddress` / `effectiveAddress` 与三个限额常量（`ADDRESS_TEXT_MAX` / `PUBLIC_ADDRESS_MAX` / `PUBLIC_LABEL_MAX`）各有一份。只写「两份各自有自己的用例」不够——两份会一起漂移。做法：`tests/client.test.mjs` 把**同一份** accept/reject 矩阵同时跑过两侧并断言结果相等（含长度边界），限额常量由测试比对 host 常量而非各写字面量。复核时抓到过一个真实差异：`effectiveAddress` 对「没有字符串 `address` 的网卡条目」两侧行为不同（一侧跳过、一侧当首条），现已统一为跳过并由上面那份矩阵守住。

> **实测教训四（2026-10-19，配对二维码）：手写编解码器只能用「两个独立工具夹住」验，绝不能自己验自己。** QR 编码器（RS 纠错、掩码罚分、格式/版本信息，300+ 行）在阶段 5 被判成「无法验证所以不做」，于是 D2 承诺的二维码一直缺席，直到用户来问。可复用的做法分三步：
>
> 1. **参考实现必须钉死所有可变项。** 成熟实现（node-qrcode）会自动分段、自动选版本、自动选掩码；逐位比对前要强制成同一模式（`create([{ data, mode: 'byte' }])`）、同一版本、同一掩码。只放开一个可变项，否则比的是两个实现的启发式，不是编码正确性。实测：同一条 66 字节链接自动分段进 v4、强制 byte 模式进 v5。
> 2. **fixture 是纯文本 JSON，随仓库提交**（`{ text, version, mask, ecc, size, rows: ["0101…"] }`），生成工具装在 `%TEMP%`、不进 `package.json`（零依赖这条红线不破）。另加一组「自动」条目记录参考实现**选择**了什么，版本/掩码选择才顺带被验到。
> 3. **独立解码器只做一次性回读**（`jsqr`），把本实现的矩阵按 `scale=4、静区=4` 画成 RGBA 喂进去，断言回读 === 原文。它证明「符号真能解开」，**不证明手机能扫**；三者（逐位一致 / 解码器回读 / 真机扫码）必须在报告和 CHANGELOG 里分开写。
>
> 两个附带结论：**编码器必须是纯函数并挂到 `internals`**（浏览器半边没有 DOM 也没有构建步骤，纯函数才能在 `node --test` 里逐位断言，渲染只能做结构性断言：节点存在、`path` 的 `d` 重放等于矩阵）；**机器可读图形不能跟着主题翻转**——`--dsw-alias-label-primary` 在暗色主题变亮、`--dsw-alias-bg-layer-1` 变暗，于是面板一度画出浅底深码的反色二维码，而「多数现代手机能读反色码」这句话从未在真机上验证过（正是本清单禁止的「把未验证说成已验证」）。解法是用**主题无关的 `--dsw-static-*`**（仍是 token，不是字面色）固定「深模块 + 浅静区」，并把 4 模块静区写进 `viewBox`：像素写死的 `padding:10px` 在 v1 上是 1 个模块、v11 上是 3 个，永远到不了规范要求的 4 个。

交互行为（配对流程、吊销即时生效）靠 `implement.md` 阶段 5/6 的**真机验证**覆盖，并在报告里写明验证到了什么程度——不把"模拟宿主通过"说成"真实 GUI 已验证"。

## Code Review Checklist

- [ ] 有没有顶层 `import` / `export`？**用测试验，别信 `node --check`**（见上）
- [ ] `apply` 抛出路径有没有兜底？`inject` 里有没有声明可选服务？
- [ ] 读服务时 `ctx.get()` 与 `ctx[name]` 两条路都包了 try/catch？
- [ ] 每个 EventSource / 定时器都有 cleanup？
- [ ] 有没有写死颜色或绝对路径？
- [ ] 错误态是否区分了 403 / 409 / 网络失败？
- [ ] 吊销是否等服务端确认才改列表？
- [ ] 二维码之外是否还有纯文本配对码？
- [ ] 手写编码/序列化器有没有一份独立参考实现的逐位 fixture？可变项（模式 / 版本 / 掩码）是不是都钉死了？
- [ ] 机器可读图形（二维码等）的极性和静区固定吗？主题 token 会不会在暗色主题下把它反过来、或用像素写死的边距凑不够规范要求的静区？
- [ ] 词典两种语言键集是否一致？
- [ ] 弹层是不是 portal 到 `document.body`？有没有三条降级都试过（无 DOM / 无 body / 无 `react-dom`）且都不抛？
- [ ] 模态的关闭路径是否只有显式那两条？遮罩上有没有残留的 `onClick` / `pointerdown`？
- [ ] 抄到客户端的那份规则，有没有和 host 共用一份矩阵的测试（而不是各自一套用例）？
