/**
 * dsh-remote-control — turning a proxied request into an audit event.
 *
 * ## The trade-off this module IS
 *
 * `design.md` §6 is explicit: the gateway does not understand DSH semantics. It
 * is a byte-forwarding hop, and that is precisely why a DSH upgrade cannot break
 * it (`prd.md` constraint 6 — "鉴权放在入口层按路径前缀拦截，不逐个改写 DSH
 * 内部接口"). The moment this module started importing DSH's route table, the
 * plugin would gain a dependency on internal API shapes and would produce an
 * audit trail that silently stops working on the next release.
 *
 * So classification is **path prefix + method only**, and the answer for an
 * unrecognized request is `null` — i.e. record nothing (see below). `design.md`
 * §6 makes that trade explicitly: 宁可漏记也不耦合内部接口.
 *
 * ### Why an unrecognized action is NOT recorded (2026-10-19)
 *
 * Until 2026-10-19 an unrecognized write was recorded as `unknown`, on the theory
 * that "degrade rather than guess" still left a trace. In practice the panel's
 * audit tab filled with 「未识别动作」 rows that named no action and no device the
 * user could act on — DSH's own transport writes (`/api/session/control` and the
 * streaming endpoints) are unrecognized by design, so the rows were constant
 * noise around the handful of events the trail exists for (`pair`, `connect`,
 * `send_message`, `stop_task`, `approval_answer`, `revoke`, `pair_failed`).
 * A user asking for「未识别动作暂不记录」is asking for exactly that: the trail
 * records KNOWN actions, and an unrecognized write is dropped rather than labelled
 * with a name that says nothing.
 *
 * The `unknown` EVENT remains in `AUDIT_EVENTS` (`audit.js`) because it is still
 * the grammar of files written before this change: dropping it from the closed set
 * would make those lines unreadable and unfilterable. It is read-only legacy.
 *
 * The mapping stays a closed table, so the day DSH renames a path the event
 * silently disappears — which is the accepted cost of not coupling to internal
 * APIs, and is why `tests/classify.test.mjs` pins every rule as reachable.
 *
 * ## The mapping, and where each prefix comes from
 *
 * Measured against the installed host (`@deepseek-ai/dsh-0.2.0-rc.2`), the web
 * transport is a JSON-RPC channel on the `/api` prefix
 * (`@deepseek-ai/dsh-client-connection`: `API_PATH = "/api"`, `kind: 'prefix'`),
 * and every method is a `<channel>/<namespace>/<method>` path called with
 * `POST`:
 *
 * | matched prefix                        | event             | why |
 * |---------------------------------------|-------------------|-----|
 * | `POST /api/session/prompt`            | `send_message`    | the only call that submits user text into a turn |
 * | `POST /api/session/cancel`            | `stop_task`       | the stop button — cancels the active turn |
 * | `POST /api/session/control`           | not recorded      | the streaming control channel; direction is ambiguous, so it is NOT counted as a stop |
 * | `POST /api/$events/result`            | `approval_answer` | the client's reply into a Host waterfall (approval, question, plan) |
 * | `POST /api/remote.mux`                | `connect`         | unreachable over HTTP (it is an upgrade) — listed for completeness |
 * | `GET  /remote-control/api/*`          | not recorded      | never proxied; see below |
 *
 * ### Why NOT `sendMessage`
 *
 * No such path exists in the installed host. The nearest candidates were checked
 * and rejected:
 *
 *   - `POST /api/session/prompt` is the method that carries a user prompt into a
 *     session (its typert manifest declares `session.prompt` with a `request`
 *     parameter). That is what "sent a message" means from a phone.
 *   - `POST /api/session/control` is a STREAM the client opens; it carries
 *     control *events*, not the prompt, and treating it as a stop would mislabel
 *     every streaming session as "the user stopped the task".
 *
 * An earlier draft of `design.md` §6 wrote `POST /api/...sendMessage` as an
 * example. That path does not exist on this host, which is exactly why the
 * classifier degrades instead of hard-coding a guess: had the prefix been taken
 * literally, every `send_message` would have been silently recorded as
 * `unknown`.
 *
 * ### Why the approval answer is on `/api/$events/result`
 *
 * There is no `/api/approval/...` path. The client answers a pending waterfall
 * (approval request, question, plan confirmation) by POSTing its outcome to the
 * gateway's own internal unary endpoint `$events/result`
 * (`@deepseek-ai/dsh-api-gateway`: `REMOTE_EVENT_RESULT_ENDPOINT = "$events/result"`,
 * called as `connection.rpc.call("/api", REMOTE_EVENT_RESULT_ENDPOINT, …)`).
 * That is the only client→host write on the wire that means "the user answered".
 * It is also used for plan and question replies, so the event name is the
 * documented `approval_answer` — the audit records the ACTION class, not which
 * widget produced it.
 *
 * `$` is legal in an endpoint segment (`ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/`),
 * and Node's `URL` leaves it alone in a pathname.
 *
 * ## Reads are never classified
 *
 * A `GET` is not an action worth auditing: `send_message`, `stop_task` and
 * `approval_answer` all mutate state, and recording every streamed-token read
 * would drown the trail. Only write methods are classified; a read returns
 * `null`, i.e. "record nothing". `connect` / `disconnect` are emitted by the
 * WebSocket path, where a connection genuinely begins and ends.
 */

/**
 * Path-prefix rules, tried in order. The FIRST match wins, so a more specific
 * prefix must come before a more general one.
 *
 * Each entry's `path` is matched as a PREFIX against the request pathname, which
 * is what makes this resilient: a query string, a trailing segment or a version
 * suffix does not defeat it, while a renamed resource does — and then the answer
 * is `unknown` rather than a wrong label.
 */
const RULES = Object.freeze([
  Object.freeze({ method: 'POST', path: '/api/session/prompt', event: 'send_message' }),
  Object.freeze({ method: 'POST', path: '/api/session/cancel', event: 'stop_task' }),
  Object.freeze({ method: 'POST', path: '/api/$events/result', event: 'approval_answer' }),
])

/**
 * Upgrade routes, kept in a separate table because they are matched by a
 * different question.
 *
 * `/api/remote.mux` is deliberately NOT in {@link RULES}: it is reachable only as
 * a WebSocket handshake, and a `GET` on it over plain HTTP is not a `connect` —
 * it would 404 upstream. Putting it in the HTTP table would make the table claim
 * a mapping that never fires, which is exactly the defect that made
 * `tests/classify.test.mjs` assert "every rule is reachable" in the first place.
 */
const UPGRADE_RULES = Object.freeze([
  Object.freeze({ path: '/api/remote.mux', event: 'connect' }),
])

/** Methods that never produce an audit event, however they are routed. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Whether a method mutates state.
 *
 * @param {string | undefined} method
 * @returns {boolean}
 */
function isWrite(method) {
  if (typeof method !== 'string') return false
  return !SAFE_METHODS.has(method.toUpperCase())
}

/**
 * Extract the pathname from a request target, tolerating a garbage value.
 *
 * @param {string | undefined} target
 * @returns {string} The pathname, or '' when unparsable.
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
 * Classify one proxied HTTP request.
 *
 * Pure and side-effect free, so the mapping can be asserted without a server —
 * which is the only way a path-prefix table stays honest across DSH releases.
 *
 * @param {string | undefined} method
 * @param {string | undefined} url
 * @returns {string | null} A member of `AUDIT_EVENTS` for a KNOWN write worth
 *   recording; `null` for "record nothing" — a read, a request with no usable
 *   target, or a write this hop does not recognize (`未识别动作暂不记录`).
 */
export function classify(method, url) {
  /* Reads are not actions. `null` and not `'unknown'`: the trail must not fill
     with one line per streamed chunk. */
  if (!isWrite(method)) return null
  const pathname = pathnameOf(url)
  if (pathname === '') return null

  /* Requests this hop serves itself (the admin API lives on the official port,
     never here) are not DSH actions at all. A write on that prefix is a probe,
     and since 2026-10-19 a probe is not recorded: it has no action to name. */
  if (pathname === '/remote-control' || pathname.startsWith('/remote-control/')) return null

  const verb = method.toUpperCase()
  for (const rule of RULES) {
    if (rule.method !== verb) continue
    if (pathname === rule.path || pathname.startsWith(`${rule.path}/`)) return rule.event
  }
  /* Unrecognized: nothing is written. See the module note for why this is a
     deliberate silence rather than an `unknown` label. */
  return null
}

/**
 * Classify one WebSocket upgrade handshake.
 *
 * `connect` for the multiplexed channel, `null` for anything else. Only
 * `/api/remote.mux` is proxied in practice, and a channel this hop does not
 * recognize has no action to name — the same rule `classify` follows since
 * 2026-10-19.
 *
 * @param {string | undefined} url
 * @returns {string | null}
 */
export function classifyUpgrade(url) {
  const pathname = pathnameOf(url)
  for (const rule of UPGRADE_RULES) {
    if (pathname === rule.path || pathname.startsWith(`${rule.path}/`)) return rule.event
  }
  return null
}

/**
 * The classifier's mapping, exported for the tests above and for a future panel
 * that wants to explain what it is counting.
 *
 * @returns {ReadonlyArray<{ method: string, path: string, event: string }>}
 */
export function classificationRules() {
  return RULES
}

/**
 * The upgrade mapping, exported for the same reason.
 *
 * @returns {ReadonlyArray<{ path: string, event: string }>}
 */
export function upgradeClassificationRules() {
  return UPGRADE_RULES
}
