// Download-mode command layer.
// Ported from brokkr-flash (GPL-3.0-or-later, Gabriel2392): src/protocol/odin/cmd.cpp.

import {
  checkResponse,
  CloseParam,
  Cmd,
  decodeResponse,
  encodeRequest,
  InitParam,
  parseTargetAck,
  PitParam,
  PROTOCOL_VERSION_REQUESTED,
  RESPONSE_SIZE,
  splitTotalSize,
  SuperParam,
  type TargetInfo,
  XmitParam,
} from './protocol'
import type { Transport } from './transport'

export type Log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void
export const silentLog: Log = () => {}

export class ReadOnlyViolation extends Error {
  constructor(what: string) {
    super(`read-only mode: refused to send ${what}`)
    this.name = 'ReadOnlyViolation'
  }
}

export interface OdinOptions {
  /** When true, every command that could change the device is refused before it reaches the wire. */
  readOnly: boolean
  commandTimeoutMs: number
  flashTimeoutMs: number
  log: Log
}

const PIT_CHUNK = 500

export class OdinClient {
  readonly opts: OdinOptions
  private pitReading = false

  constructor(
    readonly transport: Transport,
    opts: Partial<OdinOptions> = {},
  ) {
    const given = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined))
    this.opts = { readOnly: true, commandTimeoutMs: 5000, flashTimeoutMs: 45000, log: silentLog, ...given }
  }

  private allowed(id: number, param: number): boolean {
    if (!this.opts.readOnly) return true
    switch (id) {
      case Cmd.INIT:
        return param === InitParam.TARGET
      case Cmd.PIT:
        return param === PitParam.GET || param === PitParam.COMPLETE || (param === PitParam.START && this.pitReading)
      case Cmd.CLOSE:
        return param === CloseParam.END || param === CloseParam.REBOOT
      default:
        return false
    }
  }

  private async sendRequest(id: number, param: number, ints: readonly number[] = [], timeoutMs?: number) {
    if (!this.allowed(id, param)) throw new ReadOnlyViolation(`command ${id}/${param}`)
    this.opts.log('debug', `>> ${id}/${param} [${ints.join(', ')}]`)
    await this.transport.write(encodeRequest(id, param, ints), timeoutMs ?? this.opts.commandTimeoutMs)
  }

  private async recvResponse(expectedId: number, allowNegativeAck = false, timeoutMs?: number): Promise<number> {
    const r = decodeResponse(await this.transport.read(RESPONSE_SIZE, timeoutMs ?? this.opts.commandTimeoutMs))
    this.opts.log('debug', `<< ${r.id} ack=${r.ack}`)
    return checkResponse(expectedId, r, allowNegativeAck)
  }

  private async rpc(id: number, param: number, ints: readonly number[] = [], opts: { allowNegativeAck?: boolean; timeoutMs?: number } = {}) {
    await this.sendRequest(id, param, ints, opts.timeoutMs)
    return this.recvResponse(id, opts.allowNegativeAck, opts.timeoutMs)
  }

  async handshake(): Promise<void> {
    // brokkr sends a trailing NUL over USB and plain "ODIN" over stream transports.
    const ping = this.transport.kind === 'serial' ? 'ODIN' : 'ODIN\0'
    await this.transport.write(new TextEncoder().encode(ping), this.opts.commandTimeoutMs)
    const resp = await this.transport.read(4, this.opts.commandTimeoutMs)
    const text = new TextDecoder().decode(resp)
    if (text !== 'LOKE') throw new Error(`handshake failed: expected LOKE, got ${JSON.stringify(text)}`)
  }

  async getTargetInfo(): Promise<TargetInfo> {
    const ack = await this.rpc(Cmd.INIT, InitParam.TARGET, [PROTOCOL_VERSION_REQUESTED], { allowNegativeAck: true })
    return parseTargetAck(ack)
  }

  async setPacketSize(bytes: number): Promise<void> {
    await this.rpc(Cmd.INIT, InitParam.PACKETSIZE, [bytes])
  }

  async sendTotalSize(total: number): Promise<void> {
    await this.rpc(Cmd.INIT, InitParam.TOTALSIZE, splitTotalSize(total))
  }

  async readPit(): Promise<Uint8Array> {
    const size = await this.rpc(Cmd.PIT, PitParam.GET, [], { allowNegativeAck: true })
    if (size <= 0 || size > 16 * 1024 * 1024) throw new Error(`device returned invalid PIT size ${size}`)
    const out = new Uint8Array(size)
    this.pitReading = true
    try {
      const parts = Math.ceil(size / PIT_CHUNK)
      for (let i = 0; i < parts; i++) {
        await this.sendRequest(Cmd.PIT, PitParam.START, [i])
        const n = Math.min(PIT_CHUNK, size - i * PIT_CHUNK)
        out.set(await this.transport.read(n, this.opts.commandTimeoutMs), i * PIT_CHUNK)
      }
    } finally {
      this.pitReading = false
    }
    await this.transport.drain(50)
    await this.rpc(Cmd.PIT, PitParam.COMPLETE)
    return out
  }

  async writePit(pit: Uint8Array): Promise<void> {
    await this.rpc(Cmd.PIT, PitParam.SET)
    await this.rpc(Cmd.PIT, PitParam.START, [pit.byteLength])
    if (this.opts.readOnly) throw new ReadOnlyViolation('PIT data')
    await this.transport.write(pit, this.opts.flashTimeoutMs)
    await this.recvDataAck()
    await this.rpc(Cmd.PIT, PitParam.COMPLETE, [pit.byteLength])
  }

  async declareSuperUsedBlocks(blocks: number): Promise<void> {
    await this.rpc(Cmd.SUPER, SuperParam.USED_BLOCKS, [blocks])
  }

  async beginDownload(roundedSize: number): Promise<void> {
    const t = { timeoutMs: this.opts.flashTimeoutMs }
    await this.rpc(Cmd.XMIT, XmitParam.DOWNLOAD, [], t)
    await this.rpc(Cmd.XMIT, XmitParam.START, [roundedSize], t)
  }

  async beginDownloadCompressed(compSize: number, decompSize: number): Promise<void> {
    const t = { timeoutMs: this.opts.flashTimeoutMs }
    await this.rpc(Cmd.XMIT, XmitParam.COMPRESSED_DOWNLOAD, [], t)
    await this.rpc(Cmd.XMIT, XmitParam.COMPRESSED_START, [compSize, decompSize], t)
  }

  /** Send one data packet and wait for its 8-byte ack. */
  async sendDataPacket(data: Uint8Array): Promise<void> {
    if (this.opts.readOnly) throw new ReadOnlyViolation('image data')
    await this.transport.write(data, this.opts.flashTimeoutMs)
    await this.recvDataAck()
  }

  private async recvDataAck(): Promise<void> {
    const r = decodeResponse(await this.transport.read(RESPONSE_SIZE, this.opts.flashTimeoutMs))
    if (r.id !== Cmd.EMPTY || r.ack < 0) this.opts.log('debug', `data ack id=${r.id} ack=${r.ack}`)
    if (r.id === -1) checkResponse(Cmd.EMPTY, r)
  }

  async endDownload(p: EndParams): Promise<void> {
    const ints = [0, p.size, p.binType, p.devType, p.partId, p.last ? 1 : 0, 0, 0]
    await this.rpc(Cmd.XMIT, p.compressed ? XmitParam.COMPRESSED_COMPLETE : XmitParam.COMPLETE, ints, {
      timeoutMs: this.opts.flashTimeoutMs,
    })
  }

  /** End the session. With reboot, the reboot ack is often lost because the device resets. */
  async close(reboot: boolean): Promise<void> {
    await this.rpc(Cmd.CLOSE, CloseParam.END)
    if (!reboot) return
    try {
      await this.rpc(Cmd.CLOSE, CloseParam.REBOOT, [], { timeoutMs: 500 })
    } catch (e) {
      this.opts.log('debug', `reboot ack missing (device likely rebooting): ${String(e)}`)
    }
  }
}

export interface EndParams {
  compressed: boolean
  size: number
  partId: number
  devType: number
  binType: number
  last: boolean
}
