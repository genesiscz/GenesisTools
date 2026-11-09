# tools har-analyzer

Read a HAR (HTTP Archive) file from the browser's Network tab without dumping it: a dashboard, filtered entry
tables, one entry at a time, error and security scans, and a redactor that removes passwords, tokens, cookies and
emails before the file leaves your machine. It is built for people and agents who debug API calls, auth flows and
slow pages. A reference system prints a large body once and only a short preview after that, so a long session does
not pay for the same payload twice.

## Quick start

```bash
tools har-analyzer load ~/Downloads/capture.har   # index the file, print the dashboard (always start here)
tools har-analyzer errors                          # every 4xx and 5xx with a body preview
tools har-analyzer list --status 4xx,5xx           # compact table of matching entries
tools har-analyzer show e14 --raw                  # full headers and bodies of entry 14
tools har-analyzer expand e14.rs.body --schema     # the shape of a JSON body, not the data
tools har-analyzer redact ~/Downloads/capture.har  # write ~/Downloads/capture.redacted.har, credentials masked
```

Every command after `load` works on the last loaded file, except `redact`, which takes file paths. Entries are
numbered from `e0` in file order; `e14` and `14` mean the same entry.

## Commands

### Load and sessions

| Command | What it does |
|---------|--------------|
| `load <file>` | Parse and index a HAR file, make it the active session, print the dashboard |
| `dashboard` | Print the dashboard of the active session again |
| `sessions` | List stored sessions; `*` marks the active one |
| `sessions --clean` | Remove sessions not used for more than a day |

The dashboard shows the entry count, duration, total size, status mix, domains and content types.

### Browse entries

- `list`: a table of entries. Filters: `--domain`, `--url`, `--status`, `--method`, `--type`, `--min-time`,
  `--min-size`, and `--limit` (default 50).
- `show <entry>`: a summary of one entry: timings, the first 5 request and response headers, query parameters,
  body sizes. `--raw` prints the full headers and bodies. `--raw --section body` or `--raw --section headers`
  keeps one part, and `--raw --section cookies` prints the request and response cookies.
- `expand <refId>`: the full content of a reference such as `e14.rs.body`. `--schema [skeleton|typescript|schema]`
  prints the inferred shape of a JSON body instead of the data.
- `domains`: every domain by request count, with total size and average time.
- `domain <name>`: the entries of one domain (a glob) with their response bodies. Filters: `--status`, `--method`,
  `--limit`, `--include-all`.
- `search <query>`: case-insensitive text search. `--scope url|body|header|all` (default `all`), `--domain`,
  `--limit` (default 20).

Plain `--raw` never prints cookies: `--raw --section cookies` is the only way to see them. `--section` does nothing
without `--raw`, and an unknown value such as `cookie` prints empty output.

`expand` accepts four paths: `eN.rq.headers`, `eN.rs.headers`, `eN.rq.body` and `eN.rs.body` (`rq` is the request,
`rs` the response). It reads the value from the HAR file, so it works for any entry, also one you never displayed.
`--schema` alone means `skeleton`, and it needs a JSON body.

`domain` prints each response body in full the first time it appears (see [the reference system](#how-it-works)),
so narrow it with `--status` or `--limit` on a large domain.

`search` reports one match per entry, with about 60 characters of context, and checks the URL first, then the
response and request bodies, then the headers. It reads every body, whatever its content type.

### Analyses

- `errors`: 4xx and 5xx entries in two groups, with the first 120 characters of a text body.
- `security`: findings by severity (listed below). It prints names and lengths, never the secret values.
- `headers`: the headers on more than half of the entries, then the rest with the entries that carry them. Each
  header shows its value when it has only one, else the number of distinct values.
  `--scope request|response|both` (default `both`).
- `waterfall`: an ASCII timeline of start time and duration, 40 columns wide. `--domain`, `--limit` (default 30).
- `size`: total bytes, bytes per content type, and the 10 largest responses.
- `redirects`: redirect chains, hop by hop, with the final status.
- `cookies`: each cookie with the entry that set it, its flags, and the requests that sent it.
- `diff <entry1> <entry2>`: method, path, status, time, sizes and type side by side (`*` marks a difference), the
  headers that differ, and both response bodies.

`security` reports these findings:

- HIGH: a query parameter or request header whose name contains `api_key`, `apikey`, `x-api-key`, `secret` or
  `token` (Authorization is checked separately), and a query parameter whose name contains `password`, `passwd` or
  `auth`.
- MEDIUM: a JWT in an `Authorization: Bearer` header, with its `alg` and `exp`, marked `(EXPIRED)` when it expired.
- LOW: a `Set-Cookie` without `HttpOnly` or without `Secure`.

### Write a HAR

- `export`: write a filtered subset of the active session as a HAR, to stdout or to `-o, --output <file>`.
  Filters: `--domain`, `--status`, `--method`. `--sanitize` runs the redactor over each entry, `--strip-bodies`
  removes request and response bodies.
- `redact <files...>`: mask credentials and personal data in HAR files. It needs no `load`. Flags: `-o, --output`,
  `--in-place`, `--dry-run`, `--details`, `--only`, `--skip`, `--mask`. See [Redaction](#redaction-redact), which
  also compares it with `export --sanitize`.

### MCP server

- `mcp`: start a stdio MCP server with the `har_*` tools (see [For agents](#for-agents)).

### Interactive mode

`tools har-analyzer` with no arguments, or `tools har-analyzer -i`, opens a menu. It resumes the last session or
asks for a `.har` path, prints the dashboard, and offers list, show, domain drill-down, search, errors, waterfall,
security and size. Under "More...", only "Dashboard (refresh)" runs. Redirects, cookies, export and headers only
print the CLI command to run (`Use CLI: tools har-analyzer <cmd>`). Diff asks for two entries and then also only
prints the CLI command. "Load different HAR" switches the file.

### Global options

These belong to the tool, not to a subcommand. They work before or after the subcommand:
`tools har-analyzer --full show e14 --raw` and `tools har-analyzer show e14 --raw --full` are the same.

| Flag | Effect |
|------|--------|
| `--format md\|json\|toon` | Output format (default `md`). See [For agents](#for-agents) |
| `--full` | Bypass the reference system and print every value in full |
| `--include-all` | Also print bodies of static assets (CSS, JS, images, fonts) |
| `--session <hash>` | Use another stored session instead of the last loaded one |
| `-v, --verbose` | Verbose logging |
| `-i, --interactive` | Start interactive mode |
| `--readme` | Print this README |

`--full` affects `show --raw` and `domain`. `--include-all` affects `show --raw` and `domain`. `diff` and `errors`
always use the default rules. The MCP server ignores `--format`, `--full`, `--include-all` and `--session` (see
[For agents](#for-agents)).

### Filters

`list` has every filter. `domain` has `--status`, `--method` and `--limit`. `export` has `--domain`, `--status` and
`--method`. `search` and `waterfall` have `--domain`.

- `--status` takes a comma-separated list of codes and classes: `200`, `4xx`, `4xx,5xx`. A `!` excludes:
  `!3xx`, `2xx,!204`. A negation excludes its status wherever it sits in the list.
- `--method` takes a comma-separated list, case-insensitive: `GET,POST`.
- `--domain`, `--url` and `--type` are globs where `*` is the only wildcard. They are case-insensitive and must match
  the whole value. `--url` matches the full URL with scheme and host, so write `--url '*/api/users*'`, not
  `--url /api/users`.
- `--min-time` is in milliseconds, `--min-size` in bytes of the response content.

```bash
tools har-analyzer list --domain '*.example.com' --method POST --status '!2xx'
tools har-analyzer list --type 'application/json*' --min-time 500 --limit 20
tools har-analyzer domain api.example.com --status 4xx
tools har-analyzer search "invalid_grant" --scope body
```

## Redaction (`redact`)

`redact` removes credentials and personal data and keeps the HAR structurally valid, so you can still load and
analyze the result. It works on file paths directly (no `load` needed) and accepts several files.

What it redacts:

- JSON request and response bodies: values under password, secret, token, session, email and username keys, plus
  email-shaped values under any key. Keys match by their exact normalized name (lowercase, without `-`, `_`, `.` and
  spaces), never as a substring, so `token_type` and an error `code` field survive. Every body with a JSON MIME
  type that parses as an object or an array is written back compact, also when nothing in it was masked, so a
  diff against the original shows every such body as changed.
- Form bodies (`x-www-form-urlencoded`) and multipart params: the same key rules. Pairs it does not touch stay byte
  for byte.
- Headers: `Authorization` and `Proxy-Authorization` (the scheme stays, for example `Bearer`), `Cookie` and
  `Set-Cookie` (cookie names and attributes stay), and every header whose name contains a credential part: `secret`,
  `apikey`, `password`, `session`, `token`, `auth`, `credential` or `signature`. So `authToken`, `X-Auth-Token` and
  `X-Goog-Api-Key` are masked; `:authority`, `WWW-Authenticate` and `Access-Control-*` are left alone. `Location` and
  `Referer` get their query strings redacted.
- Cookies, query strings, request URLs, redirect URLs and page titles.
- JWTs anywhere in the file, through a catch-all pass over non-standard fields.

Emails are matched only in structured values (JSON, forms, query strings), never in raw HTML, so contact addresses in
page content stay. A name such as `image@2x.png` is not treated as an email.

Base64 bodies are not scanned. Each one is listed as a warning.

Mask styles keep the file analyzable instead of blanking everything:

| Style | Effect | Default for |
|-------|--------|-------------|
| `stars` | Full mask, length kept | password, secret, username |
| `partial` | Head and tail kept for correlation | token, session, cookie, jwt, email |
| `label` | `[REDACTED:<kind>]` | (opt-in) |
| `keep` | Leave the value untouched | (opt-in) |

`stars` keeps the length up to 64 characters: `hunter2` becomes `*******`. `partial` prints a value as
`opaq[***]alue`. It reveals a quarter of the value on each side, at most 12 characters. An email keeps its domain
(`******@example.com`), and a value under 16 characters falls back to stars. The kinds are `password`, `secret`,
`token`, `session`, `email`, `username`, `cookie` and `jwt`. `--only` wins over `--skip`.

```bash
# Default: writes <name>.redacted.har next to each input
tools har-analyzer redact login.har capture2.har

# Rewrite the originals; backups land in /tmp with printed restore commands
tools har-analyzer redact *.har --in-place

# Report only, with every redacted location
tools har-analyzer redact login.har --dry-run --details

# Keep cookies intact (needed for session analysis), fully hide tokens
tools har-analyzer redact login.har \
    --skip cookie \
    --mask token=stars,jwt=stars

# Redact only passwords and emails
tools har-analyzer redact login.har --only password,email

# One input, an explicit output path
tools har-analyzer redact login.har -o ~/Projects/app/fixtures/login.clean.har
```

Every run verifies itself: a second redaction pass over the output must find zero further changes. In the default
report, a failed pass prints `verify FAILED` and the command exits 1. With `--format json`, a failed pass does not
change the exit code (it stays 0): read `verified` in each report object. Do not share a file that failed. The
change report lists the entry index, the JSON path or location, and the kind, never the values themselves.
`redact` ignores `--format toon` and prints the default report.

Rules for the output flags:

- `-o, --output` works with one input file only, and not together with `--in-place`.
- `--in-place` copies each original to `/tmp/har-redact-backup-<timestamp>/` first and prints a `cp` command per file
  to restore it. Two inputs with the same file name get `capture.har` and `capture.2.har`. `/tmp` is cleared on
  reboot, so the restore window is finite.
- An input that does not parse as JSON, or a path that does not exist, is skipped with an error line on stderr,
  and the other files are still processed. A skipped input does not change the exit code: the command exits 0
  even when it skipped every input. With `--format json`, a skipped input is missing from the array.
- With `--format json` and `--in-place`, the `cp` restore commands are not printed. Each report object carries
  its `backupFile` path instead.

`export --sanitize` or `redact`:

- `export --sanitize` uses the same rules per entry, but masks tokens, sessions, cookies and JWTs as
  `[REDACTED:<kind>]` with no head or tail, because a sanitized export is meant to be shared (changed 2026-10-07).
  It does not touch page titles, runs no whole-file JWT sweep, does not verify itself, and needs a loaded session.
- `redact` covers the whole file, verifies itself and reports every change. Use it for a full file; use
  `export --sanitize --strip-bodies -o clean.har` for a small shareable subset.

## How it works

**Sessions.** `load` parses the file once and stores an index: method, URL, status, sizes, timings and MIME type
of every entry, plus totals and a domain index. The session id is the xxHash64 of the file content, so loading
the same unchanged file again reuses the same id, and a changed file gets a new one.

**Data on disk.** Everything lives under `~/.genesis-tools/har-analyzer/cache/`. `GENESIS_TOOLS_HOME` replaces your
home folder, so the cache is then `$GENESIS_TOOLS_HOME/.genesis-tools/har-analyzer/cache/`. Set it to the folder
above `.genesis-tools`, not to `.genesis-tools` itself.

- `sessions/<hash>.json`: the index of one HAR file.
- `sessions/<hash>.refs.json`: which references were already shown in full.
- `last-session.txt`: the hash of the active session.
- `/tmp/har-redact-backup-<timestamp>/` (outside that folder): the originals that `redact --in-place` replaced.

A session file expires one day after its last write, and every command that reads a session rewrites it, so a
session in daily use stays. `load` also removes sessions unused for more than a day, in the background, like
`sessions --clean`. Loading the same file again keeps the references that were already shown.

**The original file is still needed.** The index holds no bodies and no headers. `show`, `expand`, `domain`,
`search` (scopes `body`, `header` and the default `all`), `headers`, `errors`, `security`, `cookies`, `diff` and
`export` read them from the original HAR at the absolute path it had at `load` time. `dashboard`, `list`,
`domains`, `waterfall`, `size` and `redirects` work from the index alone.

**The reference system.** A value longer than 200 characters gets a reference id the first time it is printed, and
the full value follows the tag: `[ref:e14.rs.body] {"users":[...]}`. Every later view of the same value prints only
an 80-character preview and its length: `[ref:e14.rs.body] {"users":[{"id":1,... (1834 chars)`. The id format is
`e<N>.<rq|rs>.<body|headers>`. Use `expand <refId>` to print the value again, or `--full` to switch the system off.

**Bodies that are skipped.** By default only bodies of these types are printed: JSON (`application/json` and its
variants, `text/json`), HTML, XML (`text/xml`, `application/xml`), `text/plain`, `x-www-form-urlencoded` and
`multipart/form-data`. Other bodies (CSS, JS, images, fonts, WASM) print as `[skipped: <type>, <size>]` until you
pass `--include-all`. In `show --raw`, `diff`, `expand` and the MCP tools, a base64 body always prints as
`[binary: <type>, <size>]`.

`domain` follows other rules. It shows a skipped body as `(<mime>)`, not as `[skipped: ...]`. It does not check the
encoding, so with `--include-all`, or when a base64 body has a text MIME type, it prints the raw base64 text.

**What it needs.** It reads local files only: no network, no API, no cost. A HAR in `~/Downloads`, `~/Desktop` or
`~/Documents` makes macOS ask once for access to that folder for GenesisTools; allow it. Full Disk Access is not
needed.

## For agents

- **Never `cat` or `jq` a HAR file.** Load it and use the commands above. The plugin skill `gt:analyze-har`
  (`plugins/genesis-tools/skills/analyze-har/SKILL.md`) has the workflow.
- **Order:** `load`, then `errors` or `list` with filters, then `domain` or `show eN`, then `show eN --raw`, then
  `expand`. Use `expand <ref> --schema` (or `--schema typescript`) to learn a JSON body's shape before you print it.
- **References persist across commands and across agent turns** for a day. After a context reset, a value you never
  saw in this context may print only as a preview. Use `expand` or `--full` to see it again.
- **`--format json` is a wrapper, not a schema.** Most commands print `{"output":"<the markdown text>"}`, and
  `--format toon` prints the same object in TOON. Most short "nothing found" messages print as plain text in every
  format. `load` and `sessions` ignore `--format`, `export` always prints a HAR, and `redact` ignores
  `--format toon`.
- **`redact --format json` is structured:** an array with one object per file: `file`, `outputFile`, `backupFile`,
  `entryCount`, `changeCount`, `changes` (`entryIndex`, `location`, `kind`, `count`), `skipped` and `verified`.
  In this mode a failed verify pass still exits 0, so check `verified` in every object before you share a file.
- **Live secrets.** Several commands print values as they are. A HAR of a login flow holds the plaintext password
  and live session tokens.
  - `show` prints the first 5 request and response headers and every query parameter, with values.
  - `show --raw` prints every header and every text body; `show --raw --section cookies` prints the cookie values.
  - `domain` prints response bodies and `errors` the first 120 characters of each error body.
  - `diff` prints the header values that differ (cut to 30 characters), and `search` prints about 60 characters
    around each match.
  - `headers` prints a header's value when all its entries share one value (cut to 80 characters).

  `cookies` prints cookie names, flags and entry ids, not values. `security` prints names and lengths only.
  Redact before a HAR leaves the machine.
- **Exit codes:** 0 on success. 1 when no session is loaded, when an entry or ref id does not exist, for a bad
  `--schema` mode or a body that is not JSON, for invalid or conflicting `redact` flags, and when `redact` fails
  its verify pass in the default report. With `redact --format json`, a failed verify does not change the exit
  code (it stays 0): read `verified` in each report object. A `redact` input that it skipped does not change the
  exit code either.

### MCP server

```json
{
  "mcpServers": {
    "har-analyzer": { "command": "tools", "args": ["har-analyzer", "mcp"] }
  }
}
```

| Tool | Arguments | What it does |
|------|-----------|--------------|
| `har_load` | `file` | Load a HAR and return the dashboard |
| `har_overview` | | The dashboard of the current session |
| `har_list` | `domain status method url limit` | One line per matching entry |
| `har_detail` | `entry` (a number), `raw section full` | Like `show` |
| `har_expand` | `ref` | Like `expand`, without `--schema` |
| `har_search` | `query`, `scope domain` | Like `search` |
| `har_analyze` | `type`: `errors` or `security` | A reduced scan (see below) |
| `har_redact` | `file`, `output only skip mask` | Like `redact` (see below) |
| `har_export` | `domain status sanitize stripBodies` | Counts matches only (see below) |

`har_detail` takes its own `full` argument. `full: true` switches the reference system off and also prints the
response body of a static asset type, as `--include-all` does in the CLI. With `raw`, the request body prints
whatever its type, and `section` knows only `headers` and `body` (there is no cookies section).

`har_analyze` is smaller than the CLI commands. `errors` is one flat list with the first 80 characters of any body:
no 4xx and 5xx groups, no MIME check. `security` checks two things only: an `Authorization` header that starts with
`Bearer ey`, and a query parameter named exactly `api_key`, `apikey`, `token`, `secret` or `key`. It has no
header API key check, no `password`, `passwd` or `auth` parameter check, no cookie flag check, no `alg` or `exp`
details and no severity levels. Run the CLI `security` for the full rules.

`har_redact` writes `<name>.redacted.har` unless `output` is given, and returns an error when the verify pass fails.
`har_export` writes nothing: it counts the matching entries and prints the CLI `export` command to run.

The server ignores the global flags (`--format`, `--full`, `--include-all`, `--session`), so
`tools har-analyzer --full mcp` changes nothing.

The server keeps its session in memory. Its first call picks up the last session the CLI loaded; after that, a CLI
`load` does not change it. Call `har_load` to switch. `har_load` also makes the file the CLI's active session (it
rewrites `last-session.txt`), so the user's next CLI command works on that file.

## Troubleshooting

- **`No session loaded. Use load <file> first.`** Nothing was loaded in the last day, the session expired, or
  `--session` got a short hash. `sessions` prints only the first 8 characters, but `--session` needs the full
  hash (the file name in `~/.genesis-tools/har-analyzer/cache/sessions/`) or the HAR's path. A value with a `/` or
  a `.` is read as a path and hashed, so it finds the session only while the file is unchanged.
- **`show`, `errors` or `security` fails after you moved or deleted the HAR.** Bodies and headers are read from
  the original path. Put the file back or `load` it from its new place. Interactive mode prints
  `Could not read HAR source file`.
- **A body prints as a one-line preview with `(N chars)`.** It was shown in full before. Run `expand <refId>` or
  add `--full`.
- **A body prints as `[skipped: text/css, 12 KB]`, or as `(text/css)` in `domain`.** Static asset types are
  hidden. Add `--include-all`.
- **`list --url /api/users` finds nothing.** The URL glob must match the whole URL. Use `--url '*/api/users*'`.
- **`search --scope headers` finds nothing.** The scope is `header`, singular. An unknown scope matches nothing and
  prints `No matches found`.
- **`redirects` misses a hop or shows no chain.** Chains come from each response's `redirectURL` field and need the
  next request in the same capture. A HAR whose exporter leaves `redirectURL` empty, or a redirect to a page the
  capture does not hold, shows no chain. Check the `location` header with
  `show eN --raw --section headers`.
- **`redact` prints `verify FAILED` and exits 1.** The second pass still found redactable data. Do not share that
  output. With `--format json` there is no such line and the exit code stays 0: the object has `verified: false`.
- **`redact` exits 0 but wrote nothing.** It skipped every input: check stderr for
  `not a parseable HAR file, skipping`. A relative path is read from the current folder.
- **The MCP server answers about an old file.** It holds its session in memory. Call `har_load` with the new file.
- **The CLI suddenly works on another file.** An agent called the MCP `har_load`, which also sets the CLI's active
  session. Run `load` again, or pass `--session`.

## Related

- [../chrome-devtools/README.md](../chrome-devtools/README.md): `tools chrome-devtools har` writes a HAR from the
  live browser; `--sanitize --analyze` redacts it and runs `load` on it.
- [../azure-devops/README.md](../azure-devops/README.md): `tools azure-devops workitem <id> --attachments-suffix .har`
  downloads HAR attachments of a work item.
- [../secrets/README.md](../secrets/README.md): `tools secrets` finds hardcoded secrets in code and redacts them from
  text; `redact` here does that job for HAR files.
- [../debugging-master/README.md](../debugging-master/README.md): runtime debugging that uses the same reference
  system.
