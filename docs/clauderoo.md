# Clauderoo

CLI contracts for the Genesis.app usage monitor. The Swift app parses these
JSON envelopes. It does not talk to Anthropic.

Machine output goes through `out.result(...)` (one JSON value plus a newline).

## `tools claude usage --json --scored`

Requires `--json`. `--scored` without `--json` exits 1.

```json
{
  "fetchedAt": 1710000000000,
  "accounts": [
    {
      "accountName": "bfbc",
      "tier": "ready",
      "group": "fable",
      "score": 1.2,
      "cooling": false,
      "weeklyRatePctPerHour": 0.4,
      "sessionHeadroomPct": 80,
      "weeklyHeadroomPct": 60,
      "sessionUsableFraction": 1,
      "why": "…"
    }
  ],
  "timings": { "fetchMs": 12, "scoreMs": 1, "totalMs": 13, "accounts": 1 }
}
```

`accounts` is `sortGrouped(scoreAccounts(...))`: group order fable, opus,
expired, dead; inside a group, higher `score` first.

`group` is `fable | opus | dead | expired`. `tier` is
`ready | session-starved | weekly-blocked | no-data`.

## `tools claude usage sessions --json`

```json
{
  "fetchedAt": 1710000000000,
  "rows": [
    {
      "sessionId": "c53c4440-…",
      "title": "string or null",
      "cwd": "/abs/path",
      "cwdShort": "repo",
      "project": "string or null",
      "mtime": 1710000000000,
      "lastCacheAt": 1710000000000,
      "model": "opus",
      "modelSwitched": false,
      "cacheStatus": "HOT",
      "cacheTtlSec": 2400,
      "totalTokens": 0,
      "cacheReadTokens": 0,
      "cacheCreateTokens": 0,
      "filePath": "/abs/session.jsonl"
    }
  ],
  "timings": {}
}
```

Flags:

- `--hours <n>`: keep rows whose file mtime is within n hours (default 6).
- `--min <n>`: if the hours window has fewer than N rows, append older
  sessions by mtime.

`cacheStatus` is `HOT | COOLING | CRITICAL | COLD`, from `lastCacheAt`
(last main-thread user/assistant timestamp, not inode mtime):

| status | idle |
|---|---|
| HOT | under 50 min |
| COOLING | 50–55 min |
| CRITICAL | 55–60 min |
| COLD | 60 min or more |

Rows sort HOT first, then `lastCacheAt` descending.

Import existing `@app/claude` modules. Do not copy ranking or cache-TTL math.
