# 实施：面板分 Tab 与审计明细

> 先做宿主（可单测、可独立验），再做前端；tab 只是搬运已有 section，风险最低放最后。

## 0. 准备

- [ ] 读 `.trellis/spec/backend/index.md`、`.trellis/spec/frontend/index.md` 与两侧 quality-guidelines
- [ ] 基线：`npm test`（559 通过）、`npm run check:syntax`、`npm pack --dry-run`（31 个文件）
- [ ] 读 `src/host/audit.js` 的写入校验（`sanitizeMeta` / `buildAuditLine` / `isAuditEvent`），读取投影要与之同源

## 1. 宿主：审计读接口

- [ ] `constants.js`：`AUDIT_EVENTS_PAGE_SIZE = 50`、`AUDIT_EVENTS_MAX_PAGE = 200`、游标分隔常量
- [ ] `audit.js` 新增 `readEvents({ limit, before, action })`：倒序遍历当天/往前文件，逐行投影 `ts/event/deviceId/ip`，坏行跳过，`nextBefore` 按「多凑一条」判断
- [ ] `api.js`：`GET /audit/events`，仅回环；`limit`/`before`/`action` 校验失败 → `400 admin/invalid-argument`
- [ ] `api.js` 的 `GET /state` 在 `audit` 下补 `actions: AUDIT_EVENTS`
- [ ] `tests/audit.test.mjs` 增补 `readEvents`：顺序、分页不重不漏、动作过滤、`meta` 被投影掉、坏行跳过、游标解析失败
- [ ] `tests/admin-api.test.mjs`：200/400 三类、非回环 403、`/state` 带 `actions`
- [ ] `node --test tests/audit.test.mjs tests/admin-api.test.mjs` 绿

## 2. 前端：Tab 外壳

- [ ] `useState` 的 tab 默认值按「接入开启且监听中 → 配对，否则接入」计算（关闭即卸载，不记忆）
- [ ] `TabList` + `TabPanel`：`role=tablist/tab/tabpanel`、`aria-selected`、roving `tabIndex`、`aria-controls`/`aria-labelledby` 双向
- [ ] 键盘：`ArrowLeft/ArrowRight` 循环、`Home/End` 到首尾，焦点跟随
- [ ] `StatusStrip`：`监听 3090 · 0 条连接 · 2 台设备` / 「远程接入未启用」
- [ ] 把现有四个 section 搬进对应 panel，不改其内部逻辑
- [ ] CSS：`drc-tabs` / `drc-tab` / `drc-tabActive` / `drc-statusStrip` / `drc-panelBody`；只用主题 token

## 3. 前端：审计明细

- [ ] `useAuditEvents({ action })`：首屏 50 条、加载更多按 `nextBefore` 追加、失败分类沿用 `describeFailure`
- [ ] 明细列表：时间（同日 `HH:MM:SS` / 跨天 `MM-DD HH:MM:SS`，`title` 放 ISO）、动作、设备名（缺失回退 id 前 8 位）、IP
- [ ] 筛选下拉：选项来自 `state.audit.actions`，切换即重置分页
- [ ] 状态：首屏加载 / 追加中 / 空 / 失败 / 没有更多了
- [ ] i18n 四份同步新增键（`audit.detail.*`、`tabs.*`、`status.*`）

## 4. 测试

- [ ] `tests/client.test.mjs`：tab 默认值规则、键盘切 tab、`aria-selected` 唯一、状态条文案、明细渲染字段（含「`meta` 里的自由文本不出现」）、加载更多拼接、筛选重置
- [ ] 防回归：断言前端**没有**复制动作闭集（源码里不出现硬编码动作数组）

## 5. 收尾

- [ ] `npm test` / `npm run check:syntax` / `npm pack --dry-run`
- [ ] 真机（headless Chrome）：1024×700 与 601×1731 两个视口，逐个 tab 截图；确认无页面级滚动、明细翻页与筛选可用
- [ ] `CHANGELOG.md` 增补（Added / Changed）
- [ ] `.trellis/spec`：记录「分页游标要带序号」与「读取路径要再投影一次」两条

## 验证命令

```bash
node --test tests/audit.test.mjs
node --test tests/admin-api.test.mjs
node --test tests/client.test.mjs
npm test
npm run check:syntax
npm pack --dry-run
```

## 回滚点

- 第 1 步只新增只读端点与字段，删掉即回到现状。
- 第 2 步把 section 搬进 tab，是纯前端结构改动；若 tab 无障碍验收不过，可先只保留「配对 / 审计」两个 tab 上线，其余再补。
