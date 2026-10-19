/**
 * Access addresses: enumeration, parsing and resolution (`prd.md` R2/R3).
 *
 * Everything here is a pure function of its argument, which is why this suite
 * needs no server, no temp directory and no clock. The one injected seam is
 * `listLanAddresses(interfaces)` — a test that read the REAL `os.networkInterfaces`
 * would assert different things on the maintainer's laptop than in CI, and would
 * be the kind of test that gets deleted when it flakes.
 *
 * These rules are duplicated in the browser half (`src/client.js`), which cannot
 * import this module at all (single `__ModuleLoader__` factory, no top-level
 * import). `tests/client.test.mjs` runs both copies over the same matrix; this
 * file owns the rules themselves.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ADDRESS_TEXT_MAX,
  PUBLIC_ADDRESS_MAX,
  PUBLIC_LABEL_MAX,
} from '../src/host/constants.js'
import {
  defaultAccess,
  effectiveAddress,
  formatAddress,
  listLanAddresses,
  normalizeAccess,
  parseAddress,
  validateAccess,
} from '../src/host/addresses.js'

/** One `networkInterfaces()` entry. */
function nic(address, family = 'IPv4', internal = false) {
  return { address, family, internal }
}

/* ------------------------------------------------------------------ *
 * listLanAddresses
 * ------------------------------------------------------------------ */

test('only usable IPv4 addresses are enumerated', () => {
  /* The point of the list is "what a phone on this network could open", so the
     loopback, the link-local and the IPv6 entries are all noise that would make
     the default selection wrong. */
  const list = listLanAddresses({
    Loopback: [nic('127.0.0.1', 'IPv4', true), nic('::1', 'IPv6', true)],
    WLAN: [nic('192.168.1.5'), nic('fe80::1', 'IPv6'), nic('169.254.10.20')],
    Ethernet: [nic('10.0.0.7')],
  })

  assert.deepEqual(list, [
    { address: '192.168.1.5', iface: 'WLAN', private: true },
    { address: '10.0.0.7', iface: 'Ethernet', private: true },
  ])
})

test('home-LAN addresses sort first, then office/VPN, then public', () => {
  /* The first entry becomes the default selection, so it must be the address a
     phone can actually reach. `192.168/16` is the home-LAN default, `10/8` the
     common office/VPN range, `172.16/12` where Hyper-V and Docker live, and a
     public-range address is still offered — just behind the private ones. The
     secondary sort keeps the order stable across polls: a dropdown whose options
     shuffle is unusable. */
  const list = listLanAddresses({
    A: [nic('203.0.113.9')],
    B: [nic('192.168.1.5')],
    C: [nic('10.0.0.7')],
    D: [nic('172.16.4.4')],
    E: [nic('8.8.4.4')],
  })

  assert.deepEqual(list.map((entry) => entry.address), [
    '192.168.1.5',
    '10.0.0.7',
    '172.16.4.4',
    '203.0.113.9',
    '8.8.4.4',
  ])
  assert.deepEqual(list.map((entry) => entry.private), [true, true, true, false, false])
})

test('virtual adapters sort after every physical one, so they cannot win the default', () => {
  /* Real machine, 2026-10-19: Windows reported Hyper-V's `vEthernet (Default
     Switch)` at 172.29.240.1 and WSL's vEthernet at 172.30.192.1 beside the real
     `以太网 2` at 192.168.9.77. Private-first ordering made the Hyper-V switch the
     DEFAULT — an address no phone on the LAN can open. Physical adapters win,
     whatever their range. */
  const list = listLanAddresses({
    'vEthernet (Default Switch)': [nic('172.29.240.1')],
    'vEthernet (WSL (Hyper-V firewall))': [nic('172.30.192.1')],
    '以太网 2': [nic('192.168.9.77')],
    Tailscale: [nic('100.101.102.103')],
  })

  assert.deepEqual(list.map((entry) => entry.iface), [
    '以太网 2',
    'Tailscale',
    'vEthernet (Default Switch)',
    'vEthernet (WSL (Hyper-V firewall))',
  ])
  /* Tailscale is not classed as virtual: a 100.64/10 address is exactly what a
     remote device uses on that overlay (`prd.md` recommends it), so it must stay
     a plain row near the top rather than be buried with the switches. */
  assert.equal(list[0].address, '192.168.9.77')
})

test('the RFC 1918 boundaries are the ones classified as private', () => {
  const list = listLanAddresses({
    A: [nic('10.255.255.255'), nic('172.15.0.1'), nic('172.16.0.1'), nic('172.31.255.255'), nic('172.32.0.1'), nic('192.168.0.1')],
  })
  const byAddress = new Map(list.map((entry) => [entry.address, entry.private]))
  assert.equal(byAddress.get('10.255.255.255'), true)
  assert.equal(byAddress.get('172.15.0.1'), false, '172.15 is outside 172.16/12')
  assert.equal(byAddress.get('172.16.0.1'), true)
  assert.equal(byAddress.get('172.31.255.255'), true)
  assert.equal(byAddress.get('172.32.0.1'), false, '172.32 is outside 172.16/12')
  assert.equal(byAddress.get('192.168.0.1'), true)
})

test('a loopback row is dropped even when the platform did not flag it internal', () => {
  /* `prd.md` acceptance 3 says non-loopback, and Node's `internal` flag is only
     the platform's way of saying so. If a host reports `127.0.0.1` without it (a
     second loopback alias, a platform quirk), the panel must still not offer the
     one address no other device can reach — least of all as the DEFAULT, which is
     what the private-first sort would make it. */
  const list = listLanAddresses({
    Loopback: [nic('127.0.0.1'), nic('127.1.2.3')],
    WLAN: [nic('192.168.1.5')],
  })
  assert.deepEqual(list, [{ address: '192.168.1.5', iface: 'WLAN', private: true }])

  /* And with nothing else on the host, the answer is an empty list — the panel's
     "no local network address" state — never a loopback row. */
  assert.deepEqual(listLanAddresses({ Loopback: [nic('127.0.0.1')] }), [])
})

test('one address on two interfaces is listed once', () => {
  /* A bridge and its member interface report the same address; two identical rows
     that select the same thing are noise in a dropdown. */
  const list = listLanAddresses({
    'br0': [nic('192.168.1.5')],
    'eth0': [nic('192.168.1.5')],
  })
  assert.deepEqual(list, [{ address: '192.168.1.5', iface: 'br0', private: true }])
})

test('the listing accepts the numeric family Node 16 reported, and never throws', () => {
  /* `family` was the number 4 before Node 18; the older field shape must not
     silently empty the list on a host that still reports it. */
  assert.deepEqual(listLanAddresses({ eth0: [nic('10.1.2.3', 4)] }), [
    { address: '10.1.2.3', iface: 'eth0', private: true },
  ])

  /* Garbage in, empty list out — this runs during a state read, where a throw
     would turn the whole panel into a 500. `undefined` is deliberately NOT in the
     list: it selects the default `os.networkInterfaces()` argument, which is a
     different (and untestable here) code path. */
  for (const input of [null, [], 'nope', 42]) {
    assert.deepEqual(listLanAddresses(input), [], `listLanAddresses(${JSON.stringify(input)})`)
  }
  assert.deepEqual(listLanAddresses({ eth0: 'not a list' }), [])
  assert.deepEqual(listLanAddresses({ eth0: [null, 'x', { address: 'nonsense' }] }), [])
})

/* ------------------------------------------------------------------ *
 * parseAddress
 * ------------------------------------------------------------------ */

test('every documented address form is accepted', () => {
  const accepted = new Map([
    ['192.168.1.5', { scheme: null, host: '192.168.1.5', port: null }],
    ['1.2.3.4', { scheme: null, host: '1.2.3.4', port: null }],
    ['home.example.com', { scheme: null, host: 'home.example.com', port: null }],
    ['home.example.com:3090', { scheme: null, host: 'home.example.com', port: 3090 }],
    ['dsh.lan:65535', { scheme: null, host: 'dsh.lan', port: 65535 }],
    ['http://dsh.lan', { scheme: 'http', host: 'dsh.lan', port: null }],
    ['https://dsh.example.net', { scheme: 'https', host: 'dsh.example.net', port: null }],
    ['https://dsh.example.net:8443', { scheme: 'https', host: 'dsh.example.net', port: 8443 }],
    ['HTTPS://UPPER.example', { scheme: 'https', host: 'UPPER.example', port: null }],
    ['[::1]', { scheme: null, host: '[::1]', port: null }],
    ['[::1]:3090', { scheme: null, host: '[::1]', port: 3090 }],
    ['[2001:db8::1]:8443', { scheme: null, host: '[2001:db8::1]', port: 8443 }],
    /* Trimmed, not rejected: a paste from a terminal comes with whitespace. */
    ['  192.168.1.5  ', { scheme: null, host: '192.168.1.5', port: null }],
  ])
  for (const [text, expected] of accepted) {
    assert.deepEqual(parseAddress(text), expected, `accepted: ${JSON.stringify(text)}`)
  }
})

test('anything that is not a bare authority is refused', () => {
  /* Refused rather than repaired, and each class for its own reason:
     - a path/query/fragment would be stored and then rendered next to the pairing
       fragment (this value is an AUTHORITY, not a URL);
     - userinfo is where credentials live and nothing here takes one;
     - a non-http(s) scheme would make the panel build a link to a different
       protocol;
     - port 0 and 65536 are not ports;
     - an unbracketed multi-colon string has an ambiguous port, and guessing is how
       a link ends up on a port the user never chose. */
  const refused = [
    '', '   ', '192.168.1.5 3090', '192.168.1.5:0', '192.168.1.5:65536',
    '192.168.1.5:', '192.168.1.5:abc', '192.168.1.5:12 34', '192.168.1.5:-1',
    '192.168.1.5:0x10', '192.168.1.5:3090.5',
    'http://dsh.lan/path', 'http://dsh.lan/?q=1', 'http://dsh.lan/#frag',
    'dsh.lan/', '//dsh.lan', 'dsh.lan:3090/pair',
    'user@dsh.lan', 'http://user:pass@dsh.lan',
    'ftp://dsh.lan', 'file:///etc/passwd', 'javascript:alert(1)',
    '::1', '[::1', '[zz]:3090', '[]:3090',
    'dsh..lan', '-dsh.lan', 'dsh-.lan', '.dsh.lan', 'dsh.lan.',
    'a'.repeat(ADDRESS_TEXT_MAX + 1),
  ]
  for (const text of refused) {
    assert.equal(parseAddress(text), null, `refused: ${JSON.stringify(text)}`)
  }
  /* Not a string at all. */
  for (const value of [null, undefined, 42, {}, []]) {
    assert.equal(parseAddress(value), null, `refused: ${JSON.stringify(value)}`)
  }
})

test('the documented length limit is inclusive', () => {
  /* 253 is the DNS name limit; the value at the boundary must still parse, or the
     limit is off by one and a legal name refuses to save. Each label stays within
     the 63-character label limit, so this exercises the total-length bound and not
     the per-label one. */
  const host = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.')
  assert.equal(host.length, ADDRESS_TEXT_MAX)
  assert.notEqual(parseAddress(host), null)
  assert.equal(parseAddress(`${host}e`), null)
})

/* ------------------------------------------------------------------ *
 * formatAddress
 * ------------------------------------------------------------------ */

test('an address round-trips through formatAddress without inventing a scheme', () => {
  /* Storing a guessed `http://` would make a later change to the default
     invisible in the file. */
  for (const text of ['192.168.1.5', 'home.example.com:3090', 'https://dsh.example.net', '[::1]:3090']) {
    assert.equal(formatAddress(parseAddress(text)), text)
  }
  assert.equal(formatAddress(null), '')
  assert.equal(formatAddress({}), '')
  assert.equal(formatAddress({ host: '' }), '')
  /* Out-of-range ports are dropped rather than printed. */
  assert.equal(formatAddress({ scheme: 'http', host: 'dsh.lan', port: 0 }), 'http://dsh.lan')
  assert.equal(formatAddress({ scheme: 'http', host: 'dsh.lan', port: 70_000 }), 'http://dsh.lan')
  /* An unknown scheme is dropped, not echoed. */
  assert.equal(formatAddress({ scheme: 'ftp', host: 'dsh.lan', port: 21 }), 'dsh.lan:21')
})

/* ------------------------------------------------------------------ *
 * effectiveAddress
 * ------------------------------------------------------------------ */

const LAN = [
  { address: '192.168.1.5', iface: 'WLAN', private: true },
  { address: '10.0.0.7', iface: 'Ethernet', private: true },
]

const BOOK = [
  { id: 'pub_a', label: 'home', address: 'home.example.com:3090' },
  { id: 'pub_b', label: 'tunnel', address: 'https://dsh.example.net' },
]

test('LAN mode uses the stored choice while it is still on this machine', () => {
  assert.equal(effectiveAddress({ mode: 'lan', lanAddress: '10.0.0.7' }, LAN), '10.0.0.7')
  assert.equal(effectiveAddress({ mode: 'lan', lanAddress: '' }, LAN), '192.168.1.5', 'empty means the first entry')
})

test('LAN mode falls back to the first address, without writing anything', () => {
  /* A cable unplugged for a minute must not rewrite the user's choice: the
     resolution happens here, at link time, and `GET /state` keeps returning the
     stored value so the panel can say "your address is gone". */
  const access = { mode: 'lan', lanAddress: '172.16.0.9' }
  assert.equal(effectiveAddress(access, LAN), '192.168.1.5')
  assert.equal(access.lanAddress, '172.16.0.9', 'the stored choice is untouched')
  assert.equal(effectiveAddress(access, []), null, 'no interfaces, no address')
  assert.equal(effectiveAddress(access, undefined), null)
  assert.equal(effectiveAddress(null, LAN), '192.168.1.5', 'a missing access block still resolves')
})

test('public mode reads the book, never the interfaces', () => {
  assert.equal(effectiveAddress({ mode: 'public', public: BOOK, selectedPublicId: 'pub_b' }, LAN), 'https://dsh.example.net')
  /* A dangling selection resolves to the first row, not to the LAN list. */
  assert.equal(effectiveAddress({ mode: 'public', public: BOOK, selectedPublicId: 'pub_gone' }, LAN), 'home.example.com:3090')
  assert.equal(effectiveAddress({ mode: 'public', public: BOOK, selectedPublicId: null }, LAN), 'home.example.com:3090')
  /* An empty book means NO address, which is what makes the link fall back to the
     page host and the panel show the honest loopback hint. */
  assert.equal(effectiveAddress({ mode: 'public', public: [], selectedPublicId: null }, LAN), null)
  assert.equal(effectiveAddress({ mode: 'public' }, LAN), null)
})

test('an unknown or missing mode behaves as LAN', () => {
  /* The reader must never end up in `public` by accident: that is the mode whose
     reachability this plugin cannot check. */
  assert.equal(effectiveAddress({ mode: 'nonsense', lanAddress: '10.0.0.7' }, LAN), '10.0.0.7')
  assert.equal(effectiveAddress({}, LAN), '192.168.1.5')
  assert.equal(effectiveAddress({ mode: 'public', public: [null, 'x'] }, LAN), null)
})

/* ------------------------------------------------------------------ *
 * defaultAccess / normalizeAccess / validateAccess
 * ------------------------------------------------------------------ */

test('defaultAccess is a fresh, fully-defaulted object', () => {
  const first = defaultAccess()
  assert.deepEqual(first, { mode: 'lan', lanAddress: '', public: [], selectedPublicId: null })
  assert.notEqual(defaultAccess(), first, 'a shared literal would leak one click into the next mount')
  assert.notEqual(defaultAccess().public, first.public)
})

test('normalizeAccess keeps everything usable and repairs the rest', () => {
  /* The LENIENT policy, which is what the store reads a hand-edited file with:
     each unusable field falls back on its own and each unusable row is dropped. */
  assert.deepEqual(normalizeAccess({ mode: 'nonsense', lanAddress: 42, public: 'nope', selectedPublicId: 7 }), {
    mode: 'lan',
    lanAddress: '',
    public: [],
    selectedPublicId: null,
  })

  assert.deepEqual(normalizeAccess({
    mode: 'public',
    lanAddress: '192.168.1.5',
    public: [
      { id: 'pub_a', label: 'ok', address: ' home.example.com:3090 ' },
      { id: 'pub_a', label: 'duplicate id', address: 'other.example' },
      { id: '', address: 'dropped.example' },
      { id: 'pub_c', label: 'x'.repeat(PUBLIC_LABEL_MAX + 1), address: 'dropped.example' },
      { id: 'pub_d', address: 'has/a/path' },
      null,
    ],
    selectedPublicId: 'pub_a',
  }), {
    mode: 'public',
    lanAddress: '192.168.1.5',
    /* Only the first row survives: the duplicate id, the empty id, the over-long
       label and the unusable address are each dropped, and the address is
       normalized on the way in. */
    public: [{ id: 'pub_a', label: 'ok', address: 'home.example.com:3090' }],
    selectedPublicId: 'pub_a',
  })

  /* An over-long book is truncated in display order, not discarded. */
  const many = Array.from({ length: PUBLIC_ADDRESS_MAX + 4 }, (unused, index) => ({
    id: `pub_${String(index)}`,
    label: '',
    address: `host${String(index)}.example`,
  }))
  const truncated = normalizeAccess({ mode: 'public', public: many })
  assert.equal(truncated.public.length, PUBLIC_ADDRESS_MAX)
  assert.equal(truncated.public[0].id, 'pub_0')
  assert.equal(truncated.public[PUBLIC_ADDRESS_MAX - 1].address, `host${String(PUBLIC_ADDRESS_MAX - 1)}.example`)

  /* A selection naming no row becomes null, which readers resolve to the first. */
  assert.equal(normalizeAccess({ mode: 'public', public: BOOK, selectedPublicId: 'pub_gone' }).selectedPublicId, null)
  assert.equal(normalizeAccess({ mode: 'public', public: [] }).selectedPublicId, null)

  /* Garbage of every kind is survivable. */
  for (const value of [null, undefined, 42, 'nope', [], true]) {
    assert.deepEqual(normalizeAccess(value), defaultAccess(), `normalizeAccess(${JSON.stringify(value)})`)
  }
})

test('validateAccess refuses exactly what normalizeAccess had to repair', () => {
  /* The STRICT policy: `POST /settings` answers 400 instead of rewriting the
     caller's input, so the panel and the user agree on what was saved. Same rules
     as the lenient reader — and this test is the proof that they are the same
     rules, by running the same inputs down both. */
  const invalid = [
    null,
    'nope',
    [],
    { mode: 'sideload' },
    { lanAddress: 42 },
    { lanAddress: 'has/a/path' },
    { lanAddress: '192.168.1.5:3090' },
    { lanAddress: 'http://192.168.1.5' },
    { public: 'nope' },
    { public: [{ id: 'pub_a', address: 'home.example.com' }, { id: 'pub_a', address: 'other.example' }] },
    { public: [{ id: '', address: 'home.example.com' }] },
    { public: [{ id: 'pub_a', label: 'x'.repeat(PUBLIC_LABEL_MAX + 1), address: 'home.example.com' }] },
    { public: [{ id: 'pub_a', address: 'has/a/path' }] },
    { public: Array.from({ length: PUBLIC_ADDRESS_MAX + 1 }, (unused, index) => ({ id: `pub_${String(index)}`, address: `h${String(index)}.example` })) },
  ]
  for (const value of invalid) {
    const result = validateAccess(value)
    assert.equal(result.ok, false, `refused: ${JSON.stringify(value)}`)
    assert.equal(typeof result.message, 'string')
    assert.ok(result.message.length > 0, 'a refusal must say something the panel can render')
    /* And the lenient reader took the same input without throwing — proving the
       two policies share one grammar rather than two. */
    assert.equal(typeof normalizeAccess(value), 'object')
  }
})

test('validateAccess normalizes a valid value into what gets stored', () => {
  const result = validateAccess({
    mode: 'public',
    lanAddress: ' 192.168.1.5 ',
    public: [
      { id: 'pub_a', label: ' 家里 DDNS ', address: ' home.example.com:3090 ' },
      { id: 'pub_b', address: 'HTTPS://dsh.example.net' },
    ],
    selectedPublicId: 'pub_b',
  })
  assert.deepEqual(result, {
    ok: true,
    access: {
      mode: 'public',
      lanAddress: '192.168.1.5',
      public: [
        { id: 'pub_a', label: '家里 DDNS', address: 'home.example.com:3090' },
        { id: 'pub_b', label: '', address: 'https://dsh.example.net' },
      ],
      selectedPublicId: 'pub_b',
    },
  })

  /* An absent mode means `lan`, and an absent selection means the first row. */
  assert.deepEqual(validateAccess({}), {
    ok: true,
    access: { mode: 'lan', lanAddress: '', public: [], selectedPublicId: null },
  })
  /* A selection that names no row is nulled rather than refused: that is how
     "delete the row I had selected" is expressed in one request. */
  assert.deepEqual(validateAccess({ mode: 'public', selectedPublicId: 'pub_gone' }), {
    ok: true,
    access: { mode: 'public', lanAddress: '', public: [], selectedPublicId: null },
  })
})
