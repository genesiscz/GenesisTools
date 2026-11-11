# tools qr

Prints a QR code in the terminal for a URL, any text, or a WiFi network. Use it to hand a phone a link from the
terminal, or to get a guest onto your WiFi, without typing anything on the phone. It runs offline and needs no
account.

## Quick start

```bash
tools qr https://example.com                          # a link: the phone camera opens it
tools qr "any text you like"                          # any text, encoded as typed
tools qr https://example.com --small                  # half the width and height, fits a small window

# WiFi: the phone scans and joins
tools qr wifi --ssid HomeNet --pass "s3cret"          # a WPA network (the default)
tools qr wifi --ssid Guest --security nopass          # an open network
tools qr wifi --ssid Hidden --pass "s3cret" --hidden  # a network that does not broadcast its name
```

## Commands

### `tools qr [text]`

Encodes `text` exactly as given. The tool adds no scheme: `example.com` stays plain text, so pass
`https://example.com` when the phone should open a link.

| Flag | What it does |
|------|--------------|
| `--small` | Half-block rendering: half the width and half the lines |
| `-v, --verbose` | Debug logging on stderr |
| `--readme` | Print this README and exit |
| `-h, --help` | Show the help |

### `tools qr wifi`

Encodes a network in the `WIFI:` scheme that the iOS and Android camera apps read natively. No app is needed on the
phone.

| Flag | What it does |
|------|--------------|
| `--ssid <ssid>` | Network name. Required. |
| `--pass <password>` | Password. Required unless `--security nopass`, ignored with it. |
| `--security <type>` | `WPA` (default), `WEP` or `nopass`. Any letter case. |
| `--hidden` | Mark the network as hidden (`H:true`; the default is `H:false`) |
| `--small` | Half-block rendering |

The payload has this shape:

```text
WIFI:T:<security>;S:<ssid>;P:<password>;H:<true|false>;;
```

In the SSID and the password, each of `\ ; , : "` gets a backslash before it, so an SSID `Cafe;Guest` goes in as
`S:Cafe\;Guest`. The tool accepts only the three `--security` values above, so it cannot encode an enterprise
(EAP) network.

## Size and rendering

`--small` matters more than it sounds. A full-size QR for a long URL can be taller than a normal terminal, and a QR
that scrolls cannot be scanned. Measured 2026-11-09 01:16 with qrcode-terminal 0.12.0 (columns x lines, the code only):

| Input | Full size | `--small` |
|-------|-----------|-----------|
| 25-character URL | 54 x 27 | 27 x 15 |
| 60-character URL (or a WiFi payload of 54 to 78 characters) | 70 x 35 | 35 x 19 |
| WiFi payload `WIFI:T:WPA;S:HomeNet;P:s3cret;H:false;;` (39 characters) | 62 x 31 | 31 x 17 |
| 150-character URL | 94 x 47 | 47 x 25 |
| 500-character URL | 158 x 79 | 79 x 41 |

An 80 x 24 terminal holds the `--small` code of a 60-character URL, but not the full-size one.

- **The tool picks `--small` by itself** when stdout is not a terminal (a pipe, a file, an agent) or when `NO_COLOR`
  is set. The full-size code is drawn with ANSI background colours, so without a colour terminal it comes out as
  escape codes or as blank lines. The half-block form is plain Unicode and reads anywhere. An explicit `--small`
  always wins. No flag forces the full-size form into a pipe.
- **Full size does not depend on the theme's text colour**: it paints ANSI black and white backgrounds.
- **`--small` follows your theme**: the light squares take the terminal's text colour and the dark squares its
  background colour. That is right on a dark theme and inverted on a light theme, and not every scanner reads an
  inverted code.

## How it works

- Everything runs locally: no network call, no account, no macOS permission, no cost. The tool calls `renderQr`
  from `@genesiscz/utils/qr` (`src/utils/qr.ts`), which wraps the `qrcode-terminal` package.
- The error correction level is always L (about 7% of the code can be damaged), which gives the smallest code.
  `renderQr` has a `level` option, but qrcode-terminal 0.12.0 ignores it.
- A code holds at most 2953 bytes (QR version 40 at level L). Longer input fails with
  `ERROR: code length overflow. (…)`.
- Each character goes in as one byte, not as UTF-8. ASCII text is safe. A character above U+00FF is corrupted: `č`
  (U+010D) goes in as the byte 0x0D. Accented Latin-1 letters such as `é` go in as Latin-1 bytes, which a scanner can
  show wrong.
- The code goes to stdout and nothing else does. The `QR for: <text>` line (for WiFi, `QR for WiFi network: <ssid>`)
  goes to stderr. So `tools qr https://example.com > code.txt` saves only the code, in the `--small` form.

### Where data lives

The tool has no config file and no storage of its own. Two shared GenesisTools logs see it:

- `~/.genesis-tools/logs/<date>.log`: every run that prints a code writes a debug record. For `tools qr <text>`
  it holds the text. For `wifi` it holds only the SSID, the security type and the hidden flag, never the password.
- `~/.genesis-tools/logs/<date>-failures.jsonl`: a failed run keeps its command line. The failure log masks
  flags with names such as `--password` or `--token`, but not `--pass`. So a failed `wifi` run (a wrong `--security`
  value, a missing `--ssid`) keeps the password there in plain text. Checked 2026-11-09 01:16 against `redactArgv`.

### WiFi passwords

- ⚠️ The password appears in your shell history when you pass `--pass`. On a shared machine, start the command with
  a space if your shell skips those (zsh `setopt HIST_IGNORE_SPACE`, bash `HISTCONTROL=ignorespace`), or clear the
  history entry afterward.
- The code itself carries the password in plain text. Anyone who scans it, or reads a saved copy, has the password.
- The tool never prints the password on screen and never writes it to the day log.

## Configuration

There is no config file and no account. One environment variable changes the output:

| Variable | Effect |
|----------|--------|
| `NO_COLOR` | Any value makes `--small` the default (in a terminal, not when `FORCE_COLOR` is also set) |

## For agents

- In an agent shell stdout is not a terminal, so the code is the plain Unicode `--small` form. Stdout holds the
  code only; the label line is on stderr. There is no `--json` output.
- Exit code 0 means the code was printed. Exit code 1 means no text, a wrong `--security` value, a missing
  `--pass`, a missing or empty `--ssid`, or input over 2953 bytes.
- There is no MCP tool and no plugin skill for this tool.

## Troubleshooting

**The phone does not scan the code.** The code scrolled or wrapped. Use `--small`, a larger window or a
smaller font.

**A `--small` code does not scan on a light theme.** The code is inverted there. Drop `--small` in a colour
terminal, or switch to a dark theme.

**The phone shows text instead of opening a link.** The input has no scheme. Pass `https://example.com`, not
`example.com`.

**`ERROR: code length overflow. (…)`** The input is over 2953 bytes. Shorten it, or encode a link to the content.

**Accented letters or emoji scan wrong.** Only ASCII is safe. See How it works.

**`error: required option '--ssid <ssid>' not specified`.** `wifi` always needs `--ssid`.

**`--pass is required for WPA networks (or use --security nopass).`** Add `--pass`, or pass `--security nopass`
for an open network. `WEP` needs a password too.

**`Invalid --security "…". Must be one of: WPA, WEP, nopass.`** Use one of those three values.

**`tools qr help wifi` fails with `too many arguments`.** The root command takes text, so it has no `help`
command: `tools qr help` encodes the word "help". Run `tools qr wifi --help`.

**The word `wifi` cannot be encoded.** `wifi` on its own always runs the subcommand, even after `--`. The match is
case-sensitive, so `WIFI` encodes as text.

**Text that starts with `-` is read as a flag.** Put `--` before it. Bun drops a `--` that comes straight after the script, so double it:
`tools qr -- -- "-hello"`, or put an option first: `tools qr --small -- "-hello"`. A plain `tools qr -- "-hello"` fails with
`unknown option '-hello'`.

## Related

- [dev-dashboard](../dev-dashboard/README.md): `tools dev-dashboard tunnel setup` prints a pairing QR for the
  DevDashboard mobile app with the same renderer.
- [debugging-master](../debugging-master/README.md): `tools debugging-master start` prints its dashboard address as a
  QR to scan from a phone.
