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
 * ## Every side effect is owned by an effect
 *
 * The poll timer, the pairing countdown, the `keydown` listener and the
 * object URL of an audit export all live in effects whose cleanup releases
 * them. Nothing is module-scoped: a hot reload or a disabled plugin must leave
 * no stray icon, no running poll and no listener behind
 * (`state-management.md` — no cross-mount state, no module-level cache).
 *
 * ## No QR code in this build
 *
 * `prd.md` D2 asked for QR-primary pairing. A QR encoder is 300+ lines of
 * Reed-Solomon + mask selection, and this package ships ZERO runtime
 * dependencies (locked by `tests/package.test.mjs`). An encoder whose only
 * verification is against itself is worse than none — a code that cannot be
 * scanned is indistinguishable from a network fault. So the primary path is the
 * plaintext code plus a copyable one-time link, and the QR is deferred.
 *
 * `internals` below is the private, documented surface the file-level tests
 * exercise (`tests/client.test.mjs`): it exists because the browser half has no
 * DOM test environment, and the transport classification / URL construction are
 * exactly the parts that must not ship unverified.
 */

window.__ModuleLoader__.load({
  id: '@misaka10091/dsh-remote-control',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    /* Destructured once, at materialization, so every hook below is the same
       function identity for the lifetime of the module. */
    const { useCallback, useEffect, useRef, useState } = React

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
      'panel.entry': '设备与审计',
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
      'access.gatewayNotListening': '已启用，但当前没有在监听。重启 dsh 后生效。',
      'access.gatewayListening': '正在监听 {port} 端口，已建立 {live} 条远程连接。',
      'pair.heading': '添加设备',
      'pair.add': '生成配对码',
      'pair.hint': '在这台设备上输入下面的配对码，或直接打开链接。配对码一次性、两分钟内有效。',
      'pair.code': '配对码',
      'pair.link': '配对链接',
      'pair.copy': '复制',
      'pair.copied': '已复制',
      'pair.copyFailed': '复制失败，请手动选择文本。',
      'pair.expires': '剩余 {seconds} 秒',
      'pair.needGateway': '先启用远程接入并重启 dsh，否则生成的链接没有可连接的端口。',
      'pair.loopbackHint': '此链接里的 127.0.0.1 需要换成这台机器的局域网 IP，手机才能打开。',
      'pair.cancel': '取消',
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
      'error.loopback.title': '管理面板仅本机可用',
      'error.loopback.body': '设备管理只能在这台机器上操作。远程设备即使已完成配对，也只获得会话访问权，不获得管理权——这是有意设计，不是故障。',
      'error.crossOrigin.title': '请求来源被拒绝',
      'error.crossOrigin.body': '这个请求不是从 dsh web 页面发出的，管理接口按跨站请求拒绝。请从本机的 dsh web 页面打开面板。',
      'error.gatewayDown.title': '远程网关未监听',
      'error.gatewayDown.body': '远程接入当前没有可用的监听端口。请启用远程接入并重启 dsh。',
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
      'panel.entry': 'Devices and audit',
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
      'access.gatewayNotListening': 'Enabled, but nothing is listening right now. Restart dsh to apply it.',
      'access.gatewayListening': 'Listening on port {port} with {live} live remote connection(s).',
      'pair.heading': 'Add a device',
      'pair.add': 'Generate pairing code',
      'pair.hint': 'Type the code below on the device, or just open the link. The code is single use and expires in two minutes.',
      'pair.code': 'Pairing code',
      'pair.link': 'Pairing link',
      'pair.copy': 'Copy',
      'pair.copied': 'Copied',
      'pair.copyFailed': 'Copy failed; select the text manually.',
      'pair.expires': '{seconds}s left',
      'pair.needGateway': 'Enable remote access and restart dsh first, or the generated link has no port to connect to.',
      'pair.loopbackHint': 'Replace 127.0.0.1 in this link with this machine LAN address so a phone can open it.',
      'pair.cancel': 'Cancel',
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
      'error.loopback.title': 'The management panel is local-only',
      'error.loopback.body': 'Devices can only be managed on this machine. A paired remote device gets session access, never administration — that is the design, not a fault.',
      'error.crossOrigin.title': 'Request origin refused',
      'error.crossOrigin.body': 'This request did not come from the dsh web page, and the management API refuses cross-site requests. Open the panel from the dsh web page on this machine.',
      'error.gatewayDown.title': 'The remote gateway is not listening',
      'error.gatewayDown.body': 'Remote access has no listening port right now. Enable remote access and restart dsh.',
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
     * Build the one-time pairing link from the server's own pairing payload.
     *
     * The `<pairId>:<code>` pair lives in the FRAGMENT (`design.md` §3.1 step 3):
     * a fragment is never sent to a server, so the code cannot land in an access
     * log. The origin comes from the page (the desktop browser knows the address
     * it is being used at) and the PORT from the gateway, which is the only
     * listener a phone can reach.
     *
     * @param {{ fragment?: string, pairPath?: string, port?: number | null }} pairing
     * @param {string} pageHref
     * @returns {string | null} null when the inputs cannot form a URL.
     */
    function pairingUrl(pairing, pageHref) {
      if (pairing === null || typeof pairing !== 'object') return null
      const fragment = typeof pairing.fragment === 'string' ? pairing.fragment : ''
      const pairPath = typeof pairing.pairPath === 'string' && pairing.pairPath !== ''
        ? pairing.pairPath
        : '/remote-control/pair'
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
      '.drc-panel{position:absolute;left:0;bottom:calc(100% + 8px);z-index:1000;display:flex;flex-direction:column;box-sizing:border-box;width:min(380px,calc(100vw - 24px));max-height:min(600px,calc(100vh - 96px));background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:16px;overflow:hidden}',
      '.drc-panel:focus{outline:none}',
      '.drc-panelHeader{display:flex;align-items:flex-start;gap:8px;padding:14px 14px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.drc-panelTitles{display:flex;flex:1;flex-direction:column;gap:2px;min-width:0}',
      '.drc-panelTitle{margin:0;color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:22px}',
      '.drc-panelSubtitle{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.drc-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:none;border-radius:50%;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:16px;line-height:1;cursor:pointer}',
      '.drc-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.drc-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.drc-body{display:flex;flex-direction:column;gap:14px;padding:14px;overflow-y:auto}',
      '.drc-section{display:flex;flex-direction:column;gap:8px}',
      '.drc-sectionTitle{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}',
      '.drc-row{display:flex;align-items:center;justify-content:space-between;gap:10px}',
      '.drc-field{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.drc-label{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
      '.drc-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.drc-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      '.drc-switch{position:relative;flex:none;box-sizing:border-box;width:40px;height:22px;padding:0;border:1px solid var(--dsw-alias-border-l3);border-radius:11px;background:var(--dsw-alias-bg-layer-1);cursor:pointer;transition:background 120ms ease}',
      '.drc-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.drc-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.drc-switch:disabled{cursor:default;opacity:.5}',
      '.drc-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-tertiary);transition:transform 120ms ease,background 120ms ease}',
      '.drc-switch[aria-checked="true"] .drc-knob{transform:translateX(18px);background:var(--dsw-alias-label-primary-inverted)}',
      '.drc-input{box-sizing:border-box;width:88px;height:30px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
      '.drc-input:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.drc-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;height:30px;padding:0 12px;border:1px solid transparent;border-radius:8px;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}',
      '.drc-button:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.drc-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.drc-button:disabled{cursor:default;background:none;opacity:.55}',
      '.drc-buttonPrimary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted)}',
      '.drc-buttonPrimary:hover{background:var(--dsw-alias-button-primary-hover)}',
      '.drc-buttonDanger{color:var(--dsw-alias-state-error-primary)}',
      '.drc-buttonDanger:hover{background:var(--dsw-alias-interactive-bg-hover-danger)}',
      '.drc-code{display:flex;align-items:center;justify-content:center;gap:6px;padding:10px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:18px;font-weight:600;letter-spacing:.1em}',
      '.drc-codeGroup{padding:0 1px}',
      '.drc-linkInput{box-sizing:border-box;width:100%;height:28px;padding:0 8px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-link);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}',
      '.drc-devices{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}',
      '.drc-device{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.drc-device:last-child{border-bottom:none}',
      '.drc-deviceMain{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.drc-deviceName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
      '.drc-deviceMeta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.drc-deviceActions{display:flex;flex:none;align-items:center;gap:6px}',
      '.drc-notice{display:flex;flex-direction:column;gap:4px;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}',
      '.drc-noticeTitle{margin:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:20px}',
      '.drc-noticeBody{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.drc-noticeError{border-color:var(--dsw-alias-state-error-primary)}',
      '.drc-noticeError .drc-noticeTitle{color:var(--dsw-alias-state-error-primary)}',
      '.drc-noticeWarn{border-color:var(--dsw-alias-state-warn-primary)}',
      '.drc-noticeWarn .drc-noticeTitle{color:var(--dsw-alias-state-warn-label)}',
      '.drc-noticeOk .drc-noticeTitle{color:var(--dsw-alias-state-success-primary)}',
      '.drc-auditList{display:flex;flex-wrap:wrap;gap:4px 10px;margin:0;padding:0;list-style:none}',
      '.drc-auditItem{display:flex;gap:4px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.drc-auditValue{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
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
        headers: { accept: 'application/json' },
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
     *   updateSettings: (patch: object) => Promise<{ ok: boolean, settings: object | null, failure: object | null }>,
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

      /** Persist the enable switch or the port; the caller re-reads afterwards. */
      const updateSettings = useCallback(async (patch) => {
        try {
          const data = await requestJson('settings', { method: 'POST', body: patch })
          await load()
          return {
            ok: true,
            settings: data !== null && typeof data === 'object' ? data.settings ?? null : null,
            failure: null,
          }
        } catch (error) {
          return { ok: false, settings: null, failure: describeFailure(error) }
        }
      }, [load])

      return { snapshot, refresh: load, revokeDevice, updateSettings }
    }

    /**
     * The pairing flow: mint a code, count down, forget it.
     *
     * Nothing is cached across a panel close — a code that outlived its card
     * would be a credential with no visible lifetime. Host-side, a pair is a
     * 120 s one-shot either way, so a stale card could only mislead.
     *
     * @returns {{
     *   current: object | null,
     *   remainingMs: number,
     *   busy: boolean,
     *   failure: object | null,
     *   start: () => Promise<void>,
     *   clear: () => void,
     * }}
     */
    function usePairing() {
      const [current, setCurrent] = useState(null)
      const [remainingMs, setRemainingMs] = useState(0)
      const [busy, setBusy] = useState(false)
      const [failure, setFailure] = useState(null)

      const clear = useCallback(() => {
        setCurrent(null)
        setRemainingMs(0)
        setFailure(null)
      }, [])

      const start = useCallback(async () => {
        setBusy(true)
        setFailure(null)
        try {
          const data = await requestJson('pairing', { method: 'POST', body: {} })
          setCurrent(data !== null && typeof data === 'object' ? data : null)
          setRemainingMs(data !== null && typeof data === 'object' && Number.isFinite(data.ttlMs) ? data.ttlMs : 0)
        } catch (error) {
          setCurrent(null)
          setFailure(describeFailure(error))
        } finally {
          setBusy(false)
        }
      }, [])

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
             visible countdown at zero would invite a scan that must fail. */
          if (left === 0) setCurrent(null)
        }
        tick()
        const timer = setInterval(tick, COUNTDOWN_INTERVAL_MS)
        return () => clearInterval(timer)
      }, [current])

      return { current, remainingMs, busy, failure, start, clear }
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
     * The enable switch and the port field.
     *
     * Both take effect on the next plugin load, and the panel says so rather than
     * implying a live re-bind: `src/host/api.js#updateSettings` answers
     * `requiresReload`, and a UI that quietly disagreed with that would have the
     * user waiting for a listener that will never appear.
     *
     * @param {object} props
     * @param {(key: string, params?: object) => string} props.t
     * @param {{ enabled: boolean, port: number } | null} props.settings
     * @param {object | null} props.gateway
     * @param {(patch: object) => Promise<{ ok: boolean, failure: object | null }>} props.updateSettings
     */
    function AccessSection({ t, settings, gateway, updateSettings }) {
      const [portDraft, setPortDraft] = useState(null)
      const [busy, setBusy] = useState(false)
      const [outcome, setOutcome] = useState(null)

      const enabled = settings !== null && typeof settings === 'object' && settings.enabled === true
      const known = settings !== null && typeof settings === 'object'
      const portText = portDraft !== null
        ? portDraft
        : (known && Number.isInteger(settings.port) ? String(settings.port) : '')

      const commit = async (patch) => {
        setBusy(true)
        setOutcome(null)
        const result = await updateSettings(patch)
        setBusy(false)
        setOutcome(result.ok ? { tone: 'ok' } : { tone: 'error', failure: result.failure })
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

      let listeningKey = 'access.gatewayDisabled'
      let listeningParams
      if (enabled) {
        const listening = gateway !== null && typeof gateway === 'object' && gateway.listening === true
        if (listening) {
          listeningKey = 'access.gatewayListening'
          listeningParams = {
            port: gateway.port === null || gateway.port === undefined ? '?' : gateway.port,
            live: Number.isInteger(gateway.liveConnections) ? gateway.liveConnections : 0,
          }
        } else {
          listeningKey = 'access.gatewayNotListening'
        }
      }

      return h('section', { className: 'drc-section' },
        h('h3', { className: 'drc-sectionTitle' }, t('access.heading')),
        h('div', { className: 'drc-row' },
          h('div', { className: 'drc-field' },
            h('span', { className: 'drc-label' }, t('access.enable')),
            h('p', { className: 'drc-hint' }, t('access.enableHint')),
          ),
          h('button', {
            type: 'button',
            className: 'drc-switch',
            role: 'switch',
            'aria-checked': enabled,
            'aria-label': t('access.enable'),
            disabled: busy || known !== true,
            onClick: onToggle,
          }, h('span', { className: 'drc-knob' })),
        ),
        h('p', { className: 'drc-hint' }, t(listeningKey, listeningParams)),
        h('div', { className: 'drc-row' },
          h('label', { className: 'drc-field' },
            h('span', { className: 'drc-label' }, t('access.port')),
            h('input', {
              className: 'drc-input drc-mono',
              type: 'text',
              inputMode: 'numeric',
              value: portText,
              'aria-label': t('access.port'),
              disabled: busy || known !== true,
              onChange: (event) => {
                setOutcome(null)
                setPortDraft(event.target.value)
              },
            }),
          ),
          h('button', {
            type: 'button',
            className: 'drc-button',
            disabled: busy || known !== true,
            onClick: onSavePort,
          }, t('access.save')),
        ),
        outcome === null ? null : (outcome.tone === 'invalid'
          ? h(Notice, { tone: 'error', title: t('access.invalidPort') })
          : (outcome.tone === 'ok'
            ? h(Notice, { tone: 'ok', title: t('access.saved'), body: t('access.reloadRequired') })
            : h(FailureNotice, { failure: outcome.failure === null ? { kind: 'unknown' } : outcome.failure, t }))),
      )
    }

    /**
     * The pairing card: text code, countdown, one-time link.
     *
     * The code is the primary path (see the file header on why there is no QR),
     * so it is rendered large, grouped and selectable, with a copy button beside
     * the link. Both are `readOnly` inputs or plain text: nothing here is a
     * credential the browser should autofill or remember.
     *
     * @param {object} props
     * @param {(key: string, params?: object) => string} props.t
     * @param {object} props.pairing The `usePairing` result.
     * @param {object | null} props.gateway
     */
    function PairingSection({ t, pairing, gateway }) {
      const [copied, setCopied] = useState(null)
      const [copyFailed, setCopyFailed] = useState(false)
      const current = pairing.current
      const listening = gateway !== null && typeof gateway === 'object' && gateway.listening === true
      const url = current === null ? null : pairingUrl(current, documentBase())
      const seconds = Math.max(0, Math.ceil(pairing.remainingMs / 1000))

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
        current === null
          ? h('div', { className: 'drc-row' },
            h('button', {
              type: 'button',
              className: 'drc-button drc-buttonPrimary',
              disabled: pairing.busy === true,
              onClick: () => { void pairing.start() },
            }, t('pair.add')),
          )
          : h('div', { className: 'drc-section' },
            h('div', { className: 'drc-code drc-mono' },
              pairingCodeGroups(typeof current.code === 'string' ? current.code : '').map((group, index) => (
                h('span', { className: 'drc-codeGroup', key: 'g' + String(index) }, group)
              )),
            ),
            h('div', { className: 'drc-row' },
              h('span', { className: 'drc-hint' }, t('pair.expires', { seconds })),
              h('div', { className: 'drc-deviceActions' },
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
              h('input', {
                className: 'drc-linkInput',
                type: 'text',
                readOnly: true,
                value: url,
                'aria-label': t('pair.link'),
                onFocus: (event) => event.target.select(),
              }),
              h('div', { className: 'drc-row' },
                h('button', { type: 'button', className: 'drc-button', onClick: () => { void copy('link', url) } },
                  copied === 'link' ? t('pair.copied') : t('pair.copy')),
              ),
            ),
            url !== null && isLoopbackName(new URL(url).hostname)
              ? h('p', { className: 'drc-hint' }, t('pair.loopbackHint'))
              : null,
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

      return h('li', { className: 'drc-device' },
        h('div', { className: 'drc-deviceMain' },
          h('span', { className: 'drc-deviceName' }, typeof device.name === 'string' && device.name !== ''
            ? device.name
            : String(device.id)),
          h('span', { className: 'drc-deviceMeta' },
            seen === null ? t('devices.never') : t('devices.lastSeen', { when: seen })),
          source === null ? null : h('span', { className: 'drc-deviceMeta' }, t(source.labelKey, { ip: source.value, ua: source.value })),
          live === null ? null : h('span', { className: 'drc-deviceMeta' }, live),
          revoked ? h('span', { className: 'drc-deviceMeta' }, t('devices.revoked')) : null,
          failed ? h('span', { className: 'drc-deviceMeta', role: 'alert' }, t('devices.failed')) : null,
        ),
        /* A revoked row offers no action: it is already refused by the gateway
           (`gateway/auth.js`), so a button here would promise something the
           server would answer with "already revoked". */
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

      return h('section', { className: 'drc-section' },
        h('h3', { className: 'drc-sectionTitle' }, t('audit.heading')),
        summary === null
          ? h('p', { className: 'drc-hint' }, t('audit.empty'))
          : h('div', { className: 'drc-field' },
            h('span', { className: 'drc-hint' }, summary.retentionDays === null || summary.retentionDays === undefined
              ? t('audit.heading')
              : t('audit.window', { days: summary.retentionDays })),
            h('span', { className: 'drc-hint' },
              t('audit.files', { count: Number.isInteger(summary.files) ? summary.files : 0 })
              + ' · '
              + t('audit.lines', { count: lines })),
            summary.firstDay === null || summary.lastDay === null
              ? null
              : h('span', { className: 'drc-hint' }, t('audit.range', { from: summary.firstDay, to: summary.lastDay })),
            Number.isInteger(summary.invalidLines) && summary.invalidLines > 0
              ? h('span', { className: 'drc-hint' }, t('audit.invalidLines', { count: summary.invalidLines }))
              : null,
            lines === 0
              ? h('p', { className: 'drc-hint' }, t('audit.empty'))
              : h('ul', { className: 'drc-auditList' },
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
     * The panel itself.
     *
     * Mounted only while open, which is what bounds every subscription in the
     * hooks above to the panel's visible lifetime.
     *
     * @param {object} props
     * @param {(key: string, params?: object) => string} props.t
     * @param {() => void} props.onClose
     * @param {{ current: HTMLElement | null }} props.panelRef
     */
    function Panel({ t, onClose, panelRef }) {
      const status = useGatewayStatus()
      const pairing = usePairing()

      const snapshot = status.snapshot
      const state = snapshot.state !== null && typeof snapshot.state === 'object' ? snapshot.state : null
      const settings = state !== null && state.settings !== null && typeof state.settings === 'object'
        ? state.settings
        : null
      const gateway = state !== null && state.gateway !== null && typeof state.gateway === 'object'
        ? state.gateway
        : null

      const body = []
      if (snapshot.error !== null) {
        body.push(h(FailureNotice, {
          key: 'failure',
          failure: snapshot.error,
          t,
          /* Retry is offered, and it is the only recovery path: `hook-guidelines.md`
             forbids automatic retries. */
          onRetry: () => { void status.refresh() },
        }))
      }
      if (snapshot.phase === 'loading' && state === null) {
        body.push(h('p', { className: 'drc-hint', key: 'loading' }, t('panel.loading')))
      }
      if (state !== null) {
        body.push(h(AccessSection, {
          key: 'access',
          t,
          settings,
          gateway,
          updateSettings: status.updateSettings,
        }))
        body.push(h(PairingSection, { key: 'pairing', t, pairing, gateway }))
        body.push(h(DeviceSection, {
          key: 'devices',
          t,
          devices: snapshot.devices,
          onRevoke: status.revokeDevice,
        }))
        body.push(h(AuditSection, { key: 'audit', t, audit: snapshot.audit }))
      }

      return h('section', {
        className: 'drc-panel',
        role: 'dialog',
        'aria-label': t('panel.title'),
        tabIndex: -1,
        ref: panelRef,
      },
        h('header', { className: 'drc-panelHeader' },
          h('div', { className: 'drc-panelTitles' },
            h('h2', { className: 'drc-panelTitle' }, t('panel.title')),
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
        h('div', { className: 'drc-body' }, body),
      )
    }

    /**
     * The sidebar-foot seat.
     *
     * Receives only the sidebar's column state (`{ wide }`) plus the
     * framework-bound translator; it is the only entry point of this plugin, so
     * everything else here is reached through it.
     *
     * @param {object} props
     * @param {boolean} [props.wide] Sidebar expanded (false = 56px icon rail).
     * @param {(key: string, params?: object) => string} [props.t] Bound to {@link NS}.
     */
    function SidebarAction({ wide = false, t = fallbackTranslate }) {
      const [open, setOpen] = useState(false)
      const panelRef = useRef(null)
      const rootRef = useRef(null)

      useEffect(() => {
        if (open !== true) return undefined

        const onKeyDown = (event) => {
          /* `component-guidelines.md`: `Esc` closes the panel. Bound on the
             document, because focus may be anywhere inside it. */
          if (event.key === 'Escape') setOpen(false)
        }
        window.addEventListener('keydown', onKeyDown)

        /* Outside-click dismissal, written here rather than taken from
           `@deepseek-ai/dsh-client-ui-primitives`: the primitives module is
           optional (`quality-guidelines.md` required pattern 3), and a required
           dependency on an optional module is exactly the boot failure the
           baseline test exists to prevent. `pointerdown` rather than `click` so
           a press that starts outside and drags in does not still close it. */
        const onPointerDown = (event) => {
          const root = rootRef.current
          if (root === null) return
          /* `composedPath()` is the reliable answer and works across shadow
             boundaries; `contains` is the fallback for an older engine. Both are
             feature-checked, because this runs inside an event listener where a
             throw would be an unhandled error on a user's click. */
          const inside = typeof event.composedPath === 'function'
            ? event.composedPath().includes(root)
            : (typeof root.contains === 'function' && event.target !== null && typeof event.target === 'object'
              ? root.contains(event.target)
              : false)
          if (inside) return
          setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)

        const node = panelRef.current
        if (node !== null && typeof node.focus === 'function') node.focus()

        return () => {
          window.removeEventListener('keydown', onKeyDown)
          document.removeEventListener('pointerdown', onPointerDown, true)
        }
      }, [open])

      return h('div', { className: 'drc-root', ref: rootRef },
        open
          ? h(Panel, { t, onClose: () => setOpen(false), panelRef })
          : null,
        h('button', {
          type: 'button',
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
     * Read one optional client service.
     *
     * `ctx.get` is the documented probe and returns `undefined` for a service the
     * composition does not provide; the direct property is the fallback for a
     * host whose context exposes services plainly. Never throws.
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
      const direct = ctx[name]
      return direct === undefined || direct === null ? null : direct
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
     * (`quality-guidelines.md` required pattern 2). The locale service is
     * optional: a host without it renders English, because a panel that failed
     * to mount over a missing translator would be an unmountable plugin.
     *
     * @param {object} ctx Client root context.
     */
    function apply(ctx) {
      const locale = serviceOf(ctx, 'locale')
      if (locale !== null && typeof locale.register === 'function') {
        effect(ctx, () => locale.register(NS, { zh: ZH, en: EN }), 'remote-control: dictionaries')
      }

      effect(ctx, installStyles, 'remote-control: styles')

      const slots = serviceOf(ctx, 'slots')
      if (slots === null || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        /* Visible degradation, never silence (`quality-guidelines.md` §5 in the
           backend spec): a host without the slot service cannot show this panel,
           and a user staring at a missing entry deserves one line explaining it.
           There is no host logger on the browser side, so the console is the only
           sink the browser has. */
        if (typeof console !== 'undefined' && typeof console.warn === 'function') {
          console.warn('[remote-control] the UI slot service is unavailable; the device panel is not mounted')
        }
        return
      }

      effect(
        ctx,
        () => slots.inject(SEAT, () => slots.register({
          name: SEAT,
          id: SEAT_ID,
          locale: NS,
        }, SidebarAction)),
        'remote-control: sidebar footer action',
      )
    }

    return {
      name: 'dsh-remote-control',
      /* `slots` is the one real dependency: without it there is no seat to fill.
         `locale` is deliberately absent so a composition that provides no locale
         service still mounts the panel (English fallback) instead of parking this
         plugin forever. */
      inject: ['slots'],
      apply,
      /**
       * Private surface for `tests/client.test.mjs`.
       *
       * The browser half has no DOM test environment, so the pieces that must not
       * ship unverified — the mount-relative URL builder, the fragment-holding
       * pairing link, the four-way failure classification and the dictionaries
       * themselves — are exposed here and exercised directly. Nothing at runtime
       * reads this.
       */
      internals: {
        NS,
        SEAT,
        SEAT_ID,
        API_BASE,
        FAILURE_KINDS,
        ZH,
        EN,
        adminUrl,
        classifyFailure,
        pairingUrl,
        pairingCodeGroups,
        parsePort,
        formatRelative,
        deviceSource,
        isLoopbackName,
        interpolate,
        fallbackTranslate,
        attachmentName,
      },
    }
  },
})
