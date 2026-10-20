/**
 * dsh-remote-control — the pairing bootstrap, served on the GATEWAY port.
 *
 * ## Why this module exists
 *
 * `design.md` §3.1 is a two-sided handshake, and before this module only one side
 * existed: `api.js#createPairing` minted a code and handed the desktop panel a
 * `pairPath` of `/remote-control/pair`, while nothing anywhere served that path
 * and `pairing.redeem()` had no caller outside the test suite. A user could mint a
 * code and never redeem it — the phone opened the link, had no cookie, and got the
 * gateway's 401 page forever.
 *
 * The redeem half therefore belongs HERE and not on the admin API: pairing is the
 * one action a device performs *before* it has any credential, and the admin API
 * is loopback-only by design (`prd.md` R4). The gateway is the only listener a
 * phone can reach, so it is the only possible host for it.
 *
 *   - `GET  /remote-control/pair` — a self-contained HTML page. The code travels in
 *     the URL **fragment**, which a browser never sends to the server
 *     (`design.md` §3.1 step 3), so the page reads `location.hash` client-side and
 *     POSTs it back. Without a fragment it shows a manual entry form.
 *   - `POST /remote-control/pair` — `{ pairId, code }` → `pairing.redeem(...)`. On
 *     success: mint a **signed JWT** (`research/jwt-device-credential.md` §3.1
 *     step ③), answer `303` to `/` with `Set-Cookie: dsh-rc-jwt=<JWT>; Max-Age=…;
 *     Path=/; HttpOnly; SameSite=Lax`, and record the `pair` audit event.
 *
 * ## The one-time code, and why the token is a JWT rather than a random string
 *
 * This is the OAuth authorization-code shape the user asked for: a short-lived,
 * single-use code is exchanged for a bearer credential. The credential carries
 * `iss`/`sub`/`aud`/`iat`/`exp`/`jti`/`name` and nothing else (`tokens.js`), so the
 * gateway can identify the device from the token instead of scanning a table of
 * hashes, while revocation stays instant through the gateway's in-memory revoked
 * set (`gateway/server.js`). Nothing sensitive goes in the payload: a JWT is
 * readable by whoever holds it.
 *
 * ## The security question this module had to answer before existing
 *
 * `authorize()` must not gate these two routes — a device being paired has no
 * cookie by definition, so gating them would make pairing impossible. That is the
 * same shape as the two defects this project already paid for: the stage-2 loopback
 * exemption that skipped the origin fence, and the stage-3 read arms that admitted
 * a cross-site WebSocket. So the question has to be answered explicitly rather
 * than waved at (`quality-guidelines.md` §8 — does this hop supply the proof the
 * attacker lacks?):
 *
 *   **This path never touches the proxy, and therefore supplies nothing.**
 *   `proxy.js` is where the gateway injects the instance-wide `dsh-auth-*`
 *   credential, rewrites `Host` and strips `Origin` (that is precisely what made
 *   the stage-2 exemption a laundering hole). The pairing routes answer out of
 *   process memory and make no upstream request at all: no `forward()`, no
 *   `innerAuth.header()`, no `Header` rewrite, nothing. So the exemption waives
 *   the credential and nothing else, and the origin fence still runs in full.
 *
 * What an unauthenticated caller can actually do here, enumerated:
 *
 *   | Action | Effect | Bound |
 *   |---|---|---|
 *   | `GET` the page | a constant ~3 KB HTML document, no input echoed | none needed (see below) |
 *   | `POST` a guess | one `pair_failed` audit line, one debit of the existing budget | `pairing.js`: 5/pair, 20/source/60 s |
 *   | `POST` a wrong-shaped body | `400`, no budget spent | body bounded at `PAIRING_MAX_BODY_BYTES` |
 *   | anything else | `405` / `404` | — |
 *
 * It cannot reach DSH (no proxy hop), cannot create a device (`addDevice` runs only
 * after a successful redeem), cannot read the device table, cannot learn whether a
 * `pairId` exists beyond the `pairing/unknown` / `pairing/invalid-code` distinction
 * that `research/official-connection-fence.md` §7.3 records as a deliberate,
 * accepted trade, and cannot learn a code (it is compared in constant time inside
 * `pairing.js` and never leaves memory).
 *
 * **`GET` is deliberately NOT budgeted, and NOT origin-fenced; the `POST` is both.**
 * That asymmetry is the one judgement call in this module, so it is spelled out in
 * {@link servePage} at the code and summarised here:
 *
 *   - the page is a CONSTANT with no state and no input echo, and a budget it
 *     consumed would let an attacker behind a shared NAT address deny the
 *     legitimate user the pairing page — a DoS lever handed over for no benefit;
 *   - a real pairing link is normally TAPPED in a chat app, which a browser reports
 *     as `Sec-Fetch-Site: cross-site`; fencing the read would refuse the page in the
 *     most common real-world path and protect nothing, because the write that
 *     follows the page is same-origin and fully fenced;
 *   - the page cannot be framed (`X-Frame-Options: DENY`, CSP `frame-ancestors
 *     'none'`), which is the one thing a lenient read could otherwise have enabled.
 *
 * There is deliberately no second rate limiter: two would drift, and the POST
 * already spends exactly the one budget `pairing.js` owns.
 *
 * ## `settings.enabled` is re-read on every request
 *
 * The listener is only started when remote access is on (`src/index.js`), but the
 * panel can switch it off while the listener is still bound — `POST
 * /remote-control/api/settings` reports `requiresReload: true` and does not tear
 * the socket down. A gateway whose switch has been turned off must stop minting
 * credentials *now*, not at the next reload, so the check is a per-request read of
 * the store rather than a value captured at start. It fails CLOSED: a store that
 * cannot be read answers `503`, never `200`.
 *
 * ## Failure policy (`.trellis/spec/backend/error-handling.md`)
 *
 * No throw escapes: {@link createPairingRoute}'s `handle` is `async` and wraps
 * everything, and a handler that somehow still rejects destroys the response
 * rather than leaving the client hanging. Every write goes through `wire.js`, so
 * `writeHead` can never be issued twice.
 *
 * ## The pairing code is never logged and never audited
 *
 * Not by convention — structurally. The success path audits `{ event: 'pair',
 * deviceId, ip, meta: { pairId } }`: `pairId` is an opaque `pair_*` identifier, and
 * the clear code is simply not in scope at the audit call site. The failure path
 * audits nothing at all: `pairing.js` already reports every spent guess through its
 * injected `onFailure` (wired to `audit.record({ event: 'pair_failed' })` in
 * `src/index.js`), exactly once, at the single point where a budget is debited, and
 * *only* for genuine guesses — `pairing/expired` and `pairing/used` are normal user
 * behaviour and are deliberately silent. Were this module to audit failures too,
 * every guess would produce two lines and the trail would stop meaning one thing.
 *
 * ## Cookie attributes, and the missing `Secure`
 *
 * `HttpOnly; SameSite=Lax; Path=/; Max-Age=…` and **no `Secure`** (`design.md`
 * §3.2): the LAN transport is plain HTTP, and a `Secure` cookie is simply never
 * sent back, which would make pairing appear to succeed and then fail on the next
 * request. That is a documented boundary in the README, not an oversight.
 */
import { randomBytes } from 'node:crypto'

import {
  DEVICE_COOKIE_MAX_AGE_SECONDS,
  DEVICE_ID_PREFIX,
  PAIRING_ROUTE_PATH,
} from '../constants.js'
import { clientAddress, headerValue } from '../loopback.js'
import { checkOrigin } from '../origin.js'
import { signDeviceToken } from '../tokens.js'
import { deviceCookie, emit, sendDocument, sendError, sendRedirect } from './wire.js'

/* Re-exported so a caller (and the package's own invariant test) can ask this
   module what path it owns without importing the domain constants module. */
export { PAIRING_ROUTE_PATH }

/**
 * Largest accepted request body.
 *
 * Every documented request is `{"pairId":"pair_…","code":"ABCD2345"}` — about
 * sixty bytes. Four kilobytes is two orders of magnitude of headroom and still
 * small enough that the bound actually bounds something.
 */
export const PAIRING_MAX_BODY_BYTES = 4 * 1024

/**
 * Deadline for reading one pairing body.
 *
 * `quality-guidelines.md` §10: every await gets a bound. The client is a phone on
 * a LAN, so a body read is normally a single packet — but a client that opens a
 * request and stops writing must not hold a handler.
 */
const BODY_TIMEOUT_MS = 10_000

/** Longest `pairId` this route forwards. Real ids are `pair_` + 12 base64url chars. */
const MAX_PAIR_ID_LENGTH = 128

/** Longest raw code input accepted. The real code is 8 characters; people paste spaces and dashes. */
const MAX_CODE_INPUT_LENGTH = 64

/** Bytes of entropy behind a device id. Never a credential — an opaque row key. */
const DEVICE_ID_BYTES = 9

/** Longest device name this module will derive from a User-Agent. */
const MAX_DEVICE_NAME_LENGTH = 80

/** Longest raw User-Agent persisted alongside the device (`design.md` §5). */
const MAX_UA_LENGTH = 200

/**
 * The pairing page.
 *
 * Deliberately one document with inline style and one inline script: it has to
 * work on a phone that has just scanned a QR code, before anything has been
 * installed, from a gateway that serves exactly two paths. There is no asset to
 * fetch, so no request of any kind leaves this page.
 *
 * The `<input>` fields are the manual fallback (`design.md` §3.1: 二维码为主 +
 * 纯文本码手输). They are needed because the fragment carries TWO values — the
 * `pairId` is 72 bits of base64url and is not something a person types, so the
 * case the form really serves is "the link opened but the scan was incomplete".
 *
 * The script maps `error.code` onto a fixed local sentence rather than rendering
 * the server's `message`: the page then renders only strings it shipped with, and
 * the server's wording can change without a second translation surface.
 */
const PAIRING_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pair this device</title></head>
<body style="font:16px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:24rem;padding:0 1.5rem;color:#111">
<h1 style="font-size:1.25rem">Pair this device</h1>
<p id="status" role="status">Reading the pairing link…</p>
<form id="manual" style="display:none;gap:.75rem;margin:1.5rem 0">
<label style="display:grid;gap:.25rem">Pairing ID
<input id="pairId" name="pairId" autocomplete="off" autocapitalize="off" spellcheck="false"
style="font:inherit;padding:.5rem;border:1px solid #999;border-radius:.375rem"></label>
<label style="display:grid;gap:.25rem">Pairing code
<input id="code" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false"
style="font:inherit;padding:.5rem;border:1px solid #999;border-radius:.375rem"></label>
<button type="submit"
style="font:inherit;padding:.6rem;border:0;border-radius:.375rem;background:#111;color:#fff">Pair</button>
</form>
<p style="color:#666;font-size:.875rem">Open the dsh remote control panel on the desktop and choose
“Add device” to get a new code. Codes are single use and expire after two minutes.</p>
<script>
(function () {
  'use strict'
  var status = document.getElementById('status')
  var form = document.getElementById('manual')
  var pairIdField = document.getElementById('pairId')
  var codeField = document.getElementById('code')

  function say(text) { status.textContent = text }

  function showManual(pairId) {
    form.style.display = 'grid'
    if (pairIdField.value === '' && typeof pairId === 'string') pairIdField.value = pairId
    codeField.focus()
  }

  /* "<pairId>:<code>", read from the fragment. A fragment never reaches the
     server, which is the entire reason the code is put there. */
  function split(raw) {
    if (typeof raw !== 'string') return null
    var text = raw.charAt(0) === '#' ? raw.slice(1) : raw
    var at = text.indexOf(':')
    if (at < 1 || at === text.length - 1) return null
    /* Only the first colon separates: a base64url pair id never contains one, but
       splitting on the LAST would silently move part of the id into the code. */
    return { pairId: text.slice(0, at), code: text.slice(at + 1) }
  }

  /* A spent code must not be left in the address bar or in the history entry the
     page was opened from. Done BEFORE the POST so a reload after a failure does
     not re-present a code that this attempt is about to consume — and so the
     fragment is gone even if the script dies halfway through. */
  function clearFragment() {
    try {
      window.history.replaceState(null, '', window.location.pathname)
    } catch (e) {
      /* A browser that refuses replaceState keeps the hash; the pairing result is
         what matters, and a code in history is stale, not reusable. */
    }
  }

  var MESSAGES = {
    'pairing/invalid-code': 'That code is not correct. Check the desktop screen and try again.',
    'pairing/expired': 'That code has expired. Ask the desktop panel for a new one.',
    'pairing/used': 'That code has already been used. Ask the desktop panel for a new one.',
    'pairing/locked': 'Too many wrong attempts for that code. Ask the desktop panel for a new one.',
    'pairing/source-locked': 'Too many wrong attempts from this device. Wait a minute, then try again.',
    'pairing/unknown': 'That pairing ID is not valid. Scan the code again.',
    'pairing/bad-request': 'That link is incomplete. Enter the pairing ID and code below.',
    'pairing/body-too-large': 'That request was too large. Scan the code again.',
    'pairing/invalid-json': 'That link is incomplete. Enter the pairing ID and code below.',
    'pairing/unsupported-media-type': 'That request could not be read. Scan the code again.',
    'pairing/unavailable': 'This gateway is not configured for pairing. Check the desktop panel.',
    'gateway/pairing-disabled': 'Remote access is switched off on the desktop.',
    'gateway/cross-origin': 'This page may not pair. Open the link from the desktop panel.',
    'gateway/method-not-allowed': 'That pairing request used an unsupported method.'
  }

  function submit(pair) {
    say('Pairing…')
    /* redirect: 'manual' so a successful 303 is observable instead of being
       followed inside this fetch — following it would download the whole dsh UI
       only to throw it away. The Set-Cookie on the 303 is stored by the browser
       as soon as the response arrives, whatever this script does with it, which
       is what makes the navigation below land already paired. */
    fetch(window.location.pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      redirect: 'manual',
      cache: 'no-store',
      body: JSON.stringify({ pairId: pair.pairId, code: pair.code })
    }).then(function (response) {
      /* Three ways to see the same 303, because a browser that ignores
         redirect: 'manual' follows it instead: it then reaches '/' and reports
         200 with response.redirected true. Treating that as a failure would tell
         the user pairing failed on a device that is now perfectly paired. */
      if (response.type === 'opaqueredirect' || response.status === 303 || response.redirected === true) {
        say('Paired. Opening dsh…')
        /* replace, not assign: the fragment carrying a now-spent code must not
           stay in this tab's history. */
        window.location.replace('/')
        return
      }
      return response.json().then(function (payload) {
        var code = payload && payload.error ? payload.error.code : null
        say(MESSAGES[code] || 'Pairing did not succeed. Ask the desktop panel for a new code.')
        showManual(pair.pairId)
      }, function () {
        say('Pairing did not succeed. Ask the desktop panel for a new code.')
        showManual(pair.pairId)
      })
    }, function () {
      say('The remote gateway could not be reached.')
      showManual(pair.pairId)
    })
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault()
    var pairId = pairIdField.value.trim()
    var code = codeField.value.trim()
    if (pairId === '' || code === '') {
      say('Enter both the pairing ID and the pairing code.')
      return
    }
    submit({ pairId: pairId, code: code })
  })

  var fromLink = split(window.location.hash)
  if (fromLink === null) {
    say('Enter the pairing ID and code shown in the desktop panel.')
    showManual('')
  } else {
    clearFragment()
    submit(fromLink)
  }
})()
</script>
</body></html>
`

/**
 * Document-level protections for the pairing page.
 *
 * The page accepts a credential, so it must not be framed (a clickjacked pairing
 * page is a way to have a user paste something into the wrong context) and it must
 * not leak its own URL — which carries the fragment — through a `Referer`, even
 * though it fetches nothing. `connect-src 'self'` is the one directive the page
 * genuinely needs, because it POSTs to its own path.
 */
const PAIRING_PAGE_HEADERS = Object.freeze({
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
})

/**
 * Build an Error carrying a stable `code` (`.trellis/spec/backend/error-handling.md`).
 *
 * @param {string} code
 * @param {string} message Never contains request data.
 * @returns {Error}
 */
function pairingError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * The pathname of a request target, or '' when it cannot be parsed.
 *
 * @param {string | undefined} target
 * @returns {string}
 */
function pathnameOf(target) {
  if (typeof target !== 'string' || target === '') return ''
  try {
    return new URL(target, 'http://localhost').pathname
  } catch {
    return ''
  }
}

/**
 * Whether a request target names the pairing route.
 *
 * Exact match plus the trailing-slash spelling; deliberately not a prefix, so a
 * future `/remote-control/pair/<something>` cannot inherit the bootstrap exemption
 * by accident. That "cannot inherit by accident" property is the whole reason the
 * upgrade path got its own fence (`quality-guidelines.md` §17).
 *
 * @param {string | undefined} target
 * @returns {boolean}
 */
export function isPairingPath(target) {
  const pathname = pathnameOf(target)
  return pathname === PAIRING_ROUTE_PATH || pathname === `${PAIRING_ROUTE_PATH}/`
}

/**
 * Derive a short human label from a User-Agent (`design.md` §3.1 — the panel shows
 * "iPhone · Safari" and lets the user rename it).
 *
 * Not a UA parser: two substring tables, first match wins. A parser would be a
 * dependency, and this only ever decorates a list row — an unrecognized agent gets
 * "Paired device" rather than a guess.
 *
 * @param {unknown} ua
 * @returns {string}
 */
export function describeUserAgent(ua) {
  if (typeof ua !== 'string' || ua === '') return 'Paired device'
  let platform = ''
  if (ua.includes('iPhone')) platform = 'iPhone'
  else if (ua.includes('iPad')) platform = 'iPad'
  else if (ua.includes('Android')) platform = 'Android'
  else if (ua.includes('Windows')) platform = 'Windows'
  else if (ua.includes('Macintosh') || ua.includes('Mac OS X')) platform = 'Mac'
  else if (ua.includes('Linux')) platform = 'Linux'

  let browser = ''
  if (ua.includes('Edg/')) browser = 'Edge'
  else if (ua.includes('OPR/')) browser = 'Opera'
  else if (ua.includes('Firefox/')) browser = 'Firefox'
  else if (ua.includes('Chrome/')) browser = 'Chrome'
  else if (ua.includes('Safari/')) browser = 'Safari'

  const label = browser === '' ? platform : (platform === '' ? browser : `${platform} · ${browser}`)
  return label === '' ? 'Paired device' : label.slice(0, MAX_DEVICE_NAME_LENGTH)
}

/**
 * HTTP status for a `pairing/*` failure code.
 *
 * The codes are mapped rather than collapsed so a user can tell "the code expired"
 * from "I typed it wrong" (`research/official-connection-fence.md` §7.3 records
 * that this distinction is deliberate and already public through the codes
 * themselves, so the status may carry it too):
 *
 *   | code | status | why that one |
 *   |---|---|---|
 *   | `pairing/unknown` | 404 | the pair does not exist |
 *   | `pairing/invalid-code` | 403 | the pair exists, this credential is wrong |
 *   | `pairing/expired` | 410 | it existed and is gone |
 *   | `pairing/used` | 409 | it is gone because it was consumed |
 *   | `pairing/locked` / `source-locked` | 429 | a rate limit fired |
 *   | `pairing/entropy` | 503 | our fault, and retryable |
 *
 * @param {string} code
 * @returns {number}
 */
function statusForFailure(code) {
  switch (code) {
    case 'pairing/unknown': return 404
    case 'pairing/invalid-code': return 403
    case 'pairing/expired': return 410
    case 'pairing/used': return 409
    case 'pairing/locked': return 429
    case 'pairing/source-locked': return 429
    case 'pairing/entropy': return 503
    default: return 500
  }
}

/**
 * Human sentence for a `pairing/*` failure code.
 *
 * No path, no URL, no digest, and above all no echo of the submitted code
 * (`error-handling.md` — a body may only say what kind of refusal happened).
 *
 * @param {string} code
 * @returns {string}
 */
function messageForFailure(code) {
  switch (code) {
    case 'pairing/unknown':
      return 'That pairing id is not valid. Open the link from the desktop panel again.'
    case 'pairing/invalid-code':
      return 'That pairing code is not correct.'
    case 'pairing/expired':
      return 'That pairing code has expired. Ask the desktop panel for a new one.'
    case 'pairing/used':
      return 'That pairing code has already been used. Ask the desktop panel for a new one.'
    case 'pairing/locked':
    case 'pairing/source-locked':
      return 'Too many wrong attempts. Ask the desktop panel for a new code.'
    case 'pairing/entropy':
      return 'The pairing code could not be issued. Try again.'
    default:
      return 'The pairing request could not be completed.'
  }
}

/**
 * Read a request body, bounded in size and in time.
 *
 * The size bound works as "keep at most `PAIRING_MAX_BODY_BYTES`, then stop
 * keeping bytes but keep draining". That detail is the point: answering the moment
 * the bound is crossed races the 413 against a socket reset while the client is
 * still writing, and the client is the side that loses the answer. Draining is not
 * buffering — the excess is discarded as it arrives, so memory stays at the bound
 * however large the upload is — and the deadline stops a client that never finishes.
 *
 * `error`, `close` AND `end` are all wired (`quality-guidelines.md` §19): a client
 * that aborts does not reliably emit `error`, and an abandoned promise here would
 * leak the handler.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string>} Rejects with a stable-`code` Error.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    let tooLarge = false
    let settled = false

    /** @param {string} code @param {string} message */
    function fail(code, message) {
      if (settled) return
      settled = true
      cleanup()
      reject(pairingError(code, message))
    }

    function succeed() {
      if (settled) return
      settled = true
      cleanup()
      resolve(Buffer.concat(chunks).toString('utf8'))
    }

    function cleanup() {
      clearTimeout(timer)
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('close', onClose)
    }

    function onData(chunk) {
      size += chunk.length
      if (size > PAIRING_MAX_BODY_BYTES) {
        /* Stop holding bytes the moment the bound is crossed; keep draining so the
           client can finish writing and actually read the 413. */
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    }

    function onEnd() {
      if (tooLarge) {
        fail('pairing/body-too-large', 'the pairing request body is too large')
        return
      }
      succeed()
    }

    function onError() {
      fail('pairing/body-unreadable', 'the pairing request body could not be read')
    }

    function onClose() {
      /* `close` without `end`: the client went away mid-body. */
      fail('pairing/body-aborted', 'the request was aborted before its body arrived')
    }

    const timer = setTimeout(() => {
      fail('pairing/body-timeout', 'the pairing request body did not arrive in time')
    }, BODY_TIMEOUT_MS)
    timer.unref?.()

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('close', onClose)
  })
}

/**
 * Whether a request declares a JSON body.
 *
 * Checked BEFORE the body is read, so a form-encoded or `text/plain` POST — the
 * shapes a cross-site page can send without a CORS preflight — costs this process
 * nothing but a header comparison.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
function isJsonRequest(req) {
  const type = headerValue(req, 'content-type')
  if (typeof type !== 'string') return false
  return type.split(';')[0].trim().toLowerCase() === 'application/json'
}

/**
 * Parse a JSON object body, or fail with a stable code.
 *
 * The parse error is deliberately not included in the message: it quotes the
 * input, and the input is the caller's. An empty body is NOT `{}` here — unlike the
 * admin API, every pairing request has required fields, so an empty body is a
 * malformed one.
 *
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
function parseJsonBody(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw pairingError('pairing/bad-request', 'a pairing request body is required')
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw pairingError('pairing/invalid-json', 'the request body is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw pairingError('pairing/invalid-json', 'the request body must be a JSON object')
  }
  return parsed
}

/**
 * Mint a device id.
 *
 * `dev_` + 9 random bytes as base64url, matching the `^dev_[A-Za-z0-9_-]{1,80}$`
 * shape the store, the audit writer and the admin API all agree on. A short buffer
 * from an injected source would produce a malformed id in silence, so — same rule
 * as `pairing.js`'s code generator — it fails loudly instead
 * (`quality-guidelines.md` §5).
 *
 * @param {(size: number) => Buffer} random
 * @returns {string}
 */
function createDeviceId(random) {
  const bytes = random(DEVICE_ID_BYTES)
  if (!(bytes instanceof Uint8Array) || bytes.length < DEVICE_ID_BYTES) {
    throw pairingError('pairing/entropy', 'the random source returned too few bytes')
  }
  return `${DEVICE_ID_PREFIX}${bytes.toString('base64url')}`
}

/**
 * Build the pairing routes.
 *
 * @param {object} options
 * @param {ReturnType<typeof import('../store.js').createStore>} options.store Device table (also read for `settings.enabled`).
 * @param {ReturnType<typeof import('../pairing.js').createPairingStore> | null | undefined} options.pairing
 *   The in-memory pair table. Absent means the host forgot to wire it: the routes
 *   answer `503 pairing/unavailable` rather than a 401 that would suggest pairing
 *   first.
 * @param {string} options.cookieName Name of the device cookie (`dsh-rc-jwt`).
 * @param {Buffer} options.jwtKey HS256 signing key (`jwt-key.js`). Required: a
 *   route that cannot sign must not mint a device row, or it would create a device
 *   that can never authenticate.
 * @param {(entry: object) => void} [options.record] Safe audit writer, supplied by `server.js`.
 * @param {object} [options.logger]
 * @param {(size: number) => Buffer} [options.random] Random-byte source; injectable for tests.
 * @param {() => number} [options.now] Clock in epoch milliseconds; injectable for tests.
 * @param {number} [options.maxAgeSeconds] Device-cookie lifetime; defaults to `DEVICE_COOKIE_MAX_AGE_SECONDS`.
 * @returns {{ path: string, handle: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void }}
 */
export function createPairingRoute(options) {
  const store = options.store
  const pairing = options.pairing !== null && typeof options.pairing === 'object' ? options.pairing : null
  const cookieName = options.cookieName
  const jwtKey = options.jwtKey
  const record = typeof options.record === 'function' ? options.record : () => {}
  const logger = options.logger
  const random = typeof options.random === 'function' ? options.random : randomBytes
  const now = typeof options.now === 'function' ? options.now : Date.now
  const maxAgeSeconds = Number.isInteger(options.maxAgeSeconds) && options.maxAgeSeconds > 0
    ? options.maxAgeSeconds
    : DEVICE_COOKIE_MAX_AGE_SECONDS

  /**
   * Whether remote access is switched on, read fresh on every request. Fail closed.
   *
   * A store that cannot be read must not be read as "enabled": `store/corrupt`
   * during a request means the device table is unusable, and minting a token
   * against it would produce a credential nothing can verify.
   *
   * @returns {boolean}
   */
  function remoteEnabled() {
    if (store === null || typeof store !== 'object' || typeof store.getSettings !== 'function') return false
    try {
      const settings = store.getSettings()
      return settings !== null && typeof settings === 'object' && settings.enabled === true
    } catch (error) {
      /* Debug, not warn: a corrupt table already failed the plugin at mount time
         with a loud error, and one line per request would bury it. */
      emit(logger, 'debug', `[remote-control] pairing settings unreadable (${describeFailure(error)})`)
      return false
    }
  }

  /**
   * The gate a WRITE on this path passes through, in order.
   *
   * `enabled` first: a switched-off gateway must refuse before it does anything,
   * including running a fence. Then the origin fence, unchanged and in full — this
   * is the arm that makes the bootstrap exemption safe, and it is the SAME function
   * the rest of the port uses, so it cannot drift.
   *
   * Used only by the `POST`. See {@link servePage} for why the read deliberately
   * does not call it.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @returns {boolean} true when the caller may continue.
   */
  function admitWrite(req, res) {
    if (!remoteEnabled()) {
      sendError(res, 503, 'gateway/pairing-disabled', 'Remote access is switched off on this machine.')
      return false
    }
    const fence = checkOrigin(req)
    if (!fence.ok) {
      sendError(res, 403, 'gateway/cross-origin', 'Cross-site requests are not accepted by the remote gateway.')
      emit(logger, 'debug', `[remote-control] pairing request refused by the origin fence (${fence.reason})`)
      return false
    }
    return true
  }

  /**
   * `GET /remote-control/pair` (and `HEAD`).
   *
   * Static: it reads nothing off the request, and echoes no parameter. In
   * particular it must never reflect `pairId` from a query string back into the
   * document, which is why there is no query-parameter path here at all — the id
   * arrives in the fragment, in the browser.
   *
   * ## Why the READ does not run the origin fence, and the WRITE does
   *
   * `design.md` §3.1 puts the code in the URL fragment, and the fragment is
   * normally delivered by a link a person TAPS — in a chat app, a notes app, a
   * mail client. A browser reports that navigation as `Sec-Fetch-Site: cross-site`,
   * so running the fence here would refuse the page in the single most common way a
   * pairing link actually gets opened. That would be a usability bug dressed as a
   * security feature, and it would buy nothing, because:
   *
   *   - `checkOrigin`'s write arms (2-4) do not apply to a `GET` at all; only arm 1
   *     (`cross-site → 403`) would fire, and it would fire on the legitimate case.
   *   - The document is a CONSTANT. It has no state, no allocation proportional to
   *     the request, and discloses only what every other path's 401 already
   *     discloses: a gateway is here. There is nothing to protect by hiding it.
   *   - A cross-site reader could not use what it reads anyway: the POST that
   *     follows is same-origin (the page POSTs to its own path), so a hostile
   *     origin's fetch of this URL gains a document it could have fetched from this
   *     repository, and gains no ability to pair a device.
   *   - The framing route is closed separately and unconditionally
   *     (`X-Frame-Options: DENY`, CSP `frame-ancestors 'none'`), so this page cannot
   *     be used as a clickjacking surface — which is the one thing a lenient read
   *     could otherwise have enabled.
   *
   * So the read is unfenced and the write is fully fenced. That asymmetry is
   * deliberate and is covered by a test that asserts BOTH halves with the same
   * `Sec-Fetch-Site: cross-site` header (`tests/gateway-pairing.test.mjs`).
   *
   * `settings.enabled` still gates it: a switched-off gateway does not hand out the
   * page, because a page that can only ever fail is worse than an honest 503.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  function servePage(req, res) {
    if (!remoteEnabled()) {
      sendError(res, 503, 'gateway/pairing-disabled', 'Remote access is switched off on this machine.')
      return
    }
    sendDocument(res, 200, PAIRING_PAGE, PAIRING_PAGE_HEADERS)
  }

  /**
   * `POST /remote-control/pair`.
   *
   * The order is the security design and must not be reshuffled:
   *
   *   1. `enabled` + origin fence — before a byte of the body is read, so a
   *      cross-site POST never gets this process to buffer its payload;
   *   2. media type, then a bounded body read;
   *   3. shape validation — a malformed body is NOT a guess and spends no budget,
   *      because it cannot guess a code and a client bug must not burn the user's
   *      address;
   *   4. `pairing.redeem` — the only credential comparison, and the only place the
   *      two existing budgets are debited;
   *   5. mint → store the hash → audit → `303` + `Set-Cookie`.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @returns {Promise<void>}
   */
  async function handlePost(req, res) {
    if (!admitWrite(req, res)) return

    if (pairing === null) {
      sendError(res, 503, 'pairing/unavailable', 'This gateway is not configured for pairing.')
      return
    }

    if (!isJsonRequest(req)) {
      sendError(res, 415, 'pairing/unsupported-media-type', 'The pairing request must be JSON.')
      return
    }

    let payload
    try {
      payload = parseJsonBody(await readBody(req))
    } catch (error) {
      const errorCode = typeof error?.code === 'string' ? error.code : 'pairing/bad-request'
      const status = errorCode === 'pairing/body-too-large'
        ? 413
        : (errorCode === 'pairing/body-timeout' || errorCode === 'pairing/body-aborted' ? 408 : 400)
      /* A body we could not finish reading leaves the connection in an unknown
         position, so it is closed rather than reused. */
      const extra = status === 413 || status === 408 ? { connection: 'close' } : undefined
      sendError(
        res,
        status,
        errorCode,
        status === 413
          ? 'The pairing request body is too large.'
          : (status === 408 ? 'The pairing request body did not arrive in time.' : 'The pairing request could not be read.'),
        extra,
      )
      return
    }

    const pairId = typeof payload.pairId === 'string' ? payload.pairId.trim() : ''
    const code = typeof payload.code === 'string' ? payload.code.trim() : ''
    if (pairId === '' || code === ''
      || pairId.length > MAX_PAIR_ID_LENGTH || code.length > MAX_CODE_INPUT_LENGTH) {
      /* Refused BEFORE the budget: this request cannot guess a code, and a client
         that sends a malformed body must not be able to lock a legitimate address
         out of pairing. */
      sendError(res, 400, 'pairing/bad-request', 'A pairing id and a pairing code are required.')
      return
    }

    /* The single credential comparison, and the single place both budgets live.
       `source` is the real client: `pairing.js` keeps the per-source window, so
       passing it is what makes "rotating the pairId" not reset the budget.
       `clientAddress` answers the socket peer for a LAN connection and Cloudflare's
       `CF-Connecting-IP` for a managed tunnel (loopback socket only) — without it
       every public request would share one bucket keyed `127.0.0.1`. */
    const source = clientAddress(req)
    let redeemed
    try {
      redeemed = pairing.redeem(pairId, code, source === undefined ? {} : { source })
    } catch (error) {
      const errorCode = typeof error?.code === 'string' && error.code.startsWith('pairing/')
        ? error.code
        : 'pairing/internal'
      /* NOT audited here. `pairing.js` reported every spent guess through its own
         `onFailure` — once, at the point the budget was debited, and only for a
         genuine guess (`expired` / `used` stay silent). Auditing again would
         double every line and make "one pair_failed per attempt" false. */
      emit(logger, 'debug', `[remote-control] pairing refused (${errorCode})`)
      sendError(res, statusForFailure(errorCode), errorCode, messageForFailure(errorCode))
      return
    }

    /* From here the pair is CONSUMED. A failure below (a full disk, a damaged
       table) cannot be recovered by retrying this request — the code is spent — so
       the response says "could not complete" and the user asks for a new code. */
    let jwt
    let device
    try {
      const ua = headerValue(req, 'user-agent')
      const name = describeUserAgent(ua)
      device = store.addDevice({
        id: createDeviceId(random),
        name,
        /* No `tokenHash`: the credential is the JWT below, and a hash of it would
           be a second verifier nobody reads (`research/jwt-device-credential.md`
           §3.6). `id` IS the credential's `sub`, so the row and the token are
           bound at creation. */
        ua: typeof ua === 'string' ? ua.slice(0, MAX_UA_LENGTH) : '',
      })
      jwt = signDeviceToken(
        { sub: device.id, name: device.name, ttlSeconds: maxAgeSeconds },
        jwtKey,
        { now, random },
      )
    } catch (error) {
      emit(logger, 'error', `[remote-control] the paired device could not be stored (${describeFailure(error)})`)
      sendError(res, 500, 'pairing/store-failed', 'The paired device could not be stored. Ask the desktop panel for a new code.')
      return
    }

    /* `pairId` is the only identifier recorded: it is an opaque `pair_*` value, and
       the clear code is not in scope here at all — which is the structural reason a
       pairing code cannot reach the trail (`logging-guidelines.md`). */
    record({
      event: 'pair',
      deviceId: device.id,
      ip: source,
      meta: { pairId: redeemed.pairId },
    })
    emit(
      logger,
      'info',
      `[remote-control] device paired: ${device.id} (${device.name}) from ${source ?? 'unknown address'}`,
    )

    sendRedirect(res, 303, '/', {
      'set-cookie': deviceCookie(cookieName, jwt, maxAgeSeconds),
    })
  }

  /**
   * Answer one request on the pairing path.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @returns {Promise<void>} Never rejects.
   */
  async function dispatch(req, res) {
    try {
      if (!isPairingPath(req?.url)) {
        /* Only reachable if a caller routed a non-pairing target here. Answering
           404 keeps this module's surface exactly one path wide. */
        sendError(res, 404, 'pairing/not-found', 'There is no such endpoint.')
        return
      }

      const method = typeof req?.method === 'string' ? req.method.toUpperCase() : ''
      if (method === 'GET' || method === 'HEAD') {
        servePage(req, res)
        return
      }
      if (method === 'POST') {
        await handlePost(req, res)
        return
      }
      sendError(res, 405, 'gateway/method-not-allowed', 'This endpoint accepts GET, HEAD or POST.', {
        allow: 'GET, HEAD, POST',
      })
    } catch {
      /* Belt and braces on top of each handler's own guards: an exception here
         would otherwise reach the server's request listener as a bare reset. */
      emit(logger, 'error', '[remote-control] the pairing route failed unexpectedly')
      if (res.headersSent === true) res.destroy()
      else sendError(res, 500, 'pairing/internal', 'The pairing request could not be completed.')
    }
  }

  /** Never rejects, so the request listener can call it without a `catch`. */
  function handle(req, res) {
    dispatch(req, res).catch(() => {
      try {
        if (res.headersSent === true) res.destroy()
        else sendError(res, 500, 'pairing/internal', 'The pairing request could not be completed.')
      } catch {
        /* the response is already unusable */
      }
    })
  }

  return { path: PAIRING_ROUTE_PATH, handle }
}

/**
 * Describe an error for a log line without its message.
 *
 * A `code` is what an operator greps for and it never quotes a value; `message` is
 * used only when there is no code at all. Neither can carry the pairing code,
 * because neither is built from it.
 *
 * @param {unknown} error
 * @returns {string}
 */
function describeFailure(error) {
  if (error === null || typeof error !== 'object') return 'unknown error'
  if (typeof error.code === 'string' && error.code !== '') return error.code
  if (typeof error.message === 'string' && error.message !== '') return error.message
  return 'unknown error'
}
