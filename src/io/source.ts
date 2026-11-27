/** Random-access byte source. Backed by a File/Blob in the browser, so nothing is loaded whole. */
export interface Source {
  readonly name: string
  readonly size: number
  read(offset: number, length: number): Promise<Uint8Array>
}

export function blobSource(blob: Blob, name = blob instanceof File ? blob.name : 'blob'): Source {
  return {
    name,
    size: blob.size,
    async read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > blob.size) throw new Error(`${name}: read out of range`)
      return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer())
    },
  }
}

export function bytesSource(bytes: Uint8Array, name = 'bytes'): Source {
  return {
    name,
    size: bytes.byteLength,
    async read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > bytes.byteLength) throw new Error(`${name}: read out of range`)
      return bytes.slice(offset, offset + length)
    },
  }
}

export function subSource(src: Source, offset: number, size: number, name = src.name): Source {
  if (offset + size > src.size) throw new Error(`${name}: range exceeds source`)
  return {
    name,
    size,
    read(o, l) {
      if (o < 0 || l < 0 || o + l > size) return Promise.reject(new Error(`${name}: read out of range`))
      return src.read(offset + o, l)
    },
  }
}

/** Sequential reader with a read-ahead buffer, for streaming through large sources. */
export class SeqReader {
  private buf: Uint8Array = new Uint8Array(0)
  private bufPos = 0
  private srcPos: number

  constructor(
    private readonly src: Source,
    start = 0,
    private readonly chunk = 8 * 1024 * 1024,
  ) {
    this.srcPos = start
  }

  get position(): number {
    return this.srcPos - (this.buf.byteLength - this.bufPos)
  }

  async readExact(n: number): Promise<Uint8Array> {
    if (this.buf.byteLength - this.bufPos >= n) {
      const out = this.buf.subarray(this.bufPos, this.bufPos + n)
      this.bufPos += n
      return out
    }
    const out = new Uint8Array(n)
    let have = this.buf.byteLength - this.bufPos
    out.set(this.buf.subarray(this.bufPos), 0)
    this.buf = new Uint8Array(0)
    this.bufPos = 0
    while (have < n) {
      const want = Math.min(Math.max(this.chunk, n - have), this.src.size - this.srcPos)
      if (want <= 0) throw new Error(`${this.src.name}: unexpected end of data`)
      const got = await this.src.read(this.srcPos, want)
      this.srcPos += got.byteLength
      const take = Math.min(n - have, got.byteLength)
      out.set(got.subarray(0, take), have)
      have += take
      if (take < got.byteLength) {
        this.buf = got
        this.bufPos = take
      }
    }
    return out
  }
}
