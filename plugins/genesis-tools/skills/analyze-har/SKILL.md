---
name: genesis-tools:analyze-har
description: |
  Token-efficient HAR (HTTP Archive) file analysis with reference system. Use when user provides a HAR file, asks to analyze network traffic, debug API calls, investigate HTTP requests/responses, or review web performance. Triggers on "analyze HAR", "HAR file", "network traffic", "HTTP archive", "debug requests", "analyze network", "look at this HAR", or when a .har file path is mentioned. NEVER read HAR files directly with cat/jq - always use this tool.
---

# HAR Analyzer

Token-efficient HAR analysis. Uses a **reference system** - large data shown once gets a ref ID, subsequent views show `[ref:ID]` + preview instead of repeating.

## Critical Rule

**NEVER `cat`, `jq`, or directly read a HAR file.** Always use `tools har-analyzer` commands. Raw HAR reading wastes 10-100x more tokens.

## Optimal Workflow

```
1. tools har-analyzer load <file.har>     # Parse + dashboard (always start here)
2. tools har-analyzer list --status 4xx   # Filter to what matters
3. tools har-analyzer domain <domain>     # Drill into specific API
4. tools har-analyzer show e14            # Detail for one entry
5. tools har-analyzer show e14 --raw      # Full body/headers if needed
6. tools har-analyzer expand e14.rs.body  # Re-show a referenced value
```

## Command Reference

| Command | Purpose | Key Options |
|---------|---------|-------------|
| `load <file>` | Parse HAR, show dashboard | |
| `dashboard` | Re-show overview stats | |
| `list` | Compact entry table | `--domain --status --method --url --limit` |
| `show <eN>` | Entry detail (L2) | `--raw --section body\|headers\|cookies` |
| `expand <ref>` | Show full referenced data | `--schema [skeleton\|typescript\|schema]` |
| `domains` | List domains with stats | |
| `domain <name>` | Drill-down: paths + body previews | `--status --method` |
| `search <query>` | Grep across entries | `--scope url\|body\|header\|all` |
| `errors` | 4xx/5xx focus with body previews | |
| `waterfall` | ASCII timing chart | `--domain --limit` |
| `security` | Find JWT, API keys, insecure cookies | |
| `size` | Bandwidth breakdown by type | |
| `headers` | Deduplicated header analysis | `--scope request\|response\|both` |
| `redirects` | Redirect chain tracking | |
| `cookies` | Cookie flow (set/sent tracking) | |
| `diff <e1> <e2>` | Compare two entries | |
| `export` | Export filtered HAR subset | `--sanitize --strip-bodies -o file` |

## Global Options

| Flag | Purpose |
|------|---------|
| `--format md\|json\|toon` | Output format (default: md) |
| `--full` | Bypass ref system, show everything |
| `--include-all` | Show CSS/JS/image/font bodies (skipped by default) |

## Reference System

- Data >200 chars gets a ref ID on first show: `[ref:e14.rs.body] {"users":[...]}`
- Same data in later commands shows: `[ref:e14.rs.body] {"users":[{"id":1,... (1.8KB)`
- Use `expand <refId>` to see full content again
- Ref format: `e{N}.{rq|rs}.{body|headers|cookies}`
- `--full` flag bypasses refs entirely

## Content Skipping

By default, bodies of static assets are skipped (CSS, JS, images, fonts, WASM). Only JSON, HTML, XML, and plain text bodies are shown. Use `--include-all` to override.

## Common Patterns

**Understand API shape before expanding full body (token-efficient!):**
```bash
tools har-analyzer expand e14.rs.body --schema            # compact skeleton
tools har-analyzer expand e14.rs.body --schema typescript  # TS interfaces
tools har-analyzer expand e14.rs.body                      # full content only if needed
```

**Debug API errors:**
```bash
tools har-analyzer load capture.har
tools har-analyzer errors                    # See all 4xx/5xx
tools har-analyzer show e14 --raw            # Full error response
```

**Analyze specific API:**
```bash
tools har-analyzer domain api.example.com    # All requests to that domain
tools har-analyzer domain api.example.com --status 4xx
```

**Find sensitive data:**
```bash
tools har-analyzer security                  # JWT, API keys, insecure cookies
```

**Compare working vs failing request:**
```bash
tools har-analyzer diff e5 e14               # Side-by-side comparison
```

## MCP Server

If configured as MCP server (`tools har-analyzer mcp`), use MCP tools directly:
`har_load`, `har_overview`, `har_list`, `har_detail`, `har_expand`, `har_search`, `har_analyze`, `har_flow`, `har_diff`, `har_export`
