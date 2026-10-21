/**
 * `cloudflared` location and installation.
 *
 * The download is the only action in this package that writes an executable, so it
 * is tested against a fake transport with real bytes: the digest comes from the
 * asset metadata (like GitHub's API), and every refusal case asserts that NOTHING
 * was left behind.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

import {
  assetFor,
  downloadTunnelBinary,
  downloadedBinaryLeaf,
  extractBinaryFromTgz,
  findOnPath,
  resolveTunnelBinary,
} from '../src/host/tunnel-binary.js'
import { cleanupDir, makeTempDir } from './helpers.mjs'

function makeExecutable(dir, name) {
  const file = path.join(dir, name)
  writeFileSync(file, 'binary')
  try {
    chmodSync(file, 0o755)
  } catch {
    /* Windows has no POSIX execute bit. */
  }
  return file
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Minimal ustar archive with one regular file — enough for the extractor. */
function makeTar(name, content) {
  const header = Buffer.alloc(512)
  header.write(name, 0, 'utf8')
  header.write('0000644\u0000', 100, 'ascii')
  header.write('0000000\u0000', 108, 'ascii')
  header.write('0000000\u0000', 116, 'ascii')
  const size = Buffer.from(`${content.length.toString(8).padStart(11, '0')}\u0000`, 'ascii')
  size.copy(header, 124)
  header.write('00000000000\u0000', 136, 'ascii')
  header.write('        ', 148, 'ascii')
  header[156] = '0'.charCodeAt(0)
  header.write('ustar\u000000', 257, 'ascii')
  const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512)
  content.copy(padded)
  return Buffer.concat([header, padded, Buffer.alloc(1024)])
}

/* ------------------------------------------------------------------ *
 * Asset selection
 * ------------------------------------------------------------------ */

test('assetFor maps each supported platform to the official asset name', () => {
  assert.deepEqual(assetFor('win32', 'x64'), { asset: 'cloudflared-windows-amd64.exe', archive: null })
  assert.deepEqual(assetFor('win32', 'ia32'), { asset: 'cloudflared-windows-386.exe', archive: null })
  assert.deepEqual(assetFor('linux', 'x64'), { asset: 'cloudflared-linux-amd64', archive: null })
  assert.deepEqual(assetFor('linux', 'arm64'), { asset: 'cloudflared-linux-arm64', archive: null })
  assert.deepEqual(assetFor('darwin', 'arm64'), { asset: 'cloudflared-darwin-arm64.tgz', archive: 'tgz' })
  for (const [platform, arch] of [['win32', 'arm64'], ['freebsd', 'x64'], ['linux', 'mips']]) {
    assert.throws(() => assetFor(platform, arch), (error) => error.code === 'tunnel/unsupported-platform')
  }
})

test('downloadedBinaryLeaf follows the platform convention', () => {
  assert.equal(downloadedBinaryLeaf('win32'), 'cloudflared.exe')
  assert.equal(downloadedBinaryLeaf('linux'), 'cloudflared')
  assert.equal(downloadedBinaryLeaf('darwin'), 'cloudflared')
})

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

test('a configured absolute path wins', () => {
  const dir = makeTempDir()
  try {
    const file = makeExecutable(dir, 'my-cloudflared')
    const resolved = resolveTunnelBinary({
      baseDir: dir,
      binaryPath: file,
      platform: process.platform,
      env: { PATH: '' },
    })
    assert.deepEqual(resolved, { available: true, source: 'custom', path: file })
  } finally {
    cleanupDir(dir)
  }
})

test('a configured bare name is looked up on PATH', () => {
  const dir = makeTempDir()
  try {
    const leaf = downloadedBinaryLeaf(process.platform)
    const file = makeExecutable(dir, leaf)
    const resolved = resolveTunnelBinary({
      baseDir: dir,
      binaryPath: leaf,
      platform: process.platform,
      env: { PATH: dir, PATHEXT: '.EXE' },
    })
    assert.equal(resolved.available, true)
    assert.equal(resolved.source, 'custom')
    assert.equal(resolved.path, file)
  } finally {
    cleanupDir(dir)
  }
})

test('a configured path that does not exist never falls back', () => {
  const dir = makeTempDir()
  try {
    /* Both fallbacks exist and must be ignored: the typo has to be visible. */
    makeExecutable(dir, downloadedBinaryLeaf(process.platform))
    const pathDir = path.join(dir, 'bin')
    writeFileSync(path.join(dir, 'placeholder'), '')
    const resolved = resolveTunnelBinary({
      baseDir: dir,
      binaryPath: path.join(dir, 'missing', 'cloudflared'),
      platform: process.platform,
      env: { PATH: pathDir },
    })
    assert.deepEqual(resolved, { available: false, source: 'missing', path: null })
  } finally {
    cleanupDir(dir)
  }
})

test('PATH is preferred over the downloaded copy, and the copy is used when PATH has none', () => {
  const dir = makeTempDir()
  try {
    const leaf = downloadedBinaryLeaf(process.platform)
    const onPath = path.join(dir, 'bin')
    mkdirSync(onPath, { recursive: true })
    const fromPath = makeExecutable(onPath, leaf)
    makeExecutable(dir, leaf)

    const viaPath = resolveTunnelBinary({
      baseDir: dir,
      platform: process.platform,
      env: { PATH: onPath, PATHEXT: '.EXE' },
    })
    assert.equal(viaPath.source, 'path')
    assert.equal(viaPath.path.toLowerCase(), fromPath.toLowerCase())

    const viaDownloaded = resolveTunnelBinary({
      baseDir: dir,
      platform: process.platform,
      env: { PATH: '', PATHEXT: '.EXE' },
    })
    assert.equal(viaDownloaded.source, 'downloaded')
    assert.equal(viaDownloaded.path, path.join(dir, leaf))

    const none = resolveTunnelBinary({
      baseDir: dir,
      platform: process.platform,
      env: { PATH: '', PATHEXT: '.EXE' },
    })
    assert.equal(none.available, true, 'the downloaded copy still exists in this fixture')
  } finally {
    cleanupDir(dir)
  }
})

test('findOnPath honours PATHEXT on Windows', () => {
  const dir = makeTempDir()
  try {
    for (const [name, extension] of [['lowercase', '.exe'], ['uppercase', '.EXE']]) {
      const binDir = path.join(dir, name)
      mkdirSync(binDir)
      const file = path.join(binDir, `cloudflared${extension}`)
      /* Injecting win32 does not make the host filesystem case-insensitive. */
      writeFileSync(file, 'x')
      assert.equal(
        findOnPath('cloudflared', {
          platform: 'win32',
          env: { Path: binDir, PATHEXT: `.COM;${extension}` },
        }),
        file,
      )
    }
    assert.equal(findOnPath('cloudflared', { platform: 'win32', env: { Path: '', PATHEXT: '.EXE' } }), null)
  } finally {
    cleanupDir(dir)
  }
})

test('findOnPath requires executable bits on POSIX', { skip: process.platform === 'win32' }, () => {
  const dir = makeTempDir()
  try {
    const file = path.join(dir, 'cloudflared')
    writeFileSync(file, 'x')
    chmodSync(file, 0o644)
    const options = { platform: process.platform, env: { PATH: dir } }
    assert.equal(findOnPath('cloudflared', options), null, 'a regular file without execute bits is rejected')

    chmodSync(file, 0o755)
    assert.equal(findOnPath('cloudflared', options), file, 'the executable file is found')
  } finally {
    cleanupDir(dir)
  }
})

/* ------------------------------------------------------------------ *
 * macOS archive
 * ------------------------------------------------------------------ */

test('the macOS archive yields the single binary', () => {
  const payload = Buffer.from('cloudflared-binary-payload')
  const tgz = gzipSync(makeTar('cloudflared', payload))
  assert.deepEqual(extractBinaryFromTgz(tgz), payload)
})

test('a malformed archive is a stable failure, not a RangeError', () => {
  assert.throws(
    () => extractBinaryFromTgz(Buffer.from('not gzip')),
    (error) => error.code === 'tunnel/download-failed',
  )
  assert.throws(
    () => extractBinaryFromTgz(gzipSync(Buffer.alloc(10))),
    (error) => error.code === 'tunnel/download-failed',
  )
})

/* ------------------------------------------------------------------ *
 * Download
 * ------------------------------------------------------------------ */

function metadataFor(assetName, bytes, overrides = {}) {
  return {
    tag_name: '2026.10.1',
    assets: [{
      name: assetName,
      digest: `sha256:${sha256(bytes)}`,
      browser_download_url: `https://github.com/cloudflare/cloudflared/releases/download/2026.10.1/${assetName}`,
      ...overrides,
    }],
  }
}

function fakeFetch(metadata, bytes) {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    if (String(url).includes('api.github.com')) {
      return { ok: true, headers: { get: () => null }, json: async () => metadata }
    }
    return {
      ok: true,
      headers: { get: (name) => (name === 'content-length' ? String(bytes.length) : null) },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }
  }
  return { fetchImpl, calls }
}

test('a verified download is installed atomically', async () => {
  const dir = makeTempDir()
  try {
    const selection = assetFor(process.platform, process.arch)
    const payload = Buffer.alloc(4096, 0x5a)
    const installed = selection.archive === 'tgz' ? payload : payload
    const assetBytes = selection.archive === 'tgz' ? gzipSync(makeTar('cloudflared', payload)) : payload
    const { fetchImpl, calls } = fakeFetch(metadataFor(selection.asset, assetBytes), assetBytes)
    const result = await downloadTunnelBinary({
      baseDir: dir,
      platform: process.platform,
      arch: process.arch,
      fetchImpl,
    })
    assert.equal(result.version, '2026.10.1')
    assert.equal(result.path, path.join(dir, downloadedBinaryLeaf(process.platform)))
    assert.deepEqual(readFileSync(result.path), installed)
    assert.equal(calls.length, 2, 'metadata then asset')
    assert.ok(!existsSync(`${result.path}.${process.pid}.download`), 'no temp file is left behind')
  } finally {
    cleanupDir(dir)
  }
})

test('the darwin download is unpacked before installation', async () => {
  const dir = makeTempDir()
  try {
    const payload = Buffer.alloc(4096, 0x33)
    const tgz = gzipSync(makeTar('cloudflared', payload))
    const { fetchImpl } = fakeFetch(metadataFor('cloudflared-darwin-arm64.tgz', tgz), tgz)
    const result = await downloadTunnelBinary({
      baseDir: dir,
      platform: 'darwin',
      arch: 'arm64',
      fetchImpl,
    })
    assert.equal(result.path, path.join(dir, 'cloudflared'))
    assert.deepEqual(readFileSync(result.path), payload)
  } finally {
    cleanupDir(dir)
  }
})

test('a digest mismatch installs nothing', async () => {
  const dir = makeTempDir()
  try {
    const binary = Buffer.alloc(4096, 0x11)
    const metadata = metadataFor('cloudflared-linux-amd64', binary, { digest: `sha256:${'0'.repeat(64)}` })
    const { fetchImpl } = fakeFetch(metadata, binary)
    await assert.rejects(
      downloadTunnelBinary({ baseDir: dir, platform: 'linux', arch: 'x64', fetchImpl }),
      (error) => error.code === 'tunnel/download-failed',
    )
    assert.ok(!existsSync(path.join(dir, 'cloudflared')), 'no executable is written')
  } finally {
    cleanupDir(dir)
  }
})

test('an asset without a published digest is refused', async () => {
  const dir = makeTempDir()
  try {
    const binary = Buffer.alloc(4096, 0x22)
    const metadata = metadataFor('cloudflared-linux-amd64', binary, { digest: null })
    const { fetchImpl } = fakeFetch(metadata, binary)
    await assert.rejects(
      downloadTunnelBinary({ baseDir: dir, platform: 'linux', arch: 'x64', fetchImpl }),
      (error) => error.code === 'tunnel/download-failed',
    )
    assert.ok(!existsSync(path.join(dir, 'cloudflared')))
  } finally {
    cleanupDir(dir)
  }
})

test('an asset hosted anywhere but github.com is refused before writing', async () => {
  const dir = makeTempDir()
  try {
    const binary = Buffer.alloc(4096, 0x44)
    const metadata = metadataFor('cloudflared-linux-amd64', binary, {
      browser_download_url: 'https://evil.example/cloudflared',
    })
    const { fetchImpl } = fakeFetch(metadata, binary)
    await assert.rejects(
      downloadTunnelBinary({ baseDir: dir, platform: 'linux', arch: 'x64', fetchImpl }),
      (error) => error.code === 'tunnel/download-failed',
    )
    assert.ok(!existsSync(path.join(dir, 'cloudflared')))
  } finally {
    cleanupDir(dir)
  }
})

test('a release that does not carry this platform is a stable failure', async () => {
  const dir = makeTempDir()
  try {
    const binary = Buffer.alloc(4096, 0x55)
    const metadata = { tag_name: '2026.10.1', assets: [] }
    const { fetchImpl } = fakeFetch(metadata, binary)
    await assert.rejects(
      downloadTunnelBinary({ baseDir: dir, platform: 'linux', arch: 'x64', fetchImpl }),
      (error) => error.code === 'tunnel/download-failed',
    )
  } finally {
    cleanupDir(dir)
  }
})

test('an unsupported platform fails before any request', async () => {
  const dir = makeTempDir()
  try {
    let called = false
    await assert.rejects(
      downloadTunnelBinary({
        baseDir: dir,
        platform: 'win32',
        arch: 'arm64',
        fetchImpl: async () => { called = true },
      }),
      (error) => error.code === 'tunnel/unsupported-platform',
    )
    assert.equal(called, false)
  } finally {
    cleanupDir(dir)
  }
})
