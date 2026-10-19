/**
 * The QR encoder, pinned against a reference implementation.
 *
 * `prd.md` R5 / `design.md` §3. An encoder verified only against itself is worse
 * than none: a symbol that looks like a QR code and does not scan is
 * indistinguishable, from the user's side, from a network fault. So the expected
 * values in `tests/fixtures/qr-reference.json` come from node-qrcode — a mature,
 * independent encoder — forced into the SAME mode this implementation uses.
 *
 * Two things the fixtures have to get right, both measured rather than assumed
 * (`research/qr-reference-vectors.md` §3):
 *
 *   - byte mode must be FORCED on the reference (`create([{ data, mode: 'byte' }])`).
 *     Left to itself node-qrcode splits a link into numeric / alphanumeric / byte
 *     runs, fits one version smaller, and the comparison would be against a symbol
 *     this encoder is not trying to produce.
 *   - version AND mask must be pinned for a bit-for-bit comparison. Mask selection
 *     is a penalty-score judgement and differs between implementations (the
 *     reference's N4 reads the 5% step differently from a literal reading of the
 *     rule), so only the `auto` group — which records what the reference CHOSE —
 *     tests version and mask selection at all.
 *
 * The fixture is plain JSON so it can be committed, diffed and re-generated
 * without shipping the reference tool: `qrcode` is a development-time dependency
 * that lives in `%TEMP%` and appears in no manifest (`prd.md` constraint 4).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const clientSource = readFileSync(path.join(repoRoot, 'src', 'client.js'), 'utf8')

/**
 * The smallest React the bundle will accept.
 *
 * The browser half has no DOM test environment (no jsdom, by design), so the way
 * to reach a pure function inside the factory is to execute the factory with a
 * stub module table. `createElement` records the tree instead of rendering it.
 */
const REACT_STUB = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useCallback: (fn) => fn,
}

/**
 * Materialize `src/client.js` against a fake `window.__ModuleLoader__`.
 *
 * @returns {{ bundle: any, required: string[] }}
 */
function loadClientBundle() {
  const registrations = []
  const required = []
  const previousWindow = globalThis.window
  globalThis.window = {
    __ModuleLoader__: {
      load: (registration) => {
        registrations.push(registration)
      },
    },
  }
  try {
    /* Not `import()`: this file is not an ES module, and importing it would test
       something other than what a browser does with it. */
    /* eslint-disable-next-line no-new-func */
    new Function(clientSource)()
  } finally {
    globalThis.window = previousWindow
  }

  assert.equal(registrations.length, 1, 'src/client.js must submit exactly one registration')
  const reactDom = { createPortal: (node) => node }
  const bundle = registrations[0].factory((specifier) => {
    required.push(specifier)
    if (specifier === 'react') return REACT_STUB
    if (specifier === 'react-dom') return reactDom
    throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
  })
  return { bundle, required }
}

const { bundle } = loadClientBundle()
const { encodeQr, qrPathData, qrViewBox } = bundle.internals

const fixture = JSON.parse(
  readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'qr-reference.json'), 'utf8'),
)

/**
 * The symbol as row strings, asserting every module really is a 0 or a 1.
 *
 * @param {{ size: number, modules: Uint8Array }} result
 * @returns {string[]}
 */
function rowsOf(result) {
  const rows = []
  for (let row = 0; row < result.size; row++) {
    let line = ''
    for (let col = 0; col < result.size; col++) {
      const value = result.modules[(row * result.size) + col]
      assert.ok(value === 0 || value === 1, `module (${row},${col}) is ${String(value)}, not a bit`)
      line += value === 1 ? '1' : '0'
    }
    rows.push(line)
  }
  return rows
}

/**
 * Paint a `d` attribute back into a matrix.
 *
 * The panel draws one `<path>` of horizontal runs, so the only honest way to check
 * the picture is to replay it: every `M x y h<n> v1 h-<n> z` fills `n` modules.
 *
 * @param {string} d
 * @param {number} size
 * @returns {Uint8Array}
 */
function paintPath(d, size) {
  const modules = new Uint8Array(size * size)
  const pattern = /M(\d+) (\d+)h(\d+)v1h-\3z/g
  let matched = 0
  let match
  while ((match = pattern.exec(d)) !== null) {
    const col = Number.parseInt(match[1], 10)
    const row = Number.parseInt(match[2], 10)
    const run = Number.parseInt(match[3], 10)
    assert.ok(row >= 0 && row < size, `run at row ${row} is outside the symbol`)
    assert.ok(col >= 0 && col + run <= size, `run at ${col}+${run} is outside the symbol`)
    for (let offset = 0; offset < run; offset++) {
      const target = (row * size) + col + offset
      assert.equal(modules[target], 0, `the path paints (${row},${col + offset}) twice`)
      modules[target] = 1
    }
    matched++
  }
  /* Every character of `d` belongs to a matched run: a stray prefix would silently
     reduce how much of the picture this check covers. */
  assert.equal(d.match(/M/g)?.length ?? 0, matched, 'every sub-path must be parsed')
  return modules
}

/** Byte-mode capacity per version at ECC level M, from the published table. */
const BYTE_CAPACITY_M = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412]

/* ---------------------------------------------------------------------- *
 * The fixture itself
 * ---------------------------------------------------------------------- */

test('the reference fixture is well formed and covers every text at every mask', () => {
  assert.match(fixture.generator, /mode: 'byte'/, 'the reference must be forced into byte mode')
  for (const [name, group] of [['fixed', fixture.fixed], ['auto', fixture.auto]]) {
    assert.ok(Array.isArray(group) && group.length > 0, `${name} must be a non-empty array`)
    for (const entry of group) {
      assert.equal(entry.ecc, 'M', `${name}: only ECC level M is implemented`)
      assert.ok(entry.version >= 1 && entry.version <= 15, `${name}: version out of range`)
      assert.equal(entry.size, (entry.version * 4) + 17, `${name}: size must follow the version`)
      assert.equal(entry.rows.length, entry.size, `${name}: one row per module row`)
      for (const row of entry.rows) {
        assert.equal(row.length, entry.size, `${name}: every row is one module wide per column`)
        assert.match(row, /^[01]+$/, `${name}: rows are 0/1 strings`)
      }
      assert.equal(entry.bytes, Buffer.byteLength(entry.text, 'utf8'), `${name}: byte count`)
    }
  }

  /* The fixed group must really pin all eight masks for every text, or "mask
     selection is not what this compares" would be an unverified claim. */
  const masksByText = new Map()
  for (const entry of fixture.fixed) {
    const masks = masksByText.get(entry.text) ?? []
    masks.push(entry.mask)
    masksByText.set(entry.text, masks)
  }
  assert.ok(masksByText.size >= 6, 'the fixed group must cover several texts')
  for (const [text, masks] of masksByText) {
    assert.deepEqual(
      [...masks].sort((left, right) => left - right),
      [0, 1, 2, 3, 4, 5, 6, 7],
      `every mask must be pinned for ${JSON.stringify(text.slice(0, 24))}`,
    )
  }
  /* And the auto group must be the one that records a CHOICE. */
  assert.equal(fixture.auto.length, masksByText.size + 2, 'auto group size')
})

/* ---------------------------------------------------------------------- *
 * Layer 1: bit-for-bit against the reference, version and mask pinned
 * ---------------------------------------------------------------------- */

test('every fixed version + mask produces the reference matrix bit for bit', () => {
  let compared = 0
  for (const entry of fixture.fixed) {
    const result = encodeQr(entry.text, { version: entry.version, mask: entry.mask })
    const where = `${entry.label} v${entry.version} mask ${entry.mask}`

    assert.equal(result.ok, true, where)
    assert.equal(result.version, entry.version, where)
    assert.equal(result.mask, entry.mask, where)
    assert.equal(result.size, entry.size, where)
    assert.deepEqual(rowsOf(result), entry.rows, where)
    compared++
  }
  /* 6 texts x 8 masks. A silent drop to 0 comparisons would otherwise pass. */
  assert.equal(compared, 48)
})

/* ---------------------------------------------------------------------- *
 * Layer 2: version and mask selection, against the reference's own choice
 * ---------------------------------------------------------------------- */

test('automatic version and mask match what the reference chose', () => {
  for (const entry of fixture.auto) {
    const result = encodeQr(entry.text)
    assert.equal(result.ok, true, entry.label)
    assert.equal(result.version, entry.version, `version selection: ${entry.label}`)
    assert.equal(result.mask, entry.mask, `mask selection: ${entry.label}`)
    assert.deepEqual(rowsOf(result), entry.rows, entry.label)
  }
})

/* ---------------------------------------------------------------------- *
 * Capacity and mode
 * ---------------------------------------------------------------------- */

test('byte-mode capacity matches the published table for versions 1 to 15', () => {
  /* This is the assertion that keeps the version table honest: `a` repeated to the
     published capacity must land on that version, and one more byte must move on.
     It independently checks the total-codeword and EC-codeword tables, and the
     16-bit character count that starts at v10. */
  for (let version = 1; version <= 15; version++) {
    const capacity = BYTE_CAPACITY_M[version - 1]
    const exact = encodeQr('a'.repeat(capacity))
    assert.equal(exact.ok, true, `${capacity} bytes must encode`)
    assert.equal(exact.version, version, `${capacity} bytes must be v${version}`)

    if (version === 15) break
    const over = encodeQr('a'.repeat(capacity + 1))
    assert.equal(over.ok, true, `${capacity + 1} bytes must still encode`)
    assert.equal(over.version, version + 1, `${capacity + 1} bytes must move to v${version + 1}`)
  }
})

test('a link past v15-M is refused, never truncated and never thrown', () => {
  assert.deepEqual(encodeQr('a'.repeat(413)), { ok: false, reason: 'too-long' })
  assert.deepEqual(encodeQr('a'.repeat(5000)), { ok: false, reason: 'too-long' })
  /* A forced version that cannot hold the payload is the same failure, not a
     silent downgrade to a bigger symbol. */
  assert.deepEqual(encodeQr('a'.repeat(200), { version: 1 }), { ok: false, reason: 'too-long' })
  assert.deepEqual(encodeQr('x', { version: 99 }), { ok: false, reason: 'too-long' })
  assert.deepEqual(encodeQr('x', { version: 0 }), { ok: false, reason: 'too-long' })
})

test('byte mode is never traded for a smaller segmented symbol', () => {
  /* 15 digits fit v1 in numeric mode (capacity 34) but not in byte mode (14). The
     reference would segment; this encoder must not — the whole fixture comparison
     depends on it (`prd.md` D2, research §3.1). */
  assert.equal(encodeQr('1'.repeat(14)).version, 1)
  assert.equal(encodeQr('1'.repeat(15)).version, 2)
  assert.equal(encodeQr('HELLO WORLD!!!!').version, 2, '15 alphanumerics exceed the 14 bytes v1 holds')
})

/* ---------------------------------------------------------------------- *
 * Failure values, shape, purity
 * ---------------------------------------------------------------------- */

test('empty and non-string input fail with a reason instead of throwing', () => {
  assert.deepEqual(encodeQr(''), { ok: false, reason: 'empty' })
  for (const value of [null, undefined, 0, 42, true, {}, [], () => {}]) {
    assert.deepEqual(encodeQr(value), { ok: false, reason: 'empty' }, `input ${String(value)}`)
  }
})

test('no input or option combination can make the encoder throw', () => {
  /* `apply` must never throw (the web boot refuses to draw the GUI over an entry
     that did not activate), and the encoder sits in a render path, so the failure
     has to be a value even for inputs nobody meant to send. */
  const hostile = [
    '', 'x', 'a'.repeat(413), 'a'.repeat(100000), '\uD800', '\u0000', ' '.repeat(5000),
    null, undefined, 0, NaN, {}, [], () => {}, Symbol('qr'),
  ]
  for (const value of hostile) {
    assert.doesNotThrow(() => encodeQr(value), `encodeQr(${String(value).slice(0, 24)}) threw`)
  }
  for (const options of [null, 7, 'mask', [], { version: 'nope' }, { mask: 'nope' }, { version: 3, mask: 9 }]) {
    assert.doesNotThrow(() => encodeQr('http://a.io#xy', options), `options ${JSON.stringify(options)} threw`)
  }
  /* An out-of-range mask falls back to automatic selection rather than to a
     non-existent mask 9. */
  const fallback = encodeQr('http://a.io#xy', { mask: 9 })
  assert.equal(fallback.ok, true)
  assert.ok(fallback.mask >= 0 && fallback.mask <= 7)
})

test('the returned matrix is a size x size bit array without the quiet zone', () => {
  const result = encodeQr('http://192.168.9.77:3090/remote-control/pair#AbCdEfGhIjKl:7K3M9Q2X')
  assert.equal(result.ok, true)
  assert.equal(result.version, 5)
  assert.equal(result.size, 37)
  assert.ok(result.modules instanceof Uint8Array)
  assert.equal(result.modules.length, result.size * result.size)
  for (const value of result.modules) assert.ok(value === 0 || value === 1)
  /* The quiet zone is the renderer's job (`design.md` §1.1): the top-left module is
     the finder pattern's corner, which is dark, and row 0 col 0 of the matrix is
     therefore NOT a margin of light modules. */
  assert.equal(result.modules[0], 1)
})

test('two calls with the same input agree exactly — no hidden state', () => {
  const text = 'https://remote.example.com/remote-control/pair#AbCdEfGhIjKl:7K3M9Q2X'
  const first = encodeQr(text)
  const second = encodeQr(text)
  assert.deepEqual(second, first)
  /* And the generator polynomial cache is not leaking between versions. */
  assert.deepEqual(encodeQr('http://a.io#xy'), encodeQr('http://a.io#xy'))
})

/* ---------------------------------------------------------------------- *
 * The SVG path the panel draws
 * ---------------------------------------------------------------------- */

test('the path data repaints the encoder matrix exactly', () => {
  for (const entry of [fixture.auto[0], fixture.auto[4]]) {
    const result = encodeQr(entry.text)
    const d = qrPathData(result.modules, result.size)
    assert.deepEqual(paintPath(d, result.size), result.modules, entry.label)
    /* One sub-path per horizontal run, not per module: a v11 symbol is ~1900 dark
       modules and this keeps them out of the DOM. */
    const runs = d.match(/M/g)?.length ?? 0
    assert.ok(runs > 0 && runs < result.modules.length / 2, `${runs} runs, ${result.modules.length} modules`)
  }
})

test('the viewBox leaves a four-module quiet zone that no module can enter', () => {
  /* ISO/IEC 18004 §9.1: four light modules on every side. It is geometry here
     rather than CSS padding because a padding in pixels cannot scale with the
     version, and the one-off decoder round-trip this shipped with assumed four. */
  for (const version of [1, 5, 11, 15]) {
    const size = (version * 4) + 17
    const viewBox = qrViewBox(size)
    const [minX, minY, width, height] = viewBox.split(' ').map(Number)
    assert.deepEqual([minX, minY], [-4, -4], `v${version}: four modules above and to the left`)
    assert.equal(width, size + 8, `v${version}: four modules of margin on the right`)
    assert.equal(height, size + 8, `v${version}: four modules of margin below`)
    /* Coordinates are unshifted module units, so the symbol occupies 0..size-1 and
       the margin is the ring outside it. */
    assert.equal(minX + 4, 0, `v${version}: the symbol must start at module 0`)
    assert.equal(minX + width - 4, size, `v${version}: the symbol must end at module size`)
  }

  /* A real path must stay inside the symbol box, so the ring is genuinely empty for
     every size class rather than empty only in the arithmetic above. */
  const texts = ['01234567', 'http://192.168.9.77:3090/remote-control/pair#AbCdEfGhIjKl:7K3M9Q2X', 'x'.repeat(412)]
  for (const text of texts) {
    const result = encodeQr(text)
    assert.equal(result.ok, true, text.slice(0, 16))
    const d = qrPathData(result.modules, result.size)
    /* `paintPath` already refuses a run outside the symbol, and every run is inside
       it by construction here: nothing can be drawn in the margin. */
    assert.deepEqual(paintPath(d, result.size), result.modules, text.slice(0, 16))
    for (const match of d.matchAll(/M(\d+) (\d+)h(\d+)/g)) {
      const col = Number(match[1])
      const row = Number(match[2])
      const run = Number(match[3])
      assert.ok(row >= 0 && row < result.size, 'a run must not enter the top/bottom margin')
      assert.ok(col >= 0 && col + run <= result.size, 'a run must not enter the left/right margin')
    }
  }
})
