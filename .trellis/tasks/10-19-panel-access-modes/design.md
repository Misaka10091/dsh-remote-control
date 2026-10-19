# 设计：面板接入地址与模态重做

> 对应 `prd.md` R1–R6。跨三层：host 地址枚举/校验、settings 持久化、管理 API 契约、客户端模态与地址选择。

## 1. 数据模型

### 1.1 settings 扩展（additive，向后兼容）

```jsonc
"settings": {
  "enabled": true,
  "port": 3090,
  "access": {
    "mode": "lan",                    // 'lan' | 'public'；缺省 'lan'
    "lanAddress": "192.168.1.5",      // IPv4 字面量；'' = 自动（取第一条私网地址）
    "public": [                       // 0..8 条，用户自建，顺序即展示顺序
      { "id": "pub_k3f9", "label": "家里 DDNS", "address": "home.example.com:3090" },
      { "id": "pub_a1c2", "label": "隧道", "address": "https://dsh.example.net" }
    ],
    "selectedPublicId": "pub_k3f9"    // 必须命中 public 中的一条；否则视为第一条
  }
}
```

- 旧 `devices.json` 没有 `access` → `normalizeDocument` 补默认值，不需要迁移脚本，不加 `version`。
- **地址是显示层事实**：任何地址写错都不影响网关绑定/鉴权；最坏结果是链接打不开（PRD 约束 4）。

### 1.2 生效地址（effective address）规则

存的是"用户的选择"，用的是"此刻可用的那条"：

| mode | 生效地址 |
|---|---|
| `lan` | `lanAddress` 且它仍出现在本机网卡列表 → 用它；否则回退到列表第一条（私网优先）；列表为空 → 无地址 |
| `public` | `selectedPublicId` 命中的条目；否则第一条；`public` 为空 → 无地址 |

回退只在**拼链接**时发生，不写盘：`GET /state` 原样返回存储值 + 当前网卡列表，回退由客户端算（一条纯函数，可在 Node 里测）。这样网线拔了再插回来，用户原来的选择不会被他没做过的操作改掉。

## 2. Host 侧

### 2.1 新模块 `src/host/addresses.js`（纯函数，无 IO）

```js
listLanAddresses(interfaces = os.networkInterfaces())
// → [{ address: '192.168.1.5', iface: 'WLAN', private: true }]
// 过滤：IPv4、!internal、非 127/8、非 169.254/16（link-local）、去重
// 排序：物理网卡先于虚拟网卡（vEthernet / Hyper-V / WSL / Docker / VMware …），
//       同组内 192.168/16 → 10/8 → 172.16/12 → CGNAT 100.64/10 → 公网段，
//       最后按地址字典序稳定排序
// 依据（2026-10-19 真机）：只按"私网优先"排，Hyper-V 的 vEthernet(Default Switch)
// 172.29.240.1 会成为默认值——手机根本连不上。Tailscale 不算虚拟网卡：100.64/10
// 正是这类组网里远端设备要用的地址（`prd.md` 推荐 Tailscale）。

parseAddress(text)
// → { scheme: 'http'|'https'|null, host, port: number|null } | null
// 接受：host | host:port | http(s)://host[:port] | 1.2.3.4 | [::1]:3090
// 拒绝：带 path / query / fragment / userinfo、端口越界、空串、超长（>253）、协议不是 http(s)

effectiveAddress(access, lan)   // 见 §1.2，纯函数
formatAddress(parsed)           // 规范化回字符串（存盘用）
```

限额常量进 `constants.js`：`PUBLIC_ADDRESS_MAX = 8`、`PUBLIC_LABEL_MAX = 40`、`ADDRESS_TEXT_MAX = 253`。

### 2.2 `src/host/store.js`

- `normalizeDocument`：补 `settings.access`（逐字段校验，非法值回默认；`public` 过滤非法条目并按上限截断；`selectedPublicId` 不在列表内则置 null）。
- `updateSettings(patch)`：接受 `patch.access`（整体替换，先经 §2.1 规范化）；`enabled`/`port` 行为不变。

### 2.3 `src/host/api.js`

- `GET /state` 增加两个字段，其余不变：
  ```jsonc
  {
    "settings": { ..., "access": {...} },
    "addresses": { "lan": [{ "address": "...", "iface": "WLAN", "private": true }] }
  }
  ```
- `POST /settings`：
  - 新增可写字段 `access`；校验失败 → `400 admin/invalid-access`（带可读 message），**不写盘**；
  - 响应 `requiresReload` 语义收紧：**只有 `enabled` 或 `port` 真的变了才为 `true`**（地址本身不影响监听）。这是契约变化，要同步改测试与面板文案：保存地址显示「已保存」，保存端口显示「已保存，重启 dsh 后生效」。

## 3. 客户端

### 3.1 模态弹窗

- `require('react-dom')` 的 `createPortal`（已在 `tests/package.test.mjs` 的客户端 baseline 白名单），把 `Panel` 挂到 `document.body`：彻底脱离侧栏的 `overflow` 与可能的 `transform` 包含块，**这是修裁切的结构性做法**，不是调 z-index。
- 结构：`.drc-overlay`（fixed inset:0，半透明遮罩，`align-items:center; justify-content:center`）+ `.drc-panel`（`max-height:min(720px,calc(100vh - 32px))`，内部 `.drc-body` 滚动）。
- 关闭路径只保留两条：关闭按钮、`Esc`。**移除 `pointerdown` 外点关闭**（PRD D1）。遮罩点击不关闭，也不穿透（`onPointerDown` 上 `stopPropagation` 不需要——外层没有监听者，但遮罩本身不绑点击）。
- 焦点：打开时 `focus()` 面板容器；关闭时把焦点还给触发按钮（`triggerRef`）。`aria-modal="true"`、`aria-labelledby` 指向标题。
- 无障碍的最小集：`role="dialog"`、`aria-modal`、`Esc`、初始焦点、关闭后焦点归还。不做完整 focus-trap（不做循环 Tab）——面板不是危险确认框，成本收益不划算，写进"已知限制"。

### 3.2 地址选择

新组件 `AddressSection`（放在 `AccessSection` 之后、`PairingSection` 之前）：

```
接入地址
[ 局域网 | 公网 ]                     ← 分段按钮，写 settings.access.mode
局域网： <select> 192.168.1.5 · WLAN / 10.0.0.7 · 以太网
        （列表为空 → 灰字说明"没有可用网卡地址"）
公网：  ○ 家里 DDNS  home.example.com:3090   [删除]
        ● 隧道      https://dsh.example.net  [删除]
        [备注] [地址] [添加]
        （空 → 灰字"还没有配置公网地址"）
提示：公网需要你自己做端口映射或反代；本插件不检测可达性。   ← 仅 public 模式
```

- 所有改动走同一个 `updateSettings({ access })`，成功后本地快照立即更新（现有 `updateSettings` 已经是"以服务端返回为准"，不引入乐观更新）。
- 输入非法（前端 `parseAddress` 同规则）→ 就地提示，不发请求；服务端仍二次校验（前端校验不是安全边界，只是延迟）。

### 3.3 配对链接

`pairingUrl(pairing, addressText, fallbackHref)`：

```
pairingUrl(pairing, addressText, fallbackHref)
  effective = effectiveAddress(...)                     // §1.2
  if effective !== null:
      base = parseAddress(effective)
      scheme = base.scheme ?? 'http'
      port   = base.port ?? gateway.port ?? ''
      return `${scheme}://${base.host}${port ? ':'+port : ''}${pairPath}#${fragment}`
  // 没有任何可用地址（网卡列表为空且未配置公网）→ 退回旧行为（页面 host）
  return legacyPairingUrl(pairing, fallbackHref)
```

- 现有 `pair.loopbackHint` 只在**回退到页面 host 且那是回环地址**时显示；新增 `pair.publicHint`（公网需自备映射）与 `address.staleHint`（存储的局域网地址已不在本机，就地显示在接入地址卡片里——这是它唯一可操作的位置）。
- 切换地址不重新生成配对码：链接由 `pairing` 快照 + 地址状态实时渲染，`useState` 里只有一份 pair。

## 4. 测试

| 文件 | 新增断言 |
|---|---|
| `tests/addresses.test.mjs`（新） | 枚举过滤/排序（注入 interfaces）；`parseAddress` 接受/拒绝矩阵（路径、查询、userinfo、端口 0/65536、IPv6 括号）；`effectiveAddress` 四象限（命中/回退/为空） |
| `tests/store.test.mjs` | 缺 `access` 的旧文件加载成默认；非法条目被丢弃；`public` 超限截断；`updateSettings({access})` 落盘并可读回 |
| `tests/admin-api.test.mjs` | `GET /state` 带 `addresses.lan`；`POST /settings` 非法 access → 400 且文件未变；只改 access 时 `requiresReload === false`，改端口时 `true` |
| `tests/client.test.mjs` | `pairingUrl` 端口优先级（地址自带端口 > 网关端口）、`https` 保留、无地址时回退；`effectiveAddress` 回退规则；源码级：`createPortal` 存在、不存在 `pointerdown` 外点关闭、`aria-modal` 存在 |

## 5. 兼容与回滚

- 旧 `devices.json` 直接可用（additive 字段）；旧面板（未升级的客户端 bundle）读到多余字段会忽略。
- 回滚：还原 `src/host/addresses.js`、store/api/client 四处改动即可；没有磁盘迁移，没有版本号提升。
- `requiresReload` 收紧是唯一的行为变化，若担心第三方依赖旧语义，可保留旧字段并新增 `requiresReloadGateway`——**不采纳**：本插件的 API 只有自己的面板在调，多一个字段就是多一处漂移。

## 6. 已知限制

- 不做 focus trap（Tab 可离开面板）；不做地址可达性探测（PRD 明确）。
- 公网地址写 `https://` 时，面板生成的链接也走 https，但**网关本身仍是明文 HTTP**——这一跳由用户自己的反代终结 TLS，面板的提示文案必须说清楚。
