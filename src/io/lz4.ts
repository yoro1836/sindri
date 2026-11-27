// LZ4 frame handling. The device decompresses on its side when it supports compressed download,
// so the normal path only splits the frame into blocks; decodeBlock is the fallback.
// Frame rules follow brokkr-flash (GPL-3.0-or-later, Gabriel2392): src/io/lz4_frame.cpp.

import { SeqReader, type Source } from './source'

export const LZ4_MAGIC = 0x184d2204
export const ONE_MIB = 1024 * 1024

export interface Lz4Header {
  blockSize: number
  contentSize: number
  headerBytes: number
  contentChecksum: boolean
}

export function isLz4Name(name: string): boolean {
  return name.toLowerCase().endsWith('.lz4')
}

export async function readLz4Header(src: Source): Promise<Lz4Header> {
  if (src.size < 15) throw new Error(`${src.name}: too small for an LZ4 frame`)
  const b = await src.read(0, 15)
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (dv.getUint32(0, true) !== LZ4_MAGIC) throw new Error(`${src.name}: not an LZ4 frame`)
  const flg = b[4]!
  const bd = b[5]!
  if (((flg >> 6) & 3) !== 1) throw new Error(`${src.name}: unsupported LZ4 frame version`)
  if (!(flg & 0x20)) throw new Error(`${src.name}: LZ4 blocks must be independent`)
  if (flg & 0x10) throw new Error(`${src.name}: LZ4 block checksums are not supported`)
  if (flg & 0x01) throw new Error(`${src.name}: LZ4 dictionary IDs are not supported`)
  if (!(flg & 0x08)) throw new Error(`${src.name}: LZ4 content size missing (compress with --content-size)`)
  const sizes: Record<number, number> = { 4: 64 << 10, 5: 256 << 10, 6: ONE_MIB, 7: 4 * ONE_MIB }
  const blockSize = sizes[(bd >> 4) & 7]
  if (!blockSize) throw new Error(`${src.name}: bad LZ4 block size`)
  if (blockSize > ONE_MIB) throw new Error(`${src.name}: LZ4 blocks over 1 MiB are not supported`)
  const lo = dv.getUint32(6, true)
  const hi = dv.getUint32(10, true)
  const contentSize = hi * 0x100000000 + lo
  if (!Number.isSafeInteger(contentSize)) throw new Error(`${src.name}: LZ4 content size too large`)
  return { blockSize, contentSize, headerBytes: 15, contentChecksum: (flg & 0x04) !== 0 }
}

/** Reads raw LZ4 blocks (size word + payload) in order. */
export class Lz4BlockReader {
  private readonly reader: SeqReader
  private read = 0
  readonly totalBlocks: number

  constructor(
    src: Source,
    readonly header: Lz4Header,
  ) {
    this.reader = new SeqReader(src, header.headerBytes)
    this.totalBlocks = Math.ceil(header.contentSize / header.blockSize)
  }

  get remaining(): number {
    return this.totalBlocks - this.read
  }

  /** Returns the concatenated raw blocks (each with its 4-byte size word). */
  async readBlocks(n: number): Promise<Uint8Array> {
    const chunks: Uint8Array[] = []
    let total = 0
    for (let i = 0; i < n; i++) {
      const word = await this.reader.readExact(4)
      const raw = new DataView(word.buffer, word.byteOffset, 4).getUint32(0, true)
      if (raw === 0) throw new Error('LZ4: unexpected end mark')
      const len = raw & 0x7fffffff
      if (len > this.header.blockSize) throw new Error('LZ4: block larger than frame block size')
      const block = new Uint8Array(4 + len)
      block.set(word, 0)
      block.set(await this.reader.readExact(len), 4)
      chunks.push(block)
      total += block.byteLength
      this.read++
    }
    const out = new Uint8Array(total)
    let o = 0
    for (const c of chunks) {
      out.set(c, o)
      o += c.byteLength
    }
    return out
  }
}

/** Decode a run of raw blocks (as produced by readBlocks) into `out`. Returns bytes written. */
export function decodeBlocks(raw: Uint8Array, out: Uint8Array): number {
  let ip = 0
  let op = 0
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  while (ip < raw.byteLength) {
    const word = dv.getUint32(ip, true)
    ip += 4
    const len = word & 0x7fffffff
    if (word & 0x80000000) {
      out.set(raw.subarray(ip, ip + len), op)
      op += len
    } else {
      op = decodeBlock(raw.subarray(ip, ip + len), out, op)
    }
    ip += len
  }
  return op
}

function decodeBlock(src: Uint8Array, dst: Uint8Array, op: number): number {
  const start = op
  let ip = 0
  while (ip < src.length) {
    const token = src[ip++]!
    let lit = token >> 4
    if (lit === 15) {
      let b: number
      do {
        b = src[ip++]!
        lit += b
      } while (b === 255)
    }
    if (op + lit > dst.length || ip + lit > src.length) throw new Error('LZ4: corrupt block (literals)')
    dst.set(src.subarray(ip, ip + lit), op)
    ip += lit
    op += lit
    if (ip >= src.length) break
    const off = src[ip]! | (src[ip + 1]! << 8)
    ip += 2
    if (off === 0 || off > op - start) throw new Error('LZ4: corrupt block (offset)')
    let m = (token & 15) + 4
    if ((token & 15) === 15) {
      let b: number
      do {
        b = src[ip++]!
        m += b
      } while (b === 255)
    }
    if (op + m > dst.length) throw new Error('LZ4: corrupt block (match)')
    let from = op - off
    if (off >= m) {
      dst.copyWithin(op, from, from + m)
      op += m
    } else {
      for (let i = 0; i < m; i++) dst[op++] = dst[from++]!
    }
  }
  return op
}
