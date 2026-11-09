# tools jwt

Decode and inspect a JWT offline. The tool base64url-decodes the header and the payload, then turns `exp`, `iat`
and `nbf` into local time plus a relative offset, so "is this token expired?" takes one command instead of a
mental epoch conversion. It does not verify the signature.

`tools jwt` comes with GenesisTools (`bun install && ./install.sh` puts `tools` on your PATH) and needs only Bun.

## Quick start

```bash
tools jwt --clipboard                   # decode the token you just copied (safest for a live token)
pbpaste | tools jwt                     # the same, through stdin
tools jwt <token>                      # pass the token as an argument
tools jwt --json <token>                # the raw decoded { header, payload } as JSON
tools jwt --json <token> | tools json   # shrink the decoded token for an agent (TOON or compact JSON)
```

## Usage

`tools jwt` is one command with no subcommands.

```text
tools jwt [options] [token]
```

| Item | What it does |
|------|--------------|
| `[token]` | The JWT to decode. Omit it to read stdin, or use `--clipboard`. |
| `-c, --clipboard` | Read the token from the system clipboard. Refused together with `[token]`. |
| `--json` | Print the raw decoded `{ header, payload }` as indented JSON. |
| `-v, --verbose` | Print diagnostics on stderr. They never include the token. |
| `--readme` | Print this page and exit. |
| `-h, --help` | Print the usage and exit. |

## Output

The default output shows the header's `alg` and `typ`, then every payload claim in token order, then a reminder
that the signature was not checked. This is a token with invented claims, decoded at 10:00 on a Mac set to UTC:

```text
Header
  alg  HS256
  typ  JWT

Claims
  iss  https://auth.example.com
  sub  user-42
  email  alice@example.com
  roles  ["admin","billing"]
  iat  1794211200   (issued 2026-11-09 08:00:00 — 2h ago)
  exp  1794214800   (expires 2026-11-09 09:00:00 — EXPIRED 1h ago)

Signature  not verified (offline decode only)
```

- `exp` reads `expires <time>` followed by `expires in <offset>` while the token is valid, or `EXPIRED <offset> ago`
  after that.
- `iat` reads `issued <time>`, and `nbf` reads `valid from <time>`, each followed by `<offset> ago` or
  `in <offset>`.
- The time is the machine's local time as `YYYY-MM-DD HH:MM:SS`. The offset is the largest whole unit, rounded down:
  `45s`, `23m`, `2h`, `3d`. So 90 seconds shows as `1m`, and 47 hours shows as `1d`.
- Only a numeric time claim gets the annotation. An `exp` stored as a string prints as it is.
- An object or an array claim prints as one line of compact JSON.
- A missing `alg` or `typ` prints as `(none)`. Other header fields, such as `kid`, show only in `--json`.

`--json` prints `{ "header": …, "payload": … }` with two-space indentation. It holds the raw values: no time
annotations, and no signature.

## It does not verify signatures

There is no key input and no network call. The tool decodes what the token claims about itself. That is what you
want when you debug, and it is what you must not trust for an authorization decision. Treat the output as untrusted
input: a token can claim any `iss`, `sub` or `exp` it likes until a verifier with the signing key says otherwise.

## Where the token comes from

The tool picks one source, in this order:

1. `--clipboard` reads the clipboard only. It never reads stdin, even when you pipe something in. It refuses a
   `[token]` argument next to it.
2. A `[token]` argument.
3. With no argument on a terminal, the tool reads nothing. It prints a usage hint and exits 1.
4. With no argument and stdin that is not a terminal (a pipe or a file), it reads stdin until it closes.

The same cleanup applies to all three sources:

- It strips surrounding whitespace, a leading `Bearer ` in any letter case, and wrapping quotes (`"`, `'` or a
  backtick), also when they are nested.
- It joins a token that a chat or an email wrapped over several lines. This works when the copied text is the token
  alone. When a chat wrapped it inside other text, copy only the token.
- In a larger text, such as a JSON response or a `curl` command, it takes the first three-part token inside it. A
  candidate counts only when its first part decodes to a JSON object, so `www.example.com` and `version 1.2.3` are
  never mistaken for a token. A token never starts in the middle of a word, and trailing punctuation such as a
  closing `.` or `)` is left out.
- A header that is pretty-printed JSON (its encoding does not start with `ey`) is accepted.

When the clipboard holds no token, `--clipboard` fails with `the clipboard does not hold a JWT.` An argument or stdin
that holds no token is passed on after the cleanup, so the decode error can say what is wrong with it.

On a terminal with no token, the tool does not read the clipboard for you, but it does look at it. When the
clipboard holds something shaped like a JWT, the usage hint says so and shows `tools jwt --clipboard`. A clipboard
that holds no JWT, or one that cannot be read, adds no hint. The tool prints no part of the clipboard in either case.

## How it works

- Everything runs locally. The tool makes no network call and has no config. It stores nothing except log lines
  (described below).
- `--clipboard` and the terminal hint read the clipboard through the `clipboardy` package. On macOS it calls
  `pbpaste`.
- The decoded output goes to stdout. Errors and hints go to stderr.

### Privacy

- The token is never written to the log, including under `-v`. The day log (`~/.genesis-tools/logs/<date>.log`)
  gets debug lines such as the source of the token with its length, and the header's `alg`. `-v` prints the same
  lines on stderr. They describe what the decoder did, not what it decoded.
- Error and hint text never quotes the token, so the signature stays out of a terminal recording as well.
- A failed run (exit 1) is recorded in `~/.genesis-tools/logs/<date>-failures.jsonl` (read it with
  `tools genesis-tools logs failures`). That record masks the token argument as `[redacted]` and holds only the error
  text, which never quotes the token.
- A token passed as an argument lands in your shell history. Reading from the clipboard or from stdin keeps it out,
  which is the recommended path for anything live.

## For agents

- Use `--json` for a parseable result. Pipe it to `tools json` (TOON or compact JSON, whichever is smaller) or to
  `jq`.
- The exit code is 0 when the token decodes, also when it has expired, and 1 on every error. To check expiry, compare
  `exp` with the current time yourself:

  ```bash
  printf '%s' "$TOKEN" | tools jwt --json | jq '.payload.exp != null and .payload.exp < now'
  ```

  It prints `true` when the token has expired, and `false` when it is still valid or has no `exp`. Empty output
  means the decode failed (stdout stays empty and the exit code is 1; add `set -o pipefail` to see it). The `printf`
  pipe also keeps the token out of the process list.

- With no argument and no `--clipboard`, the tool reads stdin until it closes. A caller that leaves stdin open
  waits until it does. Pass the token, pipe it, or add `</dev/null`.

## Troubleshooting

Each error below prints as `Error: <text>` on stderr, and the tool exits 1.

- **`no token provided.`** There was no argument, and stdin was a terminal or empty. Pass a token, pipe one, or use
  `--clipboard`.
- **`pass either a token or --clipboard, not both.`** Drop one of the two.
- **`could not read the clipboard.`** No clipboard is available in this session. Pipe the token instead.
- **`the clipboard does not hold a JWT.`** The clipboard needs a whole three-part token whose first part decodes to
  a JSON object. Copy the token again. An unsigned `alg: none` token also gives this error (see below), and so can an
  encrypted JWE with an empty second part.
- **`expected 3 dot-separated segments, got 1`** or **`got 2`.** An opaque token with no dots is not a JWT, and
  only its issuer can read it. Two parts mean the copy was cut short.
- **`expected 3 dot-separated segments, got 3`.** One part is empty. An unsigned `alg: none` token ends in `.`, so
  the tool refuses it.
- **`got 5`.** The text is an encrypted JWE. It has five parts and cannot be decoded without its key.
- **`the payload segment is not valid JSON.`** The payload is not JSON. Causes: an encrypted JWE whose second part is
  not empty (the tool reads its first three parts as a token), or a payload that the copy damaged.
- **`the header segment is not valid JSON.`**, **`the header segment is not a JSON object.`** or **`the payload
  segment is not a JSON object.`** The text has three dotted parts, but a part does not decode to a JSON object. It
  is not a JWT, or the copy damaged it. `tools jwt www.example.com` gives the first of these.
- **The wrong token is decoded.** When a JSON response holds both an `access_token` and an `id_token`, the tool
  decodes the one that comes first. Copy or pipe only the token you mean.

## Related

- [`tools json`](../json/README.md): turn the `--json` output into TOON, or infer its schema.
- [`tools har-analyzer`](../har-analyzer/README.md): its `security` command reports JWTs in `Authorization: Bearer`
  headers of a HAR file and marks the expired ones.
- [`tools chrome-devtools`](../chrome-devtools/README.md): read the cookies and the requests that carry a token in
  your real browser.
