# 实施：面板接入地址与模态重做

> 顺序按依赖排：host 纯函数 → 持久化 → API → 客户端 → 测试冲齐。每一步都能单独跑测，随时可停。

## 0. 准备

- [ ] 读 `.trellis/spec/backend/index.md` 与 `.trellis/spec/frontend/index.md` 的开发前清单
- [ ] 确认现有基线：`npm test`（486 通过）、`npm run check:syntax`
- [ ] 记录基线失败项（应为空）

## 1. Host：地址枚举与校验（纯函数先落地）

- [ ] 新建 `src/host/addresses.js`
  - [ ] `listLanAddresses(interfaces)`：IPv4 / 非 internal / 非 169.254 / 去重 / 私网优先排序
  - [ ] `parseAddress(text)`：host、host:port、http(s)://host[:port]、IPv4、`[IPv6]`
  - [ ] 拒绝矩阵：path / query / fragment / userinfo / 端口 0 或 65536 / 空串 / >253 字符 / 非 http(s) 协议
  - [ ] `formatAddress(parsed)`、`effectiveAddress(access, lan)`
- [ ] `src/host/constants.js` 增加限额常量（`PUBLIC_ADDRESS_MAX` / `PUBLIC_LABEL_MAX` / `ADDRESS_TEXT_MAX`）
- [ ] `tests/addresses.test.mjs` 覆盖上面每一条（注入假 interfaces，不碰真实网卡）
- [ ] `node --test tests/addresses.test.mjs` 绿

## 2. Host：settings 持久化

- [ ] `src/host/store.js` `normalizeDocument` 补 `settings.access`（缺省/非法回默认、过滤非法条目、按上限截断、selectedPublicId 归一）
- [ ] `updateSettings` 接受 `access`（整体替换，先规范化）；`enabled`/`port` 行为不变
- [ ] `tests/store.test.mjs`：旧文件（无 access）→ 默认；非法条目丢弃；超限截断；写回可读
- [ ] `node --test tests/store.test.mjs` 绿

## 3. Host：管理 API

- [ ] `src/host/api.js` `getState()` 增加 `addresses.lan`
- [ ] `updateSettings` 接受 `access`，非法 → `400 admin/invalid-access`，**不写盘**
- [ ] `requiresReload` 只在 `enabled`/`port` 实际变化时为 true
- [ ] `tests/admin-api.test.mjs`：state 带 lan 列表；非法 access 400 且文件字节未变；只改 access → `requiresReload === false`
- [ ] `node --test tests/admin-api.test.mjs` 绿

## 4. 客户端：模态弹窗

- [ ] `require('react-dom')` 取 `createPortal`；`SidebarAction` 用 portal 把 `Panel` 挂到 `document.body`（`document` 不存在时降级为不渲染）
- [ ] CSS：`.drc-overlay`（fixed inset 0 / 遮罩 / 居中）+ 调整 `.drc-panel`（去掉绝对定位，`max-height`、内部滚动）
- [ ] 移除 `pointerdown` 外点关闭；保留 `Esc`；关闭按钮保留
- [ ] 焦点：打开时聚焦面板，关闭时归还触发按钮
- [ ] `aria-modal="true"` + `aria-labelledby`
- [ ] 手工验证两个视口（1024×700、601×1731）与 rail 折叠态不被裁切

## 5. 客户端：地址选择与链接

- [ ] i18n：`locale/zh.json` / `locale/en.json` / 内联 `ZH` / `EN` 同步新增键（四份必须键一致）
- [ ] `effectiveAddress` 与 `parseAddress` 的客户端副本（与 host 同规则；浏览器半边不能 import `src/host/`）
- [ ] 新组件 `AddressSection`：模式切换、局域网下拉（含"无可用地址"）、公网列表（添加/删除/单选/备注）、提示文案
- [ ] `pairingUrl` 改为接收入参地址；无可用地址时回退旧行为并保留 `pair.loopbackHint`
- [ ] 保存地址显示「已保存」；保存端口仍显示「已保存，重启 dsh 后生效」
- [ ] `tests/client.test.mjs`：端口优先级、https 保留、回退规则、源码级断言（createPortal / 无 pointerdown 外点关闭 / aria-modal）

## 6. 收尾

- [ ] `npm test` 全绿（数量从 486 增加）
- [ ] `npm run check:syntax`
- [ ] `npm pack --dry-run`：确认新增 `src/host/addresses.js` 在 `files` 里（**容易漏**，`files` 是白名单）
- [ ] 真机验证：启动 `dsh --profile web`，在面板里切局域网 IP / 加两条公网地址 / 复制链接，确认链接主机名随之变化
- [ ] 更新 `CHANGELOG.md`（Added + Changed：`requiresReload` 收紧）
- [ ] 更新 `.trellis/spec`（模态与"显示层地址不是鉴权因子"两条经验）

## 验证命令

```bash
node --test tests/addresses.test.mjs
node --test tests/store.test.mjs
node --test tests/admin-api.test.mjs
node --test tests/client.test.mjs
npm test
npm run check:syntax
npm pack --dry-run
```

## 回滚点

- 第 1、2 步只新增字段与模块，删掉即回到现状，无磁盘迁移。
- 第 3 步 `requiresReload` 语义收紧是唯一契约变化；若面板与 API 出现不一致，先回滚 `api.js` 这一处再查。
