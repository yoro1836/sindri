// Drives the real WebUsbTransport against a fake USBDevice backed by the mock download-mode device.
import { describe, expect, it } from 'vitest'
import { expandInputs } from '../src/core/images'
import { buildPit } from '../src/core/pit'
import { flash, inspect } from '../src/core/session'
import { bytesSource } from '../src/io/source'
import { buildTar } from '../src/io/tar'
import { WebUsbTransport } from '../src/transport/webusb'
import { lz4Frame } from './lz4-encode'
import { MockDevice } from './mock-device'
import { FakeUsb } from './fake-usb'

const PIT = buildPit('s5e9945', [
  { id: 7, binType: 0, devType: 8, attribute: 0, updateAttribute: 1, name: 'BOOT', fileName: 'boot.img', begin: 8192, blocks: 16384 },
  { id: 8, binType: 0, devType: 8, attribute: 0, updateAttribute: 1, name: 'VENDOR_BOOT', fileName: 'vendor_boot.img', begin: 24576, blocks: 16384 },
])

describe('WebUsbTransport', () => {
  it('claims the CDC data interface, sends ZLPs, and completes inspect + flash', async () => {
    const mock = new MockDevice({ pit: PIT })
    const usb = new FakeUsb(mock)
    const t = new WebUsbTransport(usb as unknown as USBDevice)
    await t.open()
    expect(usb.claimed).toBe(1)

    const boot = new Uint8Array(3 * 1024 * 1024 + 5).map((_, i) => (i * 31) & 0xff)
    const vb = new Uint8Array(2 * 1024 * 1024).map((_, i) => (i >> 9) & 0xff)
    const tar = buildTar([
      { name: 'boot.img', data: boot },
      { name: 'vendor_boot.img.lz4', data: lz4Frame(vb) },
    ])
    const { images } = await expandInputs([bytesSource(tar, 'AP.tar')])
    const r = await inspect(t, { images })
    expect(r.pit.partitions.length).toBe(2)
    expect(usb.zlps).toBeGreaterThan(0)
    await flash(t, { items: r.mapping!.items, reboot: true, handshake: false })
    expect(mock.partition(7).every((v, i) => v === boot[i])).toBe(true)
    expect(mock.partition(8).every((v, i) => v === vb[i])).toBe(true)
    expect(mock.rebooted).toBe(true)
  })
})
