/**
 * dsh-remote-control — the gateway's view of the origin fence.
 *
 * The fence itself lives in the domain half (`../origin.js`) since stage 4: the
 * admin API on the official port needs the SAME rules, and
 * `directory-structure.md` forbids `api.js` importing `gateway/*`. Splitting the
 * logic was the alternative and was rejected — two CSRF fences drift, and the
 * drift is a hole.
 *
 * This module therefore contains no logic. It exists so that
 *
 *   - `gateway/auth.js` keeps importing `./origin.js` (unchanged),
 *   - everything already importing `gateway/origin.js` keeps working,
 *   - and there is exactly one implementation of the rules.
 *
 * Read `../origin.js` for the four read arms, the five upgrade arms, and the
 * measured reasons each one is shaped the way it is.
 *
 * `checkAdminOrigin` is deliberately NOT re-exported here. It is the same fence
 * plus an arm that accepts the panel's own marker header, which exists only
 * because the dsh desktop app strips `Origin` from the requests it forwards to
 * the loopback port. This listener is reachable from a LAN page and answers
 * preflights through the proxy, so that arm must never widen it.
 */
export {
  authorityOf,
  checkOrigin,
  checkUpgradeOrigin,
  headerOf,
  isWriteMethod,
} from '../origin.js'
