# 实施：配对二维码

> 顺序按依赖排：先拿 fixture（没有它就没有验收标准），再写编码器，最后渲染与收尾。

## 0. 准备

- [ ] 读 `.trellis/spec/frontend/index.md` 与 `.trellis/spec/frontend/quality-guidelines.md`
- [ ] 读 `research/qr-reference-vectors.md`（三个坑：多模式分段、掩码不可靠、容量按 byte 算）
- [ ] 基线：`npm test`（533 通过）、`npm run check:syntax`
- [ ] 工具装到 `%TEMP%`（**不进仓库**）：`npm install --prefix "$env:TEMP/qr-ref" qrcode jsqr`

## 1. 生成参考 fixture

- [ ] 写一次性脚本（放 `%TEMP%`，不提交）用 node-qrcode 生成 `tests/fixtures/qr-reference.json`
  - [ ] 文本集：`01234567`、`HELLO WORLD`、局域网链接、公网 https 链接、250 字节长链接、v1 边界链接
  - [ ] 每条文本 × `maskPattern` 0–7，`mode: 'byte'`，`errorCorrectionLevel: 'M'`，版本按容量算好并写进条目
  - [ ] 另加一组自动条目（不传 version/mask）
- [ ] fixture 用脚本复核一次：`size === rows.length`，每行长度 = size，字符只含 0/1

## 2. 编码器（`src/client.js`）

- [ ] `encodeQr(text, options)` 纯函数：UTF-8 → byte 段 → 数据码字 + 填充
- [ ] v1–v15 ECC M 参数表（总码字、块结构、校正图形坐标）
- [ ] GF(256) 乘法 + RS 纠错 + 分块交织 + 余数位
- [ ] 矩阵骨架：定位/分隔/时序/校正/暗模块 → 之字形放置
- [ ] 掩码 N1–N4 罚分 + 8 选 1；格式信息（BCH 15,5 + 0x5412）；v≥7 版本信息（BCH 18,6）
- [ ] 失败返回 `{ ok: false, reason }`，不抛异常
- [ ] 挂到 `internals.encodeQr`
- [ ] `tests/qr.test.mjs`：固定掩码逐位一致、自动模式一致、容量边界、空输入、`modules` 形状、幂等
- [ ] `node --test tests/qr.test.mjs` 绿（**这一步之前不要碰渲染**）

## 3. 渲染

- [ ] `PairingSection` 增 SVG：单个 `<path>`，静区由 CSS padding，`role="img"` + `aria-label`
- [ ] `drc-qr` 样式：`width:min(200px,100%)`、`aspect-ratio:1`、`color:var(--dsw-alias-label-primary)`、白底
- [ ] `too-long` 分支渲染 `pair.tooLong`，文本码与链接照旧
- [ ] i18n 四份同步：`pair.qrAlt` / `pair.qrHint` / `pair.tooLong`
- [ ] `tests/client.test.mjs`：SVG 存在、`d` 段数 = 暗模块数、`too-long` 分支、切换地址后 `d` 变化

## 4. 一次性验证（结论写进报告，不进 `npm test`）

- [ ] jsqr 回读本实现矩阵（v1 / v5 / v11 / 250 字节），断言回读文本 === 原文
- [ ] 真机扫码：启动 `dsh --profile web`，面板生成配对码，手机扫——**由用户完成**，未做就如实写「未验证」

## 5. 收尾

- [ ] `npm test`、`npm run check:syntax`、`npm pack --dry-run`（确认 fixture 与 `src/host/addresses.js` 均在清单内，且**没有**引入依赖）
- [ ] 更新 `CHANGELOG.md`：把「No QR code」从已知限制移到 Added，并如实写验证程度
- [ ] 更新 `README.md` 的配对章节（QR 从「planned」改为已实现，写清只做 byte 模式）
- [ ] 更新 `.trellis/spec/frontend/quality-guidelines.md`：新增「纯函数编码器 + 参考实现 fixture」这条可复用做法

## 验证命令

```bash
node --test tests/qr.test.mjs
node --test tests/client.test.mjs
npm test
npm run check:syntax
npm pack --dry-run
```

## 回滚点

- 第 1 步只是新增 fixture 文件，删掉即回到现状。
- 第 2、3 步只增不改：编码器与渲染分支都是新增，回滚不影响既有配对流程（文本码始终保留）。
