# Sindri

Flash Samsung phones in Download mode from the browser, over WebUSB or Web Serial.
No install, no drivers to swap on Windows (use the serial connection), works on desktop and Android Chrome.

**Status:** early. The read-only check (handshake, PIT download, file mapping) is the thing to try first.
Flashing works against the simulated device in `tests/` but has not been verified on real hardware yet.

## Use

Open the hosted page (GitHub Pages) in Chrome or Edge, then:

1. Put the phone in Download mode and plug it in.
2. Tap **Connect**. Sindri picks the connection for you: serial first on Windows (the Samsung driver or the built-in
   Windows 10/11 USB serial driver owns the port), WebUSB elsewhere. If one is busy, the button switches to the other.
   Once allowed, the phone reconnects by itself when plugged in again.
3. Pick BL / AP / CP / CSC (`.tar` or `.tar.md5`, `.lz4` entries are sent compressed when the phone supports it).
4. **Read PIT** — read-only. Shows the device's partitions and what each file would be written to.
5. Only after that passes, **Enable writing** unlocks **Flash**.

Linux: the USB node must be writable (udev rule for `04e8`), and `cdc_acm` may hold the interface; then serial is used (`uucp`/`dialout` group).

## Safety

- The read-only check uses a client that refuses every write command before it reaches the wire (`OdinClient` with `readOnly: true`; covered by tests).
- Writing needs a passing read-only check on the same connection, a toggle, and a confirmation listing every partition.
- Flashing can brick a device. You use this at your own risk.

## Develop

```sh
npm ci
npm test         # protocol, tar/lz4/md5, full flash against a simulated device, WebUSB transport
npm run dev
```

## License

GPL-3.0-or-later. See [NOTICE.md](NOTICE.md) for the projects this builds on. Not affiliated with Samsung.
