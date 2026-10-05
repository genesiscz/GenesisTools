# tools jwt

> **Decode and inspect a JWT offline.**

Base64url-decodes the header and payload, then humanizes `exp`, `iat` and `nbf` into local time plus a relative offset, so "is this token expired?" takes one command instead of a mental epoch conversion.

---

## Quick start

```bash
tools jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9....
tools jwt --clipboard                   # read the token from the system clipboard
pbpaste | tools jwt                     # read the token from stdin
tools jwt --json <token>                # raw decoded { header, payload }
tools jwt <token> | tools json          # pipe onward
```

## Arguments and options

| Item | Description |
|------|-------------|
| `[token]` | The JWT to decode. Omit it to read from stdin or, with `--clipboard`, from the clipboard. |
| `-c, --clipboard` | Read the token from the system clipboard. Do not combine it with a `[token]` argument. |
| `--json` | Print the raw decoded `{ header, payload }` as pretty JSON |
| `-v, --verbose` | Verbose diagnostics on stderr. It never includes the token. |
| `--readme` | Print this file and exit |

---

## Clipboard input

`--clipboard` (`-c`) reads the system clipboard and takes the token out of whatever you copied. It strips surrounding whitespace, a leading `Bearer `, and wrapping quotes (`"`, `'` or a backtick). It joins a token that a chat or an email wrapped over several lines. When the clipboard holds a larger text, such as a JSON response or a `curl` command, it takes the first three-part token inside it. The same cleanup applies to a `[token]` argument and to piped stdin.

When you run `tools jwt` on a terminal with no token, the tool does not read the clipboard for you. It does look at it, and when the clipboard holds something shaped like a JWT, the usage hint says so and shows `tools jwt --clipboard`. A clipboard that holds no JWT adds no hint, and the tool prints no part of what the clipboard holds in either case.

## 🛑 What this does not do

**It does not verify signatures.** There is no key input and no network call. The tool decodes what the token claims about itself, which is exactly what you want when debugging, and exactly what you must not trust for an authorization decision.

Treat the output as untrusted input. A token can claim any `iss`, `sub` or `exp` it likes until a verifier with the signing key says otherwise.

## Privacy

The token itself is never written to the log file, including under `-v`. Verbose output describes what the decoder did, not what it decoded. Error and hint text never quotes the token, so the signature part stays out of a terminal recording as well. Reading from stdin or the clipboard keeps the token out of your shell history too, which is the recommended path for anything live.
