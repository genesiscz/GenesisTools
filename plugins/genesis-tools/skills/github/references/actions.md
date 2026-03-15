# GitHub Actions — Usage, Billing & CI Analysis

Reference for analyzing GitHub Actions workflow runs, calculating costs,
and managing CI pipelines. Loaded when actions/billing/CI keywords are detected.

## Quick Reference

| Task | Approach |
|------|----------|
| List runs by date | `gh run list --created "YYYY-MM-DD" --limit 200 --json ...` |
| Summarize by workflow/status | pipe to `jq` group_by |
| Calculate billable cost | `bun <skill-dir>/scripts/actions-cost.ts --repo owner/repo --date YYYY-MM-DD` |
| Cross-repo cost scan | `bun <skill-dir>/scripts/actions-cost.ts --org <org> --date YYYY-MM-DD --cross-repo` |
| Cost per branch/PR | `bun <skill-dir>/scripts/actions-cost.ts --repo owner/repo --branch <branch>` |
| Failure waste analysis | included in script output automatically |
| Re-run failed jobs | `gh run rerun <id> --failed` |
| Cancel stale runs | `gh run cancel <id>` |
| Cache usage | `gh api /repos/{owner}/{repo}/actions/cache/usage` |

## Listing Workflow Runs

### By Date

```bash
gh run list --repo owner/repo \
  --created "YYYY-MM-DD" \
  --limit 200 \
  --json databaseId,workflowName,conclusion,createdAt,headBranch,event
```

Date range: `--created "2026-03-01..2026-03-07"`.

### By Branch

```bash
gh run list --repo owner/repo --branch main --limit 50 \
  --json databaseId,workflowName,conclusion,createdAt
```

### By Actor

```bash
gh run list --repo owner/repo --actor username --limit 50
```

### By Workflow

```bash
gh run list --repo owner/repo --workflow "CI" --limit 50
```

### By Status

```bash
gh run list --repo owner/repo --status queued
gh run list --repo owner/repo --status in_progress
gh run list --repo owner/repo --status completed
```

## Summarizing Runs

### Count by Workflow x Conclusion

```bash
gh run list --repo owner/repo --created "YYYY-MM-DD" --limit 500 \
  --json workflowName,conclusion \
  | jq 'group_by(.workflowName) | map({
      workflow: .[0].workflowName,
      total: length,
      success: [.[] | select(.conclusion == "success")] | length,
      failure: [.[] | select(.conclusion == "failure")] | length,
      cancelled: [.[] | select(.conclusion == "cancelled")] | length
    })'
```

### Duration Distribution

```bash
gh run list --repo owner/repo --limit 100 \
  --json databaseId,workflowName,createdAt,updatedAt \
  | jq 'map({
      workflow: .workflowName,
      duration_min: (((.updatedAt | fromdateiso8601) - (.createdAt | fromdateiso8601)) / 60 | floor)
    }) | group_by(.workflow) | map({
      workflow: .[0].workflow,
      avg_min: ([.[].duration_min] | add / length | floor),
      max_min: ([.[].duration_min] | max)
    })'
```

## Cost Calculation (Use the Bundled Script)

The bundled script handles all complexity: job-level timing extraction, runner detection,
per-minute billing math, and cross-repo scanning.

### Script CLI

```text
bun <skill-dir>/scripts/actions-cost.ts [options]

Options:
  --repo <owner/repo>     Single repo to analyze
  --org <org>             Org to scan (with --cross-repo)
  --date <YYYY-MM-DD>     Single date
  --from <YYYY-MM-DD>     Start of date range
  --to <YYYY-MM-DD>       End of date range (default: today)
  --branch <branch>       Filter runs by branch
  --workflow <name>       Filter by workflow name
  --cross-repo            Scan all repos in org (requires --org)
  --top <n>               Show top N most expensive runs (default: 10)
  --format <table|json>   Output format (default: table)
  --verbose               Show progress during cross-repo scan
```

### Runner Rate Table

| Runner OS | $/min | Multiplier |
|-----------|-------|------------|
| Linux (2-core) | 0.006 | 1x |
| Linux 4-core | 0.012 | 2x |
| Linux 8-core | 0.022 | 3.7x |
| Linux 16-core | 0.042 | 7x |
| Windows (2-core) | 0.010 | 1.7x |
| macOS (3/4-core) | 0.062 | 10.3x |
| macOS 12-core (xlarge) | 0.077 | 12.8x |

Free tier: 2,000 min/month (Linux equivalent). Non-Linux minutes consumed at multiplied rate.

### When to Use the Script vs Raw `gh`

- **Script:** any cost/billing question, cross-repo scan, failure waste analysis, top-N expensive runs
- **Raw gh:** simple "list runs", "cancel a run", "rerun failed", quick status checks

### Manual Calculation (Fallback)

If the script is unavailable:

1. Get run IDs: `gh run list --repo owner/repo --created YYYY-MM-DD --json databaseId`
2. For each run: `gh run view <id> --repo owner/repo --json jobs`
3. Filter non-skipped jobs (conclusion is `success`, `failure`, or `cancelled`)
4. Extract `startedAt`/`completedAt` per job, compute `Math.ceil(seconds / 60)`
5. Detect runner OS from job labels, multiply by rate

### Gotchas

- **Shell escapes `!=` in jq** — zsh mangles `!`. Use positive matching: `select(.x == "a" or .x == "b")` instead of `select(.x != "c")`.
- **Billing API needs `admin:org` scope** — `gh api /orgs/{org}/settings/billing/actions` returns 404 without it.
- **Timing API is unreliable** — `gh api repos/{owner}/{repo}/actions/runs/{id}/timing` often returns `total_ms: 0`. Don't use it.
- **Job-level timestamps are the truth** — always extract from `gh run view <id> --json jobs`.
- **Billing rounds UP per job** — `Math.ceil(durationSeconds / 60)` per individual job, not per run.

## Cost Per Branch/PR

Use `--branch` to attribute CI cost to specific feature work:

```bash
bun <skill-dir>/scripts/actions-cost.ts \
  --repo owner/repo \
  --branch feat/my-feature \
  --from 2026-03-01 --to 2026-03-12
```

## Failure Waste Analysis

The script automatically identifies wasted spend on failed runs. Output includes:
- Total failed run count and cost
- Breakdown by fast failures (<5 min) vs full-suite failures
- Percentage of total spend wasted on failures

## Cross-Repo Scanning

Scan all repos in an org to find where CI spend is concentrated:

```bash
bun <skill-dir>/scripts/actions-cost.ts \
  --org myorg \
  --date 2026-03-12 \
  --cross-repo \
  --verbose
```

Uses `gh repo list <org> --json nameWithOwner --limit 1000` to discover repos.

## Workflow Efficiency Metrics

The script summary includes per-workflow:
- Run count, success/failure/cancelled split
- Average duration and p90 duration
- Success rate percentage
- Billable minutes and estimated cost

Compare periods with `--from`/`--to`:

```bash
# This week
bun <skill-dir>/scripts/actions-cost.ts --repo owner/repo --from 2026-03-10 --to 2026-03-14

# Last week
bun <skill-dir>/scripts/actions-cost.ts --repo owner/repo --from 2026-03-03 --to 2026-03-07
```

## Re-Running and Cancelling

### Re-run Failed Jobs Only

```bash
gh run rerun <run-id> --failed --repo owner/repo
```

### Cancel In-Progress Runs

```bash
gh run cancel <run-id> --repo owner/repo
```

### Cancel All Queued Runs for a Workflow

```bash
gh run list --repo owner/repo --workflow "CI" --status queued \
  --json databaseId --jq '.[].databaseId' \
  | xargs -I{} gh run cancel {} --repo owner/repo
```

## Cache Usage

```bash
gh api /repos/{owner}/{repo}/actions/cache/usage
```

Returns `active_caches_size_in_bytes` and `active_caches_count`.

List individual caches:

```bash
gh api /repos/{owner}/{repo}/actions/caches --jq '.actions_caches | sort_by(-.size_in_bytes) | .[:10] | .[] | "\(.key) \(.size_in_bytes / 1048576 | floor)MB"'
```

## Runner Type Detection

Determine runner OS from job labels:

| Label pattern | Runner OS | Rate |
|---------------|-----------|------|
| `ubuntu-latest`, `ubuntu-*` | Linux (2-core) | $0.006/min |
| `windows-latest`, `windows-*` | Windows (2-core) | $0.010/min |
| `macos-latest`, `macos-*` | macOS (3/4-core) | $0.062/min |
| `macos-*-xlarge` | macOS 12-core (xlarge) | $0.077/min |
| Custom / self-hosted | Assume Linux | $0.006/min |

For larger Linux runners, detect from label: `ubuntu-latest-4-cores` → 4-core ($0.012/min).
