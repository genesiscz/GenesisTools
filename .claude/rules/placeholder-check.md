---
paths:
  - "scripts/ci/placeholder-check.sh"
  - "scripts/ci/harvest-placeholder-markers.ts"
  - ".githooks/**"
---

# Personal-data probe

Loaded by Claude Code when you read, write or edit the probe, its harvester or the git hooks.

## Personal-data probe (always, before every `git push`)

This is `scripts/ci/placeholder-check.sh`, not `tools ms-teams repair probe` (that one searches live Teams IndexedDB).

```bash
bash scripts/ci/placeholder-check.sh
```

The pre-push hook runs it first, before biome; a hit is a push blocker. It is sub-second on 800 needles. CI does not run it: the list would have to reach the runner as a secret, and a hit would echo the matched values into a public log.

The needle list is **local only**: `~/.genesis-tools/placeholder-check/markers.txt` (override with `PLACEHOLDER_MARKERS_FILE`). It is not in git. Other clones see "not configured, nothing scanned" and exit 0. Do not copy that file into the repo, tests, commit messages, or CLAUDE.md.

Refresh the Teams-derived block (counts only, no names printed):

```bash
bun scripts/ci/harvest-placeholder-markers.ts
```

Wired 2026-09-01 14:08. Run it BY HAND when Teams gained someone new: it reads the ms-teams cache only, so it is a seeding job, not a per-push step. The pre-push hook ran it between 2026-09-02 22:42 and 2026-09-03 21:50 and no longer does — rewriting the needle file on every push added nothing, and the harvester lives on one branch, so the `set -e` hook aborted on branches without it.
