// Loaded by the UI smoke test: replaces navigator.usb (and navigator.serial) with a fake download-mode device.
// ?busy makes the USB interface unclaimable, like Windows with the Samsung driver, so the UI must fall back to serial.
import { buildPit } from '../../src/core/pit'
import { FakeUsb } from '../fake-usb'
import { MockDevice } from '../mock-device'

const pit = buildPit('s5e9945', [
  { id: 1, binType: 0, devType: 8, attribute: 0, updateAttribute: 1, name: 'BOOT', fileName: 'boot.img', begin: 8192, blocks: 16384 },
  { id: 2, binType: 0, devType: 8, attribute: 0, updateAttribute: 1, name: 'SUPER', fileName: 'super.img', begin: 24576, blocks: 65536 },
  { id: 3, binType: 0, devType: 8, attribute: 0, updateAttribute: 1, name: 'VBMETA_A', fileName: 'vbmeta.img', begin: 90112, blocks: 16 },
  { id: 4, binType: 0, devType: 8, attribute: 0, updateAttribute: 1, name: 'VBMETA_B', fileName: '', begin: 90128, blocks: 16 },
])
export const mock = new MockDevice({ pit })
const busy = new URLSearchParams(location.search).has('busy')

const usb = new FakeUsb(mock)
if (busy)
  usb.claimInterface = async () => {
    throw new DOMException('Unable to claim interface.', 'NetworkError')
  }

// Like a first visit: nothing is allowed until a chooser is used once.
let usbAllowed = false
Object.defineProperty(navigator, 'usb', {
  value: Object.assign(new EventTarget(), {
    requestDevice: async () => ((usbAllowed = true), usb),
    getDevices: async () => (usbAllowed ? [usb] : []),
  }),
})

let serialAllowed = false
let ctrl!: ReadableStreamDefaultController<Uint8Array>
const port = Object.assign(new EventTarget(), {
  readable: null as ReadableStream<Uint8Array> | null,
  writable: null as WritableStream<Uint8Array> | null,
  getInfo: () => ({ usbVendorId: 0x04e8, usbProductId: 0x685d }),
  async open() {
    port.readable = new ReadableStream({ start: (c) => void (ctrl = c) })
    port.writable = new WritableStream({
      async write(chunk) {
        await mock.write(chunk)
        const out = mock.takeAll()
        if (out.byteLength) ctrl.enqueue(out)
      },
    })
  },
  async setSignals() {},
  async close() {},
})
Object.defineProperty(navigator, 'serial', {
  value: Object.assign(new EventTarget(), {
    requestPort: async () => ((serialAllowed = true), port),
    getPorts: async () => (serialAllowed ? [port] : []),
  }),
})
;(window as unknown as { __mock: MockDevice }).__mock = mock
