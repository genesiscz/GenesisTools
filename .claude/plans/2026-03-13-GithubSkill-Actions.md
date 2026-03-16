# GitHub Skill — Actions Reference & Cost Script

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add GitHub Actions billing/usage analysis capabilities to the `genesis-tools:github` skill — a reference file for the LLM and a bundled TypeScript script for the computational heavy lifting (job timing extraction, cross-repo scanning, cost estimation).

**Architecture:** Reference file `references/actions.md` loaded on demand via keyword triggers in SKILL.md. Bundled `scripts/actions-cost.ts` runs with `bun` and handles all date math, API pagination, and cost calculation — the parts that are too error-prone for inline jq/shell. The skill's SKILL.md gets a small (~15 line) addition: keyword triggers + quick reference table + pointer to the reference.

**Tech Stack:** TypeScript (bun), `gh` CLI (shelling out), `@octokit/rest` (optional — `gh api` is simpler and reuses auth)

---

## Context for Implementer

### Repository Structure
- **Skill directory:** `plugins/genesis-tools/skills/github/`
  - `SKILL.md` (557 lines) — main skill doc, uses Commander-style CLI
  - No `references/` or `scripts/` dirs yet — you're creating both
- **Source directory:** `src/github/` — TypeScript CLI commands (Commander)
  - `commands/` has `issue.ts`, `pr.ts`, `search.ts`, etc.
  - `index.ts` registers all subcommands
- **This script is NOT a new CLI command** — it's a standalone bun script in the skill's `scripts/` directory, invoked directly by the LLM. It does NOT need to be registered in `src/github/index.ts`.

### Key Lessons from the Session That Spawned This Plan
These are real problems encountered when doing actions billing analysis manually:

1. **Shell escapes `!=` in jq** — `gh run view` with `--jq` and `!=` fails because zsh escapes the `!`. Must use positive matching (`select(.x == "a" or .x == "b")`) or pipe to jq separately.
2. **Billing API needs `admin:org` scope** — `gh api /orgs/{org}/settings/billing/actions` returns 404 without it. The script should try it but gracefully fall back to job-level calculation.
3. **Timing API returns 0** — `gh api repos/{owner}/{repo}/actions/runs/{id}/timing` often returns `total_ms: 0`. Unreliable. Don't use it.
4. **Job-level `startedAt`/`completedAt` is the only reliable source** — extract from `gh run view <id> --json jobs`.
5. **GitHub bills per minute, rounded UP per job** — `Math.ceil(durationSeconds / 60)`.
6. **Runner rates vary** — Linux $0.008/min, Windows $0.016/min, macOS $0.08/min, larger runners scale linearly.
7. **Skipped jobs have null timestamps** — filter with `.conclusion == "failure" or .conclusion == "success" or .conclusion == "cancelled"`.
8. **Cross-repo scanning is slow** — one API call per run per repo. Need `--limit` and progress output.

### GitHub Actions Billing Model (for reference)
| Runner OS | $/min | Multiplier |
|-----------|-------|------------|
| Linux | 0.008 | 1x |
| Linux 2-core | 0.008 | 1x |
| Linux 4-core | 0.016 | 2x |
| Linux 8-core | 0.032 | 4x |
| Linux 16-core | 0.064 | 8x |
| Windows | 0.016 | 2x |
| macOS | 0.08 | 10x |
| macOS (xlarge) | 0.12 | 15x |

Free tier: 2,000 min/month (Linux), minutes consumed at multiplied rate for non-Linux.

---

## Task 1: Create `references/actions.md`

**Files:**
- Create: `plugins/genesis-tools/skills/github/references/actions.md`

**Step 1: Write the reference file**

The reference file should contain these sections (in this order):

```markdown
# GitHub Actions — Usage, Billing & CI Analysis

Reference for analyzing GitHub Actions workflow runs, calculating costs,
and managing CI pipelines. Loaded when actions/billing/CI keywords are detected.

## Quick Reference

| Task | Approach |
|------|----------|
| List runs by date | `gh run list --created "YYYY-MM-DD" --limit 200 --json ...` |
| Summarize by workflow/status | pipe to `jq` group_by |
| Calculate billable cost | `bun <skill-path>/scripts/actions-cost.ts --repo owner/repo --date YYYY-MM-DD` |
| Cross-repo cost scan | `bun <skill-path>/scripts/actions-cost.ts --org <org> --date YYYY-MM-DD --cross-repo` |
| Cost per branch/PR | `bun <skill-path>/scripts/actions-cost.ts --repo owner/repo --branch <branch>` |
| Failure waste analysis | included in script output automatically |
| Re-run failed jobs | `gh run rerun <id> --failed` |
| Cancel stale runs | `gh run cancel <id>` |
| Cache usage | `gh api /repos/{owner}/{repo}/actions/cache/usage` |

## Listing Workflow Runs

### By Date
(gh run list with --created, --limit, --json, jq examples)

### By Branch
(gh run list --branch <branch>)

### By Actor
(gh run list --user <username>)

### By Workflow
(gh run list --workflow <name-or-file>)

### By Status
(gh run list --status queued|in_progress|completed)

## Summarizing Runs

### Count by Workflow × Conclusion
(jq group_by recipe)

### Duration Distribution
(jq recipe to bucket durations)

## Cost Calculation (Use the Bundled Script)

Explain that the bundled script handles all the complexity.
Document the script's CLI interface, flags, and output format.
Include the rate table.

### When to Use the Script vs Raw `gh`
- Script: any cost/billing question, cross-repo scan, failure waste
- Raw gh: simple "list runs", "cancel a run", "rerun failed"

### Manual Calculation (Fallback)
Document the step-by-step approach if the script isn't available:
1. Get run IDs
2. For each: gh run view <id> --json jobs
3. Extract startedAt/completedAt per non-skipped job
4. ceil(seconds/60) per job
5. Multiply by rate

### Gotchas
- Shell escapes != in jq (use positive matching)
- Billing API needs admin:org scope
- Timing API unreliable (returns 0)
- Job-level timestamps are the truth

## Cost Per Branch/PR

(--branch flag, attributing cost to feature work)

## Failure Waste Analysis

How to identify wasted spend on failed runs that were superseded by later runs.

## Cross-Repo Scanning

How to scan all repos in an org for billable runs.

## Workflow Efficiency Metrics

- Average duration, success rate, p90 per workflow
- Date range comparison (this week vs last week)

## Re-Running and Cancelling

### Re-run Failed Jobs Only
gh run rerun <id> --failed

### Cancel In-Progress Runs
gh run cancel <id>

### Cancel All Queued Runs for a Workflow
(loop recipe)

## Cache Usage

gh api endpoint for cache size/usage per repo.

## Runner Type Detection

How to determine runner OS from job labels (ubuntu-latest → Linux, windows-latest → Windows, macos-latest → macOS).
```

Target: ~200-250 lines. Concise recipes, not verbose prose.

**Step 2: Verify the file reads well**

Read it back and check:
- All 13 features are covered (A1-A6, B7-B13, B15)
- No feature is missing
- Script CLI interface matches what Task 2 implements

---

## Task 2: Create `scripts/actions-cost.ts`

**Files:**
- Create: `plugins/genesis-tools/skills/github/scripts/actions-cost.ts`

**Step 1: Write the script**

The script should:
- Be executable with `bun <path>/actions-cost.ts [flags]`
- Use `Bun.spawn` to shell out to `gh` CLI (reuses auth, no token management needed)
- Accept these flags:

```
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

**Core logic (pseudocode):**

```typescript
// 1. Determine repos to scan
const repos = flags.crossRepo
  ? await listOrgRepos(flags.org)
  : [flags.repo];

// 2. For each repo, get workflow runs matching filters
for (const repo of repos) {
  const runs = await ghRunList(repo, { created, branch, workflow, limit: 500 });

  // 3. For each run, get job-level timing
  for (const run of runs) {
    const jobs = await ghRunViewJobs(repo, run.databaseId);
    // Filter: only non-skipped jobs with valid timestamps
    // Calculate: duration = completedAt - startedAt
    // Detect runner: from job labels (ubuntu* → Linux, etc.)
    // Billable: Math.ceil(durationSec / 60) * rate
  }
}

// 4. Aggregate and output
// - Per-workflow breakdown (runs, minutes, cost, success rate)
// - Per-conclusion split (success/failure/cancelled)
// - Top N most expensive runs
// - Failure waste (failed runs that had a subsequent run on same branch)
// - Total estimated cost
```

**Key implementation details:**

1. **gh CLI calls:** Use `gh run list --json databaseId,workflowName,conclusion,createdAt,updatedAt,headBranch,event` and `gh run view <id> --json jobs --jq '.jobs[] | select(.conclusion == "failure" or .conclusion == "success" or .conclusion == "cancelled") | ...'` — note: use positive matching, never `!=` in jq.

2. **Concurrency:** Process runs sequentially (one `gh run view` at a time) to avoid rate limiting. Progress output to stderr with `\r` overwrites.

3. **Runner detection:** Parse job labels array. `ubuntu-latest` / `ubuntu-*` → Linux. `windows-*` → Windows. `macos-*` → macOS. Fall back to Linux if unknown.

4. **Rate table:** Hardcoded object, keyed by runner OS. Include scaled runners (2x, 4x, 8x for Linux).

5. **Output format (table):**
```
┌─────────────────────┬───────┬──────────┬──────────┬───────────┬─────────┐
│ Workflow            │ Runs  │ Success  │ Failed   │ Bill. Min │ Est. $  │
├─────────────────────┼───────┼──────────┼──────────┼───────────┼─────────┤
│ Laravel CI          │ 36    │ 0        │ 28       │ 1,223     │ $9.97   │
│ Claude Code         │ 164   │ 0        │ 0        │ 0         │ $0.00   │
├─────────────────────┼───────┼──────────┼──────────┼───────────┼─────────┤
│ TOTAL               │ 200   │ 0        │ 28       │ 1,223     │ $9.97   │
└─────────────────────┴───────┴──────────┴──────────┴───────────┴─────────┘

Top 10 Most Expensive Runs:
  1. Laravel CI #23020200303 (failure) — 67 min, $0.54
  2. ...

Failure Waste: 28 failed runs consumed 1,010 min ($8.08)
  └ 15 full-suite failures (~66 min each) = $7.92
  └ 13 fast failures (~1 min each) = $0.11
```

6. **Output format (json):** Structured JSON with `{ summary, workflows[], topRuns[], failureWaste, dateRange }`.

**Step 2: Test the script locally**

```bash
bun plugins/genesis-tools/skills/github/scripts/actions-cost.ts \
  --repo genesiscz/ReservineBack \
  --date 2026-03-12
```

Expected: output matching the analysis from the conversation that spawned this plan.

**Step 3: Test cross-repo mode**

```bash
bun plugins/genesis-tools/skills/github/scripts/actions-cost.ts \
  --org genesiscz \
  --date 2026-03-12 \
  --cross-repo
```

Expected: shows ReservineBack + GenesisTools CI runs.

**Step 4: Test branch mode**

```bash
bun plugins/genesis-tools/skills/github/scripts/actions-cost.ts \
  --repo genesiscz/ReservineBack \
  --from 2026-03-10 \
  --to 2026-03-12 \
  --branch dev
```

---

## Task 3: Update SKILL.md with Trigger Keywords and Quick Reference

**Files:**
- Modify: `plugins/genesis-tools/skills/github/SKILL.md`

**Step 1: Update the frontmatter description**

Add actions/billing/CI triggers to the description. Insert after the existing description text, before the closing `---`:

```yaml
description: |
  Use whenever the user wants to READ or SEARCH GitHub content: fetching an issue or PR from a URL, getting comments (including after a specific comment anchor like #issuecomment-XXX), viewing PR review threads without making code changes, searching a repository's issues/PRs/code (e.g. "find how library X handles Y", "are there issues about Z"), browsing notifications or activity. Also use for GitHub Actions analysis: workflow run history, CI costs, billing breakdown, billable minutes, failure waste, cross-repo usage scanning, and run management (cancel, rerun). Triggers on any "look up", "show me", "find", "check", "summarize", or "search" intent on GitHub URLs or repositories, AND on "actions", "CI", "billing", "cost", "workflow runs", "billable minutes", "failed runs", or "rerun" intents. Do NOT use when the task is to implement code fixes, address PR feedback, or make commits — use genesis-tools:github-pr for that.
```

**Step 2: Add quick reference rows**

Insert into the Quick Reference table (after the existing rows, before `## URL Parsing`):

```markdown
| List workflow runs          | `gh run list --repo owner/repo --created YYYY-MM-DD --limit 200` |
| CI cost breakdown           | `bun <skill>/scripts/actions-cost.ts --repo owner/repo --date YYYY-MM-DD` |
| Cross-repo cost scan        | `bun <skill>/scripts/actions-cost.ts --org <org> --date YYYY-MM-DD --cross-repo` |
| Cost per branch             | `bun <skill>/scripts/actions-cost.ts --repo owner/repo --branch <branch>` |
| Re-run failed jobs          | `gh run rerun <run-id> --failed` |
| Cancel a run                | `gh run cancel <run-id>` |
| Cache usage                 | `gh api /repos/{owner}/{repo}/actions/cache/usage` |
```

**Step 3: Add reference pointer section**

Insert before `## Interactive Mode` (line 539):

```markdown
## GitHub Actions (CI/Billing)

For workflow run analysis, cost estimation, and CI management, see `references/actions.md`.

Use the bundled script for cost calculations:
\`\`\`bash
bun <skill-dir>/scripts/actions-cost.ts --repo owner/repo --date YYYY-MM-DD
\`\`\`
```

**Step 4: Verify SKILL.md is still valid**

Read back the modified file. Check:
- Frontmatter YAML parses correctly
- Quick reference table alignment
- Section ordering makes sense
- No broken references

---

## Task 4: Verify End-to-End

**Step 1: Verify reference file loads correctly**

The skill system loads references when the SKILL.md body mentions them. Verify the reference path matches:
- SKILL.md says `references/actions.md`
- File exists at `plugins/genesis-tools/skills/github/references/actions.md`

**Step 2: Run the script against real data**

```bash
cd /Users/Martin/Tresors/Projects/GenesisTools
bun plugins/genesis-tools/skills/github/scripts/actions-cost.ts \
  --repo genesiscz/ReservineBack \
  --date 2026-03-12
```

Verify output matches the known result: ~36 Laravel CI runs, ~1,223 billable minutes, ~$9.97 estimated cost.

**Step 3: Test error cases**

```bash
# No flags — should show help
bun plugins/genesis-tools/skills/github/scripts/actions-cost.ts

# Invalid repo
bun plugins/genesis-tools/skills/github/scripts/actions-cost.ts --repo nonexistent/repo --date 2026-03-12

# Future date (no runs)
bun plugins/genesis-tools/skills/github/scripts/actions-cost.ts --repo genesiscz/ReservineBack --date 2099-01-01
```

**Step 4: Commit**

```bash
git add plugins/genesis-tools/skills/github/references/actions.md
git add plugins/genesis-tools/skills/github/scripts/actions-cost.ts
git add plugins/genesis-tools/skills/github/SKILL.md
git commit -m "feat(github): add Actions billing analysis reference and cost script"
```

---

## Feature Coverage Checklist

| # | Feature | Where |
|---|---------|-------|
| A1 | Run listing (date, repo, branch, actor, workflow, status) | `references/actions.md` |
| A2 | Run summary (aggregate counts by workflow × conclusion) | `references/actions.md` + script |
| A3 | Job timing extraction | script core logic |
| A4 | Cost estimation (billable min × runner rates) | script + rate table |
| A5 | Cross-repo scan | script `--cross-repo` flag |
| A6 | Top-N most expensive runs | script `--top` flag |
| B7 | Cost per branch/PR | script `--branch` flag |
| B8 | Failure waste report | script auto-included |
| B9 | Runner type breakdown | script runner detection |
| B10 | Workflow efficiency (avg, success rate, p90) | script summary |
| B11 | Date range comparison | script `--from`/`--to` |
| B12 | Cancel stale runs | `references/actions.md` recipe |
| B13 | Re-run failed | `references/actions.md` recipe |
| B15 | Cache usage | `references/actions.md` recipe |
