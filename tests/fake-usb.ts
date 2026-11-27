// Fake WebUSB device backed by MockDevice (used by unit tests and the UI smoke test).
import type { MockDevice } from './mock-device'

export class FakeUsb {
  opened = false
  claimed = -1
  zlps = 0
  maxIn = 0
  private q = new Uint8Array(0)
  configuration = {
    configurationValue: 1,
    interfaces: [
      { interfaceNumber: 0, alternates: [{ alternateSetting: 0, interfaceClass: 2, endpoints: [{ endpointNumber: 3, direction: 'in', type: 'interrupt' }] }] },
      {
        interfaceNumber: 1,
        alternates: [
          {
            alternateSetting: 0,
            interfaceClass: 10,
            endpoints: [
              { endpointNumber: 1, direction: 'in', type: 'bulk' },
              { endpointNumber: 2, direction: 'out', type: 'bulk' },
            ],
          },
        ],
      },
    ],
  }
  productName = 'SAMSUNG USB'
  vendorId = 0x04e8
  productId = 0x685d
  constructor(readonly dev: MockDevice) {}
  async open() {
    this.opened = true
  }
  async close() {}
  async selectConfiguration() {}
  async claimInterface(n: number) {
    this.claimed = n
  }
  async releaseInterface() {}
  async selectAlternateInterface() {}
  async transferOut(ep: number, data: Uint8Array) {
    if (ep !== 2) throw new Error(`bad OUT ep ${ep}`)
    if (data.byteLength === 0) {
      this.zlps++
      return { status: 'ok', bytesWritten: 0 }
    }
    await this.dev.write(data)
    const more = this.dev.takeAll()
    const q = new Uint8Array(this.q.byteLength + more.byteLength)
    q.set(this.q)
    q.set(more, this.q.byteLength)
    this.q = q
    this.wake()
    return { status: 'ok', bytesWritten: data.byteLength }
  }
  private waiters: Array<() => void> = []
  private wake() {
    while (this.q.byteLength && this.waiters.length) this.waiters.shift()!()
  }
  /** Like real hardware: a transferIn stays pending until the device sends something. */
  transferIn(ep: number, len: number): Promise<{ status: string; data: DataView }> {
    if (ep !== 1) throw new Error(`bad IN ep ${ep}`)
    this.maxIn = Math.max(this.maxIn, len)
    return new Promise((resolve) => {
      const take = () => {
        const n = Math.min(len, this.q.byteLength)
        const out = this.q.slice(0, n)
        this.q = this.q.slice(n)
        resolve({ status: 'ok', data: new DataView(out.buffer) })
      }
      this.waiters.push(take)
      this.wake()
    })
  }
}

