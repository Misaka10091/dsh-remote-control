/**
 * The action classifier.
 *
 * `design.md` §6 makes one deliberate trade: the gateway does not understand DSH
 * semantics, so a request is classified by PATH PREFIX + METHOD, and anything
 * unrecognized records NOTHING (「未识别动作暂不记录」, 2026-10-19 — it used to be
 * recorded as `unknown`). These tests exist to keep that trade honest in both
 * directions — the mapping must actually recognize what it claims to, and it must
 * stay silent rather than guess when a path changes.
 *
 * The prefixes asserted here were measured against the installed host
 * (`@deepseek-ai/dsh-0.2.0-rc.2`); the reasoning is in `classify.js`. If a future
 * DSH renames a route, the test that fails is `classify recognizes the documented
 * prefixes` — and the correct fix is to update the rule AND the comment, not to
 * add a fallback that would guess.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { AUDIT_EVENTS } from '../src/host/audit.js'
import { classificationRules, classify, classifyUpgrade, upgradeClassificationRules } from '../src/host/classify.js'

/* ------------------------------------------------------------------ *
 * The known prefixes
 * ------------------------------------------------------------------ */

test('classify recognizes the documented prefixes', () => {
  assert.equal(classify('POST', '/api/session/prompt'), 'send_message')
  assert.equal(classify('POST', '/api/session/cancel'), 'stop_task')
  assert.equal(classify('POST', '/api/$events/result'), 'approval_answer')
})

test('the method is part of the rule, not just the path', () => {
  /* A GET on a write route is not that write. Without this a browser preflight,
     a health probe or a cache revalidation would be recorded as a message the
     user never sent. */
  assert.equal(classify('GET', '/api/session/prompt'), null)
  assert.equal(classify('HEAD', '/api/session/cancel'), null)
  assert.equal(classify('OPTIONS', '/api/$events/result'), null)
  assert.equal(classify('post', '/api/session/prompt'), 'send_message', 'methods are case-insensitive')
})

test('a matching prefix also matches its sub-paths', () => {
  /* The official transport is a PREFIX route (`kind: 'prefix'`, `/api`), and a
     method can gain a sub-segment without becoming a different action. Matching
     `p` and `p/…` is what makes the rule survive that. */
  assert.equal(classify('POST', '/api/session/prompt/extra'), 'send_message')
  assert.equal(classify('POST', '/api/session/cancel/'), 'stop_task')
  /* But not a LONGER name that merely starts with the same characters. */
  assert.equal(classify('POST', '/api/session/promptly'), null)
  assert.equal(classify('POST', '/api/session/cancelled'), null)
})

test('a query string does not defeat the match', () => {
  assert.equal(classify('POST', '/api/session/prompt?stream=1'), 'send_message')
  assert.equal(classify('POST', '/api/session/cancel?sessionId=sess_1'), 'stop_task')
})

/* ------------------------------------------------------------------ *
 * Degradation
 * ------------------------------------------------------------------ */

test('an unrecognized write records nothing instead of guessing', () => {
  /* The measured reason this matters: `design.md` §6's own example was
     `POST /api/...sendMessage`, and NO such path exists on the installed host.
     Had the classifier taken that literally, every real message would have been
     silently missing from the trail.

     Since 2026-10-19 the answer for such a path is `null`, not `unknown`: a row
     that names no action told the reader nothing and buried the events they were
     looking for (the DSH transport's own writes are unrecognized by design). */
  assert.equal(classify('POST', '/api/session/sendMessage'), null)
  assert.equal(classify('POST', '/api/some/future/route'), null)
  assert.equal(classify('POST', '/api/session/control'), null)
  assert.equal(classify('DELETE', '/api/session/1'), null)
  assert.equal(classify('PATCH', '/api/workspace/rename'), null)
})

test('a read is never classified, so the trail does not fill with streams', () => {
  /* `send_message` / `stop_task` / `approval_answer` all mutate. A GET (or the
     endless SSE reads a live session issues) is not an action, and `null` — not
     `'unknown'` — is the answer that means "record nothing". */
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'get', 'head']) {
    assert.equal(classify(method, '/api/session/list'), null, method)
  }
})

test('a request with no usable target records nothing', () => {
  for (const url of [undefined, '', null]) {
    assert.equal(classify('POST', url), null, String(url))
  }
  assert.equal(classify(undefined, '/api/session/prompt'), null, 'no method, no classification')
})

test('the admin API path is never classified as a device action', () => {
  /* It lives on the official loopback server and is refused by the gateway
     outright, so a request for it on this port is a probe. Recording it as an
     action would misattribute it to whatever device sent it — and since
     2026-10-19 a probe is not recorded at all. */
  assert.equal(classify('POST', '/remote-control/api/devices/dev_1/revoke'), null)
  assert.equal(classify('GET', '/remote-control/pair'), null, 'a read records nothing')
  assert.equal(classify('POST', '/remote-control/pair'), null)
})

test('every classifier answer is a member of the closed event set, or null', () => {
  /* The two modules must not drift: `audit.record` refuses a non-member, so a
     typo here would turn a real action into a silent no-op. */
  const paths = [
    '/api/session/prompt', '/api/session/cancel', '/api/$events/result',
    '/api/remote.mux', '/api/unknown', '/', '/remote-control/api', '/admin',
  ]
  for (const path of paths) {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      const event = classify(method, path)
      if (event === null) continue
      assert.ok(AUDIT_EVENTS.includes(event), `${method} ${path} -> ${event} is not an audit event`)
    }
  }
  for (const path of paths) {
    const upgrade = classifyUpgrade(path)
    if (upgrade === null) continue
    assert.ok(AUDIT_EVENTS.includes(upgrade), path)
  }
})

/* ------------------------------------------------------------------ *
 * Upgrades
 * ------------------------------------------------------------------ */

test('an admitted multiplexed upgrade is a connect; any other channel is not recorded', () => {
  assert.equal(classifyUpgrade('/api/remote.mux'), 'connect')
  assert.equal(classifyUpgrade('/api/remote.mux?generation=1'), 'connect')
  assert.equal(classifyUpgrade('/api/some-future.mux'), null)
  assert.equal(classifyUpgrade('/'), null)
  assert.equal(classifyUpgrade(undefined), null)
})

test('an upgrade records only a channel this hop can name', () => {
  /* A handshake is always an action, but 「未识别动作暂不记录」 applies to the
     upgrade path too: only the multiplexed channel has a name, and an unnamed one
     is dropped instead of being labelled `unknown`. */
  assert.equal(classifyUpgrade('/api/remote.mux'), 'connect')
  for (const path of ['/anything', '', undefined]) {
    assert.equal(classifyUpgrade(path), null, String(path))
  }
})

/* ------------------------------------------------------------------ *
 * The rule table itself
 * ------------------------------------------------------------------ */

test('the rule table is frozen and every entry names a real event', () => {
  const rules = classificationRules()
  assert.equal(Object.isFrozen(rules), true)
  assert.ok(rules.length >= 3)
  for (const rule of rules) {
    assert.equal(Object.isFrozen(rule), true, 'an entry cannot be mutated at runtime')
    assert.ok(AUDIT_EVENTS.includes(rule.event), rule.event)
    assert.match(rule.path, /^\//, 'every path is absolute')
    assert.ok(rule.path.length > 1 && !rule.path.endsWith('/'), `${rule.path} is normalized`)
  }
})

test('the rule table documents no path that does not exist', () => {
  /* A rule for a route the host does not have is a rule that can never fire —
     exactly the trap `design.md` §6's `sendMessage` example fell into. Each entry
     must be reachable by `classify` for its own method, which is what proves the
     table is a live mapping and not decoration. */
  for (const rule of classificationRules()) {
    assert.equal(
      classify(rule.method, rule.path),
      rule.event,
      `${rule.method} ${rule.path} does not resolve to ${rule.event}`,
    )
  }
})

test('the upgrade table is separate, because a handshake is a different question', () => {
  /* `/api/remote.mux` is reachable ONLY as a WebSocket handshake. Listing it in
     the HTTP table would claim a mapping that never fires (a plain GET on it is a
     404 upstream), and that claim is precisely what this suite is built to catch.
     This test caught it once already. */
  const upgradeRules = upgradeClassificationRules()
  assert.equal(Object.isFrozen(upgradeRules), true)
  assert.deepEqual(upgradeRules.map((rule) => rule.path), ['/api/remote.mux'])
  assert.equal(upgradeRules[0].event, 'connect')

  for (const rule of upgradeRules) {
    assert.equal(classifyUpgrade(rule.path), rule.event, `${rule.path} does not resolve`)
    /* And it must NOT be in the HTTP table under any method. A READ on it records
       nothing at all; a WRITE on it is an unrecognized action, which since
       2026-10-19 is not recorded either — never `connect`. */
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      assert.notEqual(classify(method, rule.path), rule.event, `${method} ${rule.path} must not be ${rule.event}`)
    }
    assert.equal(classify('GET', rule.path), null, 'a read on the mux records nothing')
    assert.equal(classify('POST', rule.path), null, 'a write on it is unrecognized, so it is not recorded')
  }
})
