// Loaded by the UI smoke test: replaces navigator.usb with a fake download-mode device.
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
const usb = new FakeUsb(mock)
Object.defineProperty(navigator, 'usb', {
  value: Object.assign(new EventTarget(), { requestDevice: async () => usb, getDevices: async () => [usb] }),
})
;(window as unknown as { __mock: MockDevice }).__mock = mock
