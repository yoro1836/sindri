// Tar index over a random-access source (ustar, GNU long names, PAX path/size, base-256 sizes).
// Modeled on brokkr-flash (GPL-3.0-or-later, Gabriel2392): src/io/tar.cpp.

import { type Source, subSource } from './source'

const BLOCK = 512

export interface TarEntry {
  name: string
  size: number
  /** Offset of the entry's data within the archive. */
  dataOffset: number
}

const round512 = (n: number) => Math.ceil(n / BLOCK) * BLOCK

function field(h: Uint8Array, off: number, len: number): string {
  const b = h.subarray(off, off + len)
  const end = b.indexOf(0)
  return new TextDecoder('utf-8').decode(end < 0 ? b : b.subarray(0, end))
}

function parseOctal(s: string): number {
  s = s.replace(/^[\s\0]+|[\s\0]+$/g, '')
  let v = 0
  for (const ch of s) {
    if (ch < '0' || ch > '7') break
    v = v * 8 + (ch.charCodeAt(0) - 48)
  }
  return v
}

function parseNumber(h: Uint8Array, off: number, len: number): number {
  const b0 = h[off]!
  if (b0 & 0x80) {
    if (b0 & 0x40) throw new Error('tar: negative base-256 number')
    let v = b0 & 0x3f
    for (let i = 1; i < len; i++) v = v * 256 + h[off + i]!
    if (!Number.isSafeInteger(v)) throw new Error('tar: number too large')
    return v
  }
  return parseOctal(field(h, off, len))
}

export function headerChecksumOk(h: Uint8Array): boolean {
  const expected = parseOctal(field(h, 148, 8))
  let u = 0
  let s = 0
  for (let i = 0; i < BLOCK; i++) {
    const c = i >= 148 && i < 156 ? 0x20 : h[i]!
    u += c
    s += c > 127 ? c - 256 : c
  }
  return expected === u || expected === s
}

const allZero = (h: Uint8Array) => h.every((b) => b === 0)

export async function isTar(src: Source): Promise<boolean> {
  if (src.size < BLOCK) return false
  const h = await src.read(0, BLOCK)
  return !allZero(h) && headerChecksumOk(h)
}

function parsePax(payload: string): { path?: string; size?: number } {
  const out: { path?: string; size?: number } = {}
  let pos = 0
  while (pos < payload.length) {
    const sp = payload.indexOf(' ', pos)
    if (sp < 0) break
    const len = parseInt(payload.slice(pos, sp), 10)
    if (!(len > 0) || pos + len > payload.length) break
    const rec = payload.slice(sp + 1, pos + len).replace(/\n$/, '')
    pos += len
    const eq = rec.indexOf('=')
    if (eq < 0) continue
    const k = rec.slice(0, eq)
    const v = rec.slice(eq + 1)
    if (k === 'path') out.path = v
    else if (k === 'size') out.size = parseInt(v, 10)
  }
  return out
}

export interface TarIndex {
  entries: TarEntry[]
  /** Bytes covered by the tar stream (including the end marker), when found. */
  payloadSize?: number
}

/** Scan headers only; entry data is skipped, so this is fast even for multi-GB archives. */
export async function indexTar(src: Source): Promise<TarIndex> {
  const entries: TarEntry[] = []
  let pos = 0
  let longName: string | undefined
  let paxNext: { path?: string; size?: number } = {}
  let paxGlobal: { path?: string; size?: number } = {}

  while (true) {
    if (pos + BLOCK > src.size) throw new Error(`${src.name}: tar truncated`)
    const h = await src.read(pos, BLOCK)
    pos += BLOCK
    if (allZero(h)) {
      let payloadSize: number | undefined
      if (pos + BLOCK <= src.size && allZero(await src.read(pos, BLOCK))) payloadSize = pos + BLOCK
      return { entries, payloadSize }
    }
    if (!headerChecksumOk(h)) throw new Error(`${src.name}: bad tar header checksum at ${pos - BLOCK}`)

    const type = String.fromCharCode(h[156]!)
    let size = parseNumber(h, 124, 12)
    if (pos + size > src.size) throw new Error(`${src.name}: tar entry truncated`)

    if (type === 'x' || type === 'g' || type === 'L') {
      if (size > 8 * 1024 * 1024) throw new Error(`${src.name}: tar meta header too large`)
      const text = new TextDecoder().decode(await src.read(pos, size))
      pos += round512(size)
      if (type === 'L') longName = text.replace(/\0+$/, '')
      else if (type === 'x') paxNext = { ...paxNext, ...parsePax(text) }
      else paxGlobal = { ...paxGlobal, ...parsePax(text) }
      continue
    }

    const prefix = field(h, 345, 155)
    let name = field(h, 0, 100)
    if (prefix && h[257] === 0x75 /* 'u' of ustar */) name = `${prefix.replace(/\/$/, '')}/${name}`
    if (longName !== undefined) name = longName
    const pax = { ...paxGlobal, ...paxNext }
    if (pax.path) name = pax.path
    if (pax.size !== undefined) size = pax.size
    longName = undefined
    paxNext = {}

    if (type === '0' || type === '\0' || type === '7') entries.push({ name, size, dataOffset: pos })
    pos += round512(size)
  }
}

export function tarBasename(name: string): string {
  const i = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  return i < 0 ? name : name.slice(i + 1)
}

export function entrySource(src: Source, e: TarEntry): Source {
  return subSource(src, e.dataOffset, e.size, `${src.name}:${e.name}`)
}

/** Build a tar (ustar, no long names) — used by tests. */
export function buildTar(files: Array<{ name: string; data: Uint8Array }>, md5Trailer?: string): Uint8Array {
  const parts: Uint8Array[] = []
  const enc = new TextEncoder()
  for (const f of files) {
    const h = new Uint8Array(BLOCK)
    h.set(enc.encode(f.name).subarray(0, 99), 0)
    h.set(enc.encode('0000644\0'), 100)
    h.set(enc.encode('0000000\0'), 108)
    h.set(enc.encode('0000000\0'), 116)
    h.set(enc.encode(f.data.byteLength.toString(8).padStart(11, '0') + '\0'), 124)
    h.set(enc.encode('00000000000\0'), 136)
    h[156] = 0x30
    h.set(enc.encode('ustar\0'), 257)
    h.set(enc.encode('00'), 263)
    h.fill(0x20, 148, 156)
    let sum = 0
    for (const b of h) sum += b
    h.set(enc.encode(sum.toString(8).padStart(6, '0') + '\0 '), 148)
    parts.push(h, f.data, new Uint8Array(round512(f.data.byteLength) - f.data.byteLength))
  }
  parts.push(new Uint8Array(BLOCK * 2))
  let total = parts.reduce((a, p) => a + p.byteLength, 0)
  const body = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    body.set(p, o)
    o += p.byteLength
  }
  if (!md5Trailer) return body
  const t = enc.encode(md5Trailer)
  const out = new Uint8Array(total + t.byteLength)
  out.set(body)
  out.set(t, total)
  total += t.byteLength
  return out
}
