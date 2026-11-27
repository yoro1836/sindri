// High-level flows: read-only inspection and full flash.
// Flash flow ported from brokkr-flash (GPL-3.0-or-later, Gabriel2392): src/protocol/odin/flash.cpp.

import { decodeBlocks, Lz4BlockReader, ONE_MIB, readLz4Header } from '../io/lz4'
import { SeqReader } from '../io/source'
import { type ImageSpec, type FlashItem, type Mapping, mapToPit } from './images'
import { type Log, OdinClient } from './odin'
import { findByName, isAB, type Partition, parsePit, type Pit } from './pit'
import type { TargetInfo } from './protocol'
import type { Transport } from './transport'

export interface InspectResult {
  target: TargetInfo
  pitBytes: Uint8Array
  pit: Pit
  mapping?: Mapping
}

/**
 * Read-only: handshake, target info, PIT download, optional mapping of images.
 * Uses a read-only client, so no write/flash command can reach the device.
 */
export async function inspect(
  transport: Transport,
  opts: { images?: ImageSpec[]; reboot?: boolean; log?: Log; handshake?: boolean; onHandshake?: () => void } = {},
): Promise<InspectResult> {
  const odin = new OdinClient(transport, { readOnly: true, log: opts.log })
  if (opts.handshake ?? true) {
    await odin.handshake()
    opts.onHandshake?.()
  }
  const target = await odin.getTargetInfo()
  const pitBytes = await odin.readPit()
  await odin.close(!!opts.reboot)
  const pit = parsePit(pitBytes)
  return { target, pitBytes, pit, mapping: opts.images ? mapToPit(pit, opts.images) : undefined }
}

const XMIT_START_ALIGN = 128 * 1024
const MAX_LZ4_WINDOW = 31 * ONE_MIB
export const DEFAULT_WINDOW = 30 * ONE_MIB

const roundUp = (n: number, a: number) => Math.ceil(n / a) * a

export function xmitWindowBytes(part: Partition, def = DEFAULT_WINDOW): number {
  switch (part.devType) {
    case 1:
    case 2:
    case 8:
      return 30 * ONE_MIB
    case 6:
      return 4 * ONE_MIB
    case 7:
      return ONE_MIB
    case 0: {
      const blk = Math.max(0, part.rawBlockSize)
      const units = Math.floor(blk / 128)
      if (!units) return def
      const base = blk + (part.attribute === 1 ? units * 4 : 0)
      return base * 1024 * Math.floor(800 / units) || def
    }
    default:
      return def
  }
}

export function streamsLz4(spec: ImageSpec, deviceLz4: boolean): boolean {
  return spec.lz4 && deviceLz4 && (spec.lz4BlockSize === ONE_MIB || spec.size <= spec.lz4BlockSize)
}

/** One XMIT window: begin sizes, packet buffer, and the END size. */
export interface Window {
  compressed: boolean
  /** XMIT START size (rounded raw size, or compressed byte count). */
  begin: number
  /** Decompressed bytes covered by this window. */
  end: number
  data: Uint8Array
  last: boolean
}

/** Produces the windows for one image, exactly as brokkr's WindowPrefetcher does. */
export async function* windowsFor(item: FlashItem, deviceLz4: boolean, pkt: number): AsyncGenerator<Window> {
  const { spec, part } = item
  const window = xmitWindowBytes(part)
  if (streamsLz4(spec, deviceLz4)) {
    const header = await readLz4Header(spec.source)
    const reader = new Lz4BlockReader(spec.source, header)
    const winDecomp = Math.min(window, MAX_LZ4_WINDOW) - (Math.min(window, MAX_LZ4_WINDOW) % header.blockSize)
    if (!winDecomp) throw new Error(`${spec.origin}: transfer window smaller than one LZ4 block`)
    let sent = 0
    while (sent < header.contentSize) {
      const rem = header.contentSize - sent
      const last = rem <= winDecomp
      const decomp = last ? rem : winDecomp
      const raw = await reader.readBlocks(last ? reader.remaining : decomp / header.blockSize)
      const data = new Uint8Array(roundUp(raw.byteLength, pkt))
      data.set(raw)
      yield { compressed: true, begin: raw.byteLength, end: decomp, data, last }
      sent += decomp
    }
    return
  }

  let next: () => Promise<Uint8Array>
  const total = spec.size
  if (spec.lz4) {
    // Device can't take this frame compressed: decompress here, whole blocks per window.
    const header = await readLz4Header(spec.source)
    const reader = new Lz4BlockReader(spec.source, header)
    const blocksPerWin = Math.max(1, Math.floor(window / header.blockSize))
    let produced = 0
    next = async () => {
      const n = Math.min(blocksPerWin, reader.remaining)
      const want = Math.min(n * header.blockSize, total - produced)
      const out = new Uint8Array(want)
      const got = decodeBlocks(await reader.readBlocks(n), out)
      if (got !== want) throw new Error(`${spec.origin}: LZ4 decoded ${got} bytes, expected ${want}`)
      produced += got
      return out
    }
  } else {
    const seq = new SeqReader(spec.source, 0, window)
    let left = total
    next = async () => {
      const n = Math.min(left, window)
      left -= n
      return seq.readExact(n)
    }
  }
  let sent = 0
  while (sent < total) {
    const chunk = await next()
    if (!chunk.byteLength) throw new Error(`${spec.origin}: empty read`)
    const data = new Uint8Array(roundUp(chunk.byteLength, pkt))
    data.set(chunk)
    sent += chunk.byteLength
    yield { compressed: false, begin: roundUp(chunk.byteLength, XMIT_START_ALIGN), end: chunk.byteLength, data, last: sent >= total }
  }
}

export interface FlashOptions {
  items: FlashItem[]
  /** PIT to upload before flashing (re-partition). */
  pitUpload?: Uint8Array
  reboot: boolean
  /**
   * The ODIN/LOKE handshake happens once per USB connection. After a session ends without reboot
   * the device stays in download mode and expects INIT directly (Heimdall's --resume).
   */
  handshake?: boolean
  log?: Log
  onStage?: (stage: string) => void
  onProgress?: (p: { done: number; total: number; item: number; itemDone: number; itemTotal: number }) => void
  signal?: AbortSignal
}

export interface FlashSetup {
  target: TargetInfo
  pit: Pit
  pkt: number
}

/** Full flash in one session. `items` must come from mapping against a PIT read from this same device. */
export async function flash(transport: Transport, o: FlashOptions): Promise<FlashSetup> {
  const stage = (s: string) => o.onStage?.(s)
  const odin = new OdinClient(transport, { readOnly: false, log: o.log })

  if (o.handshake ?? true) {
    stage('Handshake')
    await odin.handshake()
  }
  const target = await odin.getTargetInfo()
  const pkt = target.protocol < 2 ? 128 * 1024 : ONE_MIB
  if (target.protocol >= 2) {
    stage('Negotiating packet size')
    await odin.setPacketSize(pkt)
  }

  if (o.pitUpload) {
    stage('Uploading PIT')
    await odin.writePit(o.pitUpload)
  }

  stage('Reading PIT')
  const pit = parsePit(await odin.readPit())
  for (const it of o.items) {
    const p = pit.partitions.find((x) => x.id === it.part.id)
    if (!p || p.fileName !== it.part.fileName || p.devType !== it.part.devType)
      throw new Error(`PIT changed since inspection: ${it.part.fileName}`)
  }

  const total = o.items.reduce((a, it) => a + it.spec.size, 0)
  if (o.items.length) {
    stage('Sending total size')
    await odin.sendTotalSize(total)
  }

  const hasSuper = o.items.some((it) => it.part.name.toUpperCase() === 'SUPER')
  if (!o.pitUpload && hasSuper && isAB(pit) && findByName(pit, 'SUPER')) {
    stage('Declaring super size')
    await odin.declareSuperUsedBlocks(0)
  }

  let done = 0
  for (let i = 0; i < o.items.length; i++) {
    const it = o.items[i]!
    stage(`Flashing ${it.spec.sourceName}`)
    let itemDone = 0
    const gen = windowsFor(it, target.lz4, pkt)
    let pending = gen.next()
    while (true) {
      o.signal?.throwIfAborted()
      const r = await pending
      if (r.done) break
      const w = r.value
      if (!w.last) pending = gen.next() // prefetch the next window while this one is sent
      if (w.compressed) await odin.beginDownloadCompressed(w.begin, w.end)
      else await odin.beginDownload(w.begin)
      const packets = w.data.byteLength / pkt
      for (let p = 0; p < packets; p++) {
        await odin.sendDataPacket(w.data.subarray(p * pkt, (p + 1) * pkt))
        const add = w.compressed
          ? Math.floor(((p + 1) * w.end) / packets) - Math.floor((p * w.end) / packets)
          : Math.max(0, Math.min(pkt, w.end - p * pkt))
        done += add
        itemDone += add
        o.onProgress?.({ done, total, item: i, itemDone, itemTotal: it.spec.size })
      }
      await odin.endDownload({ compressed: w.compressed, size: w.end, partId: it.part.id, devType: it.part.devType, binType: it.part.binType, last: w.last })
      if (w.last) break
    }
  }

  stage(o.reboot ? 'Finishing and rebooting' : 'Finishing')
  await odin.close(o.reboot)
  return { target, pit, pkt }
}
