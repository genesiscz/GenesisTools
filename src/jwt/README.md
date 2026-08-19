# tools jwt

> **Decode and inspect a JWT offline.**

Base64url-decodes the header and payload, then humanizes `exp`, `iat` and `nbf` into local time plus a relative offset, so "is this token expired?" takes one command instead of a mental epoch conversion.

---

## Quick start

```bash
tools jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9....
pbpaste | tools jwt                     # read the token from stdin
tools jwt --json <token>                # raw decoded { header, payload }
tools jwt <token> | tools json          # pipe onward
```

## Arguments and options

| Item | Description |
|------|-------------|
| `[token]` | The JWT to decode. Omit it to read from stdin. |
| `--json` | Print the raw decoded `{ header, payload }` as pretty JSON |
| `-v, --verbose` | Verbose diagnostics on stderr. It never includes the token. |
| `--readme` | Print this file and exit |

---

## 🛑 What this does not do

**It does not verify signatures.** There is no key input and no network call. The tool decodes what the token claims about itself, which is exactly what you want when debugging, and exactly what you must not trust for an authorization decision.

Treat the output as untrusted input. A token can claim any `iss`, `sub` or `exp` it likes until a verifier with the signing key says otherwise.

## Privacy

The token itself is never written to the log file, including under `-v`. Verbose output describes what the decoder did, not what it decoded. Reading from stdin keeps the token out of your shell history too, which is the recommended path for anything live.
