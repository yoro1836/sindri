// PIT (partition information table) parser.
// Ported from brokkr-flash (GPL-3.0-or-later, Gabriel2392): src/protocol/odin/pit.cpp.

export const PIT_MAGIC = 0x12349876
const HEADER_SIZE = 28
const ENTRY_SIZE = 4 * 9 + 32 * 3

export interface Partition {
  id: number
  binType: number
  devType: number
  attribute: number
  updateAttribute: number
  /** Raw blockSize field (begin block on newer PITs). */
  rawBlockSize: number
  beginBlock: number
  blockBytes: number
  blockCount: number
  /** Partition size in bytes derived from block layout (0 when unknown). */
  sizeBytes: number
  name: string
  fileName: string
}

export interface Pit {
  comTar2: string
  cpuBlId: string
  luCount: number
  partitions: Partition[]
}

function cstr(b: Uint8Array): string {
  const end = b.indexOf(0)
  return new TextDecoder('latin1').decode(end < 0 ? b : b.subarray(0, end)).trim()
}

export function parsePit(bytes: Uint8Array): Pit {
  if (bytes.byteLength < HEADER_SIZE) throw new Error('PIT: buffer too small for header')
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (dv.getInt32(0, true) !== PIT_MAGIC) throw new Error('PIT: bad magic')
  const count = dv.getInt32(4, true)
  if (count < 0 || count > 4096) throw new Error(`PIT: bad partition count ${count}`)
  if (bytes.byteLength < HEADER_SIZE + count * ENTRY_SIZE) throw new Error('PIT: truncated partition table')

  const raw: Array<{ binType: number; devType: number; id: number; attribute: number; updateAttribute: number; blockSize: number; blockLength: number; offset: number; name: string; fileName: string }> = []
  for (let i = 0; i < count; i++) {
    const o = HEADER_SIZE + i * ENTRY_SIZE
    const int = (k: number) => dv.getInt32(o + k * 4, true)
    raw.push({
      binType: int(0),
      devType: int(1),
      id: int(2),
      attribute: int(3),
      updateAttribute: int(4),
      blockSize: int(5),
      blockLength: int(6),
      offset: int(7),
      name: cstr(bytes.subarray(o + 36, o + 68)),
      fileName: cstr(bytes.subarray(o + 68, o + 100)),
    })
  }

  // Newer PITs keep the begin block in blockSize; older ones in offset.
  const maxBlockSize = Math.max(0, ...raw.map((r) => r.blockSize))
  const maxOffset = Math.max(0, ...raw.map((r) => r.offset))
  const blockSizeIsBegin = maxBlockSize > 4096 && maxOffset <= 4096

  const partitions: Partition[] = raw.map((r) => ({
    id: r.id,
    binType: r.binType,
    devType: r.devType,
    attribute: r.attribute,
    updateAttribute: r.updateAttribute,
    rawBlockSize: r.blockSize,
    beginBlock: blockSizeIsBegin ? r.blockSize : r.offset,
    blockBytes: r.devType === 8 ? 4096 : 512,
    blockCount: 0,
    sizeBytes: 0,
    name: r.name,
    fileName: r.fileName,
  }))

  const byDev = new Map<number, number[]>()
  partitions.forEach((p, i) => {
    const l = byDev.get(p.devType) ?? []
    l.push(i)
    byDev.set(p.devType, l)
  })
  for (const idxs of byDev.values()) {
    idxs.sort((a, b) => partitions[a]!.beginBlock - partitions[b]!.beginBlock)
    idxs.forEach((i, k) => {
      const p = partitions[i]!
      let blocks = 0
      const next = idxs[k + 1]
      if (next !== undefined) {
        const diff = partitions[next]!.beginBlock - p.beginBlock
        if (diff > 0) blocks = diff
      } else if (raw[i]!.blockLength > 0) {
        blocks = raw[i]!.blockLength
      }
      p.blockCount = blocks
      p.sizeBytes = blocks * p.blockBytes
    })
  }

  return {
    comTar2: cstr(bytes.subarray(8, 16)),
    cpuBlId: cstr(bytes.subarray(16, 24)),
    luCount: dv.getUint16(24, true),
    partitions,
  }
}

export function findByFileName(pit: Pit, fileName: string): Partition | undefined {
  return fileName ? pit.partitions.find((p) => p.fileName === fileName) : undefined
}

export function findByName(pit: Pit, name: string): Partition | undefined {
  const n = name.toLowerCase()
  return pit.partitions.find((p) => p.name.toLowerCase() === n)
}

export function isAB(pit: Pit): boolean {
  return !!findByName(pit, 'VBMETA_A') && !!findByName(pit, 'VBMETA_B')
}

/** Build PIT bytes (used by tests and the mock device). */
export function buildPit(cpuBlId: string, parts: Array<Omit<Partition, 'beginBlock' | 'blockBytes' | 'blockCount' | 'sizeBytes' | 'rawBlockSize'> & { begin: number; blocks: number }>): Uint8Array {
  const out = new Uint8Array(HEADER_SIZE + parts.length * ENTRY_SIZE)
  const dv = new DataView(out.buffer)
  const enc = new TextEncoder()
  dv.setInt32(0, PIT_MAGIC, true)
  dv.setInt32(4, parts.length, true)
  out.set(enc.encode('COM_TAR2'), 8)
  out.set(enc.encode(cpuBlId).subarray(0, 8), 16)
  parts.forEach((p, i) => {
    const o = HEADER_SIZE + i * ENTRY_SIZE
    const ints = [p.binType, p.devType, p.id, p.attribute, p.updateAttribute, p.begin, p.blocks, 0, 0]
    ints.forEach((v, k) => dv.setInt32(o + k * 4, v, true))
    out.set(enc.encode(p.name).subarray(0, 31), o + 36)
    out.set(enc.encode(p.fileName).subarray(0, 31), o + 68)
  })
  return out
}
