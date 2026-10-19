# 设计：配对二维码

> 对应 `prd.md` R1–R5。全部落在客户端半边（`src/client.js`）+ 新测试与 fixture；宿主、网关、API 一律不动。

## 1. 编码器（`src/client.js` 内的纯函数）

### 1.1 对外形状

```js
/**
 * @param {string} text  UTF-8 文本（配对链接）
 * @param {{ version?: number, mask?: number }} [options]  仅测试用；省略即自动
 * @returns {{ ok: true, version: number, size: number, modules: Uint8Array }
 *         | { ok: false, reason: 'too-long' | 'empty' }}
 */
function encodeQr(text, options)
```

- `modules` 是 `size*size` 的 0/1 扁平数组，**不含静区**（静区是渲染层的事）。
- 挂在 `internals.encodeQr` 上，与 `pairingUrl` / `classifyFailure` 同一套测试通道。
- 失败用返回值而不是抛异常：面板要能就地降级（R4），而不是让 `apply`/渲染炸掉。

### 1.2 流水线

```
UTF-8 字节 → 版本选择 → byte 模式数据段 → 数据码字 + 填充
   → RS 纠错（GF(256)，本原多项式 0x11D）→ 分块交织 → 余数位
   → 矩阵骨架（定位/分隔/时序/校正/暗模块）→ 数据放置（之字形，避开功能图形）
   → 掩码（8 选 1，按 N1–N4 罚分）→ 格式信息（BCH 15,5 + 0x5412）→ 版本信息（v≥7，BCH 18,6）
```

需要的表（v1–v15，ECC M）：每版本总码字数、纠错块数与每块数据码字数、校正图形中心坐标。
表来自 ISO/IEC 18004 的公开参数，写死在文件里，**并用参考实现的输出间接验证**（错一格逐位比对就红）。

### 1.3 版本选择与容量

- 目标版本 = 第一个满足 `数据位 ≤ 该版本数据容量` 的版本（v1→v15 顺序扫描）。
- 全部版本都装不下 → `{ ok: false, reason: 'too-long' }`。
- 空串/非字符串 → `{ ok: false, reason: 'empty' }`。
- 容量按 byte 模式算：**不得**参考 node-qrcode 自动分段后的结果（研究 §3.1 实测 v4 vs v5 的差别就来自这里）。

### 1.4 掩码

- 8 个掩码全算一遍，按 N1（连续同色 ≥5）、N2（2×2 同色块）、N3（`1011101` 类图形）、N4（暗模块比例偏离 50%）罚分，取最小者。
- 罚分实现按规范写，**不抄参考实现的代码**；用 fixture 的「自动掩码比对」检验结论一致。

## 2. 渲染

### 2.1 SVG 形状

```js
// 单个 <path>，暗模块拼成 M x y h1 v1 h-1 z，避免几百个 <rect> 节点
h('svg', {
  className: 'drc-qr', viewBox: `0 0 ${size} ${size}`, role: 'img',
  'aria-label': t('pair.qrAlt'), shapeRendering: 'crispEdges', focusable: 'false',
}, h('path', { d, fill: 'currentColor' }))
```

- 静区由 CSS `padding` 提供（白底 + 四周留白），不写进 `viewBox`。
  > **check 阶段偏差（2026-10-19）**：像素写死的 `padding:10px` 在 v1 上约等于 1 个模块、v11 上约 3 个，
  > 永远到不了 ISO/IEC 18004 §9.1 要求的 4 个——而 §3.4 的一次性解码回读正是按「静区 4 模块」做的，
  > 等于验了一个 UI 并不画出来的符号。改为**静区写进 `viewBox`**（`qrViewBox`：`-4 -4 size+8 size+8`，
  > 由 SVG 自身的浅色 token 背景着色），CSS `padding:10px` 降级为额外留白；`qrPathData` 的坐标
  > 仍是未偏移的模块坐标。同一轮还改了配色：`--dsw-alias-label-primary` / `--dsw-alias-bg-layer-1`
  > 在暗色主题下会翻转（模块变亮、底变暗），画出浅底深码的反色符号，而「多数手机能读反色码」
  > 从未在真机验证过；改用主题无关的 `--dsw-static-neutral-bluish-1000`（模块）/
  > `--dsw-static-neutral-bluish-00`（静区），仍是设计 token、没有字面色。
- 颜色只用主题 token / `currentColor`（`quality-guidelines.md` 禁止写死颜色）。
- 尺寸：`width: min(200px, 100%)`，`aspect-ratio: 1`；窄视口下不撑破模态（任务 `10-19-panel-access-modes` 的 `.drc-panel` 宽 560px、内部滚动）。

### 2.2 接入位置

`PairingSection`：二维码放在分组文本码**上方**，下面是原有「配对码 / 配对链接 / 复制」。
仅当 `pairing` 快照存在时渲染；`encodeQr` 返回 `too-long` 时改为渲染 `pair.tooLong` 提示，文本码照旧。

新增 i18n 键（四份同步：`locale/zh.json`、`locale/en.json`、内联 `ZH`、内联 `EN`）：

| 键 | zh | en |
|---|---|---|
| `pair.qrAlt` | 配对二维码 | Pairing QR code |
| `pair.qrHint` | 用手机相机扫码，或在手机上输入下面的配对码 | Scan with your phone camera, or type the code below |
| `pair.tooLong` | 链接太长，无法生成二维码；请用文本码，或换一条更短的接入地址 | The link is too long for a QR code; use the text code or a shorter address |

## 3. 测试

### 3.1 fixture（`tests/fixtures/qr-reference.json`，纯文本）

```jsonc
[ { "text": "…", "ecc": "M", "version": 5, "mask": 3, "size": 37, "rows": ["0101…", …] } ]
```

生成方式（一次性，工具装在 `%TEMP%`，**不进 `package.json`**）：

```js
const qrcode = require(process.env.TEMP + '/qr-ref/node_modules/qrcode')
qrcode.create([{ data: text, mode: 'byte' }], { errorCorrectionLevel: 'M', version, maskPattern: mask })
```

覆盖文本：`01234567`（规范示例）、`HELLO WORLD`、真实局域网链接、真实公网 https 链接、250 字节长链接、
以及一条 v1 边界（最短可编码链接）。每条文本 × 8 个掩码；另加一组「自动」条目（不钉 version/mask）。

### 3.2 断言（`tests/qr.test.mjs` 新建）

1. 固定掩码逐位一致（每条文本 × 8 掩码）。
2. 自动版本/掩码逐位一致（自动条目）。
3. 容量边界：最短链接 → v1；v15 上限内的长链接通过；再长 → `{ ok: false, reason: 'too-long' }`。
4. 空串/非字符串 → `{ ok: false, reason: 'empty' }`。
5. `modules` 长度 = `size*size`，且仅含 0/1。
6. 同一文本两次调用结果一致（无隐藏状态）。

### 3.3 客户端渲染断言（`tests/client.test.mjs` 增补）

- `PairingSection` 用 stub React 渲染后，树里存在 `svg.drc-qr`，其 `path.d` 的 `M` 段数量等于矩阵中暗模块数。
- `encodeQr` 返回 `too-long` 时，渲染出 `pair.tooLong` 文案且**没有** `svg.drc-qr`。
- 切换接入地址（不同 `addressText`）后 `d` 不同、配对码不变。

### 3.4 一次性验证（不进 `npm test`，结论写进任务报告）

- jsqr 回读：把本实现产出的矩阵按 scale=4、静区=4 画成 RGBA，喂给 `jsqr`，断言回读文本 === 原文。覆盖 v1/v5/v11 与 250 字节长链接。
- 真机扫码：由用户在手机上完成，报告如实标注。

## 4. 兼容与回滚

- 只新增纯函数、SVG 渲染与 3 个 i18n 键；不动宿主、API、settings、网关。
- 回滚 = 删除 `encodeQr` 及其渲染分支与测试；无磁盘格式变化。

## 5. 已知限制

- **只做 byte 模式**：同一条链接的版本可能比 node-qrcode 的自动分段结果大 1–2 级（v5 vs v4）。
- **不做 focus/触控交互**：二维码是静态图片，不响应点击（点击复制的是链接，不是图片）。
- **面板宽度 560px 上限**：二维码边长固定 ≤200px，不随窗口放大。
