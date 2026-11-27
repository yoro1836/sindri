import './app.css'
import { expandInputs, type FlashItem, type Mapping } from '../core/images'
import type { Log } from '../core/odin'
import type { Pit } from '../core/pit'
import type { TargetInfo } from '../core/protocol'
import { flash, inspect, streamsLz4 } from '../core/session'
import type { Transport } from '../core/transport'
import { findMd5Trailer, md5Of } from '../io/md5'
import { blobSource, type Source } from '../io/source'
import { requestUsbDevice, webUsbSupported, WebUsbTransport } from '../transport/webusb'
import { requestSerialPort, webSerialSupported, WebSerialTransport } from '../transport/webserial'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

const SLOTS = ['BL', 'AP', 'CP', 'CSC', 'USERDATA'] as const
type Slot = (typeof SLOTS)[number]

interface State {
  transport?: Transport
  handshaken: boolean
  busy: boolean
  files: Partial<Record<Slot, File>>
  target?: TargetInfo
  pit?: Pit
  pitBytes?: Uint8Array
  mapping?: Mapping
  /** Inspection passed on this connection with the current file set. */
  checked: boolean
  abort?: AbortController
}

const st: State = { handshaken: false, busy: false, files: {}, checked: false }

// ---------- log ----------
const logEl = $('log')
const log: Log = (level, msg) => {
  if (level === 'debug' && !$<HTMLInputElement>('verbose').checked) return
  const line = document.createElement('div')
  line.className = level[0]!
  line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`
  logEl.append(line)
  logEl.scrollTop = logEl.scrollHeight
  if (level === 'error') console.error(msg)
}

function status(text: string, kind: '' | 'ok' | 'err' = '') {
  const s = $('status')
  s.textContent = text
  s.className = `oui-viewing-subtitle ${kind}`
}

const fmtSize = (n: number) => {
  const u = ['B', 'KiB', 'MiB', 'GiB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

// ---------- slots ----------
function renderSlots() {
  const wrap = $('slots')
  wrap.replaceChildren()
  for (const slot of SLOTS) {
    const row = document.createElement('div')
    row.className = 'oui-bubble-item slot'
    const f = st.files[slot]
    row.innerHTML = `<span class="slot-name">${slot}</span><span class="slot-file ${f ? 'set' : ''}"></span>`
    ;(row.querySelector('.slot-file') as HTMLElement).textContent = f ? `${f.name} · ${fmtSize(f.size)}` : 'No file'
    if (f) {
      const clear = document.createElement('button')
      clear.className = 'icon-clear'
      clear.title = 'Remove'
      clear.textContent = '✕'
      clear.onclick = () => {
        delete st.files[slot]
        filesChanged()
      }
      row.append(clear)
    }
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.tar,.md5,.img,.bin,.lz4,.pit'
    input.onchange = () => {
      const file = input.files?.[0]
      if (file) st.files[slot] = file
      filesChanged()
    }
    const pick = document.createElement('button')
    pick.className = 'oui-button'
    pick.textContent = f ? 'Change' : 'Choose'
    pick.onclick = () => input.click()
    row.append(input, pick)
    wrap.append(row)
  }
}

function filesChanged() {
  st.mapping = undefined
  st.checked = false
  renderSlots()
  renderPlan()
  sync()
}

function sources(): Source[] {
  return SLOTS.flatMap((s) => (st.files[s] ? [blobSource(st.files[s]!)] : []))
}

// ---------- device ----------
async function connect(kind: 'usb' | 'serial') {
  try {
    const t = kind === 'usb' ? new WebUsbTransport(await requestUsbDevice()) : new WebSerialTransport(await requestSerialPort())
    await t.open()
    st.transport = t
    st.handshaken = false
    st.checked = false
    log('info', `Connected: ${t.label}`)
    status('Connected · not checked yet')
    if (kind === 'usb') navigator.usb.addEventListener('disconnect', onUsbDisconnect)
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotFoundError') return // chooser cancelled
    log('error', `Connect failed: ${errText(e)}`)
    status('Could not connect', 'err')
  }
  sync()
}

function onUsbDisconnect(ev: USBConnectionEvent) {
  if (st.transport instanceof WebUsbTransport && ev.device === st.transport.device) dropDevice('Device disconnected')
}

function dropDevice(msg: string) {
  st.transport = undefined
  st.handshaken = false
  st.checked = false
  st.target = undefined
  log('info', msg)
  status(msg)
  sync()
}

async function disconnect() {
  try {
    await st.transport?.close()
  } catch {
    // ignore
  }
  dropDevice('Disconnected')
}

function renderDevice() {
  const dl = $('device-info')
  if (!st.transport || !st.target) {
    dl.hidden = true
    return
  }
  const rows: Array<[string, string]> = [
    ['Connection', st.transport.label],
    ['Protocol', `v${st.target.protocol}`],
    ['Compressed transfer', st.target.lz4 ? 'Supported' : 'Not supported'],
  ]
  if (st.pit) rows.push(['Chip', st.pit.cpuBlId || '?'], ['Partitions', String(st.pit.partitions.length)])
  dl.replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dt = document.createElement('dt')
      dt.textContent = k
      const dd = document.createElement('dd')
      dd.textContent = v
      return [dt, dd]
    }),
  )
  dl.hidden = false
}

// ---------- read-only check ----------
async function runInspect() {
  if (!st.transport) return
  st.busy = true
  sync()
  try {
    status('Reading partition table…')
    const { images, skipped } = await expandInputs(sources())
    for (const s of skipped) log('info', `Skipped ${s}`)
    log('info', st.handshaken ? 'Starting read-only session' : 'Handshake (ODIN → LOKE)')
    const r = await inspect(st.transport, { images, log, handshake: !st.handshaken, onHandshake: () => (st.handshaken = true) })
    st.target = r.target
    st.pit = r.pit
    st.pitBytes = r.pitBytes
    st.mapping = r.mapping
    log('info', `PIT read: ${r.pit.partitions.length} partitions, chip ${r.pit.cpuBlId}, protocol v${r.target.protocol}, LZ4 ${r.target.lz4 ? 'yes' : 'no'}`)
    const m = r.mapping!
    for (const u of m.unmatched) log('warn', `No partition for ${u.sourceName} (${u.origin})`)
    for (const o of m.oversized) log('warn', `${o.spec.sourceName} (${fmtSize(o.spec.size)}) is larger than ${o.part.name} (${fmtSize(o.part.sizeBytes)})`)
    st.checked = m.items.length > 0
    status(m.items.length ? `Check passed · ${m.items.length} images matched` : 'Check passed · no firmware selected', 'ok')
    renderPit()
  } catch (e) {
    log('error', `Read-only check failed: ${errText(e)}`)
    status('Read-only check failed', 'err')
  } finally {
    st.busy = false
    renderPlan()
    sync()
  }
}

function renderPit() {
  const pit = st.pit
  $('pit-wrap').hidden = !pit
  if (!pit) return
  const t = $('pit')
  t.innerHTML = '<tr><th>ID</th><th>Name</th><th>File</th><th>Dev</th><th>Bin</th><th>Size</th></tr>'
  for (const p of pit.partitions) {
    const tr = document.createElement('tr')
    for (const v of [p.id, p.name, p.fileName || '—', p.devType, p.binType, p.sizeBytes ? fmtSize(p.sizeBytes) : '—']) {
      const td = document.createElement('td')
      td.textContent = String(v)
      tr.append(td)
    }
    t.append(tr)
  }
}

function renderPlan() {
  const m = st.mapping
  $('plan-wrap').hidden = !m
  if (!m) return
  const wrap = $('plan')
  wrap.replaceChildren()
  const total = m.items.reduce((a, it) => a + it.spec.size, 0)
  for (const it of m.items) wrap.append(planRow(it))
  for (const u of m.unmatched) {
    const row = document.createElement('div')
    row.className = 'oui-bubble-item plan-item'
    row.innerHTML = '<span class="name warn"></span><span class="meta">skipped</span>'
    ;(row.firstChild as HTMLElement).textContent = `${u.sourceName} · no matching partition`
    wrap.append(row)
  }
  const sum = document.createElement('div')
  sum.className = 'oui-bubble-item plan-item'
  sum.innerHTML = `<span class="name"><b>${m.items.length} images</b></span><span class="meta">${fmtSize(total)}</span>`
  wrap.append(sum)
}

function planRow(it: FlashItem) {
  const row = document.createElement('div')
  row.className = 'oui-bubble-item plan-item'
  const name = document.createElement('span')
  name.className = 'name'
  name.textContent = `${it.spec.sourceName} → ${it.part.name}`
  if (st.target && streamsLz4(it.spec, st.target.lz4)) name.insertAdjacentHTML('beforeend', '<span class="tag lz4">LZ4</span>')
  if (it.part.sizeBytes && it.spec.size > it.part.sizeBytes) name.classList.add('bad')
  const meta = document.createElement('span')
  meta.className = 'meta'
  meta.textContent = fmtSize(it.spec.size)
  row.append(name, meta)
  return row
}

async function runVerify() {
  st.busy = true
  sync()
  let ok = true
  try {
    for (const slot of SLOTS) {
      const f = st.files[slot]
      if (!f) continue
      const src = blobSource(f)
      const t = await findMd5Trailer(src)
      if (!t) {
        log('info', `${f.name}: no MD5 trailer`)
        continue
      }
      const start = performance.now()
      let last = 0
      const got = await md5Of(src, t.hashedBytes, (done) => {
        const now = performance.now()
        if (now - last > 250) {
          last = now
          status(`Verifying ${slot} · ${Math.floor((done / t.hashedBytes) * 100)}%`)
        }
      })
      const secs = (performance.now() - start) / 1000
      if (got === t.expected) log('info', `${f.name}: MD5 OK (${(t.hashedBytes / 1048576 / secs).toFixed(0)} MiB/s)`)
      else {
        ok = false
        log('error', `${f.name}: MD5 mismatch (expected ${t.expected}, got ${got})`)
      }
    }
    status(ok ? 'MD5 verified' : 'MD5 mismatch — do not flash', ok ? 'ok' : 'err')
  } catch (e) {
    log('error', `Verify failed: ${errText(e)}`)
    status('Verify failed', 'err')
  } finally {
    st.busy = false
    sync()
  }
}

function savePit() {
  if (!st.pitBytes) return
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([st.pitBytes as Uint8Array<ArrayBuffer>]))
  a.download = `${st.pit?.cpuBlId || 'device'}.pit`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

// ---------- flash ----------
function confirmFlash(items: FlashItem[]): Promise<boolean> {
  return new Promise((resolve) => {
    $('dialog-title').textContent = `Write ${items.length} images?`
    const body = $('dialog-body')
    body.textContent = 'This writes to the phone. Do not unplug it until Sindri says it is done.'
    const ul = document.createElement('ul')
    for (const it of items) {
      const li = document.createElement('li')
      li.textContent = `${it.part.name} ← ${it.spec.sourceName} (${fmtSize(it.spec.size)})`
      ul.append(li)
    }
    body.append(ul)
    $('dialog').hidden = $('dialog-mask').hidden = false
    const done = (v: boolean) => (e: Event) => {
      e.preventDefault()
      $('dialog').hidden = $('dialog-mask').hidden = true
      resolve(v)
    }
    $('dialog-ok').onclick = done(true)
    $('dialog-cancel').onclick = done(false)
    $('dialog-mask').onclick = done(false)
  })
}

async function runFlash() {
  const m = st.mapping
  if (!st.transport || !st.checked || !m || !$<HTMLInputElement>('arm').checked) return
  if (!(await confirmFlash(m.items))) return
  st.busy = true
  st.abort = new AbortController()
  $('progress-wrap').hidden = false
  sync()
  const started = performance.now()
  try {
    await flash(st.transport, {
      items: m.items,
      reboot: $<HTMLInputElement>('reboot').checked,
      handshake: !st.handshaken,
      log,
      signal: st.abort.signal,
      onStage: (s) => {
        $('progress-stage').textContent = s
        log('info', s)
      },
      onProgress: (p) => {
        const pct = p.total ? (p.done / p.total) * 100 : 100
        $('progress-bar').style.width = `${pct}%`
        const secs = (performance.now() - started) / 1000
        $('progress-pct').textContent = `${pct.toFixed(1)}% · ${(p.done / 1048576 / secs).toFixed(1)} MiB/s`
      },
    })
    log('info', `Done in ${((performance.now() - started) / 1000).toFixed(0)} s`)
    status('Flash complete', 'ok')
  } catch (e) {
    log('error', `Flash failed: ${errText(e)}`)
    status('Flash failed', 'err')
  } finally {
    st.busy = false
    st.checked = false
    st.handshaken = true
    $<HTMLInputElement>('arm').checked = false
    sync()
  }
}

// ---------- wiring ----------
function sync() {
  const connected = !!st.transport
  $<HTMLButtonElement>('connect-usb').hidden = connected || !webUsbSupported()
  $<HTMLButtonElement>('connect-serial').hidden = connected || !webSerialSupported()
  $<HTMLButtonElement>('disconnect').hidden = !connected
  $('connect-hint').hidden = connected
  $<HTMLButtonElement>('disconnect').disabled = st.busy
  $<HTMLButtonElement>('inspect').disabled = !connected || st.busy
  $<HTMLButtonElement>('verify').disabled = st.busy || !Object.keys(st.files).length
  $<HTMLButtonElement>('save-pit').hidden = !st.pitBytes
  const arm = $<HTMLInputElement>('arm')
  arm.disabled = !st.checked || st.busy
  if (arm.disabled && !st.busy) arm.checked = false
  const fb = $<HTMLButtonElement>('flash')
  fb.disabled = !(connected && st.checked && arm.checked && !st.busy)
  fb.classList.toggle('armed', !fb.disabled)
  $<HTMLButtonElement>('cancel').hidden = !st.abort || !st.busy
  renderDevice()
}

$('connect-usb').onclick = () => connect('usb')
$('connect-serial').onclick = () => connect('serial')
$('disconnect').onclick = () => disconnect()
$('inspect').onclick = () => runInspect()
$('verify').onclick = () => runVerify()
$('save-pit').onclick = () => savePit()
$('flash').onclick = () => runFlash()
$('cancel').onclick = () => st.abort?.abort()
$('arm').onchange = () => sync()

if (!webUsbSupported() && !webSerialSupported()) $('unsupported').hidden = false
window.addEventListener('beforeunload', (e) => {
  if (st.busy) e.preventDefault()
})
renderSlots()
sync()
