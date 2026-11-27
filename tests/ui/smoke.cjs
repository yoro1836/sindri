// UI smoke test: runs the page against the fake USB device and saves screenshots. Usage: SCHEME=dark node tests/ui/smoke.cjs
const { chromium } = require('playwright')
const { spawn } = require('child_process')
;(async () => {
  const srv = spawn('npx', ['vite', '--port', '5174', '--strictPort'], { cwd: process.cwd(), stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 2500))
  const b = await chromium.launch()
  const p = await b.newPage({ viewport: { width: 412, height: 900 }, colorScheme: process.env.SCHEME || 'light' })
  p.on('pageerror', (e) => console.log('pageerror', e.message))
  await p.route(/localhost:5174\/(\?busy)?$/, async (route) => {
    const res = await route.fetch()
    let html = await res.text()
    html = html.replace(
      '<script type="module" src="/src/ui/main.ts"></script>',
      '<script type="module">await import("/tests/ui/fake-env.ts"); await import("/src/ui/main.ts")</script>',
    )
    route.fulfill({ response: res, body: html })
  })
  await p.goto('http://localhost:5174/' + (process.env.BUSY ? '?busy' : ''))
  const ap = await p.evaluate(async () => {
    const { buildTar } = await import('/src/io/tar.ts')
    const { lz4Frame } = await import('/tests/lz4-encode.ts')
    const boot = new Uint8Array(3 << 20).map((_, i) => (i * 7) & 255)
    const sup = new Uint8Array(40 << 20).map((_, i) => (i >> 10) & 15)
    const tar = buildTar([
      { name: 'boot.img', data: boot },
      { name: 'super.img.lz4', data: lz4Frame(sup) },
      { name: 'vbmeta.img', data: new Uint8Array(4096) },
      { name: 'extra.img', data: new Uint8Array(10) },
    ])
    let s = ''
    for (let i = 0; i < tar.length; i += 0x8000) s += String.fromCharCode(...tar.subarray(i, i + 0x8000))
    return btoa(s)
  })
  const buf = Buffer.from(ap, 'base64')
  await p.screenshot({ path: (process.env.OUT || '/tmp') + '/sindri-' + (process.env.SCHEME || 'light') + '-0-initial.png' })
  await p.click('#connect')
  if (process.env.BUSY) {
    console.log('after first click:', await p.textContent('#status'), '| button:', await p.textContent('#connect'))
    await p.click('#connect')
  }
  console.log('after connect:', await p.textContent('#log'), await p.textContent('#status'))
  const inputs = await p.$$('#slots input[type=file]')
  await inputs[1].setInputFiles({ name: 'AP_TEST.tar', mimeType: 'application/x-tar', buffer: buf })
  await p.click('#inspect')
  await p.waitForSelector('#plan-wrap:not([hidden])')
  await p.screenshot({ path: (process.env.OUT || '/tmp') + '/sindri-' + (process.env.SCHEME||'light') + '-1-checked.png', fullPage: true })
  console.log('status:', await p.textContent('#status'))
  console.log('arm disabled:', await p.$eval('#arm', (e) => e.disabled))
  await p.click('label:has(#arm)')
  await p.click('#flash')
  await p.waitForTimeout(500)
  await p.screenshot({ path: (process.env.OUT || '/tmp') + '/sindri-' + (process.env.SCHEME||'light') + '-2-confirm.png' })
  await p.click('#dialog-ok')
  await p.waitForFunction(() => /complete|failed/i.test(document.getElementById('status').textContent), null, { timeout: 60000 })
  console.log('status:', await p.textContent('#status'))
  console.log('mock:', JSON.stringify(await p.evaluate(() => ({ fin: [...window.__mock.finished], reboot: window.__mock.rebooted, total: window.__mock.totalSize }))))
  await p.evaluate(() => window.scrollTo(0, 700))
  await p.waitForTimeout(400)
  await p.screenshot({ path: (process.env.OUT || '/tmp') + '/sindri-' + (process.env.SCHEME || 'light') + '-3-done.png' })
  console.log(await p.$$eval('#log div', (ds) => ds.map((d) => d.textContent).join('\n')))
  await b.close()
  srv.kill()
})()
