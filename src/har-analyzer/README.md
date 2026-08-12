# HAR Analyzer

Token-efficient HAR (HTTP Archive) file analyzer with a reference system that eliminates data repetition.

## Usage

```bash
# Load and analyze a HAR file
tools har-analyzer load capture.har

# Interactive mode
tools har-analyzer
tools har-analyzer -i

# Start MCP server
tools har-analyzer mcp
```

## Commands

| Command | Description |
|---------|-------------|
| `load <file>` | Parse HAR file, show dashboard |
| `dashboard` | Re-show overview stats |
| `list` | Compact entry table with filters |
| `show <eN>` | Entry detail (add `--raw` for full content) |
| `expand <ref>` | Show full referenced data |
| `domains` | List domains with stats |
| `domain <name>` | Drill-down into a specific domain |
| `search <query>` | Search across entries |
| `headers` | Deduplicated header analysis |
| `waterfall` | ASCII timing chart |
| `errors` | 4xx/5xx focus with body previews |
| `security` | Find JWT, API keys, insecure cookies |
| `size` | Bandwidth breakdown by type |
| `redirects` | Redirect chain tracking |
| `cookies` | Cookie flow (set/sent tracking) |
| `diff <e1> <e2>` | Compare two entries |
| `export` | Export filtered HAR subset |
| `redact <files...>` | Redact PII/credentials from HAR files (no session needed) |
| `sessions` | List/manage HAR sessions |
| `mcp` | Start MCP server |

## Redaction (`redact`)

Removes credentials and PII while keeping the HAR structurally valid and analyzable. Works directly on file paths (no `load` needed) and accepts multiple files.

What gets redacted:

- Request/response JSON bodies: values under password/secret/token/session/email/username keys (exact normalized-name matches, so `token_type` and error `code` fields survive), plus email-formatted values under any key
- Form bodies (`x-www-form-urlencoded`) and multipart params: same key rules, untouched pairs preserved byte-for-byte
- Headers: Authorization (scheme kept), Cookie/Set-Cookie (names and attributes kept), API-key headers
- Cookies, query strings, request URLs, redirect URLs, page titles
- JWTs anywhere in the file (catch-all pass over non-standard fields)

Base64 bodies are not scanned; each one is listed as a warning.

Mask styles keep the file analyzable instead of blanking everything:

| Style | Effect | Default for |
|-------|--------|-------------|
| `stars` | Full mask, length preserved (`hunter2` -> `*******`) | password, secret, username |
| `partial` | Head+tail kept for correlation (`opaq[***]alue`); emails keep their domain (`******@cez.cz`); values under 16 chars fall back to stars | token, session, cookie, jwt, email |
| `label` | `[REDACTED:<kind>]` | (opt-in) |
| `keep` | Leave untouched | (opt-in) |

```bash
# Default: writes <name>.redacted.har next to each input
tools har-analyzer redact login.har capture2.har

# Rewrite originals; backups land in /tmp with printed restore commands
tools har-analyzer redact *.har --in-place

# Report only
tools har-analyzer redact login.har --dry-run --details

# Keep cookies intact (needed for session analysis), fully hide tokens
tools har-analyzer redact login.har --skip cookie --mask token=stars,jwt=stars

# Redact only passwords and emails
tools har-analyzer redact login.har --only password,email
```

Every run self-verifies: a second redaction pass over the output must find zero further changes, otherwise the command exits 1. The change report lists entry index, JSON path/location, and kind, never the values themselves.

## Global Options

| Flag | Description |
|------|-------------|
| `--format md\|json\|toon` | Output format (default: md) |
| `--full` | Bypass ref system, show everything |
| `--include-all` | Show CSS/JS/image/font bodies |
| `--session <hash>` | Use a specific session |
| `-v, --verbose` | Verbose logging |
| `-i, --interactive` | Launch interactive mode |

## Reference System

Data >200 chars gets a ref ID on first show. Subsequent views show `[ref:ID]` + preview instead of repeating the full content. Use `expand <refId>` to see full content again. Use `--full` to bypass refs entirely.

## Filter Options (list, domain, export)

`--domain`, `--status` (200, 4xx, 5xx), `--method`, `--url`, `--limit`
