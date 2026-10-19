# 设计：面板分 Tab 与审计明细

> 对应 `prd.md` R1–R7。跨三层：客户端信息架构、宿主审计读接口、共享的字段投影规则。

## 1. 客户端：Tab 结构

### 1.1 组件形状

```
Panel
├─ header（标题 / 副标题 / 关闭）        ← 不随 tab 变化
├─ ConfigBar                            ← 总开关 + 端口（面板级设置，全部 tab 共用）
├─ StatusStrip                          ← R3，常驻（监听端口 / 连接数 / 设备数）
├─ TabList (role="tablist")             ← 4 个 tab
└─ .drc-body（唯一滚动容器）
   └─ 4 × .drc-panelBody (role="tabpanel")
      └─ 该 tab 的 section 内容（访问过即保持挂载，非当前者 hidden）
```

- 四个 panel 的内容沿用现有组件：`AccessPointSection` + `PairingSection`（配对）/ `PublicBookSection`（接入）/ `DeviceSection` / `AuditSection` + `AuditEventsSection`。
- **面板级设置全部在顶部**（评审结论「端口同理，应当是顶部配置」）：`ConfigBar` 放总开关与端口，`StatusStrip` 放实时状态。它们不属于任何 tab——开关决定整块面板还能不能用，端口决定配对链接里要写哪个端口，把其中任何一个塞进某个 tab 都会让两个相邻设置从两个地方回答同一个问题。`ConfigBar` 挂在 tab 面板之外，半途输入的端口天然不会随切 tab 丢失。
- **配对 tab = 接入点 + 配对码**：`AccessPointSection`（局域网/公网切换 + 地址选择）在上，`PairingSection` 在下。选接入点属于「配对一台设备」，不是管理动作；马上要扫码的人不该为了改链接里的地址去换 tab。公网地址簿为空时，这一屏是个死胡同，所以空态给一个直达「接入」的按钮。
- **接入 tab = 只管理公网地址簿**（`PublicBookSection`）：增、删、备注、标出「使用中」。选哪一条在配对 tab 做，这里不做选择。
- **唯一滚动容器是 `.drc-body`**（`flex:1 1 auto; min-height:0; overflow-y:auto`）。审计明细**不再**自带 `max-height` 与 `overflow`：两层滚动在同一块面板里会让滚轮先滚内层到尽头再滚外层，而「加载更多」按钮落在第二个滚动语境里。
- **挂载策略：访问过就保持挂载**。非当前 panel 用 `hidden` 隐藏（同时移出无障碍树与 Tab 顺序），但**不卸载**——设备列表的吊销确认、公网地址簿的草稿、审计的分页游标都活在 section 里，卸载会把「请求还在飞、切回来却是干净表单」变成常态（PRD 约束 4）。首次访问才挂载，未访问过的 panel 不 `sectionsOf`；这几个 section 都不定时轮询，隐藏时不产生额外工作。
- tab 状态：`const [tab, setTab] = useState(null)`。**默认值不在初值里算**——首个渲染时 `/state` 还是空快照，算出来永远是「接入」。`null` 表示「用户还没选」，渲染时按实时状态推导：`tab === null ? preferredTab(settings, gateway) : tab`。这样状态到达后默认页自然变成「配对」，而用户一旦点过某个 tab 就不再被轮询改写。关闭面板即卸载，天然不记忆（约束 4）。

### 1.2 无障碍（tab 模式的标准契约）

| 要求 | 做法 |
|---|---|
| 角色 | `role="tablist"` / `role="tab"` / `role="tabpanel"` |
| 关联 | 每个 tab `id="drc-tab-<key>"` + `aria-controls="drc-panel-<key>"`；panel 反向 `aria-labelledby` |
| 选中 | `aria-selected` 唯一为真；`tabIndex` 选中为 0、其余 -1（roving tabindex） |
| 键位 | `ArrowLeft/ArrowRight` 循环切换，`Home/End` 到首尾，焦点跟随选中项 |
| 标题 | panel 内仍保留 `h3`（`drc-sectionTitle`），便于读屏定位 |

不做 URL 同步（面板是浮层，不改路由）。

### 1.3 状态条

`drc-statusStrip`：一行，`监听 3090 · 0 条连接 · 2 台设备`；取自 `/state` 的 `gateway.listening/port/liveConnections` 与 `devices.active/total`。
未启用 → `远程接入未启用`（纯文本，不带颜色语义）；监听中但接入开关为开却未监听 → 沿用现有 `access.gatewayNotListening` 的语义，避免两处说法不一致。

### 1.4 审计明细

```
[全部 ▾]  最近 50 条
┌───────────────────────────────────────────────┐
│ 17:42:03  配对     Android · Chrome   192.168.1.7 │
│ …                                              │
└───────────────────────────────────────────────┘
[ 加载更多 ]   或  没有更多了
```

- 表格用 `ul/li` + `grid`（不是 `<table>`：两列会换行，语义表格反而更难读）；每行四段。
- 时间：同一天只显示 `HH:MM:SS`，跨天显示 `MM-DD HH:MM:SS`（`title` 里放完整 ISO）。
- 设备列：`deviceId` 映射到设备名，来源是 **`snapshot.devices`**（`GET /devices` 的列表，客户端已在 `useGatewayStatus` 里维护）。**不是** `state.devices`——那个字段只有 `active`/`total` 两个计数，拿它映射会让每一行都落到 ID 回退。找不到对应设备时显示 `devId` 前缀 8 位（设备被删也看得懂）。
- 筛选：`<select>`，选项来自宿主返回的已知动作集合（与结算 `AUDIT_EVENTS` 同源，不在前端复制常量——见 §3）。
- 分页：`加载更多` 用 `nextBefore` 作游标；`nextBefore === null` 时按钮换成「没有更多了」。
- 状态：加载中（首屏）、追加中（按钮 loading）、空（`audit.empty` 语义）、失败（沿用 `FailureNotice`，403/网络/服务端分开）。
- 列表不再自带高度上限与滚动：条数由分页控制（50/页），滚动交给 `.drc-body`（见 §1.1）。

## 2. 宿主：审计读接口

### 2.1 端点

```
GET /remote-control/api/audit/events?limit=50&before=<cursor>&action=<event>
→ 200 { events: [{ ts, event, deviceId, ip }], nextBefore: string | null }
→ 400 admin/invalid-argument  （limit 非 1..200 / action 不在闭集 / before 解析失败）
```

- 仅回环：`guarded()` 第一条语句仍是 `guard(req)`（既有约定，一行不动）。
- 顺序：时间倒序（最新在前）。
- `limit` 默认 `AUDIT_EVENTS_PAGE_SIZE = 50`，上限 `AUDIT_EVENTS_MAX_PAGE = 200`（常量进 `constants.js`）。
- `before` 游标：`"<ts>.<seq>"`，解析失败 → 400。用序号而不是单纯时间戳，是为了同一毫秒的两条记录不被吞掉或重复（PRD 约束 5）。实现上 `seq` 是**按天序放大后的行号**（`dayOrdinal * 1_000_000 + lineNumber`），因为排序键是 `(ts, seq)` 而游标比较也用这一对，`seq` 必须是跨天文件的单调量，否则「同毫秒两条落在不同日期文件」时排序与游标会各自成立却互相矛盾。
- `action` 过滤在宿主侧做（PRD D4）。合法集合 = `AUDIT_EVENTS`（`classify.js`/`audit.js` 已有的闭集），非法值 400 而不是静默返回空。
- 响应里带 `actions`（闭集数组）**一次**即可——放在 `GET /state` 的 `audit` 字段里（`audit: { actions }`），避免每页重复传输。`/audit` 已经提供 `lines`/`files`/`retentionDays`，不重复。

### 2.2 读取路径与投影

现有 `audit.js` 只有 `summarize()` 与 `exportAll()`。新增 `readEvents({ limit, before, action })`：

0. **`ts` 的表示：磁盘与响应都是 ISO 字符串**（`buildAuditLine` 写的是 `new Date(at).toISOString()`，例如 `"2026-10-19T17:42:03.000Z"`）。**只有排序和游标**才把它 `Date.parse` 成毫秒。任何「`ts` 是数字」的写法都会让读数路径把所有正常记录判为坏行——这正是本轮评审抓到的文档缺陷（`Number.isFinite(row.ts)` 恒为 false）。
1. 从最新的一天文件往前遍历（`AUDIT_FILE_PREFIX + YYYY-MM-DD.jsonl`），逐行解析；
2. 每行先过 **与写入同源的投影**：只保留 `ts` / `event` / `deviceId` / `ip`；`isAuditEvent(event)` 为真、`Date.parse(ts)` 有限。`deviceId` / `ip` 各过写入侧同一套文法，**不合法就省略该字段而不是丢掉整条记录**——与写入侧「非法即不写」一致，且丢整条会让审计链路悄悄变短，比少一列更糟；
3. 遇到坏行跳过（与 `summarize` 的 `invalidLines` 口径一致，不抛）；
4. 按 `(ts, seq)` 倒序排，凑够 `limit` 或多凑一条以判断 `nextBefore`；
5. 返回投影后的记录，**绝不返回 `meta`**（PRD D5、约束 2）。

### 2.3 测试面

- 纯函数化：`readEvents` 接受注入的目录/时钟，测试用临时目录写若干 JSONL，断言顺序、分页不重不漏、过滤、投影（含 `meta: { text }` 被丢弃）、坏行跳过。
- API 层：400 的三种输入；`GET /state` 带 `actions`；非回环 403（复用现有 guard 测试）。

## 3. 共享常量

`AUDIT_EVENTS` 已是 `classify.js` 里被 `audit.js` 复用的闭集。**前端不复制这份常量**：`GET /state` 返回 `audit.actions`，面板据此渲染筛选下拉。理由与 `PAIRING_ROUTE_PATH` 相同——两处字面量必然漂移，而漂移的表现是「筛选某个动作永远 400」或「下拉里出现一个不存在的动作」。

## 4. 兼容与回滚

- 端点与 `/state` 字段都是**新增**；旧客户端不受影响（它不请求新端点）。
- `readEvents` 只读文件，不写任何东西；审计文件格式不变，导出不变。
- 回滚 = 删除端点 + tab 组件；没有磁盘迁移。

## 5. 已知限制

- 明细只覆盖 `AUDIT_RETENTION_DAYS`（30 天）以内且**留在本机**的记录；面板不提供跨机聚合。
- 分页是「向后翻」的一次性游标，不保证并发追加时严格快照（新写入的记录可能出现在下一页，因为它们是更新的；这是刻意取舍——审计是追加日志，实时性优先于一致性）。
- 筛选选项只含闭集里的动作，`unknown` 会把所有未识别路径归到同一个桶（既有 `classify.js` 行为）。
