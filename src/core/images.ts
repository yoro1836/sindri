// Turn the selected firmware files into flashable images and map them onto the device PIT.
// Ported from brokkr-flash (GPL-3.0-or-later, Gabriel2392): src/protocol/odin/image.cpp.

import { isLz4Name, readLz4Header } from '../io/lz4'
import { type Source } from '../io/source'
import { entrySource, indexTar, isTar, tarBasename } from '../io/tar'
import { findByFileName, type Partition, type Pit } from './pit'

export interface ImageSpec {
  /** Name the PIT knows (".lz4" stripped). */
  basename: string
  /** Name inside the archive (or of the raw file). */
  sourceName: string
  /** Where it came from, for display. */
  origin: string
  source: Source
  lz4: boolean
  lz4BlockSize: number
  /** Bytes the device will write (decompressed size for LZ4). */
  size: number
}

export interface FlashItem {
  part: Partition
  spec: ImageSpec
}

const DOWNLOAD_LIST = /^(\.\/)?meta-data\/download-list\.txt$/

const isPitName = (n: string) => n.toLowerCase().endsWith('.pit')
const stripLz4 = (n: string) => (isLz4Name(n) ? n.slice(0, -4) : n)

async function makeSpec(source: Source, sourceName: string, origin: string): Promise<ImageSpec> {
  const lz4 = isLz4Name(sourceName)
  const spec: ImageSpec = { basename: stripLz4(sourceName), sourceName, origin, source, lz4, lz4BlockSize: 0, size: source.size }
  if (lz4) {
    const h = await readLz4Header(source)
    spec.size = h.contentSize
    spec.lz4BlockSize = h.blockSize
  }
  return spec
}

export interface Expanded {
  images: ImageSpec[]
  pit?: ImageSpec
  skipped: string[]
}

/** Inputs are tar(.md5) archives or raw images. Later inputs win on duplicate names. */
export async function expandInputs(inputs: Source[]): Promise<Expanded> {
  type Cand = { source: Source; name: string; origin: string }
  const cands: Cand[] = []
  let downloadList: string[] | undefined
  const skipped: string[] = []

  for (const input of inputs) {
    if (await isTar(input)) {
      const idx = await indexTar(input)
      for (const e of idx.entries) {
        if (DOWNLOAD_LIST.test(e.name)) {
          const txt = new TextDecoder().decode(await input.read(e.dataOffset, Math.min(e.size, 128 * 1024)))
          const names = [...new Set(txt.split('\n').map((l) => l.trim()).filter(Boolean))]
          if (downloadList && downloadList.join('\n') !== names.join('\n'))
            throw new Error('multiple download-list.txt files with different contents')
          downloadList = names
          continue
        }
        const name = tarBasename(e.name)
        if (!name) continue
        cands.push({ source: entrySource(input, e), name, origin: `${input.name}:${e.name}` })
      }
    } else if (/\.tar(\.md5)?$/i.test(input.name)) {
      throw new Error(`${input.name}: not a valid tar archive`)
    } else {
      cands.push({ source: input, name: input.name, origin: input.name })
    }
  }

  const last = new Map<string, Cand>()
  for (const c of cands) last.set(stripLz4(c.name), c)

  const allow = downloadList ? new Set(downloadList) : undefined
  const images: ImageSpec[] = []
  let pit: ImageSpec | undefined
  for (const c of cands) {
    const base = stripLz4(c.name)
    if (last.get(base) !== c) continue
    if (isPitName(base)) {
      pit = await makeSpec(c.source, c.name, c.origin)
      continue
    }
    if (allow && !allow.has(base)) {
      skipped.push(`${c.name} (not in download-list.txt)`)
      continue
    }
    images.push(await makeSpec(c.source, c.name, c.origin))
  }
  return { images, pit, skipped }
}

export interface Mapping {
  items: FlashItem[]
  unmatched: ImageSpec[]
  oversized: FlashItem[]
}

export function mapToPit(pit: Pit, images: ImageSpec[]): Mapping {
  const byPart = new Map<number, FlashItem>()
  const unmatched: ImageSpec[] = []
  for (const spec of images) {
    const part = findByFileName(pit, spec.basename)
    if (!part) {
      unmatched.push(spec)
      continue
    }
    byPart.set(part.id, { part, spec })
  }
  const items = [...byPart.values()]
  const oversized = items.filter((it) => it.part.sizeBytes > 0 && it.spec.size > it.part.sizeBytes)
  return { items, unmatched, oversized }
}
