// Minimal greedy LZ4 frame encoder for tests (independent blocks, content size, no checksums).
import { LZ4_MAGIC } from '../src/io/lz4'

function compressBlock(src: Uint8Array): Uint8Array {
  const out: number[] = []
  const table = new Int32Array(1 << 16).fill(-1)
  let anchor = 0
  let ip = 0
  const end = src.length
  const limit = end - 12 // LZ4 rule: last 5 bytes literals, last match starts >= 12 from end
  const seq = (litEnd: number, matchLen: number, off: number) => {
    const lit = litEnd - anchor
    const ml = matchLen - 4
    out.push((Math.min(lit, 15) << 4) | (matchLen ? Math.min(ml, 15) : 0))
    if (lit >= 15) {
      let l = lit - 15
      while (l >= 255) {
        out.push(255)
        l -= 255
      }
      out.push(l)
    }
    for (let i = anchor; i < litEnd; i++) out.push(src[i]!)
    if (!matchLen) return
    out.push(off & 255, off >> 8)
    if (ml >= 15) {
      let l = ml - 15
      while (l >= 255) {
        out.push(255)
        l -= 255
      }
      out.push(l)
    }
  }
  while (ip < limit) {
    const key = src[ip]! | (src[ip + 1]! << 8) | (src[ip + 2]! << 16) | (src[ip + 3]! << 24)
    const h = Math.imul(key, 2654435761) >>> 16
    const cand = table[h]!
    table[h] = ip
    if (cand >= 0 && ip - cand < 65536 && src[cand] === src[ip] && src[cand + 1] === src[ip + 1] && src[cand + 2] === src[ip + 2] && src[cand + 3] === src[ip + 3]) {
      let len = 4
      while (ip + len < end - 5 && src[cand + len] === src[ip + len]) len++
      seq(ip, len, ip - cand)
      ip += len
      anchor = ip
    } else ip++
  }
  seq(end, 0, 0)
  return Uint8Array.from(out)
}

export function lz4Frame(data: Uint8Array, blockSize = 1024 * 1024, storeEvery = 0): Uint8Array {
  const bdId: Record<number, number> = { [64 << 10]: 4, [256 << 10]: 5, [1 << 20]: 6, [4 << 20]: 7 }
  const parts: Uint8Array[] = []
  const hdr = new Uint8Array(15)
  const dv = new DataView(hdr.buffer)
  dv.setUint32(0, LZ4_MAGIC, true)
  hdr[4] = 0x40 | 0x20 | 0x08
  hdr[5] = bdId[blockSize]! << 4
  dv.setUint32(6, data.length % 0x100000000, true)
  dv.setUint32(10, Math.floor(data.length / 0x100000000), true)
  hdr[14] = 0 // header checksum not verified by our reader
  parts.push(hdr)
  let n = 0
  for (let o = 0; o < data.length; o += blockSize, n++) {
    const blk = data.subarray(o, Math.min(o + blockSize, data.length))
    const comp = compressBlock(blk)
    const store = (storeEvery && n % storeEvery === 0) || comp.length >= blk.length
    const body = store ? blk : comp
    const w = new Uint8Array(4)
    new DataView(w.buffer).setUint32(0, body.length | (store ? 0x80000000 : 0), true)
    parts.push(w, body)
  }
  parts.push(new Uint8Array(4))
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
