/** A byte pipe to a device in download mode (WebUSB bulk endpoints or a CDC serial port). */
export interface Transport {
  readonly kind: 'usb' | 'serial' | 'mock'
  /** Human-readable label for logs. */
  readonly label: string
  open(): Promise<void>
  close(): Promise<void>
  /** Write all bytes. USB transports follow every write with a zero-length packet. */
  write(data: Uint8Array, timeoutMs: number): Promise<void>
  /** Read exactly `length` bytes. */
  read(length: number, timeoutMs: number): Promise<Uint8Array>
  /** Best-effort read of a pending zero-length packet; never throws. */
  drain(timeoutMs: number): Promise<void>
}

export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${ms} ms`)
    this.name = 'TimeoutError'
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new TimeoutError(what, ms)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}
