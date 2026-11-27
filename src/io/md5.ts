// .tar.md5 verification: the MD5 of the tar payload is appended as "<32 hex>  <name>\n".
import { createMD5 } from 'hash-wasm'
import type { Source } from './source'

export interface Md5Trailer {
  expected: string
  /** Number of leading bytes covered by the hash. */
  hashedBytes: number
}

export async function findMd5Trailer(src: Source): Promise<Md5Trailer | undefined> {
  const tailLen = Math.min(src.size, 4096)
  const tailOff = src.size - tailLen
  const tail = new TextDecoder('latin1').decode(await src.read(tailOff, tailLen))
  for (let i = tail.length - 2; i >= 32; i--) {
    if (tail[i] !== ' ' || tail[i + 1] !== ' ') continue
    const hex = tail.slice(i - 32, i)
    if (!/^[0-9a-fA-F]{32}$/.test(hex)) continue
    return { expected: hex.toLowerCase(), hashedBytes: tailOff + i - 32 }
  }
  return undefined
}

export async function md5Of(src: Source, length: number, onProgress?: (done: number) => void, signal?: AbortSignal): Promise<string> {
  const h = await createMD5()
  h.init()
  const chunk = 16 * 1024 * 1024
  for (let off = 0; off < length; off += chunk) {
    signal?.throwIfAborted()
    h.update(await src.read(off, Math.min(chunk, length - off)))
    onProgress?.(Math.min(off + chunk, length))
  }
  return h.digest('hex')
}
