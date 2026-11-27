import { describe, expect, it } from 'vitest'
import { expandInputs } from '../src/core/images'
import { OdinClient, ReadOnlyViolation } from '../src/core/odin'
import { buildPit, parsePit } from '../src/core/pit'
import { Cmd, CloseParam, InitParam, PitParam, splitTotalSize } from '../src/core/protocol'
import { flash, inspect } from '../src/core/session'
import { decodeBlocks, Lz4BlockReader, readLz4Header } from '../src/io/lz4'
import { findMd5Trailer, md5Of } from '../src/io/md5'
import { bytesSource } from '../src/io/source'
import { buildTar, indexTar } from '../src/io/tar'
import { lz4Frame } from './lz4-encode'
import { MockDevice } from './mock-device'

const MiB = 1024 * 1024

/** vitest's toEqual on multi-MB typed arrays is extremely slow; compare directly. */
function expectBytes(a: Uint8Array, b: Uint8Array) {
  expect(a.byteLength).toBe(b.byteLength)
  const i = a.findIndex((v, k) => v !== b[k])
  expect(i).toBe(-1)
}

function rand(n: number, seed: number, compressible = true): Uint8Array {
  const out = new Uint8Array(n)
  let x = seed >>> 0 || 1
  for (let i = 0; i < n; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    out[i] = compressible ? (x >>> 24) & 0x0f : x >>> 24
  }
  return out
}

const PIT = buildPit('s5e9945', [
  { id: 1, binType: 0, devType: 8, attribute: 0, updateAttribute: 1, name: 'BOOT', fileName: 'boot.img', begin: 8192, blocks: 16384 },
  { id: 2, binType: 0, devType: 8, attribute: 0, updateAttribute: 1, name: 'SUPER', fileName: 'super.img', begin: 24576, blocks: 65536 },
  { id: 3, binType: 1, devType: 8, attribute: 0, updateAttribute: 1, name: 'RADIO', fileName: 'modem.bin', begin: 90112, blocks: 8192 },
  { id: 4, binType: 0, devType: 8, attribute: 0, updateAttribute: 1, name: 'VBMETA_A', fileName: 'vbmeta.img', begin: 98304, blocks: 16 },
  { id: 5, binType: 0, devType: 8, attribute: 0, updateAttribute: 1, name: 'VBMETA_B', fileName: '', begin: 98320, blocks: 16 },
])

describe('protocol details', () => {
  it('splits total size like brokkr (by 0xFFFFFFFF)', () => {
    expect(splitTotalSize(10)).toEqual([10, 0])
    expect(splitTotalSize(0xffffffff)).toEqual([0, 1])
    expect(splitTotalSize(9_000_000_000)).toEqual([9_000_000_000 % 0xffffffff | 0, 2])
  })

  it('parses a PIT', () => {
    const pit = parsePit(PIT)
    expect(pit.cpuBlId).toBe('s5e9945')
    expect(pit.partitions[1]!.name).toBe('SUPER')
    expect(pit.partitions[0]!.sizeBytes).toBe(16384 * 4096)
  })
})

describe('read-only inspection', () => {
  it('reads the PIT and sends only allow-listed commands', async () => {
    const dev = new MockDevice({ pit: PIT })
    const r = await inspect(dev)
    expectBytes(r.pitBytes, PIT)
    expect(r.target.lz4).toBe(true)
    expect(r.target.protocol).toBe(5)
    expect(dev.rawWrites).toBe(0)
    expect(dev.rebooted).toBe(false)
    const allowed = new Set([`${Cmd.INIT}/${InitParam.TARGET}`, `${Cmd.PIT}/${PitParam.GET}`, `${Cmd.PIT}/${PitParam.START}`, `${Cmd.PIT}/${PitParam.COMPLETE}`, `${Cmd.CLOSE}/${CloseParam.END}`])
    for (const q of dev.requests) expect(allowed.has(`${q.id}/${q.param}`)).toBe(true)
    // multi-chunk PIT read: 28 + 5*132 bytes => 2 chunks
    expect(dev.requests.filter((q) => q.id === Cmd.PIT && q.param === PitParam.START).map((q) => q.ints[0])).toEqual([0, 1])
  })

  it('read-only client refuses every write path before it hits the wire', async () => {
    const dev = new MockDevice({ pit: PIT })
    const odin = new OdinClient(dev, { readOnly: true })
    await odin.handshake()
    await odin.getTargetInfo()
    const before = dev.requests.length
    await expect(odin.setPacketSize(MiB)).rejects.toBeInstanceOf(ReadOnlyViolation)
    await expect(odin.sendTotalSize(1)).rejects.toBeInstanceOf(ReadOnlyViolation)
    await expect(odin.writePit(PIT)).rejects.toBeInstanceOf(ReadOnlyViolation)
    await expect(odin.declareSuperUsedBlocks(0)).rejects.toBeInstanceOf(ReadOnlyViolation)
    await expect(odin.beginDownload(MiB)).rejects.toBeInstanceOf(ReadOnlyViolation)
    await expect(odin.beginDownloadCompressed(1, 1)).rejects.toBeInstanceOf(ReadOnlyViolation)
    await expect(odin.sendDataPacket(new Uint8Array(MiB))).rejects.toBeInstanceOf(ReadOnlyViolation)
    await expect(odin.endDownload({ compressed: false, size: 1, partId: 1, devType: 8, binType: 0, last: true })).rejects.toBeInstanceOf(ReadOnlyViolation)
    expect(dev.requests.length).toBe(before)
    expect(dev.rawWrites).toBe(0)
  })
})

describe('tar / lz4 / md5', () => {
  it('indexes a tar and verifies its md5 trailer', async () => {
    const a = rand(3000, 1)
    const body = buildTar([{ name: 'boot.img', data: a }])
    const hex = await md5Of(bytesSource(body), body.length)
    const tarMd5 = buildTar([{ name: 'boot.img', data: a }], `${hex}  AP_test.tar\n`)
    const src = bytesSource(tarMd5, 'AP_test.tar.md5')
    const t = await findMd5Trailer(src)
    expect(t).toEqual({ expected: hex, hashedBytes: body.length })
    const idx = await indexTar(src)
    expect(idx.entries).toEqual([{ name: 'boot.img', size: 3000, dataOffset: 512 }])
  })

  it('round-trips LZ4 frames including stored blocks', async () => {
    const data = rand(3 * MiB + 12345, 7)
    const frame = lz4Frame(data, MiB, 2)
    const src = bytesSource(frame)
    const h = await readLz4Header(src)
    expect(h.contentSize).toBe(data.length)
    const r = new Lz4BlockReader(src, h)
    const out = new Uint8Array(data.length)
    expect(decodeBlocks(await r.readBlocks(r.remaining), out)).toBe(data.length)
    expectBytes(out, data)
  })
})

async function firmware() {
  const boot = rand(5 * MiB + 777, 11, false) // raw, not a packet multiple
  const superImg = rand(40 * MiB + 4321, 12) // lz4, spans multiple windows
  const modem = rand(2 * MiB, 13)
  const vbmeta = rand(4096, 14, false)
  const ap = buildTar([
    { name: 'boot.img', data: boot },
    { name: 'super.img.lz4', data: lz4Frame(superImg) },
    { name: 'vbmeta.img', data: vbmeta },
    { name: 'meta-data/download-list.txt', data: new TextEncoder().encode('boot.img\nsuper.img\nvbmeta.img\nmodem.bin\n') },
  ])
  const cp = buildTar([{ name: 'modem.bin.lz4', data: lz4Frame(modem, 256 * 1024) }])
  return { boot, superImg, modem, vbmeta, inputs: [bytesSource(ap, 'AP.tar'), bytesSource(cp, 'CP.tar')] }
}

describe('flash against the mock device', () => {
  for (const lz4 of [true, false]) {
    it(`writes every partition byte-exact (device lz4=${lz4})`, async () => {
      const fw = await firmware()
      const { images } = await expandInputs(fw.inputs)
      const dev = new MockDevice({ pit: PIT, lz4 })
      const { mapping } = await inspect(new MockDevice({ pit: PIT, lz4 }), { images })
      expect(mapping!.unmatched).toEqual([])
      await flash(dev, { items: mapping!.items, reboot: true })
      expectBytes(dev.partition(1), fw.boot)
      expectBytes(dev.partition(2), fw.superImg)
      expectBytes(dev.partition(3), fw.modem)
      expectBytes(dev.partition(4), fw.vbmeta)
      expect([...dev.finished].sort()).toEqual([1, 2, 3, 4])
      expect(dev.totalSize).toBe(fw.boot.length + fw.superImg.length + fw.modem.length + fw.vbmeta.length)
      expect(dev.superDeclared).toBe(true)
      expect(dev.rebooted).toBe(true)
      // 256 KiB-block modem frame can't stream compressed (needs 1 MiB blocks unless it fits in one).
      const compressedStarts = dev.requests.filter((q) => q.id === Cmd.XMIT && q.param === 6).length
      expect(compressedStarts > 0).toBe(lz4)
    })
  }

  it('flashes on the same connection after a read-only inspection, without a second handshake', async () => {
    const fw = await firmware()
    const { images } = await expandInputs(fw.inputs)
    const dev = new MockDevice({ pit: PIT })
    const { mapping } = await inspect(dev, { images })
    await flash(dev, { items: mapping!.items, reboot: false, handshake: false })
    expectBytes(dev.partition(2), fw.superImg)
    expect(dev.rebooted).toBe(false)
  })

  it('surfaces bootloader error codes', async () => {
    const fw = await firmware()
    const { images } = await expandInputs(fw.inputs)
    const { mapping } = await inspect(new MockDevice({ pit: PIT }), { images })
    const dev = new MockDevice({ pit: PIT, failComplete: { at: 1, ack: -111 } })
    await expect(flash(dev, { items: mapping!.items, reboot: false })).rejects.toThrow(/signature verification failed/)
  })
})
