// Web Serial transport: uses the OS CDC-ACM driver (usbser.sys / cdc_acm), so no driver swap on Windows.
// Pending-read handling follows libmjolnir's WebSerialTransport (MIT, Greg Willard / LineageOS).

import { DOWNLOAD_MODE_PIDS, SAMSUNG_VID } from '../core/protocol'
import { TimeoutError, type Transport, withTimeout } from '../core/transport'

export const serialFilters: SerialPortFilter[] = DOWNLOAD_MODE_PIDS.map((usbProductId) => ({ usbVendorId: SAMSUNG_VID, usbProductId }))

export function webSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator
}

export async function requestSerialPort(): Promise<SerialPort> {
  return navigator.serial.requestPort({ filters: serialFilters })
}

export class WebSerialTransport implements Transport {
  readonly kind = 'serial' as const
  private reader?: ReadableStreamDefaultReader<Uint8Array>
  private writer?: WritableStreamDefaultWriter<Uint8Array>
  private chunks: Uint8Array[] = []
  private head = 0
  private available = 0
  private pending?: Promise<ReadableStreamReadResult<Uint8Array>>

  constructor(readonly port: SerialPort) {}

  get label(): string {
    const i = this.port.getInfo()
    return `serial port (${(i.usbVendorId ?? 0).toString(16)}:${(i.usbProductId ?? 0).toString(16)})`
  }

  async open(): Promise<void> {
    // CDC-ACM ignores the baud rate; a large buffer keeps 1 MiB packets flowing.
    await withTimeout(this.port.open({ baudRate: 115200, bufferSize: 1 << 20 }), 5000, 'opening the serial port')
    try {
      await this.port.setSignals({ dataTerminalReady: true })
    } catch {
      // not every platform implements it
    }
    if (!this.port.readable || !this.port.writable) throw new Error('serial port has no streams')
    this.reader = this.port.readable.getReader()
    this.writer = this.port.writable.getWriter()
  }

  async close(): Promise<void> {
    try {
      await this.reader?.cancel()
    } catch {
      // ignore
    }
    this.reader?.releaseLock()
    this.writer?.releaseLock()
    this.reader = this.writer = this.pending = undefined
    this.chunks = []
    this.head = this.available = 0
    await this.port.close()
  }

  async write(data: Uint8Array, timeoutMs: number): Promise<void> {
    if (!this.writer) throw new Error('serial port is not open')
    await withTimeout(this.writer.write(data), timeoutMs, 'serial write')
  }

  private async readChunk(timeoutMs: number): Promise<void> {
    if (!this.reader) throw new Error('serial port is not open')
    const p = this.pending ?? this.reader.read()
    this.pending = p
    let r: ReadableStreamReadResult<Uint8Array>
    try {
      r = await withTimeout(p, timeoutMs, 'serial read')
    } catch (e) {
      if (!(e instanceof TimeoutError)) this.pending = undefined
      throw e
    }
    this.pending = undefined
    if (r.done) throw new Error('serial stream closed')
    if (r.value.byteLength) {
      this.chunks.push(r.value)
      this.available += r.value.byteLength
    }
  }

  async read(length: number, timeoutMs: number): Promise<Uint8Array> {
    while (this.available < length) await this.readChunk(timeoutMs)
    const out = new Uint8Array(length)
    let w = 0
    while (w < length) {
      const c = this.chunks[0]!
      const take = Math.min(c.byteLength - this.head, length - w)
      out.set(c.subarray(this.head, this.head + take), w)
      w += take
      this.head += take
      if (this.head === c.byteLength) {
        this.chunks.shift()
        this.head = 0
      }
    }
    this.available -= length
    return out
  }

  async drain(): Promise<void> {
    // Zero-length packets never reach a serial stream; nothing to drain.
  }
}
