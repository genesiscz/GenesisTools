# tools qr

> **Render QR codes in the terminal for a URL, arbitrary text, or a WiFi network.**

Handing a phone a URL from a terminal, or getting a guest onto your WiFi, without typing anything on the phone.

---

## Quick start

```bash
tools qr https://example.com
tools qr "any text you like"
tools qr https://example.com --small          # half-height blocks, fits a small window

# WiFi: the phone scans and joins
tools qr wifi --ssid HomeNet --pass "s3cret"
tools qr wifi --ssid Guest --security nopass
tools qr wifi --ssid Hidden --pass "s3cret" --hidden
```

## Commands and options

| Item | Description |
|------|-------------|
| `[text]` | URL or text to encode |
| `--small` | Compact rendering using half-height blocks |
| `wifi` | Render a QR for a WiFi network that phones can scan to join |

### `wifi` options

| Flag | Description |
|------|-------------|
| `--ssid <ssid>` | Network name |
| `--pass <password>` | Network password. Required unless `--security nopass`. |
| `--security <type>` | `WPA`, `WEP` or `nopass` (default: `WPA`) |
| `--hidden` | Mark the network as hidden (`H:true` in the payload) |
| `--small` | Compact rendering |

---

## Notes

- `--small` matters more than it sounds. A full-size QR for a long URL can exceed a normal terminal height, and a QR that scrolls cannot be scanned.
- The WiFi payload follows the standard `WIFI:` URI scheme that iOS and Android camera apps understand natively. No app is needed on the phone.
- ⚠️ The password appears in your shell history when you pass `--pass`. On a shared machine, prefix the command with a space if your shell is configured to skip those, or clear the history entry afterward.
