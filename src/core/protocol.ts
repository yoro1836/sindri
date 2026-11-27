// Samsung download-mode ("Odin"/"Loke") wire format.
// Ported from brokkr-flash (GPL-3.0-or-later, Gabriel2392): src/protocol/odin/packet.hpp, cmd.cpp.

export const SAMSUNG_VID = 0x04e8
export const DOWNLOAD_MODE_PIDS = [0x6601, 0x685d, 0x68c3] as const

export const Cmd = {
  INIT: 100,
  PIT: 101,
  XMIT: 102,
  CLOSE: 103,
  SUPER: 106,
  EMPTY: 0,
} as const

export const InitParam = { TARGET: 0, TOTALSIZE: 2, PACKETSIZE: 5 } as const
export const PitParam = { SET: 0, GET: 1, START: 2, COMPLETE: 3 } as const
export const XmitParam = {
  DOWNLOAD: 0,
  START: 2,
  COMPLETE: 3,
  COMPRESSED_DOWNLOAD: 5,
  COMPRESSED_START: 6,
  COMPRESSED_COMPLETE: 7,
} as const
export const CloseParam = { END: 0, REBOOT: 1 } as const
export const SuperParam = { USED_BLOCKS: 0 } as const

export const REQUEST_SIZE = 1024
export const RESPONSE_SIZE = 8
const INT_COUNT = 9
const CHAR_OFFSET = 8 + INT_COUNT * 4
const CHAR_SIZE = 128

export const PROTOCOL_VERSION_REQUESTED = 5

export interface Request {
  id: number
  param: number
  ints: number[]
}

export function encodeRequest(id: number, param: number, ints: readonly number[] = [], chars?: Uint8Array): Uint8Array {
  if (ints.length > INT_COUNT) throw new Error(`too many ints (${ints.length})`)
  const buf = new Uint8Array(REQUEST_SIZE)
  const dv = new DataView(buf.buffer)
  dv.setInt32(0, id, true)
  dv.setInt32(4, param, true)
  ints.forEach((v, i) => dv.setInt32(8 + i * 4, v | 0, true))
  if (chars) buf.set(chars.subarray(0, CHAR_SIZE), CHAR_OFFSET)
  return buf
}

export function decodeRequest(buf: Uint8Array): Request {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const ints: number[] = []
  for (let i = 0; i < INT_COUNT; i++) ints.push(dv.getInt32(8 + i * 4, true))
  return { id: dv.getInt32(0, true), param: dv.getInt32(4, true), ints }
}

export interface Response {
  id: number
  ack: number
}

export function encodeResponse(id: number, ack: number): Uint8Array {
  const buf = new Uint8Array(RESPONSE_SIZE)
  const dv = new DataView(buf.buffer)
  dv.setInt32(0, id, true)
  dv.setInt32(4, ack | 0, true)
  return buf
}

export function decodeResponse(buf: Uint8Array): Response {
  if (buf.byteLength !== RESPONSE_SIZE) throw new Error(`response must be 8 bytes, got ${buf.byteLength}`)
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  return { id: dv.getInt32(0, true), ack: dv.getInt32(4, true) }
}

/** INIT/TARGET ack word: protocol version in the high half, LZ4 capability bit. */
export interface TargetInfo {
  ackWord: number
  protocol: number
  lz4: boolean
}

export function parseTargetAck(ack: number): TargetInfo {
  const ackWord = ack >>> 0
  const raw = (ackWord >>> 16) & 0xffff
  const protocol = raw === 0 ? 1 : raw
  return { ackWord, protocol, lz4: protocol > 2 && (ackWord & 0x8000) !== 0 }
}

/** TOTALSIZE is split by 0xFFFFFFFF (not 2^32), matching brokkr. */
export function splitTotalSize(total: number): [number, number] {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error(`bad total size ${total}`)
  const k = 0xffffffff
  return [(total % k) | 0, Math.floor(total / k) | 0]
}

const BOOTLOADER_ERRORS: Record<number, string> = {
  [-1]: 'unsupported binary',
  [-2]: 'write protection failure',
  [-3]: 'failed to clear write protection',
  [-4]: 'write failed',
  [-5]: 'secure check failed',
  [-6]: 'size check failed',
  [-7]: 'ext4 image handling failed',
  [-8]: 'image exceeds the 112MiB staging limit',
  [-127]: 'unknown partition',
  [-126]: 'PIT entry has no file name',
  [-125]: 'm9kefs3 cannot be downloaded',
  [-124]: 'image is too big for the partition',
  [-123]: 'BL1 check failed',
  [-122]: 'partition ID mismatch, or SUPER write rejected (upload a PIT first)',
  [-121]: 'partition is not UFS on a UFS device',
  [-120]: 'partition device type is not supported',
  [-119]: 'block write failed',
  [-118]: 'block read failed',
  [-117]: 'block erase failed',
  [-116]: 'unsupported filesystem type',
  [-115]: 'filesystem is not supported',
  [-114]: 'all binaries are blocked (KG locked)',
  [-113]: 'MDM mode, cannot download',
  [-112]: 'Knox Guard prevents flashing factory binaries',
  [-111]: 'secure check fail (signature verification failed)',
  [-110]: 'only official binaries allowed (Knox Guard)',
  [-109]: 'only official binaries allowed (Knox Guard v2.0)',
  [-108]: 'custom binary blocked by R/L',
  [-107]: 'custom binary blocked by OEM lock',
  [-106]: 'kernel rollback protection check failed',
  [-105]: 'cross-verify (kill switch) lock',
  [-104]: 'system rollback protection check failed',
  [-103]: 'ENG binary, use a USER binary',
  [-102]: 'TOKEN size is too big',
  [-101]: 'unsupported version (rollback protection)',
  [-100]: 'LDFW region erase failed',
  [-99]: 'LDFW region write failed',
  [-98]: 'UL_KEYS write failed',
  [-97]: 'bootloader token install failed',
  [-96]: 'image write failed',
  [-94]: 'AUTO BLOCKER is on, cannot download',
}

export class DeviceError extends Error {
  constructor(
    message: string,
    readonly ack?: number,
  ) {
    super(message)
    this.name = 'DeviceError'
  }
}

/** Validate a response against the request id. Returns the ack. */
export function checkResponse(expectedId: number, r: Response, allowNegativeAck = false): number {
  if (r.id === -1) {
    const why = BOOTLOADER_ERRORS[r.ack]
    const hex = (r.ack >>> 0).toString(16).padStart(8, '0')
    throw new DeviceError(why ? `${why} (${r.ack})` : `bootloader error (ack=${r.ack} / 0x${hex})`, r.ack)
  }
  if (r.id === -0x80000000) throw new DeviceError('invalid response id (INT_MIN)')
  if (r.id !== expectedId) throw new DeviceError(`unexpected response id (expected ${expectedId}, got ${r.id})`)
  if (!allowNegativeAck && r.ack < 0) throw new DeviceError(`operation failed (${r.ack})`, r.ack)
  return r.ack
}
