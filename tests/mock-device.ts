// A simulated download-mode device. Strict: protocol mistakes throw, so tests catch them.
import { decodeBlocks } from '../src/io/lz4'
import { Cmd, decodeRequest, encodeResponse, InitParam, PitParam, REQUEST_SIZE, XmitParam, type Request } from '../src/core/protocol'
import type { Transport } from '../src/core/transport'

export interface MockOptions {
  pit: Uint8Array
  protocol?: number
  lz4?: boolean
  /** Ack the n-th XMIT COMPLETE with this bootloader error. */
  failComplete?: { at: number; ack: number }
}

type Mode =
  | { k: 'handshake' }
  | { k: 'cmd' }
  | { k: 'xmit-data'; compressed: boolean; size: number; remaining: number; buf: Uint8Array[] }
  | { k: 'pit-data'; size: number }
  | { k: 'closed' }

export class MockDevice implements Transport {
  readonly kind = 'mock' as const
  readonly label = 'mock device'
  readonly requests: Request[] = []
  readonly written = new Map<number, Uint8Array[]>()
  readonly finished = new Set<number>()
  rawWrites = 0
  totalSize?: number
  superDeclared = false
  rebooted = false
  pit: Uint8Array
  private out: number[] = []
  private mode: Mode = { k: 'handshake' }
  private pkt = 128 * 1024
  private pending?: { compressed: boolean; size: number; data: Uint8Array }
  private pitMode: 'get' | 'set' | undefined
  private completes = 0

  constructor(readonly o: MockOptions) {
    this.pit = o.pit
  }

  async open() {}
  async close() {}
  async drain() {}

  private reply(id: number, ack: number) {
    this.out.push(...encodeResponse(id, ack))
  }

  async read(length: number): Promise<Uint8Array> {
    if (this.out.length < length) throw new Error(`mock: read ${length} but only ${this.out.length} queued`)
    return Uint8Array.from(this.out.splice(0, length))
  }

  /** Everything the device has queued for the host (used by the fake USB device). */
  takeAll(): Uint8Array {
    return Uint8Array.from(this.out.splice(0))
  }

  async write(data: Uint8Array): Promise<void> {
    const m = this.mode
    switch (m.k) {
      case 'handshake': {
        const s = new TextDecoder().decode(data)
        if (s !== 'ODIN\0' && s !== 'ODIN') throw new Error(`mock: bad handshake ${JSON.stringify(s)}`)
        this.out.push(...new TextEncoder().encode('LOKE'))
        this.mode = { k: 'cmd' }
        return
      }
      case 'xmit-data': {
        this.rawWrites++
        if (data.byteLength !== this.pkt) throw new Error(`mock: data packet ${data.byteLength} != pkt ${this.pkt}`)
        m.buf.push(data.slice())
        this.reply(0, m.buf.length - 1)
        if (--m.remaining === 0) {
          const all = new Uint8Array(m.buf.length * this.pkt)
          m.buf.forEach((b, i) => all.set(b, i * this.pkt))
          this.pending = { compressed: m.compressed, size: m.size, data: all }
          this.mode = { k: 'cmd' }
        }
        return
      }
      case 'pit-data': {
        this.rawWrites++
        if (data.byteLength !== m.size) throw new Error('mock: PIT size mismatch')
        this.pit = data.slice()
        this.reply(0, 0)
        this.mode = { k: 'cmd' }
        return
      }
      case 'closed':
        throw new Error('mock: write after close')
      case 'cmd':
        break
    }
    if (data.byteLength !== REQUEST_SIZE) throw new Error(`mock: expected 1024-byte request, got ${data.byteLength}`)
    const r = decodeRequest(data)
    this.requests.push(r)
    this.handle(r)
  }

  private handle(r: Request) {
    const { id, param, ints } = r
    switch (id) {
      case Cmd.INIT:
        if (param === InitParam.TARGET) {
          const proto = this.o.protocol ?? 5
          return this.reply(id, (proto << 16) | (this.o.lz4 ?? true ? 0x8000 : 0))
        }
        if (param === InitParam.PACKETSIZE) {
          this.pkt = ints[0]!
          return this.reply(id, 0)
        }
        if (param === InitParam.TOTALSIZE) {
          this.totalSize = (ints[0]! >>> 0) + (ints[1]! >>> 0) * 0xffffffff
          return this.reply(id, 0)
        }
        break
      case Cmd.PIT:
        if (param === PitParam.GET) {
          this.pitMode = 'get'
          return this.reply(id, this.pit.byteLength)
        }
        if (param === PitParam.SET) {
          this.pitMode = 'set'
          return this.reply(id, 0)
        }
        if (param === PitParam.START && this.pitMode === 'get') {
          const i = ints[0]!
          this.out.push(...this.pit.subarray(i * 500, Math.min(this.pit.byteLength, (i + 1) * 500)))
          return
        }
        if (param === PitParam.START && this.pitMode === 'set') {
          this.reply(id, 0)
          this.mode = { k: 'pit-data', size: ints[0]! }
          return
        }
        if (param === PitParam.COMPLETE) {
          this.pitMode = undefined
          return this.reply(id, 0)
        }
        break
      case Cmd.SUPER:
        this.superDeclared = true
        return this.reply(id, 0)
      case Cmd.XMIT:
        if (param === XmitParam.DOWNLOAD || param === XmitParam.COMPRESSED_DOWNLOAD) {
          if (this.totalSize === undefined) throw new Error('mock: XMIT before TOTALSIZE')
          return this.reply(id, 0)
        }
        if (param === XmitParam.START || param === XmitParam.COMPRESSED_START) {
          const size = ints[0]!
          const compressed = param === XmitParam.COMPRESSED_START
          this.reply(id, 0)
          this.mode = { k: 'xmit-data', compressed, size: compressed ? ints[1]! : size, remaining: Math.ceil(size / this.pkt), buf: [] }
          return
        }
        if (param === XmitParam.COMPLETE || param === XmitParam.COMPRESSED_COMPLETE) {
          const p = this.pending
          if (!p) throw new Error('mock: COMPLETE without data')
          this.pending = undefined
          const compressed = param === XmitParam.COMPRESSED_COMPLETE
          if (compressed !== p.compressed) throw new Error('mock: COMPLETE kind mismatch')
          const [, size, , , partId, last] = ints as [number, number, number, number, number, number]
          if (compressed ? size !== p.size : Math.ceil(size / (128 * 1024)) * 128 * 1024 !== p.size)
            throw new Error(`mock: COMPLETE size ${size} does not match START ${p.size}`)
          if (this.o.failComplete && ++this.completes === this.o.failComplete.at) return this.reply(-1, this.o.failComplete.ack)
          let bytes: Uint8Array
          if (compressed) {
            bytes = new Uint8Array(size)
            const n = decodeBlocks(trimBlocks(p.data), bytes)
            if (n !== size) throw new Error(`mock: decoded ${n} != ${size}`)
          } else {
            bytes = p.data.subarray(0, size)
          }
          if (this.finished.has(partId)) throw new Error(`mock: partition ${partId} written after last`)
          const l = this.written.get(partId) ?? []
          l.push(bytes.slice())
          this.written.set(partId, l)
          if (last) this.finished.add(partId)
          return this.reply(id, 0)
        }
        break
      case Cmd.CLOSE:
        if (param === 0) return this.reply(id, 0)
        if (param === 1) {
          this.rebooted = true
          this.mode = { k: 'closed' }
          return this.reply(id, 0)
        }
        break
    }
    throw new Error(`mock: unhandled request ${id}/${param}`)
  }

  partition(id: number): Uint8Array {
    const parts = this.written.get(id) ?? []
    const out = new Uint8Array(parts.reduce((a, p) => a + p.byteLength, 0))
    let o = 0
    for (const p of parts) {
      out.set(p, o)
      o += p.byteLength
    }
    return out
  }
}

/** Compressed windows are zero-padded to the packet size; drop the padding (a zero size word). */
function trimBlocks(data: Uint8Array): Uint8Array {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let p = 0
  while (p + 4 <= data.byteLength) {
    const w = dv.getUint32(p, true)
    if (w === 0) break
    p += 4 + (w & 0x7fffffff)
  }
  return data.subarray(0, p)
}
