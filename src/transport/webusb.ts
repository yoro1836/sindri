// WebUSB transport: claims the CDC-Data interface (class 0x0A) and talks on its bulk endpoints.
// Interface selection and the "orphaned transferIn" handling follow libmjolnir (MIT, Greg Willard / LineageOS).

import { DOWNLOAD_MODE_PIDS, SAMSUNG_VID } from '../core/protocol'
import { TimeoutError, type Transport, withTimeout } from '../core/transport'

const USB_CLASS_CDC_DATA = 0x0a

export const usbFilters: USBDeviceFilter[] = DOWNLOAD_MODE_PIDS.map((productId) => ({ vendorId: SAMSUNG_VID, productId }))

export function webUsbSupported(): boolean {
  return typeof navigator !== 'undefined' && 'usb' in navigator
}

export async function requestUsbDevice(): Promise<USBDevice> {
  return navigator.usb.requestDevice({ filters: usbFilters })
}

export class WebUsbTransport implements Transport {
  readonly kind = 'usb' as const
  private iface = -1
  private epIn = -1
  private epOut = -1
  private zlp = true
  /** WebUSB can't cancel a transfer; a timed-out transferIn must be consumed by the next read. */
  private orphan?: Promise<USBInTransferResult>

  constructor(readonly device: USBDevice) {}

  get label(): string {
    const d = this.device
    return `${d.productName ?? 'USB device'} (${hex(d.vendorId)}:${hex(d.productId)})`
  }

  async open(): Promise<void> {
    const d = this.device
    await withTimeout(d.open(), 5000, 'opening the USB device')
    if (!d.configuration) await d.selectConfiguration(1)
    const conf = d.configuration
    if (!conf) throw new Error('device has no active configuration')
    let alt = -1
    for (const itf of conf.interfaces) {
      for (const a of itf.alternates) {
        const i = a.endpoints.find((e) => e.direction === 'in' && e.type === 'bulk')
        const o = a.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk')
        if (a.interfaceClass === USB_CLASS_CDC_DATA && i && o) {
          this.iface = itf.interfaceNumber
          alt = a.alternateSetting
          this.epIn = i.endpointNumber
          this.epOut = o.endpointNumber
          break
        }
      }
      if (this.iface >= 0) break
    }
    if (this.iface < 0) throw new Error('no CDC data interface with bulk endpoints found')
    try {
      await withTimeout(d.claimInterface(this.iface), 5000, 'claiming the USB interface')
    } catch (e) {
      throw new Error(
        `could not claim the USB interface (${String(e)}). Another driver owns it: on Windows use the Serial connection or install WinUSB with Zadig; on Linux use Serial or unbind cdc_acm.`,
      )
    }
    if (alt > 0) await d.selectAlternateInterface(this.iface, alt)
  }

  async close(): Promise<void> {
    try {
      if (this.iface >= 0) await this.device.releaseInterface(this.iface)
    } catch {
      // ignore
    }
    await this.device.close()
  }

  async write(data: Uint8Array, timeoutMs: number): Promise<void> {
    const r = await withTimeout(this.device.transferOut(this.epOut, data as Uint8Array<ArrayBuffer>), timeoutMs, 'USB write')
    if (r.status !== 'ok' || r.bytesWritten !== data.byteLength) throw new Error(`USB write ${r.status} (${r.bytesWritten}/${data.byteLength})`)
    // brokkr follows every OUT transfer with a zero-length packet until one fails.
    if (this.zlp) {
      try {
        await withTimeout(this.device.transferOut(this.epOut, new Uint8Array(0)), 100, 'USB ZLP')
      } catch {
        this.zlp = false
      }
    }
  }

  async read(length: number, timeoutMs: number): Promise<Uint8Array> {
    const out = new Uint8Array(length)
    let have = 0
    while (have < length) {
      const t = this.orphan ?? this.device.transferIn(this.epIn, length - have)
      this.orphan = undefined
      let r: USBInTransferResult
      try {
        r = await withTimeout(t, timeoutMs, 'USB read')
      } catch (e) {
        if (e instanceof TimeoutError) this.orphan = t
        throw e
      }
      if (r.status !== 'ok' || !r.data) throw new Error(`USB read ${r.status}`)
      const chunk = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength)
      if (have + chunk.byteLength > length) throw new Error(`USB read overflow (${have + chunk.byteLength} > ${length})`)
      out.set(chunk, have)
      have += chunk.byteLength
    }
    return out
  }

  async drain(timeoutMs: number): Promise<void> {
    const t = this.orphan ?? this.device.transferIn(this.epIn, 512)
    this.orphan = undefined
    try {
      await withTimeout(t, timeoutMs, 'USB drain')
    } catch {
      this.orphan = t
    }
  }
}

const hex = (n: number) => n.toString(16).padStart(4, '0')
