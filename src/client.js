/**
 * dsh-remote-control — client half (plain JavaScript, no build step).
 *
 * One registration entry, exactly like the sibling panels
 * (`@misaka10091/dsh-git-panel`): the browser boot graph executes this script,
 * which only REGISTERS a factory; the factory body runs at materialization and
 * receives the synchronous `require` bound to the platform module table. There
 * is no second entry, no compiled output and no top-level `import` / `export`
 * — see `.trellis/spec/frontend/quality-guidelines.md`. A top-level `import`
 * would still pass `node --check` (it is valid ESM) while breaking this
 * contract, so `tests/package.test.mjs` guards it instead of the syntax check.
 *
 * ## What this half is, and is not
 *
 * It is ONE seat in the sidebar foot (`sidebar.footer.action`) rendering a
 * device panel. It is not an application: it owns no session data, no routing
 * and no transport to DSH. The remote transport is the host gateway, which
 * transparently proxies the official WebSocket; this file never touches it.
 *
 * ## The management API, and the 403 that is the design
 *
 * Every panel request goes to the admin API mounted at `remote-control/api`
 * (`src/host/api.js`), which is served on the OFFICIAL loopback `dsh web`
 * server and refuses anything that is not this machine (`prd.md` R4: pairing
 * grants session access, not administration). A paired phone that opens this
 * panel therefore gets **403** — and that is the feature, not a fault. So 403
 * renders as 「管理面板仅本机可用」 with an explanation, never as "load failed".
 * `prd.md`'s acceptance list and `.trellis/spec/frontend/quality-guidelines.md`
 * both name this as the failure mode to avoid.
 *
 * Paths are MOUNT-RELATIVE (`remote-control/api/...`, no leading slash) and are
 * resolved against `document.baseURI`, so a deployment under a sub-path still
 * reaches the API instead of 404-ing at the origin root.
 *
 * ## The dsh desktop app, and the marker header
 *
 * The desktop app is the one host where that 403 was WRONG rather than by design.
 * It serves this GUI from the custom origin `dsh-app://app` and forwards every
 * non-static request to the loopback port from the Electron main process, which
 * deletes `host`, `origin`, `cookie` and `sec-fetch-site` on the way (measured in
 * the shipped main bundle). A write issued from the panel there therefore carried
 * no origin proof at all and was refused — the panel loaded its state (reads are
 * not fenced) and then failed every save with 「请求来源被拒绝」. Every admin call
 * now carries {@link PANEL_MARKER_HEADER}, which the shell passes through
 * untouched and a cross-site page cannot add without a preflight the API never
 * approves; `src/host/origin.js#checkAdminOrigin` accepts it only when `Origin` is
 * absent, so nothing about the browser path changes.
 *
 * ## Every side effect is owned by an effect
 *
 * The poll timer, the pairing countdown, the `keydown` listener and the
 * object URL of an audit export all live in effects whose cleanup releases
 * them. Nothing is module-scoped: a hot reload or a disabled plugin must leave
 * no stray icon, no running poll and no listener behind
 * (`state-management.md` — no cross-mount state, no module-level cache).
 *
 * ## The panel is a modal, and its link is built from a chosen address
 *
 * Two fixes from 2026-10-19 that are structural rather than cosmetic:
 *
 *   - The panel is rendered through `createPortal` into `document.body`, inside a
 *     fixed scrim with a centred card. As an absolutely positioned child of the
 *     sidebar foot it was CLIPPED by the sidebar's `overflow` — a defect no
 *     z-index can reach. It now closes only on the close button and `Esc`
 *     (`prd.md` D1); the outside-`pointerdown` dismissal is deliberately gone.
 *   - The pairing link's hostname comes from `settings.access` resolved against the
 *     NIC list `GET /state` reports, not from `document.baseURI`. The desktop sits
 *     on `127.0.0.1`, so the old link could not be opened from a phone at all.
 *     The address is a DISPLAY fact: it never gates the gateway and never
 *     authenticates anything, so a wrong one costs a broken link and nothing more.
 *
 * ## The QR code, and why it is hand-written here
 *
 * `prd.md` D2 asked for QR-primary pairing and it was deferred once, for a real
 * reason: a QR encoder is Reed-Solomon + mask selection, this package ships ZERO
 * runtime dependencies (locked by `tests/package.test.mjs`), and an encoder whose
 * only verification is against itself produces a symbol that cannot be scanned
 * and cannot be told apart from a network fault. Task `10-19-pairing-qr` removed
 * that objection by pinning the encoder bit-for-bit against a mature reference
 * (node-qrcode, byte mode, ECC M) with a committed fixture, and by reading its
 * output back with an independent decoder once. The encoder lives in THIS half
 * because the symbol encodes the one-time link, whose fragment carries the
 * pairing code — rendering it host-side would mean sending that code to a server.
 *
 * The plaintext code and the copyable link remain: they are the fallback when a
 * link is longer than v15-M can hold, and the accessible path for anyone who
 * cannot point a camera at the screen.
 *
 * `internals` below is the private, documented surface the file-level tests
 * exercise (`tests/client.test.mjs`): it exists because the browser half has no
 * DOM test environment, and the transport classification / URL construction / QR
 * encoder are exactly the parts that must not ship unverified.
 */

window.__ModuleLoader__.load({
  id: '@misaka10091/dsh-remote-control',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    /* Destructured once, at materialization, so every hook below is the same
       function identity for the lifetime of the module. */
    const { useCallback, useEffect, useRef, useState } = React

    /**
     * `createPortal`, when this host's module table provides it.
     *
     * The panel is a centred modal and MUST NOT be laid out inside the sidebar
     * foot. It used to be an absolutely positioned child of the seat, which put
     * it inside the sidebar's `overflow` — the panel was clipped on the right and
     * bottom, and no z-index can fix clipping (2026-10-19, real GUI screenshots).
     * A portal moves the subtree to `document.body`, which is the structural fix
     * rather than a stacking-context argument.
     *
     * `react-dom` is in the client baseline (`tests/package.test.mjs` asserts the
     * whitelist), but the require is still guarded: this factory runs during
     * activation, and an unguarded throw here fails the plugin fiber and takes the
     * WHOLE web GUI down with it (`quality-guidelines.md` red line 1). A host
     * without it renders the panel in place, which is worse-looking but working.
     */
    let createPortal = null
    try {
      const ReactDOM = require('react-dom')
      if (ReactDOM !== null && (typeof ReactDOM === 'object' || typeof ReactDOM === 'function')
        && typeof ReactDOM.createPortal === 'function') {
        createPortal = ReactDOM.createPortal
      }
    } catch {
      /* No portal support: `portal()` below falls back to rendering in place. */
    }

    /* ------------------------------------------------------------------ *
     * Constants
     * ------------------------------------------------------------------ */

    /** Locale namespace of this plugin's dictionaries. */
    const NS = 'remote-control'

    /** The sidebar-foot list seat this plugin fills (declared by `dsh-client-ui-sidebar`). */
    const SEAT = 'sidebar.footer.action'

    /** Seat id, stable across reloads so a re-registration replaces rather than duplicates. */
    const SEAT_ID = 'remote-control'

    /**
     * Admin API base path, WITHOUT a leading slash.
     *
     * `component-guidelines.md`: the base is resolved against `document.baseURI`
     * at request time. An absolute `/remote-control/api` would work only when the
     * GUI is served from the origin root, and would 404 silently under a sub-path.
     */
    const API_BASE = 'remote-control/api'

    /**
     * Marker header sent on every admin API request.
     *
     * Duplicated from `src/host/constants.js` on purpose: this half has no
     * `import`, and the host copy is the one the fence reads. The two must be the
     * same literal — `tests/client.test.mjs` asserts that — because a mismatch is
     * silent in one direction only: a stale client still passes in a browser
     * (where `Origin` matches `Host`) and fails EXCLUSIVELY in the dsh desktop
     * app, which is the case this header exists for.
     *
     * Why it exists at all: the desktop app serves the GUI from `dsh-app://app`
     * and forwards every non-static request to the loopback Host with `Origin`
     * and `Sec-Fetch-Site` deleted, so a desktop-issued write carries no origin
     * proof and the fence refused it (`403 admin/cross-origin` — the panel could
     * read but never save). A cross-site page cannot add this header without a
     * CORS preflight the API never approves, which is what makes it usable as the
     * proof instead of an unconditional hole.
     */
    const PANEL_MARKER_HEADER = 'x-dsh-remote-control-panel'

    /** Value {@link PANEL_MARKER_HEADER} must carry; the host compares it exactly. */
    const PANEL_MARKER_VALUE = 'panel'

    /** Id of the injected stylesheet, so a reloaded copy does not add a second one. */
    const STYLE_ID = '@misaka10091/dsh-remote-control/client.css'

    /** While the panel is open, the device list and gateway state refresh at this cadence. */
    const POLL_INTERVAL_MS = 5000

    /** The pairing countdown ticks once a second; the code TTL is 120 s (`PAIRING_TTL_MS`). */
    const COUNTDOWN_INTERVAL_MS = 1000

    /** Deadline for one admin API request. An unanswered request must not hang the panel forever. */
    const REQUEST_TIMEOUT_MS = 15000

    /** Fallback attachment name when the export response omits `content-disposition`. */
    const AUDIT_FILE_FALLBACK = 'dsh-remote-control-audit.jsonl'

    /** Default pairing route, used when a payload omits `pairPath` (`PAIRING_ROUTE_PATH` host-side). */
    const DEFAULT_PAIR_PATH = '/remote-control/pair'

    /**
     * The pairing status route, below the admin API base (`GET /pairing/:pairId`).
     *
     * The panel holds the code and a local countdown, so it cannot tell a code
     * that is still waiting from one the phone already redeemed. This read answers
     * that on demand — the card's 「刷新」 button — instead of on a timer: the code
     * lives 120 s, and a poll watching it would be a second mechanism for a fact
     * one click already provides (`prd.md`: no auto-refresh).
     */
    const PAIRING_STATUS_PATH = 'pairing'

    /**
     * The states the host reports for one pair (`pairing.js#state`).
     *
     * A state outside this list is rendered as `unknown` instead of being trusted:
     * the browser half must be unable to paint an arbitrary host string as if it
     * were one of its own state names.
     */
    const PAIR_STATES = ['pending', 'used', 'locked', 'expired', 'unknown']

    /**
     * Address book bounds.
     *
     * MIRRORED from `src/host/constants.js` and not authoritative: the browser half
     * cannot import the host half (`src/host/` is Node ESM and is not in the
     * bundle), so the panel needs its own copy to keep an obviously-impossible
     * input from being sent. The server re-checks everything and is the only
     * authority (`quality-guidelines.md` — a front-end check is latency, not a
     * boundary). `tests/client.test.mjs` pins the parser against the host copy so
     * the two cannot drift.
     */
    const PUBLIC_ADDRESS_MAX = 8
    const PUBLIC_LABEL_MAX = 40
    const ADDRESS_TEXT_MAX = 253

    /** Id of the port input in the header config bar, so its label is a real `htmlFor` target. */
    const PORT_INPUT_ID = 'drc-port'

    /** Id of the panel's heading, targeted by `aria-labelledby` on the dialog. */
    const TITLE_ID = 'drc-panel-title'

    /**
     * The four panel tabs, in the order `prd.md` R1 names them.
     *
     * `key` is used three ways: the tab state value, the id suffix of the tab
     * (`drc-tab-<key>`) and the id suffix of its panel (`drc-panel-<key>`). Keeping
     * one value for all three is what makes the ARIA wiring impossible to get
     * half-right — a tab that controls a panel id it did not derive cannot exist
     * here.
     *
     * These are LAYOUT keys and have nothing to do with the audit action closed set.
     * That one lives on the host (`AUDIT_EVENTS`) and reaches this half through
     * `GET /state` as `audit.actions`; see {@link auditActionsOf}.
     */
    const TABS = [
      { key: 'pairing', labelKey: 'tabs.pairing' },
      { key: 'access', labelKey: 'tabs.access' },
      { key: 'devices', labelKey: 'tabs.devices' },
      { key: 'audit', labelKey: 'tabs.audit' },
    ]

    /** The tab keys in tablist order; roving focus wraps over exactly this list. */
    const TAB_KEYS = TABS.map((tab) => tab.key)

    /** Audit-detail route, below the admin API base (host: `GET /audit/events`). */
    const AUDIT_EVENTS_PATH = 'audit/events'

    /**
     * Failure kinds the panel distinguishes.
     *
     * `quality-guidelines.md` (frontend) required pattern 4: 「区分「网络不可达」
     * 「403 仅本机可用」「409 网关未监听」「服务端错误」，不要统一显示"失败"」. Each
     * kind maps to its own title and body key, so no two conditions read alike.
     */
    const FAILURE_KINDS = [
      'loopback',
      'crossOrigin',
      'gatewayDown',
      'notMounted',
      'network',
      'timeout',
      'server',
      'unknown',
    ]

    /**
     * Stable tunnel codes → locale keys.
     *
     * The host publishes `tunnel/*` codes for the PROCESS's state (not an HTTP
     * error) and `admin/tunnel-*` codes for a refused action. Rendering the code
     * itself would put English host text in a localized panel; rendering nothing
     * would leave "failed" with no cause. This map is the one place the two
     * vocabularies meet, and an unknown code falls back to a generic sentence plus
     * the code shown separately, so a future host code is visible instead of blank.
     */
    const TUNNEL_ERROR_KEYS = {
      'tunnel/binary-missing': 'tunnel.error.binaryMissing',
      'tunnel/token-missing': 'tunnel.error.tokenMissing',
      'tunnel/token-invalid': 'tunnel.error.tokenInvalid',
      'tunnel/url-missing': 'tunnel.error.urlMissing',
      'tunnel/start-timeout': 'tunnel.error.startTimeout',
      'tunnel/spawn-failed': 'tunnel.error.spawnFailed',
      'tunnel/exited': 'tunnel.error.exited',
      'tunnel/no-port': 'tunnel.error.noPort',
      'tunnel/download-failed': 'tunnel.error.downloadFailed',
      'tunnel/unsupported-platform': 'tunnel.error.unsupportedPlatform',
      'tunnel/storage': 'tunnel.error.storage',
      'tunnel/busy': 'tunnel.error.busy',
      'admin/invalid-tunnel': 'tunnel.error.invalidConfig',
      'admin/tunnel-no-gateway': 'tunnel.gatewayOff',
      'admin/tunnel-busy': 'tunnel.error.busy',
      'admin/tunnel-download-failed': 'tunnel.error.downloadFailed',
      'admin/tunnel-storage': 'tunnel.error.storage',
      'admin/tunnel-failed': 'tunnel.error.actionFailed',
    }

    /** The four states the host reports. Anything else is rendered as `stopped`. */
    const TUNNEL_STATES = ['stopped', 'starting', 'running', 'failed']

    /* ------------------------------------------------------------------ *
     * Dictionaries
     *
     * The running bundle cannot fetch `locale/*.json` (the loader serves this
     * file from a combo URL, not from the package directory), so the strings
     * ship inline. `locale/zh.json` / `locale/en.json` remain the human-readable
     * source of truth and `tests/client.test.mjs` asserts the two are EQUAL, not
     * merely key-compatible, so neither copy can drift unnoticed.
     * ------------------------------------------------------------------ */

    const ZH = {
      'panel.title': '远程控制',
      'panel.subtitle': '配对设备后可在此接入同一会话',
      'panel.entry': '远程连接',
      'panel.close': '关闭',
      'panel.retry': '重试',
      'panel.loading': '正在读取设备状态…',
      'access.heading': '接入',
      'access.enable': '启用远程接入',
      'access.enableHint': '关闭时官方 dsh web 端口完全不对外，行为与未安装插件一致。',
      'access.port': '端口',
      'access.save': '保存',
      'access.saved': '已保存。',
      'access.reloadRequired': '设置已保存到磁盘，但当前进程仍在使用旧的监听配置，需要重启 dsh 才会生效。',
      'access.invalidPort': '端口必须是 1 到 65535 之间的整数。',
      'access.gatewayDisabled': '未启用，没有监听端口。',
      'access.gatewayNotListening': '已启用，但没有在监听。请检查端口是否被占用，或换一个端口。',
      'access.gatewayListening': '正在监听 {port} 端口，已建立 {live} 条远程连接。',
      'point.heading': '配对地址',
      'address.heading': '公网地址',
      'address.modeLan': '局域网',
      'address.modePublic': '公网',
      'address.lanEmpty': '没有可用的网卡地址。',
      'address.publicEmpty': '还没有配置公网地址。',
      'address.label': '备注',
      'address.address': '地址',
      'address.add': '添加',
      'address.delete': '删除',
      'address.inUse': '使用中',
      'address.goManage': '去「接入」添加',
      'address.goTunnel': '去「接入」启用',
      'address.tunnelOff': '先在「接入」里启用 Cloudflare Tunnel，才能把它选作接入地址。',
      'address.invalid': '地址只能填 host、host:port 或 http(s)://host[:port]，不能带路径、查询、锚点、用户名，端口需在 1 到 65535 之间。',
      'address.tooMany': '最多只能保存 {max} 条公网地址。',
      'address.publicHint': '公网地址需要你自己做端口映射或 TLS 反向代理；本插件不检测可达性，链接打不开不代表配对有问题。',
      'address.staleHint': '保存的局域网地址 {address} 现在不在本机网卡列表里，链接暂时改用当前可用的地址。',
      'address.modeTunnel': 'Cloudflare',
      'tunnel.heading': 'Cloudflare Tunnel',
      'tunnel.hint': '启用后，公网流量经过 Cloudflare 转发到本机网关；配对、鉴权、吊销与审计仍由本插件负责。',
      'tunnel.enable': '启用隧道',
      'tunnel.disable': '关闭隧道',
      'tunnel.restart': '重新启动',
      'tunnel.state.stopped': '已关闭',
      'tunnel.state.starting': '正在启动，等待公网地址…',
      'tunnel.state.running': '运行中',
      'tunnel.state.failed': '启动失败',
      'tunnel.url': '公网地址',
      'tunnel.copy': '复制',
      'tunnel.copied': '已复制',
      'tunnel.mode': '隧道类型',
      'tunnel.mode.quick': '快速隧道',
      'tunnel.mode.token': '具名隧道（Token）',
      'tunnel.token': 'Token',
      'tunnel.tokenSet': '已保存',
      'tunnel.tokenUnset': '未填写',
      'tunnel.tokenInvalidState': '文件内容不可用',
      'tunnel.tokenHint': 'Token 只保存在本机数据目录（0600），面板不会回显。',
      'tunnel.publicUrl': '公开主机名',
      'tunnel.publicUrlHint': '填 Cloudflare 控制台里为该隧道配置的公开主机名，例如 https://dsh.example.com。',
      'tunnel.binary': 'cloudflared',
      'tunnel.binary.custom': '自定义路径',
      'tunnel.binary.path': '系统 PATH',
      'tunnel.binary.downloaded': '已下载',
      'tunnel.binary.missing': '未找到',
      'tunnel.download': '下载 cloudflared',
      'tunnel.downloading': '下载中…',
      'tunnel.downloaded': '已下载 {version}',
      'tunnel.binaryPath': '自定义路径',
      'tunnel.binaryPathHint': '留空则按 PATH → 已下载副本的顺序查找；填了但不存在会直接报错，不会回退。',
      'tunnel.binaryCustomMissing': '自定义路径优先；它不存在时不会回退到 PATH 或已下载副本。请修正或清空后再试。',
      'tunnel.save': '保存隧道设置',
      'tunnel.saved': '已保存。',
      'tunnel.quickHint': '快速隧道不需要账号，但域名每次启动都会变，已配对设备需要重新配对。',
      'tunnel.namedHint': '具名隧道需要先在 Cloudflare 控制台创建隧道、配置公开主机名，再把 Token 填到这里。',
      'tunnel.gatewayOff': '先在上方启用远程接入，隧道才有可转发的本地端口。',
      'tunnel.error.binaryMissing': '没有找到 cloudflared：请安装、填写路径，或用下面的按钮下载。',
      'tunnel.error.invalidConfig': '隧道设置无效，请检查模式、路径、公开主机名与 Token。',
      'tunnel.error.tokenMissing': '具名隧道需要 Token。',
      'tunnel.error.tokenInvalid': '保存的 Token 不可用，请重新填写。',
      'tunnel.error.urlMissing': '具名隧道需要填写公开主机名。',
      'tunnel.error.startTimeout': 'cloudflared 启动后没有在 30 秒内给出公网地址。',
      'tunnel.error.spawnFailed': 'cloudflared 无法启动，请检查路径与执行权限。',
      'tunnel.error.exited': 'cloudflared 进程已退出，隧道不再可用；请检查 Token 与网络后重试。',
      'tunnel.error.noPort': '网关没有可用的监听端口。',
      'tunnel.error.downloadFailed': '下载失败：网络、摘要校验或写入磁盘任一步没有完成。',
      'tunnel.error.unsupportedPlatform': 'Cloudflare 没有为当前平台/架构发布 cloudflared。',
      'tunnel.error.storage': '隧道 Token 无法写入数据目录。',
      'tunnel.error.busy': '隧道正在运行，先关闭再替换 cloudflared。',
      'tunnel.error.actionFailed': '隧道操作没有生效，之前的设置已恢复。',
      'tunnel.error.unknown': '隧道遇到未知错误。',
      'pair.heading': '添加设备',
      'pair.add': '生成配对码',
      'pair.hint': '在这台设备上输入下面的配对码，或直接打开链接。配对码一次性、两分钟内有效。',
      'pair.code': '配对码',
      'pair.qrAlt': '配对二维码',
      'pair.qrHint': '用手机相机扫码，或在手机上输入下面的配对码',
      'pair.tooLong': '链接太长，无法生成二维码；请用文本码，或换一条更短的接入地址',
      'pair.link': '配对链接',
      'pair.copy': '复制',
      'pair.copied': '已复制',
      'pair.copyFailed': '复制失败，请手动选择文本。',
      'pair.expires': '剩余 {seconds} 秒',
      'pair.needGateway': '先启用远程接入，否则生成的链接没有可连接的端口。',
      'pair.loopbackHint': '此链接里的 127.0.0.1 需要换成这台机器的局域网 IP，手机才能打开。',
      'pair.publicHint': '这条链接用的是你选定的公网地址；能否打开取决于你自己的端口映射或反向代理，本插件不检测可达性。',
      'pair.tunnelDown': '隧道当前没有运行，先在「接入」里启用 Cloudflare Tunnel。',
      'pair.tunnelHint': '这条链接走 Cloudflare Tunnel；快速隧道的域名每次启动可能变化，已配对设备需要重新配对。',
      'pair.cancel': '取消',
      'pair.refresh': '刷新',
      'pair.refreshing': '刷新中…',
      'pair.newCode': '生成新码',
      'pair.state.used': '已使用',
      'pair.state.expired': '已过期',
      'pair.state.locked': '已作废',
      'pair.state.unknown': '已失效',
      'pair.state.usedHint': '设备已经完成配对，可以在「设备」里看到它。',
      'pair.state.deadHint': '这个配对码已经不能用了，生成新码继续。',
      'devices.heading': '已授权设备',
      'devices.empty': '还没有配对设备',
      'devices.lastSeen': '最后在线 {when}',
      'devices.never': '从未在线',
      'devices.ip': '来源 {ip}',
      'devices.client': '客户端 {ua}',
      'devices.live': '{count} 条连接',
      'devices.revoked': '已吊销',
      'devices.revoke': '吊销',
      'devices.confirm': '确认吊销',
      'devices.cancel': '取消',
      'devices.failed': '吊销失败，设备仍然有效。',
      'audit.heading': '审计',
      'audit.window': '保留 {days} 天',
      'audit.files': '{count} 个文件',
      'audit.lines': '{count} 条记录',
      'audit.range': '{from} 至 {to}',
      'audit.empty': '还没有审计记录',
      'audit.export': '导出审计',
      'audit.exporting': '导出中…',
      'audit.exported': '审计已导出。',
      'audit.exportFailed': '导出失败。',
      'audit.invalidLines': '{count} 行无法解析，已跳过',
      'audit.event.pair': '配对',
      'audit.event.connect': '连接',
      'audit.event.disconnect': '断开',
      'audit.event.send_message': '发送消息',
      'audit.event.stop_task': '停止任务',
      'audit.event.approval_answer': '审批应答',
      'audit.event.revoke': '吊销',
      'audit.event.pair_failed': '配对失败',
      'audit.event.unknown': '未识别动作',
      'tabs.pairing': '配对',
      'tabs.access': '接入',
      'tabs.devices': '设备',
      'tabs.audit': '审计',
      'status.listening': '监听 {port} · {live} 条连接 · {devices} 台设备',
      'status.disabled': '远程接入未启用',
      'audit.detail.heading': '最近事件',
      'audit.detail.filter': '动作',
      'audit.detail.all': '全部',
      'audit.detail.loading': '正在读取审计明细…',
      'audit.detail.shown': '已显示 {count} 条',
      'audit.detail.loadMore': '加载更多',
      'audit.detail.loadingMore': '加载中…',
      'audit.detail.noMore': '没有更多了',
      'error.loopback.title': '管理面板仅本机可用',
      'error.loopback.body': '设备管理只能在这台机器上操作。远程设备即使已完成配对，也只获得会话访问权，不获得管理权——这是有意设计，不是故障。',
      'error.crossOrigin.title': '请求来源被拒绝',
      'error.crossOrigin.body': '这个请求不是从 dsh web 页面发出的，管理接口按跨站请求拒绝。请从本机的 dsh web 页面打开面板。',
      'error.gatewayDown.title': '远程网关未监听',
      'error.gatewayDown.body': '远程接入当前没有可用的监听端口。请检查端口是否被其他程序占用，或换一个端口再试。',
      'error.notMounted.title': '管理接口未挂载',
      'error.notMounted.body': '宿主没有注册管理接口（Web 服务器不支持注册路由，或插件未加载）。设备面板因此没有后端。',
      'error.network.title': '无法连接管理接口',
      'error.network.body': '请求没有到达 dsh 进程。确认 dsh 仍在运行，并检查浏览器是否拦截了请求。',
      'error.timeout.title': '管理接口没有响应',
      'error.timeout.body': '请求超时。dsh 进程可能正忙或已挂起，请稍后重试。',
      'error.server.title': '管理接口出错',
      'error.server.body': '宿主返回了服务端错误。详细原因写在 dsh 的日志里，面板不显示内部细节。',
      'error.unknown.title': '读取失败',
      'error.unknown.body': '管理接口返回了无法解释的响应。',
      'time.justNow': '刚刚',
      'time.minutesAgo': '{count} 分钟前',
      'time.hoursAgo': '{count} 小时前',
    }

    const EN = {
      'panel.title': 'Remote Control',
      'panel.subtitle': 'Pair a device to reach this session from another machine',
      'panel.entry': 'Remote access',
      'panel.close': 'Close',
      'panel.retry': 'Retry',
      'panel.loading': 'Reading device status…',
      'access.heading': 'Access',
      'access.enable': 'Enable remote access',
      'access.enableHint': 'When off, the official dsh web port is not reachable at all and the host behaves as if this plugin were not installed.',
      'access.port': 'Port',
      'access.save': 'Save',
      'access.saved': 'Saved.',
      'access.reloadRequired': 'The setting is on disk, but this process still runs the old listener configuration. Restart dsh for it to take effect.',
      'access.invalidPort': 'The port must be an integer between 1 and 65535.',
      'access.gatewayDisabled': 'Disabled, nothing is listening.',
      'access.gatewayNotListening': 'Enabled, but nothing is listening right now. Check whether the port is in use, or pick another one.',
      'access.gatewayListening': 'Listening on port {port} with {live} live remote connection(s).',
      'point.heading': 'Pairing address',
      'address.heading': 'Public addresses',
      'address.modeLan': 'LAN',
      'address.modePublic': 'Public',
      'address.lanEmpty': 'No local network address is available.',
      'address.publicEmpty': 'No public address configured yet.',
      'address.label': 'Label',
      'address.address': 'Address',
      'address.add': 'Add',
      'address.delete': 'Delete',
      'address.inUse': 'In use',
      'address.goManage': 'Add one in 接入',
      'address.goTunnel': 'Enable it in 接入',
      'address.tunnelOff': 'Enable Cloudflare Tunnel under 接入 before choosing it as the access address.',
      'address.invalid': 'An address is a host, host:port or http(s)://host[:port] — no path, query, fragment or userinfo, with a port between 1 and 65535.',
      'address.tooMany': 'At most {max} public addresses can be saved.',
      'address.publicHint': 'A public address needs your own port forwarding or TLS reverse proxy. This plugin never checks reachability, so a link that will not open is not a pairing fault.',
      'address.staleHint': 'The saved LAN address {address} is not on this machine any more; the link uses an address that is available right now.',
      'address.modeTunnel': 'Cloudflare',
      'tunnel.heading': 'Cloudflare Tunnel',
      'tunnel.hint': 'When enabled, public traffic is relayed through Cloudflare to the local gateway; pairing, access control, revocation and audit stay in this plugin.',
      'tunnel.enable': 'Enable tunnel',
      'tunnel.disable': 'Stop tunnel',
      'tunnel.restart': 'Restart',
      'tunnel.state.stopped': 'Stopped',
      'tunnel.state.starting': 'Starting, waiting for a public URL…',
      'tunnel.state.running': 'Running',
      'tunnel.state.failed': 'Failed to start',
      'tunnel.url': 'Public URL',
      'tunnel.copy': 'Copy',
      'tunnel.copied': 'Copied',
      'tunnel.mode': 'Tunnel type',
      'tunnel.mode.quick': 'Quick tunnel',
      'tunnel.mode.token': 'Named tunnel (token)',
      'tunnel.token': 'Token',
      'tunnel.tokenSet': 'Saved',
      'tunnel.tokenUnset': 'Not set',
      'tunnel.tokenInvalidState': 'Stored file is not usable',
      'tunnel.tokenHint': 'The token is stored only in the local data directory (0600) and is never echoed back.',
      'tunnel.publicUrl': 'Public hostname',
      'tunnel.publicUrlHint': 'Enter the public hostname configured for this tunnel in the Cloudflare dashboard, e.g. https://dsh.example.com.',
      'tunnel.binary': 'cloudflared',
      'tunnel.binary.custom': 'custom path',
      'tunnel.binary.path': 'system PATH',
      'tunnel.binary.downloaded': 'downloaded',
      'tunnel.binary.missing': 'not found',
      'tunnel.download': 'Download cloudflared',
      'tunnel.downloading': 'Downloading…',
      'tunnel.downloaded': 'Downloaded {version}',
      'tunnel.binaryPath': 'Custom path',
      'tunnel.binaryPathHint': 'Leave empty to look on PATH, then at the downloaded copy. A path that does not exist is an error, never a fallback.',
      'tunnel.binaryCustomMissing': 'A custom path wins; when it does not exist there is no fallback to PATH or the downloaded copy. Fix or clear it, then retry.',
      'tunnel.save': 'Save tunnel settings',
      'tunnel.saved': 'Saved.',
      'tunnel.quickHint': 'A quick tunnel needs no account, but its hostname changes on every start — paired devices have to pair again.',
      'tunnel.namedHint': 'A named tunnel needs a tunnel and a public hostname created in the Cloudflare dashboard; paste its token here.',
      'tunnel.gatewayOff': 'Enable remote access above first; the tunnel needs a local port to forward to.',
      'tunnel.error.binaryMissing': 'cloudflared was not found: install it, set a path, or use the download button below.',
      'tunnel.error.invalidConfig': 'Invalid tunnel settings; check the mode, path, public hostname and token.',
      'tunnel.error.tokenMissing': 'A named tunnel needs a token.',
      'tunnel.error.tokenInvalid': 'The stored token is not usable; enter it again.',
      'tunnel.error.urlMissing': 'A named tunnel needs a public hostname.',
      'tunnel.error.startTimeout': 'cloudflared did not report a public URL within 30 seconds.',
      'tunnel.error.spawnFailed': 'cloudflared could not be started; check the path and its execute permission.',
      'tunnel.error.exited': 'The cloudflared process exited, so the tunnel is no longer available. Check the token and network, then retry.',
      'tunnel.error.noPort': 'The gateway has no listening port.',
      'tunnel.error.downloadFailed': 'The download failed: network, digest verification or writing to disk did not complete.',
      'tunnel.error.unsupportedPlatform': 'Cloudflare does not publish cloudflared for this platform/architecture.',
      'tunnel.error.storage': 'The tunnel token could not be written to the data directory.',
      'tunnel.error.busy': 'The tunnel is running; stop it before replacing cloudflared.',
      'tunnel.error.actionFailed': 'The tunnel action did not apply; the previous setting was restored.',
      'tunnel.error.unknown': 'The tunnel hit an unknown error.',
      'pair.heading': 'Add a device',
      'pair.add': 'Generate pairing code',
      'pair.hint': 'Type the code below on the device, or just open the link. The code is single use and expires in two minutes.',
      'pair.code': 'Pairing code',
      'pair.qrAlt': 'Pairing QR code',
      'pair.qrHint': 'Scan with your phone camera, or type the code below',
      'pair.tooLong': 'The link is too long for a QR code; use the text code or a shorter address',
      'pair.link': 'Pairing link',
      'pair.copy': 'Copy',
      'pair.copied': 'Copied',
      'pair.copyFailed': 'Copy failed; select the text manually.',
      'pair.expires': '{seconds}s left',
      'pair.needGateway': 'Enable remote access first, or the generated link has no port to connect to.',
      'pair.loopbackHint': 'Replace 127.0.0.1 in this link with this machine LAN address so a phone can open it.',
      'pair.publicHint': 'This link uses the public address you selected. Whether it opens depends on your own port forwarding or reverse proxy — this plugin does not check reachability.',
      'pair.tunnelDown': 'The tunnel is not running; enable Cloudflare Tunnel under 接入 first.',
      'pair.tunnelHint': 'This link goes through the Cloudflare Tunnel. A quick tunnel hostname changes on every start, so paired devices have to pair again.',
      'pair.cancel': 'Cancel',
      'pair.refresh': 'Refresh',
      'pair.refreshing': 'Refreshing…',
      'pair.newCode': 'New code',
      'pair.state.used': 'Used',
      'pair.state.expired': 'Expired',
      'pair.state.locked': 'Burned',
      'pair.state.unknown': 'No longer valid',
      'pair.state.usedHint': 'The device finished pairing; it is listed under Devices.',
      'pair.state.deadHint': 'This code can no longer be used. Generate a new one to continue.',
      'devices.heading': 'Paired devices',
      'devices.empty': 'No paired devices yet',
      'devices.lastSeen': 'Last seen {when}',
      'devices.never': 'never online',
      'devices.ip': 'From {ip}',
      'devices.client': 'Client {ua}',
      'devices.live': '{count} connection(s)',
      'devices.revoked': 'Revoked',
      'devices.revoke': 'Revoke',
      'devices.confirm': 'Confirm revoke',
      'devices.cancel': 'Cancel',
      'devices.failed': 'Revocation failed; the device is still valid.',
      'audit.heading': 'Audit',
      'audit.window': 'Kept for {days} days',
      'audit.files': '{count} file(s)',
      'audit.lines': '{count} line(s)',
      'audit.range': '{from} to {to}',
      'audit.empty': 'No audit records yet',
      'audit.export': 'Export audit',
      'audit.exporting': 'Exporting…',
      'audit.exported': 'Audit exported.',
      'audit.exportFailed': 'Export failed.',
      'audit.invalidLines': '{count} unparsable line(s) skipped',
      'audit.event.pair': 'Paired',
      'audit.event.connect': 'Connected',
      'audit.event.disconnect': 'Disconnected',
      'audit.event.send_message': 'Message sent',
      'audit.event.stop_task': 'Task stopped',
      'audit.event.approval_answer': 'Approval answered',
      'audit.event.revoke': 'Revoked',
      'audit.event.pair_failed': 'Pairing failed',
      'audit.event.unknown': 'Unrecognized action',
      'tabs.pairing': 'Pairing',
      'tabs.access': 'Access',
      'tabs.devices': 'Devices',
      'tabs.audit': 'Audit',
      'status.listening': 'Listening on {port} · {live} connection(s) · {devices} device(s)',
      'status.disabled': 'Remote access is off',
      'audit.detail.heading': 'Recent events',
      'audit.detail.filter': 'Action',
      'audit.detail.all': 'All actions',
      'audit.detail.loading': 'Reading audit details…',
      'audit.detail.shown': '{count} shown',
      'audit.detail.loadMore': 'Load more',
      'audit.detail.loadingMore': 'Loading…',
      'audit.detail.noMore': 'No more records',
      'error.loopback.title': 'The management panel is local-only',
      'error.loopback.body': 'Devices can only be managed on this machine. A paired remote device gets session access, never administration — that is the design, not a fault.',
      'error.crossOrigin.title': 'Request origin refused',
      'error.crossOrigin.body': 'This request did not come from the dsh web page, and the management API refuses cross-site requests. Open the panel from the dsh web page on this machine.',
      'error.gatewayDown.title': 'The remote gateway is not listening',
      'error.gatewayDown.body': 'Remote access has no listening port right now. Check whether another program holds the port, or pick another one.',
      'error.notMounted.title': 'The management API is not mounted',
      'error.notMounted.body': 'The host did not register the management API (its web server cannot register routes, or this plugin is not loaded). The panel has no backend.',
      'error.network.title': 'The management API is unreachable',
      'error.network.body': 'The request never reached the dsh process. Check that dsh is still running, and that the browser did not block the request.',
      'error.timeout.title': 'The management API did not respond',
      'error.timeout.body': 'The request timed out. The dsh process may be busy or stuck; try again shortly.',
      'error.server.title': 'The management API failed',
      'error.server.body': 'The host returned a server error. The detail is in the dsh log; the panel never renders internals.',
      'error.unknown.title': 'Read failed',
      'error.unknown.body': 'The management API returned a response this panel cannot interpret.',
      'time.justNow': 'just now',
      'time.minutesAgo': '{count} min ago',
      'time.hoursAgo': '{count} h ago',
    }

    /* ------------------------------------------------------------------ *
     * Pure helpers
     *
     * Every one of these is a plain function of its arguments: no `window`, no
     * `document`, no `fetch`. That is what lets `tests/client.test.mjs` run them
     * under the module loader contract with nothing but a fake registration
     * target.
     * ------------------------------------------------------------------ */

    /**
     * The access settings a panel works from, whatever the host sent.
     *
     * `GET /state` always returns a complete `settings.access`, but this file must
     * survive an older host, a mid-write read, or a hand-edited file, so the shape
     * is rebuilt field by field instead of trusted. Anything unrecognizable
     * degrades to the `lan` default — never to `public`, which is the mode whose
     * reachability the plugin cannot check.
     *
     * @param {object | null} settings
     * @returns {{ mode: 'lan' | 'public' | 'tunnel', lanAddress: string, public: object[], selectedPublicId: string | null }}
     */
    function accessOf(settings) {
      const fallback = defaultAccess()
      if (settings === null || typeof settings !== 'object') return fallback
      const access = settings.access
      if (access === null || typeof access !== 'object') return fallback
      const book = Array.isArray(access.public)
        ? access.public
          .filter((entry) => entry !== null && typeof entry === 'object'
            && typeof entry.id === 'string' && entry.id !== ''
            && typeof entry.address === 'string' && entry.address !== '')
          .map((entry) => ({
            id: entry.id,
            label: typeof entry.label === 'string' ? entry.label : '',
            address: entry.address,
          }))
        : []
      /* `tunnel` is the runtime-address mode added with the managed Cloudflare
         Tunnel. An unrecognized value still degrades to `lan` — never to a mode
         whose reachability this plugin cannot reason about. */
      const mode = access.mode === 'public' || access.mode === 'tunnel' ? access.mode : 'lan'
      return {
        mode,
        lanAddress: typeof access.lanAddress === 'string' ? access.lanAddress : '',
        public: book,
        selectedPublicId: typeof access.selectedPublicId === 'string' ? access.selectedPublicId : null,
      }
    }

    /** The access settings a panel falls back to when the host sent none. */
    function defaultAccess() {
      return { mode: 'lan', lanAddress: '', public: [], selectedPublicId: null }
    }

    /**
     * Parse one access address, or refuse it — the BROWSER copy of
     * `src/host/addresses.js#parseAddress`.
     *
     * Duplicated on purpose and unavoidably: this half is a single
     * `__ModuleLoader__` factory with no `import` (the loader contract), so it
     * cannot reach into `src/host/`, which is Node ESM. The rules are kept
     * identical — and `tests/client.test.mjs` runs both implementations over the
     * same accept/reject matrix, so a rule that changes in one place fails the
     * suite instead of shipping a panel that disagrees with the host.
     *
     * Both halves are latency, not security: the host re-validates everything
     * (`POST /settings` → `400 admin/invalid-access`), so a missing rule here
     * would be a worse error message, not a hole.
     *
     * @param {unknown} text
     * @returns {{ scheme: 'http' | 'https' | null, host: string, port: number | null } | null}
     */
    function parseAddress(text) {
      if (typeof text !== 'string') return null
      const trimmed = text.trim()
      if (trimmed === '' || trimmed.length > ADDRESS_TEXT_MAX) return null
      if (/\s/.test(trimmed)) return null

      let scheme = null
      let rest = trimmed
      const schemeMatch = rest.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\//)
      if (schemeMatch !== null) {
        const name = schemeMatch[1].toLowerCase()
        if (name !== 'http' && name !== 'https') return null
        scheme = name
        rest = rest.slice(schemeMatch[0].length)
      }
      if (rest === '' || /[@/?#\\]/.test(rest)) return null

      const hostPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/
      let host
      let portText = null
      if (rest.startsWith('[')) {
        const close = rest.indexOf(']')
        if (close < 0) return null
        if (!/^[0-9A-Fa-f:.]+$/.test(rest.slice(1, close))) return null
        host = rest.slice(0, close + 1)
        const tail = rest.slice(close + 1)
        if (tail !== '') {
          if (!tail.startsWith(':')) return null
          portText = tail.slice(1)
        }
      } else {
        const colon = rest.indexOf(':')
        if (colon < 0) {
          host = rest
        } else {
          /* An unbracketed second colon makes the port ambiguous; guessing is how a
             link ends up on a port the user never chose. */
          if (rest.indexOf(':', colon + 1) >= 0) return null
          host = rest.slice(0, colon)
          portText = rest.slice(colon + 1)
        }
        if (!hostPattern.test(host)) return null
      }

      let port = null
      if (portText !== null) {
        if (!/^[0-9]{1,5}$/.test(portText)) return null
        const value = Number.parseInt(portText, 10)
        if (!Number.isInteger(value) || value < 1 || value > 65535) return null
        port = value
      }
      return { scheme, host, port }
    }

    /**
     * Normalize a parsed address back to stored text — the browser copy of
     * `src/host/addresses.js#formatAddress`.
     *
     * @param {{ scheme?: string | null, host?: string, port?: number | null } | null} parsed
     * @returns {string} `''` for an unusable input.
     */
    function formatAddress(parsed) {
      if (parsed === null || typeof parsed !== 'object') return ''
      const host = typeof parsed.host === 'string' ? parsed.host.trim() : ''
      if (host === '') return ''
      const scheme = parsed.scheme === 'http' || parsed.scheme === 'https' ? parsed.scheme : null
      const port = Number.isInteger(parsed.port) && parsed.port > 0 && parsed.port <= 65535
        ? parsed.port
        : null
      return (scheme === null ? '' : scheme + '://') + host + (port === null ? '' : ':' + port)
    }

    /**
     * The address a link should use right now — the browser copy of
     * `src/host/addresses.js#effectiveAddress` (`design.md` §1.2).
     *
     * The stored value is the user's CHOICE; this resolves it against the NIC list
     * the host just reported, falling back to the first usable entry. The fallback
     * is never written back: a cable unplugged for a minute must not silently
     * replace a selection the user made, which is why `GET /state` returns the
     * stored value and the list side by side and the resolution happens here.
     *
     * @param {object | null} access
     * @param {object[]} [lan]
     * @param {string | null} [tunnelUrl] Live managed-tunnel URL, or null/empty.
     * @returns {string | null}
     */
    function effectiveAddress(access, lan, tunnelUrl) {
      const settings = access !== null && typeof access === 'object' ? access : {}
      const list = Array.isArray(lan)
        ? lan.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.address === 'string')
        : []

      if (settings.mode === 'tunnel') {
        const text = typeof tunnelUrl === 'string' ? tunnelUrl.trim() : ''
        return text === '' ? null : text
      }

      if (settings.mode === 'public') {
        const book = Array.isArray(settings.public)
          ? settings.public.filter((entry) => entry !== null && typeof entry === 'object')
          : []
        if (book.length === 0) return null
        const wanted = typeof settings.selectedPublicId === 'string' ? settings.selectedPublicId : ''
        const chosen = book.find((entry) => entry.id === wanted) ?? book[0]
        const text = typeof chosen.address === 'string' ? chosen.address.trim() : ''
        return text === '' ? null : text
      }

      if (list.length === 0) return null
      const stored = typeof settings.lanAddress === 'string' ? settings.lanAddress : ''
      const match = stored === '' ? undefined : list.find((entry) => entry.address === stored)
      const chosen = match ?? list[0]
      const text = typeof chosen.address === 'string' ? chosen.address.trim() : ''
      return text === '' ? null : text
    }

    /**
     * Mint an id for one public-address row.
     *
     * Not a security value in any sense — nothing authenticates against it and it
     * never leaves `devices.json`. It only has to be unique within the book so the
     * radio buttons select distinct rows, which is why `Math.random` is adequate
     * and no crypto API is needed (the browser half has none in its baseline).
     *
     * The loop is BOUNDED: an unconstrained retry against a stubbed `Math.random`
     * would spin forever, and a clock-derived fallback still satisfies uniqueness
     * for a list capped at {@link PUBLIC_ADDRESS_MAX}.
     *
     * @param {object[]} existingRows
     * @returns {string}
     */
    function newPublicId(existingRows) {
      const taken = new Set(
        (Array.isArray(existingRows) ? existingRows : [])
          .map((row) => (row !== null && typeof row === 'object' ? row.id : undefined))
          .filter((id) => typeof id === 'string'),
      )
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = 'pub_' + Math.random().toString(36).slice(2, 8)
        if (!taken.has(candidate)) return candidate
      }
      return 'pub_' + Date.now().toString(36)
    }

    /**
     * Resolve one admin API request target against a page base.
     *
     * @param {string} [suffix] Path below the API base, with or without a leading slash.
     * @param {string} baseHref Mount base, normally `document.baseURI`.
     * @returns {string} Absolute URL string.
     */
    function adminUrl(suffix, baseHref) {
      const tail = typeof suffix === 'string' ? suffix.replace(/^\/+/, '') : ''
      const path = tail === '' ? API_BASE : API_BASE + '/' + tail
      return new URL(path, baseHref).toString()
    }

    /**
     * Classify a failed response into one of {@link FAILURE_KINDS}.
     *
     * Deliberately keyed on the status AND on whether the body parsed: the
     * official server's SPA fallback answers an unmounted route with `200` and
     * HTML, so "no backend" is a 200-that-will-not-parse, not a 404. Treating
     * that as a server error would send a user looking in the wrong place.
     *
     * @param {number} status HTTP status.
     * @param {unknown} payload Parsed body, if any.
     * @param {boolean} parsed Whether the body was valid JSON.
     * @returns {string} One member of {@link FAILURE_KINDS}.
     */
    function classifyFailure(status, payload, parsed) {
      const code = parsed && payload !== null && typeof payload === 'object'
        && payload.error !== null && typeof payload.error === 'object'
        && typeof payload.error.code === 'string'
        ? payload.error.code
        : null
      if (status === 403) return code === 'admin/cross-origin' ? 'crossOrigin' : 'loopback'
      if (status === 409) return 'gatewayDown'
      if (status === 404) return 'notMounted'
      if (typeof status === 'number' && status >= 500) return 'server'
      /* A transport failure has no status at all. */
      if (typeof status !== 'number' || status === 0) return 'network'
      if (parsed !== true) return 'notMounted'
      return 'server'
    }

    /**
     * The stable `code` carried by an error envelope, or null.
     *
     * @param {unknown} payload
     * @returns {string | null}
     */
    function errorCodeOf(payload) {
      if (payload === null || typeof payload !== 'object') return null
      const error = payload.error
      if (error === null || typeof error !== 'object') return null
      return typeof error.code === 'string' ? error.code : null
    }

    /**
     * Build an Error carrying a failure kind, the way the host modules carry a
     * `code` (`.trellis/spec/backend/error-handling.md`): classification travels
     * WITH the error instead of being re-derived at every catch site.
     *
     * @param {string} kind
     * @param {number | null} status
     * @param {string | null} code
     * @param {string} message Diagnostic only; never rendered.
     * @returns {Error}
     */
    function apiError(kind, status, code, message) {
      const error = new Error(message)
      error.kind = kind
      error.status = status
      error.code = code
      return error
    }

    /**
     * Normalize anything thrown into the `{ kind, status, code }` the panel renders.
     *
     * @param {unknown} error
     * @returns {{ kind: string, status: number | null, code: string | null }}
     */
    function describeFailure(error) {
      if (error !== null && typeof error === 'object'
        && typeof error.kind === 'string' && FAILURE_KINDS.includes(error.kind)) {
        return {
          kind: error.kind,
          status: Number.isInteger(error.status) ? error.status : null,
          code: typeof error.code === 'string' ? error.code : null,
        }
      }
      return { kind: 'unknown', status: null, code: null }
    }

    /**
     * Whether a hostname points at this machine.
     *
     * Used only for an honest hint: a pairing link built while the desktop
     * browser sits on `127.0.0.1` cannot be opened from a phone, and silently
     * presenting it as-is is the kind of half-truth the panel must not tell.
     *
     * @param {string} host
     * @returns {boolean}
     */
    function isLoopbackName(host) {
      return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
    }

    /**
     * The hostname of a URL string, or `''` when it cannot be parsed.
     *
     * The pairing hints below are chosen by looking at the HOST of a link that was
     * just built from user-supplied address text. Deriving it must never throw:
     * `new URL()` on a malformed string is an exception in a render path, which
     * would blank the panel.
     *
     * @param {string | null} url
     * @returns {string}
     */
    function urlHostname(url) {
      if (typeof url !== 'string' || url === '') return ''
      try {
        return new URL(url).hostname
      } catch {
        return ''
      }
    }

    /**
     * Build the one-time pairing link from the server's pairing payload and the
     * address the user selected.
     *
     * The `<pairId>:<code>` pair lives in the FRAGMENT (`design.md` §3.1 step 3):
     * a fragment is never sent to a server, so the code cannot land in an access
     * log.
     *
     * The authority comes from `addressText` — the EFFECTIVE address resolved by
     * {@link effectiveAddress} — and not from the page. That is the fix for the
     * defect this stage exists for: the desktop browser is on `127.0.0.1`, so a
     * link built from the page was unusable on every phone (`prd.md` 背景 2).
     *
     * Port precedence (`prd.md` R4 / acceptance 5): a port the user wrote INTO the
     * address wins, because `home.example.com:8443` is a statement about where the
     * gateway is reachable; otherwise the gateway's own port; otherwise none.
     * A missing `scheme` means `http`, which is what the gateway itself speaks —
     * an `https://` address is the user's reverse proxy terminating TLS in front
     * of it (`design.md` §6).
     *
     * With no usable address at all (no NIC entry and no public row) the link
     * falls back to the old page-host behaviour, and the panel says so
     * (`pair.loopbackHint`) instead of pretending the link will open.
     *
     * Switching addresses never regenerates the code: this is a pure function of
     * the `pairing` snapshot plus the current address, and the snapshot is the only
     * state the pairing flow holds.
     *
     * @param {{ fragment?: string, pairPath?: string, port?: number | null } | null} pairing
     * @param {string | null} addressText Effective address, or null for none.
     * @param {string} fallbackHref Page base, used only by the legacy fallback.
     * @param {'lan' | 'public' | 'tunnel'} [mode] Which kind of address `addressText`
     *   is: a public or tunnel one is used as written, a LAN one gets the gateway port
     *   when it names none.
     * @returns {string | null} null when the inputs cannot form a URL.
     */
    function pairingUrl(pairing, addressText, fallbackHref, mode) {
      if (pairing === null || typeof pairing !== 'object') return null
      const fragment = typeof pairing.fragment === 'string' ? pairing.fragment : ''
      const pairPath = typeof pairing.pairPath === 'string' && pairing.pairPath !== ''
        ? pairing.pairPath
        : DEFAULT_PAIR_PATH

      const address = typeof addressText === 'string' ? parseAddress(addressText) : null
      if (address !== null) {
        const scheme = address.scheme === null ? 'http' : address.scheme
        const gatewayPort = Number.isInteger(pairing.port) && pairing.port > 0 ? pairing.port : null
        /* The MODE decides whether the gateway port is implied, because the kinds of
           address are different animals:
             - LAN  `192.168.9.77` means "this host, on the gateway port" — the port is
               part of what the user is pointing at, so it is filled in;
             - public `https://dsh.example.de` means "whatever my proxy serves" — the
               port is 443 (or a port the user typed) and is not ours to guess. Appending
               3090 produced `https://host:3090/...`, a URL the proxy does not serve
               (2026-10-19, reported from a live panel);
             - tunnel `https://xxx.trycloudflare.com` is the same shape as public: the
               Cloudflare edge owns the port, and the URL is used exactly as printed.
           An explicit port always wins, in every mode. */
        const appendPort = mode !== 'public' && mode !== 'tunnel'
        const port = address.port !== null ? address.port : (appendPort ? gatewayPort : null)
        return scheme + '://' + address.host + (port === null ? '' : ':' + port) + pairPath + '#' + fragment
      }

      return legacyPairingUrl(pairing, fallbackHref)
    }

    /**
     * The pre-address behaviour: take the authority from the page itself.
     *
     * Kept, not deleted, because it is still the honest answer when the host
     * reports no usable address — and because the panel's `pair.loopbackHint` is
     * written for exactly this shape.
     *
     * @param {{ fragment?: string, pairPath?: string, port?: number | null }} pairing
     * @param {string} pageHref
     * @returns {string | null}
     */
    function legacyPairingUrl(pairing, pageHref) {
      const fragment = typeof pairing.fragment === 'string' ? pairing.fragment : ''
      const pairPath = typeof pairing.pairPath === 'string' && pairing.pairPath !== ''
        ? pairing.pairPath
        : DEFAULT_PAIR_PATH
      let base
      try {
        base = new URL(pageHref)
      } catch {
        return null
      }
      const port = Number.isInteger(pairing.port) && pairing.port > 0 ? String(pairing.port) : base.port
      const authority = base.protocol + '//' + base.hostname + (port === '' ? '' : ':' + port)
      return authority + pairPath + '#' + fragment
    }

    /**
     * Split a pairing code into readable groups.
     *
     * A code is read off a screen and typed with one thumb; grouping by four
     * does not change its value, only the chance of a transcription slip.
     *
     * @param {string} code
     * @returns {string[]}
     */
    function pairingCodeGroups(code) {
      if (typeof code !== 'string' || code === '') return []
      const groups = []
      for (let index = 0; index < code.length; index += 4) groups.push(code.slice(index, index + 4))
      return groups
    }

    /**
     * The state label for the pairing card, or `null` while the code is still live.
     *
     * `pending` maps to `null` and not to a string: a code that is simply waiting
     * already says so with its countdown, and a 「等待配对」 badge would be a second
     * claim about the same fact.
     *
     * @param {unknown} state One of {@link PAIR_STATES}.
     * @param {(key: string) => string} t
     * @returns {string | null}
     */
    function pairingStateLabel(state, t) {
      switch (state) {
        case 'used': return t('pair.state.used')
        case 'expired': return t('pair.state.expired')
        case 'locked': return t('pair.state.locked')
        case 'unknown': return t('pair.state.unknown')
        default: return null
      }
    }

    /**
     * Parse the port field.
     *
     * @param {string} text
     * @returns {number | null} null when the value is not a usable port.
     */
    function parsePort(text) {
      if (typeof text !== 'string') return null
      const trimmed = text.trim()
      if (!/^[0-9]{1,5}$/.test(trimmed)) return null
      const value = Number.parseInt(trimmed, 10)
      return value > 0 && value <= 65535 ? value : null
    }

    /**
     * Fill `{name}` placeholders.
     *
     * The framework `t` seat does this itself; this copy exists for the fallback
     * translator used when the host provides no locale service at all.
     *
     * @param {string} template
     * @param {Record<string, string | number>} [params]
     * @returns {string}
     */
    function interpolate(template, params) {
      if (typeof template !== 'string') return ''
      if (params === undefined || params === null) return template
      return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, name) => (
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole
      ))
    }

    /**
     * The translator used when the host offers no locale service.
     *
     * English is the fallback for the same reason `dsh-client-locale` uses it
     * (`FALLBACK_LOCALE`): a browser naming no supported language is the reader
     * least likely to read Chinese.
     *
     * @param {string} key
     * @param {Record<string, string | number>} [params]
     * @returns {string}
     */
    function fallbackTranslate(key, params) {
      const template = Object.prototype.hasOwnProperty.call(EN, key)
        ? EN[key]
        : (Object.prototype.hasOwnProperty.call(ZH, key) ? ZH[key] : key)
      return interpolate(template, params)
    }

    /**
     * Describe an instant relative to now, for the "last seen" column.
     *
     * @param {string | null} iso
     * @param {number} nowMs
     * @param {(key: string, params?: object) => string} t
     * @returns {string | null} null when there is no usable instant.
     */
    function formatRelative(iso, nowMs, t) {
      if (typeof iso !== 'string' || iso === '') return null
      const at = Date.parse(iso)
      if (!Number.isFinite(at)) return null
      const delta = Math.max(0, nowMs - at)
      const minute = 60_000
      const hour = 3_600_000
      const day = 86_400_000
      if (delta < minute) return t('time.justNow')
      if (delta < hour) return t('time.minutesAgo', { count: Math.floor(delta / minute) })
      if (delta < day) return t('time.hoursAgo', { count: Math.floor(delta / hour) })
      /* Older than a day: an absolute instant is more useful than "3 days ago",
         and `toLocaleString` follows the reader's locale rather than ours. */
      return new Date(at).toLocaleString()
    }

    /**
     * The address a device was last seen from.
     *
     * `src/host/api.js#publicDevice` does not project one today (the store keeps
     * no address column, `design.md` §5). Rather than invent a value, this reads
     * whichever forward-compatible field a future projection adds and otherwise
     * reports the user agent — a real fact that distinguishes two devices.
     *
     * @param {object} device
     * @returns {{ labelKey: string, value: string } | null}
     */
    function deviceSource(device) {
      if (device === null || typeof device !== 'object') return null
      for (const field of ['ip', 'sourceIp', 'lastIp', 'address']) {
        const value = device[field]
        if (typeof value === 'string' && value !== '') return { labelKey: 'devices.ip', value }
      }
      if (typeof device.ua === 'string' && device.ua !== '') return { labelKey: 'devices.client', value: device.ua }
      return null
    }

    /* ------------------------------------------------------------------ *
     * Tabs and audit detail — the pure half
     *
     * Everything below is a plain function of its arguments, which is the only
     * reason any of it can be verified: the browser half has no DOM environment, so
     * the default-tab rule, the roving-focus arithmetic, the paging request shape
     * and the four rendered fields are tested by calling them.
     * ------------------------------------------------------------------ */

    /**
     * The tab the panel opens on (`prd.md` R2, `design.md` §1.1).
     *
     * `pairing` only when remote access is enabled AND the gateway is actually
     * listening, because that is the only state in which a pairing code can be
     * minted and used; otherwise `access`, which is the screen whose switch has to
     * be turned on first. "Enabled" is the SETTING and "listening" is the
     * LISTENER's truth — a panel that opened on an unusable pairing screen would
     * invert the whole point of the change.
     *
     * There is no persistence: the panel unmounts when it closes, so a re-open
     * re-evaluates this against the state of that moment (PRD constraint 4).
     *
     * @param {object | null} settings
     * @param {object | null} gateway
     * @returns {'pairing' | 'access'}
     */
    function preferredTab(settings, gateway) {
      const enabled = settings !== null && typeof settings === 'object' && settings.enabled === true
      const listening = gateway !== null && typeof gateway === 'object' && gateway.listening === true
      return enabled && listening ? 'pairing' : 'access'
    }

    /**
     * The index one navigation key moves focus to, or `null` for any other key.
     *
     * The WAI-ARIA tabs contract, in one function: `ArrowRight`/`ArrowLeft` wrap,
     * `Home`/`End` jump to the ends. Extracted from the component so the wrap
     * arithmetic is testable — an off-by-one there is invisible until a keyboard
     * user hits the last tab and focus disappears.
     *
     * @param {string} key
     * @param {number} index Current index.
     * @param {number} count Number of tabs.
     * @returns {number | null}
     */
    function tabIndexAfterKey(key, index, count) {
      if (!Number.isInteger(count) || count <= 0) return null
      const current = Number.isInteger(index) && index >= 0 && index < count ? index : 0
      if (key === 'ArrowRight') return (current + 1) % count
      if (key === 'ArrowLeft') return (current - 1 + count) % count
      if (key === 'Home') return 0
      if (key === 'End') return count - 1
      return null
    }

    /**
     * The audit actions the panel may offer in its filter.
     *
     * Taken from `GET /state` → `audit.actions`, which is the host's closed set
     * (`design.md` §3). This half must NEVER carry its own list: a second literal
     * drifts, and the drift shows up as a dropdown entry the server answers with
     * `400`, or a missing entry whose events can never be filtered to.
     *
     * An older host that does not report `actions` yields an empty list, so the
     * filter shows only 「全部」 rather than inventing names.
     *
     * @param {object | null} state The `GET /state` payload.
     * @returns {string[]}
     */
    function auditActionsOf(state) {
      if (state === null || typeof state !== 'object') return []
      const audit = state.audit
      if (audit === null || typeof audit !== 'object' || !Array.isArray(audit.actions)) return []
      return audit.actions.filter((name) => typeof name === 'string' && name !== '')
    }

    /**
     * Keep only the four fields an audit row may ever render.
     *
     * The HOST already projects (`src/host/audit.js#projectAuditRecord`), and this
     * is the second half of the same rule rather than a duplicate of it: the panel
     * must be unable to render a field it did not enumerate, whatever a future host
     * (or a hand-edited file that the host's projection was later loosened for)
     * sends. A `meta` — the one field `prd.md` D5 forbids outright — has nowhere to
     * land here, because the object is rebuilt instead of filtered.
     *
     * @param {unknown} record
     * @returns {{ ts: string, event: string, deviceId?: string, ip?: string } | null}
     */
    function normalizeAuditEvent(record) {
      if (record === null || typeof record !== 'object' || Array.isArray(record)) return null
      if (typeof record.ts !== 'string' || record.ts === '') return null
      if (typeof record.event !== 'string' || record.event === '') return null
      const clean = { ts: record.ts, event: record.event }
      if (typeof record.deviceId === 'string' && record.deviceId !== '') clean.deviceId = record.deviceId
      if (typeof record.ip === 'string' && record.ip !== '') clean.ip = record.ip
      return clean
    }

    /**
     * Fold one fetched page into the list on screen.
     *
     * A first page (`before` absent) REPLACES, which is what makes the filter switch
     * a reset: re-filtering must not leave the previous action's records above the
     * first matching one. A later page APPENDS — 「加载更多」 adds to what the user is
     * reading. Duplicates are not removed here on purpose: the host's cursor is what
     * guarantees one record per page (`ts` + line number), and a client-side dedupe
     * key would have to invent one field — two genuine events can share a
     * millisecond, an action, a device and an address.
     *
     * @param {Array<object>} current
     * @param {Array<object>} page
     * @param {string | null | undefined} before
     * @returns {Array<object>}
     */
    function appendAuditPage(current, page, before) {
      const kept = Array.isArray(current) ? current : []
      const incoming = (Array.isArray(page) ? page : [])
        .map((record) => normalizeAuditEvent(record))
        .filter((record) => record !== null)
      return typeof before === 'string' && before !== '' ? kept.concat(incoming) : incoming
    }

    /**
     * The admin path for one page of audit detail.
     *
     * `limit` is deliberately NOT sent: the host's `AUDIT_EVENTS_PAGE_SIZE` is the
     * page size, so the first screen shows however many records the server defines
     * as a page. A literal `50` here would be a second definition of the same
     * number, and the two would drift silently.
     *
     * @param {string} [action] Member of the host's closed set, or '' for every action.
     * @param {string} [before] Cursor of the last record already shown.
     * @returns {string} Path below the admin API base.
     */
    function auditEventsQuery(action, before) {
      const parts = []
      if (typeof action === 'string' && action !== '') parts.push('action=' + encodeURIComponent(action))
      if (typeof before === 'string' && before !== '') parts.push('before=' + encodeURIComponent(before))
      return parts.length === 0 ? AUDIT_EVENTS_PATH : AUDIT_EVENTS_PATH + '?' + parts.join('&')
    }

    /**
     * Format one audit instant for the detail list (`prd.md` R5).
     *
     * Same local day as `nowMs` → `HH:MM:SS`; any other day → `MM-DD HH:MM:SS`, so
     * a list spanning midnight does not silently read as "all today". The full
     * instant goes in the row's `title`, so the exact UTC value is still one hover
     * away without cluttering the column.
     *
     * Local time is deliberate: the reader is looking at their own clock, and the
     * trail's `ts` is the only field here that is stored in UTC.
     *
     * @param {string} iso
     * @param {number} nowMs
     * @returns {{ label: string, iso: string }} Both empty when the instant is unusable.
     */
    function formatAuditTime(iso, nowMs) {
      const at = typeof iso === 'string' ? Date.parse(iso) : Number.NaN
      if (!Number.isFinite(at)) return { label: '', iso: '' }
      const pad = (value) => String(value).padStart(2, '0')
      const instant = new Date(at)
      const clock = pad(instant.getHours()) + ':' + pad(instant.getMinutes()) + ':' + pad(instant.getSeconds())
      const now = new Date(Number.isFinite(nowMs) ? nowMs : Date.now())
      const sameDay = instant.getFullYear() === now.getFullYear()
        && instant.getMonth() === now.getMonth()
        && instant.getDate() === now.getDate()
      const label = sameDay ? clock : pad(instant.getMonth() + 1) + '-' + pad(instant.getDate()) + ' ' + clock
      return { label, iso: instant.toISOString() }
    }

    /**
     * The name to show for an audit row's device.
     *
     * Resolved from the device list the panel already has, so 「刚才那台手机」 is
     * recognizable without cross-referencing ids. A record whose device was revoked
     * and pruned keeps its id prefix instead of becoming blank — the id is the only
     * thing left that identifies it, and a vanished id would read as "no device".
     *
     * @param {string} [deviceId]
     * @param {object[]} [devices]
     * @returns {string} The name, an 8-character id prefix, or an em dash.
     */
    function deviceNameOf(deviceId, devices) {
      if (typeof deviceId !== 'string' || deviceId === '') return '—'
      const list = Array.isArray(devices) ? devices : []
      const found = list.find((device) => device !== null && typeof device === 'object' && device.id === deviceId)
      const name = found !== undefined && typeof found.name === 'string' ? found.name.trim() : ''
      return name === '' ? deviceId.slice(0, 8) : name
    }

    /* ------------------------------------------------------------------ *
     * QR encoder — byte mode, error-correction level M, versions 1 to 15
     *
     * WHY IT LIVES IN THE BROWSER HALF
     *
     * The symbol encodes the one-time pairing LINK, whose fragment carries the
     * pairing code. `design.md` §3.1 keeps that code out of every request by
     * putting it in the fragment, so asking the host to render the image would
     * mean POSTing the code to a server — loopback or not. Encoding here costs
     * nothing and keeps that rule intact (`research/qr-reference-vectors.md` §5).
     *
     * WHY IT IS VERIFIABLE AT ALL
     *
     * An encoder checked only against itself produces the worst possible failure:
     * a symbol that looks like a QR code and does not scan, which the user cannot
     * tell apart from a network fault. So this one is pinned bit-for-bit against a
     * mature reference encoder (node-qrcode, byte mode, ECC M, same version and
     * mask) by `tests/fixtures/qr-reference.json`, and separately read back by an
     * independent decoder as a one-off (see the task report). The reference tool
     * is a development-time dependency in `%TEMP%`, never in `package.json`.
     *
     * WHAT IT DELIBERATELY DOES NOT DO
     *
     * No multi-mode segmentation. The reference splits a link into
     * numeric/alphanumeric/byte runs and thereby fits one version smaller than a
     * pure byte stream (measured: v4 vs v5 for the 66-byte link). Segmenting would
     * make "compare against the reference" meaningless, so capacity is computed
     * for byte mode and the symbol may be one or two versions larger than optimal
     * (`prd.md` D2, `research/qr-reference-vectors.md` §3.1).
     * ------------------------------------------------------------------ */

    /** Highest version implemented; v15-M holds 412 byte-mode bytes, enough for the worst link. */
    const QR_MAX_VERSION = 15

    /** Total codewords (data + error correction) per version, v1..v15 (ISO/IEC 18004 Table 1). */
    const QR_TOTAL_CODEWORDS = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655]

    /** Total error-correction codewords per version at level M (Table 9). */
    const QR_EC_CODEWORDS_M = [10, 16, 26, 36, 48, 64, 72, 88, 110, 130, 150, 176, 198, 216, 240]

    /** Error-correction block count per version at level M (Table 9). */
    const QR_BLOCKS_M = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10]

    /**
     * Alignment-pattern centre coordinates per version (Table E.1); empty for v1.
     *
     * Written out rather than derived from the spacing formula. A wrong table entry
     * cannot hide: the fixture comparison is bit-for-bit, so one bad coordinate
     * turns the test red on the exact module it moved.
     */
    const QR_ALIGNMENT = [
      [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
      [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54],
      [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70],
    ]

    /** Penalty weights N1..N4 (`design.md` §1.4). */
    const QR_PENALTY_N1 = 3
    const QR_PENALTY_N2 = 3
    const QR_PENALTY_N3 = 40
    const QR_PENALTY_N4 = 10

    /**
     * GF(256) log / antilog tables for the QR field (primitive polynomial 0x11D).
     *
     * `QR_GF_EXP` is doubled so the product of two logs can index it without a
     * `% 255`. Both are filled once, when the factory materializes.
     */
    const QR_GF_EXP = new Uint8Array(512)
    const QR_GF_LOG = new Uint8Array(256)

    function initQrGaloisField() {
      let value = 1
      for (let index = 0; index < 255; index++) {
        QR_GF_EXP[index] = value
        QR_GF_LOG[value] = index
        value <<= 1
        if ((value & 0x100) !== 0) value ^= 0x11D
      }
      for (let index = 255; index < 512; index++) QR_GF_EXP[index] = QR_GF_EXP[index - 255]
    }
    initQrGaloisField()

    /** The number of significant bits in a non-negative integer (0 for 0). */
    function qrBitLength(value) {
      let bits = 0
      let rest = value
      while (rest !== 0) {
        bits++
        rest >>>= 1
      }
      return bits
    }

    /** Multiply two field elements. */
    function qrGfMul(left, right) {
      if (left === 0 || right === 0) return 0
      return QR_GF_EXP[QR_GF_LOG[left] + QR_GF_LOG[right]]
    }

    /**
     * The Reed-Solomon generator polynomial of a degree:
     * `(x - a^0)(x - a^1) ... (x - a^(degree-1))`, coefficients highest power first.
     *
     * Built per call rather than memoized in a module-level map: `state-management.md`
     * forbids module-scoped state in this half, and one build is ~450 field
     * multiplications — cheaper than the argument about whether a cache counts.
     *
     * @param {number} degree Number of error-correction codewords per block.
     * @returns {number[]}
     */
    function qrGeneratorPolynomial(degree) {
      let polynomial = [1]
      for (let root = 0; root < degree; root++) {
        const next = new Array(polynomial.length + 1).fill(0)
        for (let index = 0; index < polynomial.length; index++) {
          next[index] ^= polynomial[index]
          next[index + 1] ^= qrGfMul(polynomial[index], QR_GF_EXP[root])
        }
        polynomial = next
      }
      return polynomial
    }

    /**
     * The remainder of `data` divided by `generator` — the error-correction
     * codewords for one block.
     *
     * Both are descending-coefficient arrays and the generator is monic, so the
     * division is a shift-and-xor loop.
     *
     * @param {Uint8Array} data
     * @param {number[]} generator
     * @returns {Uint8Array}
     */
    function qrRemainder(data, generator) {
      const work = new Uint8Array(data.length + generator.length - 1)
      work.set(data)
      for (let index = 0; index < data.length; index++) {
        const factor = work[index]
        if (factor === 0) continue
        for (let offset = 0; offset < generator.length; offset++) {
          work[index + offset] ^= qrGfMul(generator[offset], factor)
        }
      }
      return work.slice(data.length)
    }

    /**
     * How many BYTE-mode bytes a version holds at level M.
     *
     * Byte mode on purpose: the reference encoder's capacity reflects its
     * segmentation, and using that number here would pick a version this encoder
     * cannot fill (`research/qr-reference-vectors.md` §3.3).
     *
     * @param {number} version 1..15
     * @returns {number}
     */
    function qrByteCapacity(version) {
      const dataBits = (QR_TOTAL_CODEWORDS[version - 1] - QR_EC_CODEWORDS_M[version - 1]) * 8
      const countBits = version < 10 ? 8 : 16
      return Math.floor((dataBits - 4 - countBits) / 8)
    }

    /**
     * The UTF-8 bytes of a string.
     *
     * `TextEncoder` is preferred because it is the platform's own definition and
     * the one the reference encoder uses, which keeps the two byte-identical for
     * text outside ASCII. The hand-rolled path is the fallback for a host without
     * it.
     *
     * @param {string} text
     * @returns {Uint8Array}
     */
    function qrUtf8Bytes(text) {
      if (typeof TextEncoder === 'function') return new TextEncoder().encode(text)
      const bytes = []
      for (let index = 0; index < text.length; index++) {
        let code = text.charCodeAt(index)
        if (code >= 0xD800 && code <= 0xDBFF && index + 1 < text.length) {
          const low = text.charCodeAt(index + 1)
          if (low >= 0xDC00 && low <= 0xDFFF) {
            code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00)
            index++
          }
        }
        if (code < 0x80) bytes.push(code)
        else if (code < 0x800) bytes.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F))
        else if (code < 0x10000) {
          bytes.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F))
        } else {
          bytes.push(
            0xF0 | (code >> 18),
            0x80 | ((code >> 12) & 0x3F),
            0x80 | ((code >> 6) & 0x3F),
            0x80 | (code & 0x3F),
          )
        }
      }
      return Uint8Array.from(bytes)
    }

    /**
     * The data codewords of a byte-mode payload.
     *
     * Mode indicator, character count, the bytes, a terminator of up to four zero
     * bits, zero padding to the next byte boundary, then the 0xEC / 0x11 pad bytes
     * — the pad alternation is counted from the FIRST pad byte, not from the
     * codeword index.
     *
     * @param {Uint8Array} bytes
     * @param {number} version
     * @returns {number[]}
     */
    function qrDataCodewords(bytes, version) {
      const dataCodewordCount = QR_TOTAL_CODEWORDS[version - 1] - QR_EC_CODEWORDS_M[version - 1]
      const totalBits = dataCodewordCount * 8
      const bits = []
      const push = (value, length) => {
        for (let shift = length - 1; shift >= 0; shift--) bits.push((value >>> shift) & 1)
      }
      push(0b0100, 4)
      push(bytes.length, version < 10 ? 8 : 16)
      for (const byte of bytes) push(byte, 8)
      for (let added = 0; added < 4 && bits.length < totalBits; added++) bits.push(0)
      while (bits.length % 8 !== 0) bits.push(0)

      const codewords = []
      for (let offset = 0; offset < bits.length; offset += 8) {
        let value = 0
        for (let bit = 0; bit < 8; bit++) value = (value << 1) | bits[offset + bit]
        codewords.push(value)
      }
      for (let pad = 0; codewords.length < dataCodewordCount; pad++) {
        codewords.push(pad % 2 === 0 ? 0xEC : 0x11)
      }
      return codewords
    }

    /**
     * Data codewords → error-corrected, interleaved codewords.
     *
     * Blocks are cut short-first (the standard's group 1 / group 2 split), each
     * gets its own EC codewords, and the two groups are interleaved column by
     * column — data first, then EC. A symbol whose blocks are not interleaved
     * still *looks* right and still fails to scan, which is why this is pinned by
     * the fixture rather than eyeballed.
     *
     * @param {Uint8Array} bytes
     * @param {number} version
     * @returns {Uint8Array}
     */
    function qrCodewords(bytes, version) {
      const index = version - 1
      const total = QR_TOTAL_CODEWORDS[index]
      const dataTotal = total - QR_EC_CODEWORDS_M[index]
      const blockCount = QR_BLOCKS_M[index]
      const longBlocks = total % blockCount
      const shortBlockCount = blockCount - longBlocks
      const dataPerShortBlock = Math.floor(dataTotal / blockCount)
      const ecPerBlock = Math.floor(total / blockCount) - dataPerShortBlock
      const generator = qrGeneratorPolynomial(ecPerBlock)

      const data = qrDataCodewords(bytes, version)
      const dataBlocks = []
      const ecBlocks = []
      let offset = 0
      for (let block = 0; block < blockCount; block++) {
        const size = block < shortBlockCount ? dataPerShortBlock : dataPerShortBlock + 1
        const slice = Uint8Array.from(data.slice(offset, offset + size))
        dataBlocks.push(slice)
        ecBlocks.push(qrRemainder(slice, generator))
        offset += size
      }

      const result = new Uint8Array(total)
      let at = 0
      const widest = dataPerShortBlock + (longBlocks === 0 ? 0 : 1)
      for (let position = 0; position < widest; position++) {
        for (const block of dataBlocks) {
          if (position < block.length) result[at++] = block[position]
        }
      }
      for (let position = 0; position < ecPerBlock; position++) {
        for (const block of ecBlocks) result[at++] = block[position]
      }
      return result
    }

    /**
     * The 15-bit format field for a mask: 2 ECC bits (level M is `00`) + 3 mask
     * bits, extended by BCH(15,5) with generator 0x537 and XORed with 0x5412.
     *
     * @param {number} mask 0..7
     * @returns {number}
     */
    function qrFormatBits(mask) {
      /* Level M contributes `00` to the two leading bits of the five, so the data
         half of the field is just the mask index. */
      const data = mask
      let remainder = data << 10
      while (qrBitLength(remainder) - 11 >= 0) remainder ^= 0x537 << (qrBitLength(remainder) - 11)
      return ((data << 10) | remainder) ^ 0x5412
    }

    /**
     * The 18-bit version field for v7 and up: 6 version bits + BCH(18,6) with
     * generator 0x1F25.
     *
     * @param {number} version
     * @returns {number}
     */
    function qrVersionBits(version) {
      let remainder = version << 12
      while (qrBitLength(remainder) - 13 >= 0) remainder ^= 0x1F25 << (qrBitLength(remainder) - 13)
      return (version << 12) | remainder
    }

    /**
     * Write the two copies of the format field, reserving every module they occupy.
     *
     * The reservation is what keeps the data mask off them, so it must happen
     * before the data is placed. The skeleton therefore writes a placeholder (mask
     * 0) and the real bits are written again once the mask is chosen.
     *
     * @param {Uint8Array} modules
     * @param {Uint8Array} reserved
     * @param {number} size
     * @param {number} mask
     */
    function qrPlaceFormatInfo(modules, reserved, size, mask) {
      const bits = qrFormatBits(mask)
      for (let bit = 0; bit < 15; bit++) {
        const dark = ((bits >>> bit) & 1) === 1
        /* First copy, around the top-left finder: rows 0..5 and 7..8 of column 8,
           then the bottom-left run up column 8. */
        let row
        let col
        if (bit < 6) {
          row = bit
          col = 8
        } else if (bit < 8) {
          row = bit + 1
          col = 8
        } else {
          row = size - 15 + bit
          col = 8
        }
        modules[row * size + col] = dark ? 1 : 0
        reserved[row * size + col] = 1

        /* Second copy: the top-right run along row 8, then the two modules beside
           the top-left finder. Column 6 is the timing pattern and is skipped. */
        if (bit < 8) {
          row = 8
          col = size - 1 - bit
        } else if (bit < 9) {
          row = 8
          col = 7
        } else {
          row = 8
          col = 14 - bit
        }
        modules[row * size + col] = dark ? 1 : 0
        reserved[row * size + col] = 1
      }
    }

    /**
     * The function patterns of an empty symbol, with the `reserved` map that marks
     * every module the data mask may not touch.
     *
     * Order matters only in that the timing patterns must exist before the
     * alignment patterns are stamped over them (an alignment pattern is allowed to
     * overwrite timing modules, and the reference does the same).
     *
     * @param {number} version
     * @returns {{ size: number, modules: Uint8Array, reserved: Uint8Array }}
     */
    function qrSkeleton(version) {
      const size = version * 4 + 17
      const modules = new Uint8Array(size * size)
      const reserved = new Uint8Array(size * size)
      const put = (row, col, dark) => {
        modules[row * size + col] = dark ? 1 : 0
        reserved[row * size + col] = 1
      }

      /* Finder patterns and their one-module separators, as three 9x9 stamps that
         are clipped at the symbol edge. */
      for (const corner of [[0, 0], [0, size - 7], [size - 7, 0]]) {
        for (let row = -1; row <= 7; row++) {
          for (let col = -1; col <= 7; col++) {
            const targetRow = corner[0] + row
            const targetCol = corner[1] + col
            if (targetRow < 0 || targetRow >= size || targetCol < 0 || targetCol >= size) continue
            const dark = (row >= 0 && row <= 6 && (col === 0 || col === 6))
              || (col >= 0 && col <= 6 && (row === 0 || row === 6))
              || (row >= 2 && row <= 4 && col >= 2 && col <= 4)
            put(targetRow, targetCol, dark)
          }
        }
      }

      /* Timing patterns: row 6 and column 6 alternate, dark on even coordinates. */
      for (let at = 8; at < size - 8; at++) {
        put(at, 6, at % 2 === 0)
        put(6, at, at % 2 === 0)
      }

      /* Alignment patterns, everywhere except the three finder corners. */
      const centers = QR_ALIGNMENT[version - 1]
      const last = centers.length - 1
      for (let rowIndex = 0; rowIndex < centers.length; rowIndex++) {
        for (let colIndex = 0; colIndex < centers.length; colIndex++) {
          if ((rowIndex === 0 && colIndex === 0)
            || (rowIndex === 0 && colIndex === last)
            || (rowIndex === last && colIndex === 0)) continue
          const centerRow = centers[rowIndex]
          const centerCol = centers[colIndex]
          for (let row = -2; row <= 2; row++) {
            for (let col = -2; col <= 2; col++) {
              const dark = Math.max(Math.abs(row), Math.abs(col)) === 2 || (row === 0 && col === 0)
              put(centerRow + row, centerCol + col, dark)
            }
          }
        }
      }

      /* The always-dark module. */
      put(size - 8, 8, true)

      /* Version information, v7 and up: the same 18 bits in two 3x6 blocks. */
      if (version >= 7) {
        const bits = qrVersionBits(version)
        for (let bit = 0; bit < 18; bit++) {
          const dark = ((bits >>> bit) & 1) === 1
          const row = Math.floor(bit / 3)
          const col = size - 11 + (bit % 3)
          put(row, col, dark)
          put(col, row, dark)
        }
      }

      return { size, modules, reserved }
    }

    /**
     * Zig-zag the codeword bits into every module the function patterns left free.
     *
     * Columns are consumed in pairs from the right, alternating upward and
     * downward, and column 6 is skipped because the timing pattern owns it. Modules
     * past the last codeword bit are the standard's remainder bits and stay light.
     *
     * @param {Uint8Array} modules
     * @param {Uint8Array} reserved
     * @param {number} size
     * @param {Uint8Array} codewords
     */
    function qrPlaceData(modules, reserved, size, codewords) {
      let bitIndex = 7
      let byteIndex = 0
      let direction = -1
      let row = size - 1
      for (let col = size - 1; col > 0; col -= 2) {
        if (col === 6) col--
        for (;;) {
          for (let pair = 0; pair < 2; pair++) {
            const target = (row * size) + col - pair
            if (reserved[target] !== 0) continue
            const dark = byteIndex < codewords.length
              && ((codewords[byteIndex] >>> bitIndex) & 1) === 1
            modules[target] = dark ? 1 : 0
            bitIndex--
            if (bitIndex < 0) {
              byteIndex++
              bitIndex = 7
            }
          }
          row += direction
          if (row < 0 || row >= size) {
            row -= direction
            direction = -direction
            break
          }
        }
      }
    }

    /**
     * Whether the data mask of `mask` inverts the module at (row, col).
     *
     * @param {number} mask 0..7
     * @param {number} row
     * @param {number} col
     * @returns {boolean}
     */
    function qrMaskAt(mask, row, col) {
      switch (mask) {
        case 0: return (row + col) % 2 === 0
        case 1: return row % 2 === 0
        case 2: return col % 3 === 0
        case 3: return (row + col) % 3 === 0
        case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0
        case 5: return ((row * col) % 2) + ((row * col) % 3) === 0
        case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0
        default: return (((row * col) % 3) + ((row + col) % 2)) % 2 === 0
      }
    }

    /**
     * A copy of the skeleton with `mask` applied to every non-reserved module and
     * the format field rewritten for that mask.
     *
     * The format bits are part of the symbol a scanner sees and they differ per
     * mask, so they must be in place before the penalty is measured — exactly as
     * the reference does it.
     *
     * @param {{ size: number, modules: Uint8Array, reserved: Uint8Array }} skeleton
     * @param {number} mask
     * @returns {Uint8Array}
     */
    function qrMaskedSkeleton(skeleton, mask) {
      const { size, modules, reserved } = skeleton
      const masked = Uint8Array.from(modules)
      qrPlaceFormatInfo(masked, reserved, size, mask)
      for (let row = 0; row < size; row++) {
        for (let col = 0; col < size; col++) {
          const target = row * size + col
          if (reserved[target] !== 0) continue
          if (qrMaskAt(mask, row, col)) masked[target] ^= 1
        }
      }
      return masked
    }

    /** N1: every run of five or more same-coloured modules, row or column. */
    function qrPenaltyN1(modules, size) {
      let points = 0
      for (let row = 0; row < size; row++) {
        let runAcross = 0
        let runDown = 0
        let lastAcross = -1
        let lastDown = -1
        for (let col = 0; col < size; col++) {
          const across = modules[row * size + col]
          if (across === lastAcross) {
            runAcross++
          } else {
            if (runAcross >= 5) points += QR_PENALTY_N1 + (runAcross - 5)
            lastAcross = across
            runAcross = 1
          }
          const down = modules[col * size + row]
          if (down === lastDown) {
            runDown++
          } else {
            if (runDown >= 5) points += QR_PENALTY_N1 + (runDown - 5)
            lastDown = down
            runDown = 1
          }
        }
        if (runAcross >= 5) points += QR_PENALTY_N1 + (runAcross - 5)
        if (runDown >= 5) points += QR_PENALTY_N1 + (runDown - 5)
      }
      return points
    }

    /** N2: every 2x2 block of one colour. */
    function qrPenaltyN2(modules, size) {
      let blocks = 0
      for (let row = 0; row < size - 1; row++) {
        for (let col = 0; col < size - 1; col++) {
          const sum = modules[row * size + col]
            + modules[(row * size) + col + 1]
            + modules[((row + 1) * size) + col]
            + modules[((row + 1) * size) + col + 1]
          if (sum === 0 || sum === 4) blocks++
        }
      }
      return blocks * QR_PENALTY_N2
    }

    /** N3: the 1:1:3:1:1 finder-like pattern preceded or followed by four light modules. */
    function qrPenaltyN3(modules, size) {
      let found = 0
      for (let row = 0; row < size; row++) {
        let across = 0
        let down = 0
        for (let col = 0; col < size; col++) {
          across = ((across << 1) & 0x7FF) | modules[row * size + col]
          if (col >= 10 && (across === 0x5D0 || across === 0x05D)) found++
          down = ((down << 1) & 0x7FF) | modules[col * size + row]
          if (col >= 10 && (down === 0x5D0 || down === 0x05D)) found++
        }
      }
      return found * QR_PENALTY_N3
    }

    /**
     * N4: how far the dark-module share strays from 50%, counted in 5% steps.
     *
     * The step is `|ceil(percent / 5) - 10|`. The other reading of the same rule —
     * `floor(|percent - 50| / 5)`, the smaller of the two neighbouring multiples —
     * agrees with it for every share at or below 50% and disagrees above it
     * whenever the share is not a multiple of 5, which can change the chosen mask.
     * `prd.md` acceptance 2 requires the auto-mask output to match the reference
     * bit for bit, and the fixture records which mask the reference picked, so this
     * implements the reference's reading. See the task report: this is the one
     * place `design.md` §1.4 ("按规范写") and `prd.md` acceptance 2 pull apart, and
     * acceptance 2 wins because it is the testable one.
     *
     * @param {Uint8Array} modules
     * @returns {number}
     */
    function qrPenaltyN4(modules) {
      let dark = 0
      for (let index = 0; index < modules.length; index++) dark += modules[index]
      const steps = Math.abs(Math.ceil((dark * 100 / modules.length) / 5) - 10)
      return steps * QR_PENALTY_N4
    }

    /**
     * The mask with the lowest total penalty; ties go to the lowest index.
     *
     * @param {{ size: number, modules: Uint8Array, reserved: Uint8Array }} skeleton
     * @returns {number}
     */
    function qrBestMask(skeleton) {
      let best = 0
      let lowest = Infinity
      for (let mask = 0; mask < 8; mask++) {
        const candidate = qrMaskedSkeleton(skeleton, mask)
        const penalty = qrPenaltyN1(candidate, skeleton.size)
          + qrPenaltyN2(candidate, skeleton.size)
          + qrPenaltyN3(candidate, skeleton.size)
          + qrPenaltyN4(candidate)
        if (penalty < lowest) {
          lowest = penalty
          best = mask
        }
      }
      return best
    }

    /**
     * Encode a string as a QR symbol: byte mode, error-correction level M,
     * version 1 to 15, mask chosen by the N1..N4 penalty.
     *
     * Returns a failure VALUE rather than throwing, because both callers are in a
     * render path: `apply` must never throw (the web boot refuses to draw the GUI
     * over an entry that did not activate) and the panel has to degrade to the text
     * code in place (`prd.md` R4). A throw here would take the whole GUI down for a
     * link that is merely too long.
     *
     * @param {string} text UTF-8 text — the pairing link.
     * @param {{ version?: number, mask?: number }} [options] Test-only overrides;
     *   the fixture comparison needs the reference's version and mask forced.
     * @returns {{ ok: true, version: number, mask: number, size: number, modules: Uint8Array }
     *         | { ok: false, reason: 'too-long' | 'empty' }}
     *   `modules` is a row-major `size * size` array of 0/1 WITHOUT the quiet zone.
     */
    function encodeQr(text, options) {
      if (typeof text !== 'string' || text === '') return { ok: false, reason: 'empty' }
      const settings = options === null || typeof options !== 'object' ? {} : options
      const bytes = qrUtf8Bytes(text)

      let version = Number.isInteger(settings.version) ? settings.version : null
      if (version === null) {
        for (let candidate = 1; candidate <= QR_MAX_VERSION; candidate++) {
          if (bytes.length <= qrByteCapacity(candidate)) {
            version = candidate
            break
          }
        }
      }
      if (version === null || version < 1 || version > QR_MAX_VERSION
        || bytes.length > qrByteCapacity(version)) {
        return { ok: false, reason: 'too-long' }
      }

      const skeleton = qrSkeleton(version)
      qrPlaceFormatInfo(skeleton.modules, skeleton.reserved, skeleton.size, 0)
      qrPlaceData(skeleton.modules, skeleton.reserved, skeleton.size, qrCodewords(bytes, version))

      const mask = Number.isInteger(settings.mask) && settings.mask >= 0 && settings.mask <= 7
        ? settings.mask
        : qrBestMask(skeleton)

      return {
        ok: true,
        version,
        mask,
        size: skeleton.size,
        modules: qrMaskedSkeleton(skeleton, mask),
      }
    }

    /**
     * The `d` attribute of the single `<path>` the panel draws.
     *
     * One `M x y h<n> v1 h-<n> z` sub-path per horizontal run of dark modules. A
     * v11 symbol has ~1900 dark modules, and one `<rect>` each would be 1900 DOM
     * nodes for a static picture. Coordinates stay in raw module units (0..size-1);
     * the quiet zone is the margin `qrViewBox` adds around them.
     *
     * @param {Uint8Array} modules
     * @param {number} size
     * @returns {string}
     */
    function qrPathData(modules, size) {
      let path = ''
      for (let row = 0; row < size; row++) {
        let col = 0
        while (col < size) {
          if (modules[row * size + col] !== 1) {
            col++
            continue
          }
          let run = 1
          while (col + run < size && modules[row * size + col + run] === 1) run++
          path += 'M' + String(col) + ' ' + String(row) + 'h' + String(run) + 'v1h-' + String(run) + 'z'
          col += run
        }
      }
      return path
    }

    /**
     * The quiet zone: four light modules on every side of the symbol.
     *
     * ISO/IEC 18004 §9.1 asks for four, and that is not decoration — a scanner uses
     * the margin to tell the finder patterns from whatever surrounds them, so a
     * symbol drawn flush to its own edge is one many of them refuse. It is measured
     * in modules and carried by the `viewBox` rather than by CSS `padding`, because
     * a padding in pixels cannot scale with the version: 10px is ~1 module on a v1
     * symbol and ~3 on a v11 one, while the decoder round-trip this shipped with
     * (`design.md` §3.4) assumes four.
     */
    const QR_QUIET_ZONE = 4

    /**
     * The `viewBox` that leaves `QR_QUIET_ZONE` modules of light margin around the
     * symbol. The margin is painted by the SVG's own background, which is a light
     * design token in every theme (see `.drc-qr` below), so the quiet zone is a
     * real light margin and not merely empty geometry.
     *
     * @param {number} size Symbol width in modules.
     * @returns {string}
     */
    function qrViewBox(size) {
      const extent = size + (QR_QUIET_ZONE * 2)
      return String(-QR_QUIET_ZONE) + ' ' + String(-QR_QUIET_ZONE) + ' ' + String(extent) + ' ' + String(extent)
    }

    /* ------------------------------------------------------------------ *
     * Styles
     *
     * One injected `<style>`, owned by an effect. Theme tokens only
     * (`--dsw-alias-*`), so a transparent or re-coloured theme shows through
     * untouched; every class is prefixed `drc-` so nothing can collide with
     * another plugin's markup.
     * ------------------------------------------------------------------ */

    const CSS = [
      '.drc-root{position:relative;display:inline-flex}',
      '.drc-trigger{display:flex;align-items:center;gap:8px;box-sizing:border-box;height:42px;min-width:0;margin:0;padding:0 10px 0 8px;border:none;border-radius:12px;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;cursor:pointer}',
      '.drc-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.drc-trigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-active)}',
      '.drc-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.drc-triggerRail{width:36px;height:36px;padding:0;justify-content:center;border-radius:50%}',
      '.drc-triggerIcon{flex:none;display:block}',
      '.drc-triggerLabel{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      /* The scrim is its own layer on the document body (portal), so the card can
         never be clipped by the sidebar's overflow. Clicking it does NOT close the
         panel (PRD D1) — it carries no handler at all. */
      '.drc-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:16px;background:var(--dsw-alias-bg-mask-1)}',
      /* 640px, not 560: at 560 the pairing card spent a third of its width on the
         symbol column and the user agent still ran out of room, so the panel read
         as a narrow form on a wide desktop. The height cap and the `100%` fallback
         are what keep it usable on a phone-sized viewport. */
      '.drc-panel{position:relative;display:flex;flex-direction:column;box-sizing:border-box;width:min(640px,100%);max-height:min(760px,calc(100vh - 32px));background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:16px;overflow:hidden}',
      '.drc-panel:focus{outline:none}',
      '.drc-panelHeader{display:flex;align-items:flex-start;gap:8px;padding:14px 14px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.drc-panelTitles{display:flex;flex:1;flex-direction:column;gap:2px;min-width:0}',
      '.drc-panelTitle{margin:0;color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:22px}',
      '.drc-panelSubtitle{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.drc-configBar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.drc-configGroup{display:flex;align-items:center;gap:8px;min-width:0}',
      '.drc-configLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:nowrap}',
      '.drc-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:none;border-radius:50%;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:16px;line-height:1;cursor:pointer}',
      '.drc-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.drc-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      /* The body scrolls INSIDE the card, and `min-height:0` is what lets a flex
         child actually shrink below its content and scroll instead of pushing the
         card past its `max-height`. There is exactly ONE scrolling layer here (plus
         the audit detail list, which caps itself) — two nested scrollers fight over
         the wheel and the outer one never reaches the bottom. */
      '.drc-body{display:flex;flex:1 1 auto;flex-direction:column;gap:12px;min-height:0;padding:12px 16px 18px;overflow-y:auto}',
      /* The status strip sits OUTSIDE the scrolling body on purpose: 「一眼看到当前
        状态」 has to hold while the user scrolls a tab, so it cannot be part of what
         scrolls away. */
      '.drc-statusStrip{display:flex;flex-wrap:wrap;gap:4px 8px;padding:8px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.drc-tabs{display:flex;gap:4px;padding:8px 14px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.drc-tab{box-sizing:border-box;height:30px;padding:0 10px;border:none;border-bottom:2px solid transparent;border-radius:8px 8px 0 0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer}',
      '.drc-tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.drc-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      /* The selected tab is marked by weight, colour AND a rule — not by colour
         alone, which is indistinguishable in a high-contrast theme. */
      '.drc-tabActive{color:var(--dsw-alias-label-primary);font-weight:600;border-bottom-color:var(--dsw-alias-brand-primary)}',
      /* One panel element per tab so every tab's `aria-controls` resolves to
         something real; only the active one carries content. `[hidden]` needs an
         explicit rule because the UA's `display:none` loses to this class. */
      '.drc-panelBody{display:flex;flex-direction:column;gap:14px}',
      '.drc-panelBody[hidden]{display:none}',
      '.drc-section{display:flex;flex-direction:column;gap:10px}',
      /* Every section after the first is separated by a hairline instead of air
         alone: a tab can hold two unrelated blocks, and at a 14px gap they read as
         one continuous form. */
      '.drc-panelBody > .drc-section + .drc-section{border-top:1px solid var(--dsw-alias-border-l1);padding-top:14px}',
      '.drc-sectionTitle{margin:0;color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}',
      '.drc-row{display:flex;align-items:center;justify-content:space-between;gap:10px}',
      '.drc-field{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.drc-label{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
      '.drc-hint{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.drc-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      '.drc-switch{position:relative;flex:none;box-sizing:border-box;width:40px;height:22px;padding:0;border:1px solid var(--dsw-alias-border-l3);border-radius:11px;background:var(--dsw-alias-bg-layer-1);cursor:pointer;transition:background 120ms ease}',
      '.drc-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.drc-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.drc-switch:disabled{cursor:default;opacity:.5}',
      '.drc-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-tertiary);transition:transform 120ms ease,background 120ms ease}',
      '.drc-switch[aria-checked="true"] .drc-knob{transform:translateX(18px);background:var(--dsw-alias-label-primary-inverted)}',
      '.drc-input{box-sizing:border-box;width:88px;height:30px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
      '.drc-input:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.drc-inputWide{flex:1;width:auto;min-width:110px}',
      '.drc-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;height:30px;padding:0 12px;border:1px solid transparent;border-radius:8px;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}',
      '.drc-button:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.drc-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.drc-button:disabled{cursor:default;background:none;opacity:.55}',
      '.drc-buttonPrimary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted)}',
      '.drc-buttonPrimary:hover{background:var(--dsw-alias-button-primary-hover)}',
      '.drc-buttonDanger{color:var(--dsw-alias-state-error-primary)}',
      '.drc-buttonDanger:hover{background:var(--dsw-alias-interactive-bg-hover-danger)}',
      '.drc-code{display:flex;align-items:center;justify-content:flex-start;gap:6px;padding:10px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:18px;font-weight:600;letter-spacing:.1em}',
      '.drc-codeGroup{padding:0 1px}',
      /* The pairing card: symbol on the left, everything you can act on on the
         right. As a single centred column the QR pushed the code, the countdown
         and the link apart and the copy button wrapped onto a line of its own
         (screenshot, 2026-10-19). Two columns keep the whole pairing step inside
         one eye movement; `flex-wrap` collapses it back to one column when the
         panel is narrower than the two minimums together. */
      '.drc-pairCard{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}',
      '.drc-pairQr{display:flex;flex:0 0 auto;flex-direction:column;align-items:center;gap:6px;max-width:100%}',
      '.drc-pairMain{display:flex;flex:1 1 214px;flex-direction:column;gap:8px;min-width:0}',
      /* The one line a dead code shows (已使用 / 已过期 / 已作废 / 已失效): a state, not
         a warning banner — the code simply has no life left, and the useful next
         action sits right below it. */
      '.drc-pairState{margin:0;font-size:15px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-primary)}',
      /* The symbol. `176px` leaves the right column ~374px inside the 640px modal
         (640 − 32 body padding − 24 card padding − 196 symbol column − 14 gap), so
         the code, the countdown and the link all fit on one row each. The quiet zone
         itself is four modules and lives in the `viewBox` (`qrViewBox`), so it scales
         with the version instead of being a fixed number of pixels.
         The two colours come from the THEME-INDEPENDENT half of the design token
         set on purpose: a QR symbol is dark modules on a light surround in every
         theme, whereas an `--dsw-alias-*` pair flips (label-primary turns light and
         bg-layer-1 turns dark), which would draw a light-on-dark symbol that some
         scanners refuse. Still tokens, never a literal colour. */
      '.drc-qrBox{display:flex;flex-direction:column;align-items:center;gap:6px}',
      '.drc-qr{display:block;width:176px;height:auto;aspect-ratio:1;padding:10px;box-sizing:content-box;border-radius:8px;background:var(--dsw-static-neutral-bluish-00);color:var(--dsw-static-neutral-bluish-1000)}',
      /* One row: field plus its button. The link input used to be full width with
         the copy button underneath it, so the button floated alone on its own
         line and read as belonging to the next section. */
      '.drc-inline{display:flex;align-items:center;gap:6px;min-width:0}',
      '.drc-emptyAction{display:flex;flex-direction:column;align-items:flex-start;gap:8px}',
      /* The managed tunnel card: status and its timestamp on one wrap-friendly row,
         the binary source on another, and the configuration fields stacked so a
         long path or hostname does not squeeze the label. */
      '.drc-tunnelStatus{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 10px}',
      '.drc-tunnelState{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.drc-tunnelStateFailed{color:var(--dsw-alias-state-error-primary)}',
      '.drc-tunnelRow{display:flex;align-items:center;flex-wrap:wrap;gap:8px}',
      '.drc-tunnelFields{display:flex;flex-direction:column;gap:10px}',
      '.drc-linkInput{box-sizing:border-box;flex:1;width:auto;min-width:0;height:28px;padding:0 8px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-link);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}',
      '.drc-devices{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}',
      '.drc-device{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.drc-device:last-child{border-bottom:none}',
      '.drc-deviceMain{display:flex;flex:1;flex-direction:column;gap:2px;min-width:0}',
      '.drc-deviceName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
      '.drc-deviceMeta{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      /* Address and counters share one line; only the user agent gets its own,
         ellipsised row, because it is the one string long enough to wrap the row
         to three lines and bury the device name above it. */
      '.drc-deviceMetaRow{display:flex;flex-wrap:wrap;gap:2px 8px;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.drc-deviceUa{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      /* A revoked row keeps its place in the list (the audit says it existed) but
         recedes: the badge in the action column is the only state marker, so the
         old duplicate "已吊销" meta line is gone. */
      '.drc-deviceRevoked{opacity:.62}',
      '.drc-deviceActions{display:flex;flex:none;align-items:center;gap:6px}',
      /* Address controls: mutually exclusive modes (LAN / public / managed tunnel),
         so a segmented group rather than a dropdown — the mode is a choice between
         named things, not a selection from a list. */
      '.drc-segments{display:flex;gap:4px;padding:2px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
      '.drc-segment{flex:1;box-sizing:border-box;height:26px;padding:0 10px;border:none;border-radius:8px;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
      '.drc-segment:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.drc-segment:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.drc-segment:disabled{cursor:default;opacity:.55}',
      '.drc-segmentActive{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);font-weight:600}',
      '.drc-select{box-sizing:border-box;width:100%;height:30px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
      '.drc-select:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.drc-publicList{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}',
      '.drc-publicRow{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.drc-publicRow:last-child{border-bottom:none}',
      '.drc-radio{flex:none;margin:0;accent-color:var(--dsw-alias-brand-primary)}',
      '.drc-publicMain{display:flex;flex:1;flex-direction:column;gap:1px;min-width:0}',
      '.drc-publicLabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px}',
      '.drc-publicAddress{color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:16px;word-break:break-all}',
      '.drc-addForm{display:flex;flex-wrap:wrap;gap:6px;align-items:center}',
      '.drc-notice{display:flex;flex-direction:column;gap:4px;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}',
      '.drc-noticeTitle{margin:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:20px}',
      '.drc-noticeBody{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.drc-noticeError{border-color:var(--dsw-alias-state-error-primary)}',
      '.drc-noticeError .drc-noticeTitle{color:var(--dsw-alias-state-error-primary)}',
      '.drc-noticeWarn{border-color:var(--dsw-alias-state-warn-primary)}',
      '.drc-noticeWarn .drc-noticeTitle{color:var(--dsw-alias-state-warn-label)}',
      '.drc-noticeOk .drc-noticeTitle{color:var(--dsw-alias-state-success-primary)}',
      /* Audit counters: a grid of chips instead of one inline run of text. The
         per-event counts are key/value pairs a glance should be able to compare;
         run together they read as a sentence nobody parses. */
      '.drc-auditGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:6px}',
      '.drc-auditItem{display:flex;align-items:baseline;justify-content:space-between;gap:8px;box-sizing:border-box;min-width:0;padding:6px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.drc-auditItem > span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.drc-auditValue{flex:none;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      /* Audit detail: four fixed columns per row (time, action, device, address).
         A list and not a `<table>`: two columns are short and one is an ellipsised
         name, so table semantics would only make a screen reader announce headers
         before every cell. The list caps its own height so the panel keeps ONE
         scrolling layer above it. */
      /* Single scrolling owner: `.drc-body` (the modal's content column). The list
         used to cap itself at 260px with its own `overflow-y:auto`, which meant a
         nested scrollbar inside a scrolling panel — a trackpad scroll would move the
         inner list until it hit its end and then move the outer one, and the 「加载更多」
         button sat in a second scroll context. One scrollbar, at the panel level. */
      '.drc-auditEvents{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}',
      '.drc-auditEvent{display:grid;grid-template-columns:auto auto minmax(0,1fr) auto;gap:8px;align-items:baseline;padding:5px 2px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px;line-height:18px}',
      '.drc-auditEvent:last-child{border-bottom:none}',
      '.drc-auditEventTime{color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.drc-auditEventAction{white-space:nowrap;color:var(--dsw-alias-label-primary)}',
      '.drc-auditEventDevice{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}',
      '.drc-auditEventIp{white-space:nowrap;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      /* The filter is a narrow control in a row, not a full-width field. */
      '.drc-selectInline{width:auto;min-width:132px}',
      /* The switch is the only thing in the panel that animates. Respect the
         preference instead of assuming a 120ms slide is harmless: for vestibular
         disorders a small moving object is the worst case, not the mildest. */
      '@media (prefers-reduced-motion: reduce){.drc-switch,.drc-knob{transition:none}}',
    ].join('\n')

    /**
     * Inject the stylesheet once, returning its remover.
     *
     * @returns {(() => void) | undefined} Disposer, or undefined when there is no DOM.
     */
    function installStyles() {
      if (typeof document === 'undefined' || document === null) return undefined
      const selector = 'style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']'
      /* A reloaded copy finds the previous one already in the head and adds
         nothing: two identical stylesheets would double every rule's precedence
         and leak one of them past the next unload. */
      if (document.querySelector(selector) !== null) return undefined
      const tag = document.createElement('style')
      tag.dataset.plugin = '@misaka10091/dsh-remote-control'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        if (tag.parentNode !== null) tag.parentNode.removeChild(tag)
      }
    }

    /**
     * Place a subtree in `document.body` when the platform allows it.
     *
     * This is what keeps the modal out of the sidebar's `overflow` — a structural
     * fix, not a stacking-context one (`design.md` §3.1). Three degradations, in
     * order of preference:
     *
     *   1. portal into `document.body` — the normal path;
     *   2. render in place — a host whose module table has no `react-dom`, or an
     *      engine without `document.body` yet. The panel may then be clipped again,
     *      which is the old defect, but it works;
     *   3. render nothing — there is no DOM at all (a server-side render, a test
     *      harness). `typeof document === 'undefined'` is guarded explicitly
     *      because reading it is a `ReferenceError`, not `undefined`, and this
     *      function runs inside a component's render.
     *
     * @param {any} node
     * @returns {any}
     */
    function portal(node) {
      if (node === null || node === undefined) return null
      /* Reading `document` where it does not exist is a `ReferenceError`, not
         `undefined`, and this runs inside a component's render — a throw here would
         blank the panel instead of degrading. No DOM at all means there is nothing
         to render into, so the subtree is not rendered (case 3 above). */
      if (typeof document === 'undefined' || document === null) return null
      const body = document.body
      /* A `document` whose `body` is not there yet still renders in place: that is
         a host mid-boot, not a host without a DOM. */
      if (body === null || body === undefined || createPortal === null) return node
      try {
        return createPortal(node, body)
      } catch (error) {
        /* A failed portal must not blank the panel. Reported once per open. */
        report('warn', '[remote-control] the device panel could not be portalled; rendering in place:', error)
        return node
      }
    }

    /* ------------------------------------------------------------------ *
     * Transport
     * ------------------------------------------------------------------ */

    /** The page base a relative API path resolves against. */
    function documentBase() {
      if (typeof document !== 'undefined' && document !== null
        && typeof document.baseURI === 'string' && document.baseURI !== '') {
        return document.baseURI
      }
      if (typeof location !== 'undefined' && location !== null
        && typeof location.href === 'string' && location.href !== '') {
        return location.href
      }
      return 'http://localhost/'
    }

    /**
     * One admin API request, unwrapped to its `data` field.
     *
     * No retry: `hook-guidelines.md` forbids it. A failing API retried in a loop
     * fills the host log with the same line and hides the fact that nothing
     * works — the panel shows the failure instead.
     *
     * @param {string} suffix Path below `remote-control/api`.
     * @param {{ method?: string, body?: object, signal?: AbortSignal }} [options]
     * @returns {Promise<any>} The envelope's `data`.
     * @throws {Error & { kind: string, status: number | null }} Classified failure.
     */
    async function requestJson(suffix, options) {
      const method = options !== undefined && typeof options.method === 'string' ? options.method : 'GET'
      const signal = options !== undefined ? options.signal : undefined
      const body = options !== undefined ? options.body : undefined
      const init = {
        method,
        /* Same-origin cookies are irrelevant to the admin API (it uses no
           credential), but sending them matches what the page would do anyway
           and keeps a future cookie-gated route working unchanged. */
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { accept: 'application/json', [PANEL_MARKER_HEADER]: PANEL_MARKER_VALUE },
        signal,
      }
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }

      let response
      try {
        response = await fetch(adminUrl(suffix, documentBase()), init)
      } catch {
        /* An aborted request carries the caller's abort reason; anything else is
           a real transport failure. Distinguishing them is what lets the panel
           say "timed out" instead of "unreachable". */
        const reason = signal === undefined || signal === null ? undefined : signal.reason
        throw apiError(
          reason === 'timeout' ? 'timeout' : 'network',
          null,
          null,
          'the admin API could not be reached',
        )
      }

      let payload = null
      let parsed = false
      try {
        payload = await response.json()
        parsed = true
      } catch {
        /* A non-JSON body is expected on exactly one path: the SPA fallback of an
           unmounted route, which answers 200 with HTML. `classifyFailure` reads
           `parsed` for that reason. */
        parsed = false
      }

      if (response.ok !== true) {
        throw apiError(
          classifyFailure(response.status, payload, parsed),
          response.status,
          errorCodeOf(payload),
          'the admin API refused this request',
        )
      }
      if (parsed !== true || payload === null || typeof payload !== 'object' || payload.ok !== true) {
        throw apiError(
          classifyFailure(response.status, payload, parsed),
          response.status,
          errorCodeOf(payload),
          'the admin API returned an unexpected response',
        )
      }
      return payload.data
    }

    /* ------------------------------------------------------------------ *
     * Hooks
     * ------------------------------------------------------------------ */

    /** The snapshot before the first read lands. */
    const EMPTY_SNAPSHOT = Object.freeze({
      phase: 'idle',
      state: null,
      devices: [],
      audit: null,
      error: null,
    })

    /**
     * The panel's whole server state: gateway status, devices, audit summary.
     *
     * The subscription IS the mount (`state-management.md`: panel data lives in
     * component state and is re-read every time the panel opens — a module-level
     * cache would survive a hot reload and show a device that was revoked
     * elsewhere). The poll is released by the effect's cleanup, so closing the
     * panel stops it and there is never more than one in flight.
     *
     * @returns {{
     *   snapshot: typeof EMPTY_SNAPSHOT,
     *   refresh: () => Promise<void>,
     *   revokeDevice: (deviceId: string) => Promise<{ ok: boolean, failure: object | null }>,
     *   updateSettings: (patch: object) => Promise<{ ok: boolean, settings: object | null, requiresReload: boolean, failure: object | null }>,
     * }}
     */
    function useGatewayStatus() {
      const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT)

      /** Aborting on unmount is what makes "the panel closed" mean "no request in flight". */
      const inFlight = useRef(null)
      const disposed = useRef(false)
      /** Monotonic token: a superseded load must not overwrite a newer result. */
      const token = useRef(0)

      const load = useCallback(async () => {
        const previous = inFlight.current
        if (previous !== null) previous.abort('superseded')
        const mine = token.current + 1
        token.current = mine

        let controller = null
        let timer = null
        if (typeof AbortController === 'function') {
          controller = new AbortController()
          inFlight.current = controller
          /* A request-scoped deadline, always cleared in `finally` below. It is
             not a subscription: it cannot outlive the call it bounds. */
          timer = setTimeout(() => {
            if (controller !== null) controller.abort('timeout')
          }, REQUEST_TIMEOUT_MS)
        }
        const signal = controller === null ? undefined : controller.signal

        setSnapshot((current) => (current.phase === 'idle' ? { ...current, phase: 'loading' } : current))
        try {
          const [state, devices, audit] = await Promise.all([
            requestJson('state', { signal }),
            requestJson('devices', { signal }),
            requestJson('audit', { signal }),
          ])
          if (disposed.current || token.current !== mine) return
          setSnapshot({
            phase: 'ready',
            state,
            devices: devices !== null && typeof devices === 'object' && Array.isArray(devices.devices)
              ? devices.devices
              : [],
            audit,
            error: null,
          })
        } catch (error) {
          if (disposed.current || token.current !== mine) return
          /* The previous data is KEPT and the failure is rendered above it: an
             empty list on a transient error would read as "you have no devices",
             which is the reassuring-and-wrong state `quality-guidelines.md`
             forbids. */
          setSnapshot((current) => ({ ...current, phase: 'error', error: describeFailure(error) }))
        } finally {
          if (timer !== null) clearTimeout(timer)
          if (inFlight.current === controller) inFlight.current = null
        }
      }, [])

      useEffect(() => {
        disposed.current = false
        const timer = setInterval(() => {
          /* A poll that overlaps a user-initiated refresh would supersede it and
             cancel a request the user is waiting on. Skipping while one is in
             flight is enough: this is a 5 s cadence against a loopback socket. */
          if (inFlight.current !== null) return
          void load()
        }, POLL_INTERVAL_MS)
        void load()
        return () => {
          disposed.current = true
          clearInterval(timer)
          const controller = inFlight.current
          inFlight.current = null
          if (controller !== null) controller.abort('unmount')
        }
      }, [load])

      /**
       * Revoke a device, then re-read.
       *
       * NEVER optimistic (`quality-guidelines.md` forbidden pattern 6): the list
       * changes only after the server confirms, because a row removed from a
       * still-working device is a security lie — the user would believe access
       * was cut when it was not.
       */
      const revokeDevice = useCallback(async (deviceId) => {
        try {
          await requestJson('devices/' + encodeURIComponent(deviceId) + '/revoke', { method: 'POST' })
          await load()
          return { ok: true, failure: null }
        } catch (error) {
          return { ok: false, failure: describeFailure(error) }
        }
      }, [load])

      /**
       * Persist the enable switch, the port or the access addresses; the caller
       * re-reads the state afterwards (never optimistically).
       *
       * `requiresReload` is the SERVER's answer, carried through instead of being
       * inferred here: it is true only when the listener configuration changed AND
       * the host could not rebind itself, so a panel that guessed would tell a user
       * to restart `dsh` after editing an address (no restart) or after toggling the
       * switch (the host applies that live).
       */
      const updateSettings = useCallback(async (patch) => {
        try {
          const data = await requestJson('settings', { method: 'POST', body: patch })
          await load()
          return {
            ok: true,
            settings: data !== null && typeof data === 'object' ? data.settings ?? null : null,
            requiresReload: data !== null && typeof data === 'object' && data.requiresReload === true,
            failure: null,
          }
        } catch (error) {
          return { ok: false, settings: null, requiresReload: false, failure: describeFailure(error) }
        }
      }, [load])

      /**
       * Drive the managed tunnel (`start` / `stop` / `restart`), then re-read.
       *
       * The returned status is deliberately NOT merged into local state: a failed
       * start is a real state the host reports, and the next `GET /state` is the
       * only authority on it (`quality-guidelines.md` frontend — no optimistic UI).
       */
      const tunnelAction = useCallback(async (action) => {
        try {
          await requestJson('tunnel', { method: 'POST', body: { action } })
          await load()
          return { ok: true, failure: null }
        } catch (error) {
          return { ok: false, failure: describeFailure(error) }
        }
      }, [load])

      /** Persist tunnel mode / path / hostname / token, then re-read. */
      const updateTunnelConfig = useCallback(async (patch) => {
        try {
          await requestJson('tunnel/config', { method: 'POST', body: patch })
          await load()
          return { ok: true, failure: null }
        } catch (error) {
          return { ok: false, failure: describeFailure(error) }
        }
      }, [load])

      /** Download the official cloudflared into the runtime directory. */
      const downloadTunnel = useCallback(async () => {
        try {
          const data = await requestJson('tunnel/download', { method: 'POST' })
          await load()
          return {
            ok: true,
            version: data !== null && typeof data === 'object' && typeof data.version === 'string'
              ? data.version
              : '',
            failure: null,
          }
        } catch (error) {
          return { ok: false, version: '', failure: describeFailure(error) }
        }
      }, [load])

      return {
        snapshot,
        refresh: load,
        revokeDevice,
        updateSettings,
        tunnelAction,
        updateTunnelConfig,
        downloadTunnel,
      }
    }

    /**
     * The pairing flow: mint a code, count down, forget it — and, on request, ask
     * the host what the code became.
     *
     * Nothing is cached across a panel close — a code that outlived its card
     * would be a credential with no visible lifetime. Host-side, a pair is a
     * 120 s one-shot either way, so a stale card could only mislead.
     *
     * `state` exists because the countdown alone cannot tell a code that is still
     * waiting from one the phone already redeemed: both are "inside the TTL", and
     * a redeemed code kept counting down as though it were still good (2026-10-19
     * user report: 已用的配对码显示已使用). `refresh` is the manual re-read — the
     * host answers `pending` / `used` / `locked` / `expired` / `unknown`, and this
     * half never polls it: 点一次看一次.
     *
     * @returns {{
     *   current: object | null,
     *   remainingMs: number,
     *   state: string,
     *   busy: boolean,
     *   failure: object | null,
     *   start: () => Promise<void>,
     *   refresh: () => Promise<void>,
     *   clear: () => void,
     * }}
     */
    function usePairing() {
      const [current, setCurrent] = useState(null)
      const [remainingMs, setRemainingMs] = useState(0)
      const [state, setState] = useState('pending')
      const [busy, setBusy] = useState(false)
      const [failure, setFailure] = useState(null)

      const clear = useCallback(() => {
        setCurrent(null)
        setRemainingMs(0)
        setState('pending')
        setFailure(null)
      }, [])

      const start = useCallback(async () => {
        setBusy(true)
        setFailure(null)
        try {
          const data = await requestJson('pairing', { method: 'POST', body: {} })
          setCurrent(data !== null && typeof data === 'object' ? data : null)
          setRemainingMs(data !== null && typeof data === 'object' && Number.isFinite(data.ttlMs) ? data.ttlMs : 0)
          /* A brand-new code is pending by construction; nothing to ask the host. */
          setState('pending')
        } catch (error) {
          setCurrent(null)
          setState('pending')
          setFailure(describeFailure(error))
        } finally {
          setBusy(false)
        }
      }, [])

      /**
       * Ask the host what this code became. Never optimistic, never a retry.
       *
       * A failure keeps the previous state and shows the classified notice: the
       * card is still the user's only evidence of the code, so blanking it on a
       * transient read failure would look like the pairing itself failed.
       */
      const refresh = useCallback(async () => {
        if (current === null || typeof current.pairId !== 'string' || current.pairId === '') return
        setBusy(true)
        try {
          const data = await requestJson(PAIRING_STATUS_PATH + '/' + encodeURIComponent(current.pairId))
          const reported = data !== null && typeof data === 'object' ? data.state : null
          setState(PAIR_STATES.includes(reported) ? reported : 'unknown')
          setFailure(null)
        } catch (error) {
          setFailure(describeFailure(error))
        } finally {
          setBusy(false)
        }
      }, [current])

      useEffect(() => {
        if (current === null) return undefined
        const expiresAt = Date.parse(current.expiresAt)
        const tick = () => {
          if (!Number.isFinite(expiresAt)) {
            setCurrent(null)
            return
          }
          const left = Math.max(0, expiresAt - Date.now())
          setRemainingMs(left)
          /* The card removes itself when the host stops honouring the code: a
             visible countdown at zero would invite a scan that must fail. A code
             the host has already reported as used is NOT swept away here: 「已使用」
             is an answer the user asked for, and it must survive the TTL long
             enough to be read. */
          if (left === 0 && state === 'pending') setCurrent(null)
        }
        tick()
        const timer = setInterval(tick, COUNTDOWN_INTERVAL_MS)
        return () => clearInterval(timer)
      }, [current, state])

      return { current, remainingMs, state, busy, failure, start, refresh, clear }
    }

    /* ------------------------------------------------------------------ *
     * Presentational pieces
     * ------------------------------------------------------------------ */

    /**
     * The typed title/body pair for one failure kind.
     *
     * @param {object} props
     * @param {{ kind: string, status: number | null, code: string | null }} props.failure
     * @param {(key: string, params?: object) => string} props.t
     * @param {() => void} [props.onRetry]
     */
    function FailureNotice({ failure, t, onRetry }) {
      const kind = FAILURE_KINDS.includes(failure.kind) ? failure.kind : 'unknown'
      return h('div', { className: 'drc-notice drc-noticeError', role: 'alert' },
        h('p', { className: 'drc-noticeTitle' }, t('error.' + kind + '.title')),
        h('p', { className: 'drc-noticeBody' }, t('error.' + kind + '.body')),
        onRetry === undefined ? null : h('div', { className: 'drc-row' },
          h('button', { type: 'button', className: 'drc-button', onClick: onRetry }, t('panel.retry')),
        ),
      )
    }

    /**
     * One inline message row.
     *
     * @param {object} props
     * @param {'ok' | 'warn' | 'error'} props.tone
     * @param {string} props.title Already translated.
     * @param {string} [props.body] Already translated.
     */
    function Notice({ tone, title, body }) {
      const className = tone === 'error'
        ? 'drc-notice drc-noticeError'
        : (tone === 'warn' ? 'drc-notice drc-noticeWarn' : 'drc-notice drc-noticeOk')
      return h('div', {
        className,
        role: tone === 'error' ? 'alert' : 'status',
      },
        h('p', { className: 'drc-noticeTitle' }, title),
        body === undefined ? null : h('p', { className: 'drc-noticeBody' }, body),
      )
    }

    /**
     * The panel's top configuration: the master switch and the listener port.
     *
     * Both are panel-wide facts, so both live ABOVE the tabs: the switch decides
     * whether anything is reachable at all, and the address a pairing link uses
     * depends on the port it must name. Leaving the port inside a tab made two
     * adjacent settings answer the same question from different places — the review
     * that produced this layout put it as "端口同理，应当是顶部配置".
     *
     * The component owns its drafts, and it is mounted OUTSIDE the tab panels, so a
     * half-typed port survives every tab switch for free.
     *
     * @param {object} props
     * @param {(key: string, params?: object) => string} props.t
     * @param {{ enabled: boolean, port: number } | null} props.settings
     * @param {(patch: object) => Promise<{ ok: boolean, requiresReload?: boolean, failure: object | null }>} props.updateSettings
     */
    function ConfigBar({ t, settings, updateSettings }) {
      const [portDraft, setPortDraft] = useState(null)
      const [busy, setBusy] = useState(false)
      const [outcome, setOutcome] = useState(null)

      const known = settings !== null && typeof settings === 'object'
      const enabled = known && settings.enabled === true
      const portText = portDraft !== null
        ? portDraft
        : (known && Number.isInteger(settings.port) ? String(settings.port) : '')

      const commit = async (patch) => {
        setBusy(true)
        setOutcome(null)
        const result = await updateSettings(patch)
        setBusy(false)
        setOutcome(result.ok === true
          ? { tone: 'ok', requiresReload: result.requiresReload === true }
          : { tone: 'error', failure: result.failure })
      }

      const onToggle = () => {
        if (busy || known !== true) return
        void commit({ enabled: !enabled })
      }

      const onSavePort = () => {
        if (busy) return
        const value = parsePort(portText)
        if (value === null) {
          setOutcome({ tone: 'invalid' })
          return
        }
        setPortDraft(null)
        void commit({ port: value })
      }

      let outcomeNode = null
      if (outcome !== null) {
        if (outcome.tone === 'invalid') {
          outcomeNode = h(Notice, { tone: 'error', title: t('access.invalidPort') })
        } else if (outcome.tone === 'ok') {
          /* The reload sentence appears only when the server said it could NOT
             rebind the listener: a switch or port change is applied live by the
             host, and an address save never moves a socket at all. Telling the user
             to restart for either is a false instruction. */
          outcomeNode = h(Notice, {
            tone: 'ok',
            title: t('access.saved'),
            body: outcome.requiresReload === true ? t('access.reloadRequired') : undefined,
          })
        } else {
          outcomeNode = h(FailureNotice, { failure: outcome.failure === null ? { kind: 'unknown' } : outcome.failure, t })
        }
      }

      return h('div', { className: 'drc-configBar' },
        h('div', { className: 'drc-configGroup' },
          h('button', {
            type: 'button',
            className: 'drc-switch',
            role: 'switch',
            'aria-checked': enabled,
            'aria-label': t('access.enable'),
            /* The explanation is a tooltip, not a paragraph: the switch is one control
               in a dense row, and the status line below already states the effect. */
            title: t('access.enableHint'),
            disabled: busy || known !== true,
            onClick: onToggle,
          }, h('span', { className: 'drc-knob' })),
          h('span', { className: 'drc-configLabel' }, t('access.enable')),
        ),
        h('div', { className: 'drc-configGroup' },
          h('label', { className: 'drc-configLabel', htmlFor: PORT_INPUT_ID }, t('access.port')),
          h('input', {
            id: PORT_INPUT_ID,
            className: 'drc-input drc-mono',
            type: 'text',
            inputMode: 'numeric',
            value: portText,
            disabled: busy || known !== true,
            onChange: (event) => {
              setOutcome(null)
              setPortDraft(event.target.value)
            },
            onKeyDown: (event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              onSavePort()
            },
          }),
          h('button', {
            type: 'button',
            className: 'drc-button',
            disabled: busy || known !== true,
            onClick: onSavePort,
          }, t('access.save')),
        ),
        outcomeNode,
      )
    }

    /**
     * Where the pairing link points: a LAN address or one saved public address.
     *
     * This lives in the PAIRING tab on purpose. Choosing an access point is part of
     * "pair a device", not part of administration: the link, the symbol and the
     * address are one decision made in one place, and the user who is about to scan
     * a code should not have to switch tabs to change what that code will contain.
     * Maintaining the address BOOK is a different task with a different cadence and
     * lives in the 接入 tab ({@link PublicBookSection}).
     *
     * @param {object} props
     * @param {(key: string, params?: object) => string} props.t
     * @param {{ enabled: boolean, port: number } | null} props.settings
     * @param {{ lan?: object[] } | null} props.addresses
     * @param {object | null} [props.tunnel] The host's tunnel snapshot (`state`/`url`).
     * @param {(patch: object) => Promise<{ ok: boolean, failure: object | null }>} props.updateSettings
     * @param {() => void} [props.onManagePublic]
     * @param {() => void} [props.onManageTunnel]
     */
    function AccessPointSection({ t, settings, addresses, tunnel, updateSettings, onManagePublic, onManageTunnel }) {
      const [busy, setBusy] = useState(false)
      const [outcome, setOutcome] = useState(null)

      const known = settings !== null && typeof settings === 'object'
      const access = accessOf(settings)
      /* Defensive on both axes: an older host sends no `addresses` at all, and an
         entry missing `address` would render an empty option that selects nothing. */
      const lan = addresses !== null && typeof addresses === 'object' && Array.isArray(addresses.lan)
        ? addresses.lan.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.address === 'string')
        : []
      const publicRows = access.public
      const selectedPublicId = publicRows.some((row) => row.id === access.selectedPublicId)
        ? access.selectedPublicId
        : (publicRows.length > 0 ? publicRows[0].id : '')
      const tunnelUrl = tunnel !== null && typeof tunnel === 'object' && typeof tunnel.url === 'string'
        ? tunnel.url
        : ''
      const tunnelLive = tunnel !== null && typeof tunnel === 'object'
        && tunnel.state === 'running' && tunnelUrl !== ''
      const effective = effectiveAddress(access, lan, tunnelUrl)
      /* The stored LAN choice is no longer on this machine. The link silently falls
         back (that is right — a link that works beats a link that matches), but
         saying nothing would leave the user wondering why the dropdown shows an
         address they never picked. */
      const stale = access.mode === 'lan' && access.lanAddress !== ''
        && !lan.some((entry) => entry.address === access.lanAddress)

      const commit = async (next) => {
        setBusy(true)
        setOutcome(null)
        const result = await updateSettings({ access: next })
        setBusy(false)
        /* No reload sentence: an address only shapes a link, so it is live the moment
           it is stored (`design.md` §2.3). */
        setOutcome(result.ok === true ? { tone: 'ok' } : { tone: 'error', failure: result.failure })
      }

      const onMode = (mode) => {
        if (busy || known !== true || mode === access.mode) return
        void commit({
          mode,
          lanAddress: access.lanAddress,
          public: publicRows,
          selectedPublicId: access.selectedPublicId,
        })
      }

      const onPickLan = (value) => {
        if (busy || known !== true || value === '') return
        void commit({ mode: 'lan', lanAddress: value, public: publicRows, selectedPublicId: access.selectedPublicId })
      }

      const onPickPublic = (id) => {
        if (busy || known !== true || id === '') return
        void commit({ mode: 'public', lanAddress: access.lanAddress, public: publicRows, selectedPublicId: id })
      }

      const onPickTunnel = () => {
        if (busy || known !== true || tunnelLive !== true) return
        void commit({ mode: 'tunnel', lanAddress: access.lanAddress, public: publicRows, selectedPublicId: access.selectedPublicId })
      }

      /** A segment of the LAN/public/tunnel switch. */
      const segment = (mode, labelKey, enabled = true) => h('button', {
        key: mode,
        type: 'button',
        className: access.mode === mode ? 'drc-segment drc-segmentActive' : 'drc-segment',
        'aria-pressed': access.mode === mode,
        disabled: busy || known !== true || enabled !== true,
        onClick: () => (mode === 'tunnel' ? onPickTunnel() : onMode(mode)),
      }, t(labelKey))

      /** What the LAN dropdown shows: the resolved address, so it never reads blank. */
      const lanValue = effective !== null && lan.some((entry) => entry.address === effective)
        ? effective
        : (lan.length > 0 ? lan[0].address : '')

      const lanPicker = lan.length === 0
        ? h('p', { className: 'drc-hint' }, t('address.lanEmpty'))
        : h('select', {
          className: 'drc-select',
          value: lanValue,
          'aria-label': t('point.heading'),
          disabled: busy || known !== true,
          onChange: (event) => onPickLan(event.target.value),
        }, lan.map((entry) => h('option', {
          key: entry.address + '|' + String(entry.iface ?? ''),
          value: entry.address,
        }, typeof entry.iface === 'string' && entry.iface !== ''
          ? entry.address + ' · ' + entry.iface
          : entry.address)))

      /* One dropdown rather than a radio per row: this is a choice, not a book. The
         address is what the user is comparing, so it rides along in the option text.
         An empty book is a dead end from here — the mode is already `public` and there
         is nothing to pick — so the empty state offers the one action that unblocks it
         instead of a sentence that only describes the problem. */
      const publicPicker = publicRows.length === 0
        ? h('div', { className: 'drc-emptyAction' },
          h('p', { className: 'drc-hint' }, t('address.publicEmpty')),
          typeof onManagePublic === 'function'
            ? h('button', {
              type: 'button',
              className: 'drc-button',
              onClick: () => onManagePublic(),
            }, t('address.goManage'))
            : null,
        )
        : h('select', {
          className: 'drc-select',
          value: selectedPublicId,
          'aria-label': t('point.heading'),
          disabled: busy || known !== true,
          onChange: (event) => onPickPublic(event.target.value),
        }, publicRows.map((row) => h('option', { key: row.id, value: row.id },
          row.label === '' ? row.address : row.label + ' · ' + row.address)))

      /* Selecting the tunnel mode without a live tunnel would produce a link to
         nowhere, so the picker is replaced by the one action that fixes it. */
      const tunnelPicker = tunnelLive
        ? h('div', { className: 'drc-field' },
          h('span', { className: 'drc-label' }, t('tunnel.url')),
          h('p', { className: 'drc-publicAddress' }, tunnelUrl),
          h('p', { className: 'drc-hint' }, t('pair.tunnelHint')),
        )
        : h('div', { className: 'drc-emptyAction' },
          h('p', { className: 'drc-hint' }, t('pair.tunnelDown')),
          typeof onManageTunnel === 'function'
            ? h('button', {
              type: 'button',
              className: 'drc-button',
              onClick: () => onManageTunnel(),
            }, t('address.goTunnel'))
            : null,
        )

      let outcomeNode = null
      if (outcome !== null) {
        outcomeNode = outcome.tone === 'ok'
          ? h(Notice, { tone: 'ok', title: t('access.saved') })
          : h(FailureNotice, { failure: outcome.failure === null ? { kind: 'unknown' } : outcome.failure, t })
      }

      return h('section', { className: 'drc-section' },
        h('h3', { className: 'drc-sectionTitle' }, t('point.heading')),
        h('div', {
          className: 'drc-segments',
          role: 'group',
          'aria-label': t('point.heading'),
        },
          segment('lan', 'address.modeLan'),
          segment('public', 'address.modePublic'),
          segment('tunnel', 'address.modeTunnel', tunnelLive),
        ),
        access.mode === 'public'
          ? publicPicker
          : (access.mode === 'tunnel' ? tunnelPicker : lanPicker),
        tunnelLive !== true && access.mode !== 'tunnel'
          ? h('p', { className: 'drc-hint' }, t('address.tunnelOff'))
          : null,
        stale ? h('p', { className: 'drc-hint' }, t('address.staleHint', { address: access.lanAddress })) : null,
        outcomeNode,
      )
    }

    /**
     * The public address book: add, label, delete.
     *
     * The 接入 tab owns the LIST; the pairing tab owns the CHOICE. Splitting them
     * keeps the frequent action (pick an address, scan a code) away from the rare
     * one (edit the book), and it means a delete cannot leave the pairing tab
     * pointing at nothing: the selection moves here exactly the way the store's
     * normalizer moves it.
     *
     * @param {object} props
     * @param {(key: string, params?: object) => string} props.t
     * @param {{ enabled: boolean, port: number } | null} props.settings
     * @param {(patch: object) => Promise<{ ok: boolean, failure: object | null }>} props.updateSettings
     */
    function PublicBookSection({ t, settings, updateSettings }) {
      const [labelDraft, setLabelDraft] = useState('')
      const [addressDraft, setAddressDraft] = useState('')
      const [busy, setBusy] = useState(false)
      const [outcome, setOutcome] = useState(null)

      const known = settings !== null && typeof settings === 'object'
      const access = accessOf(settings)
      const publicRows = access.public
      const activeId = publicRows.some((row) => row.id === access.selectedPublicId)
        ? access.selectedPublicId
        : (publicRows.length > 0 ? publicRows[0].id : '')

      const commit = async (next) => {
        setBusy(true)
        setOutcome(null)
        const result = await updateSettings({ access: next })
        setBusy(false)
        if (result.ok !== true) {
          setOutcome({ tone: 'error', failure: result.failure })
          return false
        }
        setOutcome({ tone: 'ok' })
        return true
      }

      const onDeletePublic = (id) => {
        if (busy || known !== true) return
        const rest = publicRows.filter((row) => row.id !== id)
        void commit({
          mode: access.mode,
          lanAddress: access.lanAddress,
          public: rest,
          selectedPublicId: id === activeId ? (rest.length > 0 ? rest[0].id : null) : activeId,
        })
      }

      const onAdd = async () => {
        if (busy || known !== true) return
        const parsed = parseAddress(addressDraft)
        if (parsed === null) {
          setOutcome({ tone: 'invalid' })
          return
        }
        if (publicRows.length >= PUBLIC_ADDRESS_MAX) {
          setOutcome({ tone: 'tooMany' })
          return
        }
        const id = newPublicId(publicRows)
        const saved = await commit({
          mode: access.mode,
          lanAddress: access.lanAddress,
          public: publicRows.concat([{
            id,
            label: labelDraft.trim().slice(0, PUBLIC_LABEL_MAX),
            address: formatAddress(parsed),
          }]),
          /* A newly added address becomes the selected one: the user just typed it,
             so it is the address they mean right now. */
          selectedPublicId: id,
        })
        if (saved) {
          setLabelDraft('')
          setAddressDraft('')
        }
      }

      let outcomeNode = null
      if (outcome !== null) {
        if (outcome.tone === 'invalid') {
          outcomeNode = h(Notice, { tone: 'error', title: t('address.invalid') })
        } else if (outcome.tone === 'tooMany') {
          outcomeNode = h(Notice, { tone: 'error', title: t('address.tooMany', { max: PUBLIC_ADDRESS_MAX }) })
        } else if (outcome.tone === 'ok') {
          outcomeNode = h(Notice, { tone: 'ok', title: t('access.saved') })
        } else {
          outcomeNode = h(FailureNotice, {
            failure: outcome.failure === null ? { kind: 'unknown' } : outcome.failure,
            t,
          })
        }
      }

      return h('section', { className: 'drc-section' },
        h('h3', { className: 'drc-sectionTitle' }, t('address.heading')),
        publicRows.length === 0
          ? h('p', { className: 'drc-hint' }, t('address.publicEmpty'))
          : h('ul', { className: 'drc-publicList' },
            publicRows.map((row) => h('li', { className: 'drc-publicRow', key: row.id },
              h('div', { className: 'drc-publicMain' },
                h('span', { className: 'drc-publicLabel' }, row.label === '' ? row.address : row.label),
                row.label === '' ? null : h('span', { className: 'drc-publicAddress' }, row.address),
              ),
              row.id === activeId
                ? h('span', { className: 'drc-deviceMeta' }, t('address.inUse'))
                : null,
              h('button', {
                type: 'button',
                className: 'drc-button drc-buttonDanger',
                disabled: busy || known !== true,
                'aria-label': t('address.delete') + ' ' + row.address,
                onClick: () => onDeletePublic(row.id),
              }, t('address.delete')),
            )),
          ),
        h('div', { className: 'drc-addForm' },
          h('input', {
            className: 'drc-input drc-inputWide',
            type: 'text',
            value: labelDraft,
            maxLength: PUBLIC_LABEL_MAX,
            placeholder: t('address.label'),
            'aria-label': t('address.label'),
            disabled: busy || known !== true,
            onChange: (event) => {
              setOutcome(null)
              setLabelDraft(event.target.value)
            },
          }),
          h('input', {
            className: 'drc-input drc-inputWide drc-mono',
            type: 'text',
            value: addressDraft,
            placeholder: t('address.address'),
            'aria-label': t('address.address'),
            disabled: busy || known !== true,
            onChange: (event) => {
              setOutcome(null)
              setAddressDraft(event.target.value)
            },
            /* Enter is how a one-field form is expected to submit, and this row is
               one field away from being a form. */
            onKeyDown: (event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              void onAdd()
            },
          }),
          h('button', {
            type: 'button',
            className: 'drc-button',
            disabled: busy || known !== true,
            onClick: () => { void onAdd() },
          }, t('address.add')),
        ),
        h('p', { className: 'drc-hint' }, t('address.publicHint')),
        outcomeNode,
      )
    }

    /** Locale key for a stable tunnel/admin code, or the generic fallback. */
    function tunnelErrorKey(code) {
      if (typeof code !== 'string') return 'tunnel.error.unknown'
      return Object.prototype.hasOwnProperty.call(TUNNEL_ERROR_KEYS, code)
        ? TUNNEL_ERROR_KEYS[code]
        : 'tunnel.error.unknown'
    }

    /**
     * The managed Cloudflare Tunnel card.
     *
     * Three things share this card because they are one decision: whether the
     * tunnel runs, how it is configured, and what it is currently reachable at.
     * Splitting them across tabs would make 「启用」 depend on a setting the user
     * cannot see.
     *
     * Drafts follow the server value until the user types (`draft === null`), and a
     * successful save resets them to null so the next poll's value wins. Nothing is
     * updated optimistically: the card renders whatever `GET /state` last reported,
     * which is what makes `failed` trustworthy (`quality-guidelines.md` frontend).
     *
     * @param {object} props
     * @param {(key: string, params?: object) => string} props.t
     * @param {object | null} props.settings
     * @param {object | null} props.tunnel `GET /state`'s `tunnel` snapshot.
     * @param {object | null} props.gateway
     * @param {(action: string) => Promise<{ ok: boolean, failure: object | null }>} props.tunnelAction
     * @param {(patch: object) => Promise<{ ok: boolean, failure: object | null }>} props.updateTunnelConfig
     * @param {() => Promise<{ ok: boolean, version: string, failure: object | null }>} props.downloadTunnel
     */
    function TunnelSection({ t, settings, tunnel, gateway, tunnelAction, updateTunnelConfig, downloadTunnel }) {
      const known = settings !== null && typeof settings === 'object'
      const stored = known && settings.tunnel !== null && typeof settings.tunnel === 'object'
        ? settings.tunnel
        : { enabled: false, mode: 'quick', binaryPath: '', publicUrl: '' }
      const status = tunnel !== null && typeof tunnel === 'object' ? tunnel : null
      const state = status !== null && typeof status.state === 'string' && TUNNEL_STATES.includes(status.state)
        ? status.state
        : 'stopped'
      const enabled = status !== null ? status.enabled === true : stored.enabled === true
      /* `starting` is not a restartable state: the controller would queue the
         restart behind an in-flight start that may be waiting 30 s for a URL. */
      const canRestart = state === 'running' || state === 'failed'
      const url = status !== null && typeof status.url === 'string' ? status.url : ''
      const binary = status !== null && status.binary !== null && typeof status.binary === 'object'
        ? status.binary
        : { available: false, source: 'missing', path: null }
      const tokenSet = status !== null && status.tokenSet === true
      const tokenState = status !== null && typeof status.tokenState === 'string'
        ? status.tokenState
        : (tokenSet ? 'ok' : 'none')
      const tokenInvalid = tokenState === 'invalid'
      const errorCode = status !== null && status.error !== null && typeof status.error === 'object'
        && typeof status.error.code === 'string'
        ? status.error.code
        : null
      const gatewayLive = gateway !== null && typeof gateway === 'object' && gateway.listening === true

      const [modeDraft, setModeDraft] = useState(null)
      const [publicUrlDraft, setPublicUrlDraft] = useState(null)
      const [binaryPathDraft, setBinaryPathDraft] = useState(null)
      const [tokenDraft, setTokenDraft] = useState('')
      const [busy, setBusy] = useState(null)
      const [outcome, setOutcome] = useState(null)
      const [copied, setCopied] = useState(false)

      const mode = modeDraft !== null ? modeDraft : (stored.mode === 'token' ? 'token' : 'quick')
      const publicUrlText = publicUrlDraft !== null ? publicUrlDraft : (typeof stored.publicUrl === 'string' ? stored.publicUrl : '')
      const binaryPathText = binaryPathDraft !== null ? binaryPathDraft : (typeof stored.binaryPath === 'string' ? stored.binaryPath : '')

      const patchNow = () => {
        const patch = {
          mode,
          publicUrl: publicUrlText,
          binaryPath: binaryPathText,
        }
        if (tokenDraft.trim() !== '') patch.token = tokenDraft.trim()
        return patch
      }

      const resetDrafts = () => {
        setModeDraft(null)
        setPublicUrlDraft(null)
        setBinaryPathDraft(null)
        setTokenDraft('')
      }

      const save = async () => {
        const result = await updateTunnelConfig(patchNow())
        if (result.ok !== true) {
          setOutcome({ tone: 'error', failure: result.failure })
          return false
        }
        resetDrafts()
        setOutcome({ tone: 'ok' })
        return true
      }

      const onSave = async () => {
        if (busy !== null) return
        setBusy('save')
        setOutcome(null)
        await save()
        setBusy(null)
      }

      const onAction = async (action) => {
        if (busy !== null) return
        setBusy(action)
        setOutcome(null)
        /* start/restart persist the drafts first: "enable" with an unsaved mode or
           token would otherwise start something the user did not configure. */
        if (action !== 'stop') {
          const saved = await save()
          if (!saved) {
            setBusy(null)
            return
          }
        }
        const result = await tunnelAction(action)
        setBusy(null)
        setOutcome(result.ok === true ? { tone: 'ok' } : { tone: 'error', failure: result.failure })
      }

      const onDownload = async () => {
        if (busy !== null) return
        setBusy('download')
        setOutcome(null)
        const result = await downloadTunnel()
        setBusy(null)
        setOutcome(result.ok === true
          ? { tone: 'downloaded', version: result.version }
          : { tone: 'error', failure: result.failure })
      }

      const onClearToken = async () => {
        if (busy !== null) return
        setBusy('token')
        setOutcome(null)
        const result = await updateTunnelConfig({ token: null })
        setBusy(null)
        setOutcome(result.ok === true ? { tone: 'ok' } : { tone: 'error', failure: result.failure })
      }

      const copyUrl = async () => {
        setCopied(false)
        try {
          if (typeof navigator === 'undefined' || navigator.clipboard === undefined
            || typeof navigator.clipboard.writeText !== 'function') {
            throw new Error('clipboard unavailable')
          }
          await navigator.clipboard.writeText(url)
          setCopied(true)
        } catch {
          /* The URL is on screen and selectable; a failed copy is not worth an alert. */
          setCopied(false)
        }
      }

      const binarySourceKey = binary.available === true
        ? (binary.source === 'custom'
          ? 'tunnel.binary.custom'
          : (binary.source === 'downloaded' ? 'tunnel.binary.downloaded' : 'tunnel.binary.path'))
        : 'tunnel.binary.missing'

      let outcomeNode = null
      if (outcome !== null) {
        if (outcome.tone === 'ok') {
          outcomeNode = h(Notice, { tone: 'ok', title: t('tunnel.saved') })
        } else if (outcome.tone === 'downloaded') {
          outcomeNode = h(Notice, { tone: 'ok', title: t('tunnel.downloaded', { version: outcome.version }) })
        } else {
          const code = outcome.failure !== null && typeof outcome.failure === 'object' ? outcome.failure.code : null
          outcomeNode = h(Notice, {
            tone: 'error',
            title: t(tunnelErrorKey(code)),
            body: typeof code === 'string' && code !== '' ? code : undefined,
          })
        }
      }

      const statusNode = h('div', { className: 'drc-tunnelStatus', role: 'status' },
        h('span', { className: state === 'failed' ? 'drc-tunnelState drc-tunnelStateFailed' : 'drc-tunnelState' },
          t('tunnel.state.' + state)),
        status !== null && typeof status.startedAt === 'string'
          ? h('span', { className: 'drc-hint' }, formatRelative(status.startedAt, Date.now(), t))
          : null,
      )

      const urlNode = state === 'running' && url !== ''
        ? h('div', { className: 'drc-field' },
          h('span', { className: 'drc-label' }, t('tunnel.url')),
          h('div', { className: 'drc-inline' },
            h('input', {
              className: 'drc-input drc-mono drc-inputWide',
              type: 'text',
              readOnly: true,
              value: url,
              title: url,
              'aria-label': t('tunnel.url'),
              onFocus: (event) => event.target.select(),
            }),
            h('button', { type: 'button', className: 'drc-button', onClick: () => { void copyUrl() } },
              copied ? t('tunnel.copied') : t('tunnel.copy')),
          ),
        )
        : null

      const errorNode = errorCode === null
        ? null
        : h(Notice, {
          tone: 'error',
          title: t(tunnelErrorKey(errorCode)),
          body: errorCode,
        })

      const binaryNode = h('div', { className: 'drc-tunnelRow' },
        h('span', { className: 'drc-label' }, t('tunnel.binary')),
        h('span', { className: 'drc-hint' }, t(binarySourceKey)),
        binary.available !== true && binaryPathText.trim() !== ''
          ? h('span', { className: 'drc-hint' }, t('tunnel.binaryCustomMissing'))
          : null,
        binary.available !== true
          ? h('button', {
            type: 'button',
            className: 'drc-button',
            disabled: busy !== null,
            onClick: () => { void onDownload() },
          }, busy === 'download' ? t('tunnel.downloading') : t('tunnel.download'))
          : null,
      )

      const modeButtons = h('div', {
        className: 'drc-segments',
        role: 'group',
        'aria-label': t('tunnel.mode'),
      },
        ['quick', 'token'].map((value) => h('button', {
          key: value,
          type: 'button',
          className: mode === value ? 'drc-segment drc-segmentActive' : 'drc-segment',
          'aria-pressed': mode === value,
          disabled: busy !== null,
          onClick: () => {
            setOutcome(null)
            setModeDraft(value)
          },
        }, t('tunnel.mode.' + value))),
      )

      const tokenNode = mode !== 'token'
        ? h('p', { className: 'drc-hint' }, t('tunnel.quickHint'))
        : h('div', { className: 'drc-tunnelFields' },
          h('label', { className: 'drc-field' },
            h('span', { className: 'drc-label' }, t('tunnel.token')),
            h('input', {
              className: 'drc-input drc-inputWide',
              type: 'password',
              value: tokenDraft,
              placeholder: tokenInvalid
                ? t('tunnel.tokenInvalidState')
                : (tokenSet ? t('tunnel.tokenSet') : t('tunnel.tokenUnset')),
              autoComplete: 'off',
              disabled: busy !== null,
              onChange: (event) => {
                setOutcome(null)
                setTokenDraft(event.target.value)
              },
            }),
            h('span', { className: 'drc-hint' }, t('tunnel.tokenHint')),
          ),
          tokenState !== 'none'
            ? h('button', {
              type: 'button',
              className: 'drc-button drc-buttonDanger',
              disabled: busy !== null,
              onClick: () => { void onClearToken() },
            }, t('tunnel.tokenUnset'))
            : null,
          h('label', { className: 'drc-field' },
            h('span', { className: 'drc-label' }, t('tunnel.publicUrl')),
            h('input', {
              className: 'drc-input drc-inputWide drc-mono',
              type: 'text',
              value: publicUrlText,
              placeholder: 'https://dsh.example.com',
              disabled: busy !== null,
              onChange: (event) => {
                setOutcome(null)
                setPublicUrlDraft(event.target.value)
              },
            }),
            h('span', { className: 'drc-hint' }, t('tunnel.publicUrlHint')),
          ),
          h('p', { className: 'drc-hint' }, t('tunnel.namedHint')),
        )

      return h('section', { className: 'drc-section' },
        h('h3', { className: 'drc-sectionTitle' }, t('tunnel.heading')),
        h('p', { className: 'drc-hint' }, t('tunnel.hint')),
        status === null
          ? h(Notice, { tone: 'error', title: t('tunnel.error.unknown') })
          : null,
        gatewayLive ? null : h(Notice, { tone: 'warn', title: t('tunnel.gatewayOff') }),
        status === null ? null : statusNode,
        urlNode,
        errorNode,
        h('div', { className: 'drc-row' },
          h('button', {
            type: 'button',
            className: 'drc-button drc-buttonPrimary',
            disabled: busy !== null || status === null || (enabled !== true && gatewayLive !== true),
            onClick: () => { void onAction(enabled === true ? 'stop' : 'start') },
          }, enabled === true
            ? (busy === 'stop' ? t('tunnel.disable') + '…' : t('tunnel.disable'))
            : t('tunnel.enable')),
          canRestart
            ? h('button', {
              type: 'button',
              className: 'drc-button',
              disabled: busy !== null,
              onClick: () => { void onAction('restart') },
            }, t('tunnel.restart'))
            : null,        ),
        modeButtons,
        tokenNode,
        binaryNode,
        h('div', { className: 'drc-tunnelFields' },
          h('label', { className: 'drc-field' },
            h('span', { className: 'drc-label' }, t('tunnel.binaryPath')),
            h('input', {
              className: 'drc-input drc-inputWide drc-mono',
              type: 'text',
              value: binaryPathText,
              placeholder: 'C:\\Tools\\cloudflared.exe',
              disabled: busy !== null,
              onChange: (event) => {
                setOutcome(null)
                setBinaryPathDraft(event.target.value)
              },
            }),
            h('span', { className: 'drc-hint' }, t('tunnel.binaryPathHint')),
          ),
          h('div', { className: 'drc-row' },
            h('button', {
              type: 'button',
              className: 'drc-button',
              disabled: busy !== null,
              onClick: () => { void onSave() },
            }, busy === 'save' ? t('tunnel.save') + '…' : t('tunnel.save')),
          ),
        ),
        outcomeNode,
      )
    }

    /**
     * The pairing card: QR symbol, text code, countdown, one-time link.
     *
     * The QR is the fast path and the text code is the accessible one, so both are
     * rendered together — the symbol is never the ONLY way in (`prd.md` D2). The
     * code is grouped and selectable, with a copy button beside the link. Both are
     * `readOnly` inputs or plain text: nothing here is a credential the browser
     * should autofill or remember.
     *
     * A link too long for v15-M is not a broken panel: `encodeQr` returns a failure
     * value and this renders `pair.tooLong` in place of the symbol, with the text
     * code and the link untouched (`prd.md` R4).
     *
     * A code the host reports as used (or burned, or gone) is replaced by a
     * one-line STATE and 「生成新码」: the symbol and the code are only removed once
     * they can no longer pair anything, because showing a dead code as if it were
     * live invites a scan that must fail (2026-10-19: 已用的配对码显示已使用).
     *
     * @param {object} props
     * @param {(key: string, params?: object) => string} props.t
     * @param {object} props.pairing The `usePairing` result.
     * @param {object | null} props.gateway
     * @param {string | null} props.addressText The EFFECTIVE access address, or null
     *   when the host reported none — the link then falls back to the page's own
     *   host and says so.
     * @param {'lan' | 'public' | 'tunnel'} props.mode The selected access mode, for the hint.
     */
    function PairingSection({ t, pairing, gateway, addressText, mode }) {
      const [copied, setCopied] = useState(null)
      const [copyFailed, setCopyFailed] = useState(false)
      const current = pairing.current
      const listening = gateway !== null && typeof gateway === 'object' && gateway.listening === true
      /* A tunnel-mode selection with no live URL is NOT the legacy fallback case:
         falling back to the page host there would hand out a link that cannot work
         and silently ignore the mode the user chose. No link at all plus an explicit
         sentence is the honest answer. */
      const tunnelDown = mode === 'tunnel' && (typeof addressText !== 'string' || addressText === '')
      const url = current === null || tunnelDown ? null : pairingUrl(current, addressText, documentBase(), mode)
      const seconds = Math.max(0, Math.ceil(pairing.remainingMs / 1000))
      /* `null` while the code is live, a label once the host reports otherwise. An
         ABSENT state means "nobody has asked yet" (a pair minted in this session
         starts `pending`); an unrecognized one is rendered as `unknown` rather than
         trusted, because every known state past `pending` means the code is dead. */
      const reported = pairing.state
      const state = reported === undefined || reported === null
        ? 'pending'
        : (PAIR_STATES.includes(reported) ? reported : 'unknown')
      const stateLabel = pairingStateLabel(state, t)

      /* Encoded from the SAME `url` the copy button offers, so the symbol and the
         text can never disagree about which link is being paired. Pure and
         non-throwing, so a hostile address costs the symbol and nothing else. */
      const qr = url === null ? null : encodeQr(url)

      /* Two honest hints, never both:
         - the link fell back to the page host and that host is loopback, so no phone
           can open it (the pre-address behaviour, still reachable when the host
           enumerates no NICs and the user configured no public address);
         - a public address was used, so whether the link opens depends on the user's
           own port mapping or TLS proxy. `prd.md` forbids a reachability check, which
           means the panel must state the assumption instead of implying a verdict. */
      const usedFallback = (typeof addressText === 'string' ? parseAddress(addressText) : null) === null
      let urlHint = null
      if (url !== null) {
        if (usedFallback) {
          if (isLoopbackName(urlHostname(url))) urlHint = t('pair.loopbackHint')
        } else if (mode === 'public') {
          urlHint = t('pair.publicHint')
        } else if (mode === 'tunnel') {
          urlHint = t('pair.tunnelHint')
        }
      }

      /* The symbol alone. Its hint belongs in the text column: centred under a
         152 px square it wraps to three narrow lines and pushes the code away
         from the eye that just found the symbol. */
      const qrNode = qr === null
        ? null
        : qr.ok === true
          ? h('svg', {
            className: 'drc-qr',
            viewBox: qrViewBox(qr.size),
            role: 'img',
            'aria-label': t('pair.qrAlt'),
            shapeRendering: 'crispEdges',
            focusable: 'false',
          }, h('path', { d: qrPathData(qr.modules, qr.size), fill: 'currentColor' }))
          : null

      const copy = async (which, value) => {
        setCopyFailed(false)
        try {
          if (typeof navigator === 'undefined' || navigator.clipboard === undefined
            || typeof navigator.clipboard.writeText !== 'function') {
            throw new Error('clipboard unavailable')
          }
          await navigator.clipboard.writeText(value)
          setCopied(which)
        } catch {
          /* A blocked clipboard is common (permissions, non-secure origin) and the
             text is on screen and selectable — saying so is better than a silent
             no-op that looks like a successful copy. */
          setCopied(null)
          setCopyFailed(true)
        }
      }

      return h('section', { className: 'drc-section' },
        h('h3', { className: 'drc-sectionTitle' }, t('pair.heading')),
        h('p', { className: 'drc-hint' }, t('pair.hint')),
        listening ? null : h(Notice, { tone: 'warn', title: t('pair.needGateway') }),
        tunnelDown ? h(Notice, { tone: 'warn', title: t('pair.tunnelDown') }) : null,
        current === null
          ? h('div', { className: 'drc-row' },
            h('button', {
              type: 'button',
              className: 'drc-button drc-buttonPrimary',
              disabled: pairing.busy === true,
              onClick: () => { void pairing.start() },
            }, t('pair.add')),
          )
          : stateLabel !== null
            /* The code is dead: say what happened and offer the only useful action.
               No symbol, no code, no link — every one of them would be an invitation
               to a scan that must fail. */
            ? h('div', { className: 'drc-pairCard' },
              h('div', { className: 'drc-pairMain' },
                h('p', { className: 'drc-pairState', role: 'status' }, stateLabel),
                h('p', { className: 'drc-hint' }, t(state === 'used' ? 'pair.state.usedHint' : 'pair.state.deadHint')),
                h('div', { className: 'drc-row' },
                  h('button', {
                    type: 'button',
                    className: 'drc-button drc-buttonPrimary',
                    disabled: pairing.busy === true,
                    onClick: () => { void pairing.start() },
                  }, t('pair.newCode')),
                  h('button', { type: 'button', className: 'drc-button', onClick: pairing.clear }, t('pair.cancel')),
                ),
              ),
            )
            : h('div', { className: 'drc-pairCard' },
              qrNode === null ? null : h('div', { className: 'drc-pairQr' }, qrNode),
              h('div', { className: 'drc-pairMain' },
                /* One line says how to pair, then the two things you can pair with:
                   the code you can type and the link you can send. */
                h('p', { className: 'drc-hint' }, qr !== null && qr.ok === false ? t('pair.tooLong') : t('pair.qrHint')),
                h('div', { className: 'drc-code drc-mono' },
                  pairingCodeGroups(typeof current.code === 'string' ? current.code : '').map((group, index) => (
                    h('span', { className: 'drc-codeGroup', key: 'g' + String(index) }, group)
                  )),
                ),
                h('div', { className: 'drc-row' },
                  h('span', { className: 'drc-hint' }, t('pair.expires', { seconds })),
                  h('div', { className: 'drc-deviceActions' },
                    /* 必须手动问一次：is this code still waiting, or did the phone
                       already take it? The countdown cannot tell the two apart, and
                       the host is the only authority. */
                    h('button', {
                      type: 'button',
                      className: 'drc-button',
                      disabled: pairing.busy === true,
                      onClick: () => { void pairing.refresh() },
                    }, pairing.busy === true ? t('pair.refreshing') : t('pair.refresh')),
                    h('button', {
                      type: 'button',
                      className: 'drc-button',
                      onClick: () => { void copy('code', String(current.code ?? '')) },
                    }, copied === 'code' ? t('pair.copied') : t('pair.copy')),
                    h('button', { type: 'button', className: 'drc-button', onClick: pairing.clear }, t('pair.cancel')),
                  ),
                ),
              url === null ? null : h('div', { className: 'drc-field' },
                h('span', { className: 'drc-label' }, t('pair.link')),
                h('div', { className: 'drc-inline' },
                  h('input', {
                    className: 'drc-linkInput',
                    type: 'text',
                    readOnly: true,
                    value: url,
                    title: url,
                    'aria-label': t('pair.link'),
                    onFocus: (event) => event.target.select(),
                  }),
                  h('button', {
                    type: 'button',
                    className: 'drc-button',
                    onClick: () => { void copy('link', url) },
                  }, copied === 'link' ? t('pair.copied') : t('pair.copy')),
                ),
              ),
              urlHint === null ? null : h('p', { className: 'drc-hint' }, urlHint),
            ),
          ),
        copyFailed ? h(Notice, { tone: 'error', title: t('pair.copyFailed') }) : null,
        pairing.failure === null ? null : h(FailureNotice, { failure: pairing.failure, t }),
      )
    }

    /**
     * One device row, with its own two-step revoke confirmation.
     *
     * The confirmation is inline rather than `window.confirm`: a blocking native
     * dialog cannot be dismissed by `Esc`-handling code we own, and revoking is
     * irreversible for that device.
     *
     * @param {object} props
     * @param {(key: string, params?: object) => string} props.t
     * @param {object} props.device
     * @param {(deviceId: string) => Promise<{ ok: boolean, failure: object | null }>} props.onRevoke
     */
    function DeviceRow({ t, device, onRevoke }) {
      const [confirming, setConfirming] = useState(false)
      const [busy, setBusy] = useState(false)
      const [failed, setFailed] = useState(false)

      const source = deviceSource(device)
      const seen = formatRelative(device.lastSeenAt, Date.now(), t)
      const live = Number.isInteger(device.liveConnections) && device.liveConnections > 0
        ? t('devices.live', { count: device.liveConnections })
        : null
      /* `store.listDevices()` deliberately includes revoked rows and
         `api.js#listDevices` projects them unchanged, so the panel MUST render
         the difference. A revoked device shown with a live "revoke" button reads
         as still authorized — the same security lie as an optimistic revoke,
         just in the other direction. */
      const revoked = typeof device.revokedAt === 'string' && device.revokedAt !== ''

      const revoke = async () => {
        setBusy(true)
        setFailed(false)
        const result = await onRevoke(String(device.id))
        setBusy(false)
        if (result.ok !== true) {
          setFailed(true)
          return
        }
        /* The parent re-read the list, so this row may already be gone. Clearing
           the confirmation is still correct for the frame before it unmounts. */
        setConfirming(false)
      }

      /* Split the two shapes `deviceSource` can return: the address belongs on the
         shared meta line, the user agent does not — it is the one string long
         enough to wrap a row to three lines and bury the device name above it. */
      const clientUa = source !== null && source.labelKey === 'devices.client' ? source.value : null
      const sourceIp = source !== null && source.labelKey === 'devices.ip' ? source.value : null

      return h('li', { className: revoked ? 'drc-device drc-deviceRevoked' : 'drc-device' },
        h('div', { className: 'drc-deviceMain' },
          h('span', { className: 'drc-deviceName' }, typeof device.name === 'string' && device.name !== ''
            ? device.name
            : String(device.id)),
          h('div', { className: 'drc-deviceMetaRow' },
            h('span', {}, seen === null ? t('devices.never') : t('devices.lastSeen', { when: seen })),
            sourceIp === null ? null : h('span', {}, t('devices.ip', { ip: sourceIp, ua: sourceIp })),
            live === null ? null : h('span', {}, live),
          ),
          clientUa === null ? null : h('span', { className: 'drc-deviceUa', title: clientUa }, clientUa),
          failed ? h('span', { className: 'drc-deviceMeta', role: 'alert' }, t('devices.failed')) : null,
        ),
        /* A revoked row offers no action: it is already refused by the gateway
           (`gateway/auth.js`), so a button here would promise something the
           server would answer with "already revoked". The badge is the only state
           marker — it used to be rendered twice, once in the meta column. */
        revoked
          ? h('div', { className: 'drc-deviceActions' }, h('span', { className: 'drc-deviceMeta' }, t('devices.revoked')))
          : h('div', { className: 'drc-deviceActions' },
            confirming
              ? [
                h('button', {
                  key: 'confirm',
                  type: 'button',
                  className: 'drc-button drc-buttonDanger',
                  disabled: busy,
                  onClick: () => { void revoke() },
                }, t('devices.confirm')),
                h('button', {
                  key: 'cancel',
                  type: 'button',
                  className: 'drc-button',
                  disabled: busy,
                  onClick: () => setConfirming(false),
                }, t('devices.cancel')),
              ]
              : h('button', {
                type: 'button',
                className: 'drc-button drc-buttonDanger',
                disabled: busy,
                onClick: () => setConfirming(true),
              }, t('devices.revoke')),
          ),
      )
    }

    /**
     * The device list.
     *
     * @param {object} props
     */
    function DeviceSection({ t, devices, onRevoke }) {
      return h('section', { className: 'drc-section' },
        h('h3', { className: 'drc-sectionTitle' }, t('devices.heading')),
        devices.length === 0
          ? h('p', { className: 'drc-hint' }, t('devices.empty'))
          : h('ul', { className: 'drc-devices' },
            devices.map((device) => h(DeviceRow, {
              key: String(device.id),
              t,
              device,
              onRevoke,
            })),
          ),
      )
    }

    /**
     * Pull `filename` out of a `content-disposition` header.
     *
     * @param {string | null} header
     * @returns {string | null}
     */
    function attachmentName(header) {
      if (typeof header !== 'string') return null
      const quoted = /filename="([^"]+)"/i.exec(header)
      if (quoted !== null) return quoted[1]
      const bare = /filename=([^;]+)/i.exec(header)
      return bare === null ? null : bare[1].trim()
    }

    /**
     * The audit summary plus the export.
     *
     * The export is the ONLY path that carries the trail itself; the summary is
     * counts and a window. That split is the host's (`audit.summarize`), and the
     * panel keeps it: it never renders a recorded event's detail.
     *
     * @param {object} props
     */
    function AuditSection({ t, audit }) {
      const [phase, setPhase] = useState('idle')
      const [failed, setFailed] = useState(null)

      /**
       * The last export's object URL.
       *
       * Revoked on unmount rather than on a timer: revoking immediately after the
       * click cancels the download in some browsers, and a `setTimeout` here
       * would be a timer outside any effect — the exact leak
       * `hook-guidelines.md` names. Holding one small blob until the panel closes
       * is bounded, and the cleanup below is unconditional.
       */
      const objectUrl = useRef(null)

      useEffect(() => () => {
        const previous = objectUrl.current
        objectUrl.current = null
        if (previous !== null && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
          URL.revokeObjectURL(previous)
        }
      }, [])

      const runExport = async () => {
        setPhase('working')
        setFailed(null)
        try {
          const response = await fetch(adminUrl('audit/export', documentBase()), {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
            /* The same marker every other admin call carries: a GET passes the
               fence without it, but one code path is one place to get it right. */
            headers: { [PANEL_MARKER_HEADER]: PANEL_MARKER_VALUE },
          })
          if (response.ok !== true) {
            throw apiError(classifyFailure(response.status, null, false), response.status, null, 'export refused')
          }
          const blob = await response.blob()
          if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
            throw apiError('unknown', null, null, 'no object URL support')
          }
          const previous = objectUrl.current
          objectUrl.current = URL.createObjectURL(blob)
          if (previous !== null && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(previous)
          const name = attachmentName(response.headers.get('content-disposition')) ?? AUDIT_FILE_FALLBACK
          const anchor = document.createElement('a')
          anchor.href = objectUrl.current
          anchor.download = name
          anchor.rel = 'noopener'
          document.body.appendChild(anchor)
          anchor.click()
          document.body.removeChild(anchor)
          setPhase('done')
        } catch (error) {
          setFailed(describeFailure(error))
          setPhase('idle')
        }
      }

      const summary = audit !== null && typeof audit === 'object' ? audit : null
      const lines = summary !== null && Number.isInteger(summary.lines) ? summary.lines : 0
      const counts = summary !== null && summary.counts !== null && typeof summary.counts === 'object'
        ? summary.counts
        : {}
      const eventNames = Object.keys(counts).filter((name) => Number.isInteger(counts[name]) && counts[name] > 0)

      /* One meta line rather than three stacked ones: retention, file/line
         counts, the covered range and the invalid-line count are context for the
         counts below, not four separate facts worth a paragraph each. */
      const meta = []
      meta.push(summary !== null && summary.retentionDays !== null && summary.retentionDays !== undefined
        ? t('audit.window', { days: summary.retentionDays })
        : t('audit.heading'))
      if (summary !== null) {
        meta.push(t('audit.files', { count: Number.isInteger(summary.files) ? summary.files : 0 })
          + ' · ' + t('audit.lines', { count: lines }))
        if (summary.firstDay !== null && summary.lastDay !== null) {
          meta.push(t('audit.range', { from: summary.firstDay, to: summary.lastDay }))
        }
        if (Number.isInteger(summary.invalidLines) && summary.invalidLines > 0) {
          meta.push(t('audit.invalidLines', { count: summary.invalidLines }))
        }
      }

      return h('section', { className: 'drc-section' },
        h('h3', { className: 'drc-sectionTitle' }, t('audit.heading')),
        summary === null
          ? h('p', { className: 'drc-hint' }, t('audit.empty'))
          : h('div', { className: 'drc-field' },
            h('p', { className: 'drc-hint' }, meta.join(' · ')),
            lines === 0
              ? h('p', { className: 'drc-hint' }, t('audit.empty'))
              : h('ul', { className: 'drc-auditGrid' },
                eventNames.map((name) => h('li', { className: 'drc-auditItem', key: name },
                  h('span', {}, t('audit.event.' + name)),
                  h('span', { className: 'drc-auditValue' }, String(counts[name])),
                )),
              ),
          ),
        h('div', { className: 'drc-row' },
          h('button', {
            type: 'button',
            className: 'drc-button',
            disabled: phase === 'working',
            onClick: () => { void runExport() },
          }, phase === 'working' ? t('audit.exporting') : t('audit.export')),
        ),
        failed === null ? null : h(FailureNotice, { failure: failed, t }),
        phase === 'done' ? h(Notice, { tone: 'ok', title: t('audit.exported') }) : null,
      )
    }

    /**
     * The always-visible status line (`prd.md` R3, `design.md` §1.3).
     *
     * One line, present on every tab: without it the user has to visit 接入 to learn
     * whether anything is listening, which is exactly the scrolling the tabs exist to
     * remove. It is plain text with no state colour — "not enabled" is a fact, not an
     * error, and colouring it red would make the ordinary off state look broken.
     *
     * "Enabled but not listening" reuses the access section's own sentence
     * (`access.gatewayNotListening`) instead of a second wording: two different
     * sentences for one condition is how a user ends up believing they are two
     * different problems.
     *
     * @param {object} props
     * @param {(key: string, params?: object) => string} props.t
     * @param {object | null} props.settings
     * @param {object | null} props.gateway
     * @param {{ active?: number } | null} props.devices The `GET /state` device counts.
     */
    function StatusStrip({ t, settings, gateway, devices }) {
      const enabled = settings !== null && typeof settings === 'object' && settings.enabled === true
      if (!enabled) return h('div', { className: 'drc-statusStrip' }, t('status.disabled'))
      const listening = gateway !== null && typeof gateway === 'object' && gateway.listening === true
      if (!listening) return h('div', { className: 'drc-statusStrip' }, t('access.gatewayNotListening'))
      const port = gateway.port === null || gateway.port === undefined ? '?' : gateway.port
      const live = Number.isInteger(gateway.liveConnections) ? gateway.liveConnections : 0
      const active = devices !== null && typeof devices === 'object' && Number.isInteger(devices.active)
        ? devices.active
        : 0
      return h('div', { className: 'drc-statusStrip' }, t('status.listening', { port, live, devices: active }))
    }

    /**
     * The tab bar, with the full WAI-ARIA tabs contract (`design.md` §1.2).
     *
     * `role="tablist"` + one `role="tab"` per entry, `aria-selected` on exactly one,
     * `aria-controls` pointing at the panel id derived from the same key, and a
     * roving `tabIndex` so the whole bar is ONE stop in the page's Tab order. The
     * arrows wrap and `Home`/`End` jump — via {@link tabIndexAfterKey}, which is
     * where the arithmetic is tested.
     *
     * Focus follows selection because the tabs are `button`s that the panel's focus
     * trap already knows about: nothing here can become a way OUT of the modal.
     *
     * @param {object} props
     * @param {(key: string, params?: object) => string} props.t
     * @param {string} props.current Key of the selected tab.
     * @param {(key: string) => void} props.onSelect
     */
    function TabList({ t, current, onSelect }) {
      const refs = useRef([])

      /** Select one tab index and move focus to it. */
      const select = (index) => {
        const key = TAB_KEYS[index]
        if (key === undefined) return
        onSelect(key)
        /* The node exists already, so focusing it does not wait for the re-render;
           the container is read defensively because it is empty before the first
           ref commit (and a non-React harness may hand back anything). */
        const list = Array.isArray(refs.current) ? refs.current : []
        const node = list[index]
        if (node !== null && node !== undefined && typeof node.focus === 'function') node.focus()
      }

      const onKeyDown = (index) => (event) => {
        const next = tabIndexAfterKey(event.key, index, TABS.length)
        if (next === null) return
        event.preventDefault()
        select(next)
      }

      return h('div', { className: 'drc-tabs', role: 'tablist', 'aria-label': t('panel.title') },
        TABS.map((tab, index) => h('button', {
          key: tab.key,
          ref: (node) => {
            if (!Array.isArray(refs.current)) refs.current = []
            refs.current[index] = node
          },
          type: 'button',
          role: 'tab',
          /* The id is DERIVED from the key, here and in the panel — one value, so a
             tab cannot point at a panel that does not exist. */
          id: 'drc-tab-' + tab.key,
          className: tab.key === current ? 'drc-tab drc-tabActive' : 'drc-tab',
          'aria-selected': tab.key === current,
          'aria-controls': 'drc-panel-' + tab.key,
          tabIndex: tab.key === current ? 0 : -1,
          onClick: () => { select(index) },
          onKeyDown: onKeyDown(index),
        }, t(tab.labelKey))))
    }

    /**
     * One audit detail row: time, action, device, address (`prd.md` R5).
     *
     * The four cells are built from the four projected fields and nothing else, which
     * is the DOM half of `prd.md` D5: a record's `meta` has no slot to be rendered
     * into, even if a future host leaked it into the JSON. The full instant lives on
     * the time cell's `title` so the exact UTC value stays reachable.
     *
     * @param {object} props
     * @param {(key: string, params?: object) => string} props.t
     * @param {{ ts: string, event: string, deviceId?: string, ip?: string }} props.event
     * @param {object[]} [props.devices]
     * @param {number} [props.now] Injectable clock; defaults to `Date.now()`. The
     *   panel passes nothing — it exists so a test can decide what 「今天」 means,
     *   the same way every host module takes its clock as a parameter.
     */
    function AuditEventRow({ t, event, devices, now }) {
      const time = formatAuditTime(event.ts, Number.isFinite(now) ? now : Date.now())
      const ip = typeof event.ip === 'string' && event.ip !== '' ? event.ip : '—'
      return h('li', { className: 'drc-auditEvent' },
        h('span', { className: 'drc-auditEventTime', title: time.iso }, time.label),
        h('span', { className: 'drc-auditEventAction' }, t('audit.event.' + event.event)),
        h('span', { className: 'drc-auditEventDevice', title: typeof event.deviceId === 'string' ? event.deviceId : undefined }, deviceNameOf(event.deviceId, devices)),
        h('span', { className: 'drc-auditEventIp' }, ip),
      )
    }

    /**
     * The recent-events list.
     *
     * Split from the fetching component so the rendered fields can be asserted
     * without a DOM or a network: this is a pure function of `events`.
     *
     * @param {object} props
     * @param {(key: string, params?: object) => string} props.t
     * @param {object[]} props.events
     * @param {object[]} [props.devices]
     */
    function AuditEventList({ t, events, devices }) {
      return h('ul', { className: 'drc-auditEvents' },
        events.map((event, index) => h(AuditEventRow, {
          key: 'e' + String(index),
          t,
          event,
          devices,
        })),
      )
    }

    /**
     * The audit tab's detail block: filter, list, and 「加载更多」 (`prd.md` R5–R7).
     *
     * Three deliberate choices:
     *
     *   - **No `limit` on the wire.** The host's page size is the page size; a
     *     literal here would be a second definition of the same number.
     *   - **The filter resets paging.** Changing it re-requests page 1 and REPLACES
     *     the list ({@link appendAuditPage}), because appending a filtered page below
     *     unfiltered rows would show records the filter excludes.
     *   - **The action list comes from the host** (`state.audit.actions`, via
     *     {@link auditActionsOf}); this component never names an action.
     *
     * Failure is rendered through `FailureNotice`, so 403 / network / server each say
     * something different (`quality-guidelines.md` required pattern 4), and the retry
     * is explicit — a request re-issued on a timer would be the automatic retry the
     * spec forbids.
     *
     * @param {object} props
     * @param {(key: string, params?: object) => string} props.t
     * @param {string[]} props.actions The host's known actions (`GET /state`).
     * @param {object[]} [props.devices] For the device-name column.
     */
    function AuditEventsSection({ t, actions, devices }) {
      const [action, setAction] = useState('')
      const [events, setEvents] = useState([])
      const [nextBefore, setNextBefore] = useState(null)
      const [phase, setPhase] = useState('loading')
      const [failure, setFailure] = useState(null)

      /** Aborting on unmount is what makes "the tab closed" mean "no request in flight". */
      const inFlight = useRef(null)
      const disposed = useRef(false)
      /** Monotonic token: a superseded page must not overwrite a newer result. */
      const token = useRef(0)

      const fetchPage = useCallback(async (before) => {
        const previous = inFlight.current
        if (previous !== null) previous.abort('superseded')
        const mine = token.current + 1
        token.current = mine

        let controller = null
        if (typeof AbortController === 'function') {
          controller = new AbortController()
          inFlight.current = controller
        }
        const signal = controller === null ? undefined : controller.signal
        const appending = typeof before === 'string' && before !== ''
        setPhase(appending ? 'appending' : 'loading')
        try {
          const data = await requestJson(auditEventsQuery(action, before), { signal })
          if (disposed.current || token.current !== mine) return
          const page = data !== null && typeof data === 'object' && Array.isArray(data.events) ? data.events : []
          setEvents((current) => appendAuditPage(current, page, before))
          setNextBefore(
            data !== null && typeof data === 'object'
              && typeof data.nextBefore === 'string' && data.nextBefore !== ''
              ? data.nextBefore
              : null,
          )
          setFailure(null)
          setPhase('ready')
        } catch (error) {
          if (disposed.current || token.current !== mine) return
          /* The rows already on screen are KEPT: an empty list on a transient error
             would read as "no audit records", which is the reassuring-and-wrong
             state the spec forbids. */
          setFailure(describeFailure(error))
          setPhase('error')
        } finally {
          if (inFlight.current === controller) inFlight.current = null
        }
      }, [action])

      useEffect(() => {
        disposed.current = false
        void fetchPage(null)
        return () => {
          disposed.current = true
          const controller = inFlight.current
          inFlight.current = null
          if (controller !== null) controller.abort('unmount')
        }
      }, [fetchPage])

      /** Switching the filter restarts paging; see the note above. */
      const changeAction = (value) => {
        const next = typeof value === 'string' ? value : ''
        if (next === action) return
        setAction(next)
        setEvents([])
        setNextBefore(null)
        setFailure(null)
        setPhase('loading')
      }

      const options = Array.isArray(actions) ? actions : []

      const filterRow = h('div', { className: 'drc-row' },
        h('label', { className: 'drc-field' },
          h('span', { className: 'drc-label' }, t('audit.detail.filter')),
          h('select', {
            className: 'drc-select drc-selectInline',
            value: action,
            'aria-label': t('audit.detail.filter'),
            onChange: (event) => { changeAction(event.target.value) },
          },
            h('option', { value: '' }, t('audit.detail.all')),
            options.map((name) => h('option', { key: name, value: name }, t('audit.event.' + name))),
          ),
        ),
        phase === 'loading' && events.length === 0
          ? null
          : h('span', { className: 'drc-hint' }, t('audit.detail.shown', { count: events.length })),
      )

      let list = null
      if (events.length > 0) {
        list = h(AuditEventList, { t, events, devices })
      } else if (failure === null) {
        list = h('p', { className: 'drc-hint' },
          phase === 'loading' ? t('audit.detail.loading') : t('audit.empty'))
      }

      /* 「没有更多了」 replaces the button rather than disabling it: a disabled button
         that never re-enables reads as a failure, and `nextBefore === null` is a
         successful end. */
      let footer = null
      if (events.length > 0) {
        footer = nextBefore === null
          ? h('p', { className: 'drc-hint' }, t('audit.detail.noMore'))
          : h('div', { className: 'drc-row' },
            h('button', {
              type: 'button',
              className: 'drc-button',
              disabled: phase === 'appending',
              onClick: () => { void fetchPage(nextBefore) },
            }, phase === 'appending' ? t('audit.detail.loadingMore') : t('audit.detail.loadMore')),
          )
      }

      return h('section', { className: 'drc-section' },
        h('h3', { className: 'drc-sectionTitle' }, t('audit.detail.heading')),
        filterRow,
        list,
        footer,
        failure === null ? null : h(FailureNotice, {
          failure,
          t,
          onRetry: () => { void fetchPage(null) },
        }),
      )
    }

    /**
     * The panel itself: a centred modal card inside a scrim.
     *
     * Mounted only while open, which is what bounds every subscription in the
     * hooks above to the panel's visible lifetime.
     *
     * The wrapper is an OVERLAY and not a popover anchored to the seat, because
     * the anchored version was clipped by the sidebar's `overflow` and could not be
     * fixed with z-index (`prd.md` background 1). The card is scrolled internally
     * (`max-height` + `.drc-body{overflow-y:auto}`), so a 1731 px-tall phone viewport
     * and a 700 px desktop viewport both show the whole panel.
     *
     * Accessibility (`design.md` §3.1): `role="dialog"`, `aria-modal="true"`,
     * `aria-labelledby` on the visible title, `Esc` and the close button as the only
     * two ways out, initial focus on the card, focus returned to the trigger on close,
     * and a Tab cycle that stays inside the card — `aria-modal` claims the outside is
     * inert, so the trap is what makes that claim true (`SidebarAction`).
     *
     * @param {object} props
     * @param {(key: string, params?: object) => string} props.t
     * @param {() => void} props.onClose
     * @param {{ current: HTMLElement | null }} props.panelRef
     */
    function Panel({ t, onClose, panelRef }) {
      const status = useGatewayStatus()
      const pairing = usePairing()
      /* `null` means "the user has not chosen yet", so the first screen follows the
         state the host reports (`prd.md` R2) and a later open starts over: the panel
         unmounts on close, so there is no cross-mount state to remember (PRD
         constraint 4 — no localStorage, no module-level cache). */
      const [tab, setTab] = useState(null)

      const snapshot = status.snapshot
      const state = snapshot.state !== null && typeof snapshot.state === 'object' ? snapshot.state : null
      const settings = state !== null && state.settings !== null && typeof state.settings === 'object'
        ? state.settings
        : null
      const gateway = state !== null && state.gateway !== null && typeof state.gateway === 'object'
        ? state.gateway
        : null
      const addresses = state !== null && state.addresses !== null && typeof state.addresses === 'object'
        ? state.addresses
        : null
      const tunnel = state !== null && state.tunnel !== null && typeof state.tunnel === 'object'
        ? state.tunnel
        : null
      /* Resolved ONCE, here, and handed down: both the address card and the pairing
         link must use the same answer, and two calls could disagree across a poll
         that lands between them. */
      const access = accessOf(settings)
      const lan = addresses !== null && Array.isArray(addresses.lan) ? addresses.lan : []
      const effective = effectiveAddress(access, lan, tunnel !== null && typeof tunnel.url === 'string' ? tunnel.url : '')

      const activeTab = tab === null || !TAB_KEYS.includes(tab) ? preferredTab(settings, gateway) : tab
      const auditActions = auditActionsOf(state)
      const deviceCounts = state !== null && state.devices !== null && typeof state.devices === 'object'
        ? state.devices
        : null

      /* Which panels have been shown at least once. A panel that has been visited is
         kept MOUNTED and merely `hidden`, because the sections hold live state:
         `ConfigBar` a half-typed port, `PublicBookSection` an unsaved
         address row, `DeviceRow` a revoke confirmation, `AuditEventsSection` a page cursor.
         Rendering only the active tab unmounted all of it on every switch — a request
         in flight would land on a component that no longer existed, and coming back
         showed a pristine form with no sign of what had just happened (`prd.md`
         constraint 4). Keeping them mounted costs one subtree per visited tab; none of
         these sections polls on a timer, so a hidden panel does no work. `hidden` is
         what removes them from the accessibility tree and the tab order. */
      const [visited, setVisited] = useState(null)
      useEffect(() => {
        /* Nothing is recorded until the first real snapshot arrives: the first render
           sees an empty state, so `preferredTab` answers 接入, and marking that as
           visited would mount the access panel behind everyone's back on every open. */
        if (state === null) return
        setVisited((previous) => (previous !== null && previous[activeTab] === true
          ? previous
          : { ...(previous ?? {}), [activeTab]: true }))
      }, [activeTab, state])


      /* Notices belong to the PANEL, not to a tab: a failed state read is why the
         tabs have nothing to show, so hiding the explanation behind the tab the user
         happened to be on would be the wrong half of the story. */
      const notices = []
      if (snapshot.error !== null) {
        notices.push(h(FailureNotice, {
          key: 'failure',
          failure: snapshot.error,
          t,
          /* Retry is offered, and it is the only recovery path: `hook-guidelines.md`
             forbids automatic retries. */
          onRetry: () => { void status.refresh() },
        }))
      }
      if (snapshot.phase === 'loading' && state === null) {
        notices.push(h('p', { className: 'drc-hint', key: 'loading' }, t('panel.loading')))
      }

      /**
       * The sections belonging to one tab.
       *
       * The four existing sections are MOVED, not rewritten: their behaviour,
       * validation and strings are unchanged by this task (`implement.md` step 2).
       *
       * @param {string} key
       * @returns {any}
       */
      const sectionsOf = (key) => {
        if (state === null) {
          /* Nothing has arrived yet, so every tab shows the same "reading" line rather
             than a form built from `null`. */
          return h('p', { className: 'drc-hint' }, t('panel.loading'))
        }
        switch (key) {
          case 'pairing':
            /* The access point belongs to pairing: it is what the link and the symbol
               are built from, so choosing it is the first step of pairing a device. */
            return [
              h(AccessPointSection, {
                key: 'point',
                t,
                settings,
                addresses,
                tunnel,
                updateSettings: status.updateSettings,
                /* The empty public book is a dead end on this tab; the shortcut hands
                   the user to the tab that can fix it instead of leaving them there. */
                onManagePublic: () => setTab('access'),
                onManageTunnel: () => setTab('access'),
              }),
              h(PairingSection, {
                key: 'pairing',
                t,
                pairing,
                gateway,
                addressText: effective,
                mode: access.mode,
              }),
            ]
          case 'access':
            /* 接入 owns the public address BOOK and the managed tunnel. The master
               switch and the port live in the configuration row above the tabs, and
               the LAN/public/tunnel CHOICE lives in 配对. */
            return [
              h(TunnelSection, {
                key: 'tunnel',
                t,
                settings,
                tunnel,
                gateway,
                tunnelAction: status.tunnelAction,
                updateTunnelConfig: status.updateTunnelConfig,
                downloadTunnel: status.downloadTunnel,
              }),
              h(PublicBookSection, {
                key: 'book',
                t,
                settings,
                updateSettings: status.updateSettings,
              }),
            ]
          case 'devices':
            return h(DeviceSection, {
              key: 'devices',
              t,
              devices: snapshot.devices,
              onRevoke: status.revokeDevice,
            })
          case 'audit':
            return [
              h(AuditSection, { key: 'audit', t, audit: snapshot.audit }),
              h(AuditEventsSection, {
                key: 'audit-events',
                t,
                actions: auditActions,
                devices: snapshot.devices,
              }),
            ]
          default:
            return null
        }
      }

      return h('div', { className: 'drc-overlay' },
        h('section', {
          className: 'drc-panel',
          role: 'dialog',
          /* `aria-modal` tells a screen reader the rest of the page is inert. The
             label is the SAME visible title the user reads (`aria-labelledby`, not a
             duplicate `aria-label`), so the two can never drift apart. */
          'aria-modal': 'true',
          'aria-labelledby': TITLE_ID,
          /* Focusable as a container so opening the panel can move focus into it
             without stealing it to the first button — a reader landing on "close"
             first would hear the panel backwards. */
          tabIndex: -1,
          ref: panelRef,
        },
          h('header', { className: 'drc-panelHeader' },
            h('div', { className: 'drc-panelTitles' },
              h('h2', { className: 'drc-panelTitle', id: TITLE_ID }, t('panel.title')),
              h('p', { className: 'drc-panelSubtitle' }, t('panel.subtitle')),
            ),
            h('button', {
              type: 'button',
              className: 'drc-close',
              'aria-label': t('panel.close'),
              title: t('panel.close'),
              onClick: onClose,
            }, '×'),
          ),
          /* Header → configuration → status → tabs → panels. The configuration row
             holds the two panel-wide settings (master switch, listener port); the
             status line is a FACT that must stay visible on every tab; the tab bar
             sits between it and the content it selects. */
          h(ConfigBar, { t, settings, updateSettings: status.updateSettings }),
          h(StatusStrip, { t, settings, gateway, devices: deviceCounts }),
          h(TabList, { t, current: activeTab, onSelect: (key) => setTab(key) }),
          h('div', { className: 'drc-body' },
            notices,
            /* One panel element per tab so every tab's `aria-controls` resolves. A panel
               that has been visited keeps its subtree (see `visited`) and is hidden
               instead of unmounted, so switching tabs no longer throws away a draft, a
               pending request or a revoke confirmation. */
            TAB_KEYS.map((key) => {
              const mounted = key === activeTab || (visited !== null && visited[key] === true)
              return h('div', {
                key,
                className: 'drc-panelBody',
                role: 'tabpanel',
                id: 'drc-panel-' + key,
                'aria-labelledby': 'drc-tab-' + key,
                hidden: key !== activeTab,
              }, mounted ? sectionsOf(key) : null)
            }),
          ),
        ),
      )
    }

    /**
     * The sidebar-foot seat.
     *
     * Receives only the sidebar's column state (`{ wide }`) plus the
     * framework-bound translator; it is the only entry point of this plugin, so
     * everything else here is reached through it.
     *
     * The panel is PORTALLED to `document.body` (`{@link portal}`), so this
     * component owns the trigger, the open flag and the focus hand-off, and nothing
     * about the panel's layout.
     *
     * The panel closes on exactly two inputs: the close button and `Esc`. The old
     * outside-`pointerdown` dismissal is GONE on purpose (`prd.md` D1): a modal that
     * vanishes when the mouse wanders is how a user loses a pairing code they were
     * in the middle of reading. Clicking the scrim does nothing, and it carries no
     * handler at all rather than a handler that returns early — an absent listener
     * cannot be defeated by event ordering.
     *
     * @param {object} props
     * @param {boolean} [props.wide] Sidebar expanded (false = 56px icon rail).
     * @param {(key: string, params?: object) => string} [props.t] Bound to {@link NS}.
     */
    function SidebarAction({ wide = false, t = fallbackTranslate }) {
      const [open, setOpen] = useState(false)
      const panelRef = useRef(null)
      const triggerRef = useRef(null)

      useEffect(() => {
        if (open !== true) return undefined

        const onKeyDown = (event) => {
          /* `component-guidelines.md`: `Esc` closes the panel. */
          if (event.key === 'Escape') {
            setOpen(false)
            return
          }
          /* The dialog is `aria-modal="true"`, which tells assistive technology that
             everything outside it is inert. Without this trap that is a claim the
             DOM does not honour: Tab walked out into the sidebar while the screen
             reader still announced a modal (`ui-ux-pro-max` — focus must stay
             reachable and visible inside the dialog). Only the two edges are
             intercepted, so the browser keeps normal Tab order in between. */
          if (event.key !== 'Tab') return
          const root = panelRef.current
          if (root === null) return
          const focusable = [...root.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')]
            /* `tabIndex !== -1` is not redundant now that the panel contains a
               tablist: the four tab buttons are `button`s, and the three that are
               not selected carry a ROVING `tabIndex:-1` on purpose. A `button`
               query matches them anyway, so without this they would be counted as
               stops the browser never stops at — and if a roving tab ever landed at
               the cycle's edge, the trap would focus it and Tab would appear to do
               nothing. */
            .filter((node) => node.disabled !== true
              && node.getAttribute('aria-hidden') !== 'true'
              && node.tabIndex !== -1)
          if (focusable.length === 0) return
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          const active = document.activeElement
          if (event.shiftKey === true) {
            if (active === first || !root.contains(active)) {
              event.preventDefault()
              last.focus()
            }
            return
          }
          if (active === last || !root.contains(active)) {
            event.preventDefault()
            first.focus()
          }
        }
        window.addEventListener('keydown', onKeyDown)

        /* Focus moves INTO the panel on open — without it a keyboard user is left
           behind in the sidebar with no sign that anything appeared. */
        const node = panelRef.current
        if (node !== null && typeof node.focus === 'function') node.focus()

        return () => {
          window.removeEventListener('keydown', onKeyDown)
          /* …and back to the trigger on close, so the tab order resumes where the
             user left it instead of at the top of the document. A detached trigger
             (the plugin unloaded) makes this a no-op, which is why it is guarded. */
          const trigger = triggerRef.current
          if (trigger !== null && typeof trigger.focus === 'function') trigger.focus()
        }
      }, [open])

      return h('div', { className: 'drc-root' },
        /* Rendered through the portal (or in place, when the host cannot portal):
           `null` while closed, so the panel's own hooks unmount with it. */
        portal(open ? h(Panel, { t, onClose: () => setOpen(false), panelRef }) : null),
        h('button', {
          type: 'button',
          ref: triggerRef,
          className: wide ? 'drc-trigger' : 'drc-trigger drc-triggerRail',
          'aria-label': t('panel.entry'),
          title: t('panel.entry'),
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          onClick: () => setOpen((value) => !value),
        },
          h('svg', {
            className: 'drc-triggerIcon',
            width: 16,
            height: 16,
            viewBox: '0 0 16 16',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.4,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
            focusable: 'false',
          },
            h('rect', { x: 1.5, y: 3.5, width: 9, height: 6.5, rx: 1.5 }),
            h('path', { d: 'M4.5 12.75h3' }),
            h('path', { d: 'M6 10v2.75' }),
            h('path', { d: 'M12.25 5a4 4 0 0 1 0 5' }),
          ),
          wide
            ? h('span', { className: 'drc-triggerLabel' }, t('panel.entry'))
            : null,
        ),
      )
    }

    /* ------------------------------------------------------------------ *
     * Plugin body
     * ------------------------------------------------------------------ */

    /**
     * Print one line on the only sink the browser half has.
     *
     * There is no host logger on the client side, and a plugin that stays silent
     * about a missing capability sends the user hunting a fault that has a name.
     *
     * @param {'warn' | 'error'} level
     * @param {string} message
     * @param {unknown} [detail]
     */
    function report(level, message, detail) {
      if (typeof console === 'undefined' || console === null) return
      const sink = console[level]
      if (typeof sink !== 'function') return
      if (detail === undefined) sink.call(console, message)
      else sink.call(console, message, detail)
    }

    /**
     * Read one optional client service.
     *
     * `ctx.get` is the documented probe and returns `undefined` for a service the
     * composition does not provide; the direct property is the fallback for a
     * host whose context exposes services plainly. Never throws.
     *
     * Both reads need a guard, and not only for tidiness: a Cordis client
     * context is a Proxy that THROWS when a plugin reads a service it did not
     * declare — `Error: cannot get property "locale" without inject`. Swallowing
     * only the `get` half left the property read to escape `apply`, which failed
     * the plugin fiber and with it the whole web boot (2026-10-19).
     *
     * @param {object} ctx
     * @param {string} name
     * @returns {any | null}
     */
    function serviceOf(ctx, name) {
      if (ctx === null || typeof ctx !== 'object') return null
      let value
      try {
        value = typeof ctx.get === 'function' ? ctx.get(name) : undefined
      } catch {
        value = undefined
      }
      if (value !== undefined && value !== null) return value
      let direct
      try {
        direct = ctx[name]
      } catch {
        direct = undefined
      }
      return direct === undefined || direct === null ? null : direct
    }

    /**
     * Run `visit` with `names` declared as dependencies, and only then.
     *
     * A real Cordis context grants access to a service only after the plugin
     * declared it: `ctx.get('slots')` and `ctx.slots` both throw an
     * undeclared-service error until `inject` covers them. Declaring them on the
     * plugin object instead (`inject: ['slots']`) makes absence fatal the other
     * way round — the row stays PENDING forever, and the web boot refuses to draw
     * the GUI over any entry that did not activate. Asking per-use keeps the row
     * activatable on every composition: the callback simply never runs when the
     * service never appears, and the plugin degrades instead of failing.
     *
     * A context without `inject` (the file-level test harness, an embedder that
     * exposes services plainly) is treated as declaring everything.
     *
     * @param {object} ctx
     * @param {string[]} names
     * @param {(ctx: object) => void} visit
     */
    function withServices(ctx, names, visit) {
      if (ctx === null || typeof ctx !== 'object') return
      if (typeof ctx.inject !== 'function') {
        visit(ctx)
        return
      }
      ctx.inject(names, (scoped) => visit(scoped === undefined ? ctx : scoped))
    }

    /**
     * Run `acquire` under the context's effect scope, so its disposer is owned.
     *
     * A context without `effect` (a test harness, an embedder) still gets the
     * work done; nothing can clean it up there, which is why the caller supplies
     * one in practice.
     *
     * @param {object} ctx
     * @param {() => (() => void) | undefined} acquire
     * @param {string} label
     */
    function effect(ctx, acquire, label) {
      if (ctx !== null && typeof ctx === 'object' && typeof ctx.effect === 'function') {
        ctx.effect(() => {
          const release = acquire()
          return typeof release === 'function' ? release : () => {}
        }, label)
        return
      }
      acquire()
    }

    /**
     * Mount the client half: dictionaries, styles, and the one seat.
     *
     * Every registration is inside `ctx.effect`, which is what makes a hot
     * reload or a disabled plugin leave no stray icon behind
     * (`quality-guidelines.md` required pattern 2). Both services are optional
     * here: a host without a translator renders English, and a host without the
     * slot service renders no panel, because either one missing must not turn
     * into an unmountable plugin.
     *
     * @param {object} ctx Client root context.
     */
    function mount(ctx) {
      withServices(ctx, ['locale'], (localeCtx) => {
        const locale = serviceOf(localeCtx, 'locale')
        if (locale !== null && typeof locale.register === 'function') {
          effect(localeCtx, () => locale.register(NS, { zh: ZH, en: EN }), 'remote-control: dictionaries')
        }
      })

      effect(ctx, installStyles, 'remote-control: styles')

      withServices(ctx, ['slots'], (slotCtx) => {
        const slots = serviceOf(slotCtx, 'slots')
        if (slots === null || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
          /* Visible degradation, never silence (`quality-guidelines.md` §5 in the
             backend spec): a host without the slot service cannot show this panel,
             and a user staring at a missing entry deserves one line explaining it.
             There is no host logger on the browser side, so the console is the only
             sink the browser has. */
          report('warn', '[remote-control] the UI slot service is unavailable; the device panel is not mounted')
          return
        }

        effect(
          slotCtx,
          () => slots.inject(SEAT, () => slots.register({
            name: SEAT,
            id: SEAT_ID,
            locale: NS,
          }, SidebarAction)),
          'remote-control: sidebar footer action',
        )
      })
    }

    /**
     * Activate the plugin, and never throw while doing it.
     *
     * The web boot aborts the WHOLE GUI when any client entry does not activate:
     * the shell replaces the application with "Failed to load plugins — web
     * boot: N entries did not activate" and there is no per-plugin opt-out. So a
     * panel that cannot mount must cost its own seat, not the user's session —
     * `quality-guidelines.md` red line 1, "加载期不能崩". The failure is still
     * reported, loudly, on the only sink the browser half has.
     *
     * @param {object} ctx Client root context.
     */
    function apply(ctx) {
      try {
        mount(ctx)
      } catch (error) {
        report('error', '[remote-control] the device panel could not mount; the rest of the GUI is unaffected:', error)
      }
    }

    return {
      name: 'dsh-remote-control',
      /* Nothing is declared globally on purpose. A missing optional service must
         not park this row as PENDING: the web boot treats ANY entry that did not
         activate as fatal and refuses to draw the GUI ("Failed to load plugins —
         web boot: 1 entry did not activate"), which is exactly what a user saw in
         2026-10-19. Each facility is requested per-use through `withServices`, so
         the row activates on every composition and degrades visibly instead. */
      inject: [],
      apply,
      /**
       * Private surface for `tests/client.test.mjs`.
       *
       * The browser half has no DOM test environment, so the pieces that must not
       * ship unverified — the mount-relative URL builder, the fragment-holding
       * pairing link, the address parser/resolver (which must agree with the host
       * copy in `src/host/addresses.js`), the four-way failure classification and
       * the dictionaries themselves — are exposed here and exercised directly.
       * Nothing at runtime reads this.
       */
      internals: {
        NS,
        SEAT,
        SEAT_ID,
        API_BASE,
        PANEL_MARKER_HEADER,
        PANEL_MARKER_VALUE,
        TITLE_ID,
        FAILURE_KINDS,
        TABS,
        TAB_KEYS,
        AUDIT_EVENTS_PATH,
        ZH,
        EN,
        adminUrl,
        classifyFailure,
        accessOf,
        defaultAccess,
        parseAddress,
        formatAddress,
        effectiveAddress,
        newPublicId,
        pairingUrl,
        legacyPairingUrl,
        urlHostname,
        pairingCodeGroups,
        pairingStateLabel,
        PAIR_STATES,
        PAIRING_STATUS_PATH,
        parsePort,
        formatRelative,
        deviceSource,
        isLoopbackName,
        interpolate,
        fallbackTranslate,
        attachmentName,
        preferredTab,
        tabIndexAfterKey,
        auditActionsOf,
        normalizeAuditEvent,
        appendAuditPage,
        auditEventsQuery,
        formatAuditTime,
        deviceNameOf,
        encodeQr,
        qrPathData,
        qrViewBox,
        /**
         * The presentational pieces whose OUTPUT is the contract: the tab bar (the
         * ARIA wiring and roving tabindex), the status strip (three states of one
         * line), the audit rows (four fields, never `meta`), and the pairing card.
         * A test calls them as plain functions and inspects the returned element
         * tree — the browser half has no DOM, so structure and data flow are what can
         * be proven, never pixels.
         */
        PairingSection,
        TabList,
        StatusStrip,
        AuditEventRow,
        AuditEventList,
        AuditEventsSection,
        /** The whole shell, so a test can prove the tab graph exists in one tree. */
        Panel,
        /** Whether the portal path is available in this module table (source-level tests). */
        hasPortal: () => createPortal !== null,
      },
    }
  },
})
