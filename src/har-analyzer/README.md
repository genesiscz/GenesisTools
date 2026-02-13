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
| `sessions` | List/manage HAR sessions |
| `mcp` | Start MCP server |

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
