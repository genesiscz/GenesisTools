# Stash Tool — Design Spec

**Date:** 2026-06-24
**Status:** Draft (brainstorming locked, awaiting implementation plan)
**Author:** Martin + Claude (brainstormed in session 36161dfd)

---

## 1. Summary

`tools stash` is a global, cross-project code-overlay manager. It captures named, hunk-level chunks of code from any project into a central store, lets you (re-)apply them to the same or any related project as drift-tolerant patches, marks the applied regions with foldable `#region` markers so they stay visible and findable, and supports surgical, fully-reviewable removal with a multi-step state-machine UX (like `git rebase`'s `--continue` / `--abort`).

It's `git stash` × JetBrains Shelf × `quilt`, with first-class support for:
- recurring overlays (apply the same "debug logger setup" across 5 sibling repos)
- versioning (every `save` of an existing name creates `vN+1`)
- drift tolerance (`git apply --3way` against stored blob OIDs)
- multi-region, multi-file stashes
- skill-driven authoring (a `@stash`-aware authoring discipline that the agent enforces)

## 2. Goals

- **G1.** Capture selected regions/hunks of working-tree code into a global, named store.
- **G2.** Re-apply a stash to any project (same repo, sibling clones, or unrelated project) with drift-tolerant merging.
- **G3.** Decorate every applied region with `// #region @stash:<name>` markers so they're foldable, greppable, and removable.
- **G4.** Provide step-by-step, reviewable unapply with full diff visibility — never silently lose user edits.
- **G5.** Auto-detect "same project" across sibling clones (e.g. `col-fe`, `col-fe2`, `col-fe-native-upgrade`) and across different paths with the same `origin`.
- **G6.** Version stashes automatically — `save <name>` on an existing stash creates `vN+1`, never overwrites.
- **G7.** Ship a `skill-creator`-output skill that teaches the agent (and the user) how to author code that is easy to stash, and how to drive `tools stash` end-to-end.

## 3. Non-Goals

- **NG1.** Not a snippet manager (use `gist`, `pet`, or `massCode` for standalone snippet libraries).
- **NG2.** Not a replacement for `git stash` inside one repo (per-repo WIP shelving stays with native `git stash`).
- **NG3.** Not a code-sharing / publishing platform (no remote sync in v1 — store is local to one machine).
- **NG4.** Not a config-overlay tool like `chezmoi` (we patch *source code*, not render templates).
- **NG5.** No semantic refactoring (we operate on textual hunks, not ASTs).

## 4. Use Cases

**UC1 — Personal debug overlay across sibling repos.** Martin has `col-fe`, `col-fe2`, `col-fe-native-upgrade` (three clones of the same monorepo at different branches). He authors a debug-logger setup in `col-fe`, wraps it `// #region @stash:debug-logger`, runs `tools stash save debug-logger`. Later, working in `col-fe-native-upgrade`, runs `tools stash apply debug-logger` — same code drops in, wrapped with apply-time metadata. When done, `tools stash unapply debug-logger` strips it cleanly.

**UC2 — Cross-project transplant.** Martin writes a useful fix in Project X while debugging, decides to also drop it in Project Y as a starting point. `tools stash save fix-xyz` in X, `cd Y && tools stash apply fix-xyz` in Y. The patch may not apply cleanly (different baseline) — 3-way merge handles drift, conflict markers surface where it can't.

**UC3 — Long-lived overlay with iteration.** Martin applies a stash, edits the applied region over a week, runs `tools stash update <name>` to capture the edits as `v2` of the stash. Future applies (and other projects) get the improved version.

**UC4 — Reviewable removal.** After weeks of using an applied overlay with local edits, `tools stash unapply <name>` walks region-by-region: 14 regions unchanged → auto-removed silently; 2 regions edited → prompts to update/discard/skip; 1 region manually deleted by Martin → prompts to update stash (shrink) or skip.

**UC5 — Discovery.** `tools stash list --project` shows only stashes whose recorded source is the same project (by origin URL or sibling-clone detection). `tools stash where debug-logger` shows all projects on this machine that currently have it applied.

## 5. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  CLI: src/stash/index.ts (commander)                            │
│  ├─ commands/{save,apply,unapply,update,list,show,versions,     │
│  │            diff,drop,where}.ts                               │
│  └─ subcommand routing + global flags (-v, --readme)            │
└──────────────┬──────────────────────────────────────────────────┘
               │
       ┌───────┴────────┐
       ▼                ▼
┌─────────────┐  ┌──────────────────────────────────┐
│ lib/store/  │  │ lib/state-machine/               │
│ ─ git bare  │  │  ─ UnapplySession                │
│   repo I/O  │  │  ─ ApplyConflictSession          │
│ ─ patch fmt │  │  ─ persist / resume / abort      │
│ ─ blob fetch│  └──────────────────────────────────┘
└─────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────┐
│ lib/index-db/  ─  sqlite at ~/.genesis-tools/stash/index.db     │
│  (stashes, versions, regions, applications, projects)           │
└─────────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────┐
│ lib/markers/    ─ JSON-in-comment marker parse/emit/strip       │
│ lib/projects/   ─ sibling-clone detection (origin + tree-hash)  │
│ lib/diff/       ─ wraps src/utils/diff for region-level diffs   │
│ lib/regions/    ─ author-marker discovery in working tree       │
└─────────────────────────────────────────────────────────────────┘
```

Storage root: `~/.genesis-tools/stash/`
- `store/` — bare git repo (`git init --bare`); patches stored as refs `refs/stashes/<id>/v<n>`; blob OIDs survive for `git apply --3way`.
- `index.db` — sqlite (see §6.2).
- `state/` — JSON state files for in-progress unapply/apply sessions: `<project-hash>--<verb>--<stash-id>.json`.
- `cache/` — derived lookups (project↔origin↔stashes), regenerable.
- `logs/` — pino day-stamped (via `@app/logger`).

## 6. Data Model

### 6.1 Region marker format

**Opening marker (lean, default):**
```ts
// #region @stash:debug-logger {"id":"3f2a8b","v":2}
```

**Opening marker (verbose, `--verbose-markers` at apply time):**
```ts
// #region @stash:debug-logger {"id":"3f2a8b","v":2,"hunk":1,"src":"col-fe@abc123","applied":"2026-06-24T14:30:00Z"}
```

**Closing marker (always bare — pairs by label):**
```ts
// #endregion @stash:debug-logger
```

**Marker JSON schema (parsed via `SafeJSON.parse`):**
- `id` *(required)* — stash UUID prefix (first 6 hex of full UUID, enough for collision-free lookup; falls back to full UUID if collision detected).
- `v` *(required)* — version number (integer).
- `hunk` *(optional)* — 1-indexed if a stash region is split across multiple non-contiguous hunks in one file.
- `src` *(verbose only)* — `<basename>@<short-sha>` of the project where this was applied from.
- `applied` *(verbose only)* — ISO-8601 UTC.

**Comment syntax adapts per language:** `// #region` (JS/TS/PHP/Java/C/C++/Go/Rust/Swift), `# region` (Python/Ruby/Bash/YAML/TOML), `<!-- #region` … `-->` (HTML/XML/MD), `/* #region */` (CSS).

**Inline single-line form** (for 1-line stashes):
```ts
someCall(); // @stash:debug-logger {"id":"3f2a8b","v":2}
```
On unapply, an inline-marked line is removed wholesale.

### 6.2 SQLite schema

```sql
CREATE TABLE stashes (
  id TEXT PRIMARY KEY,                -- full UUID v7
  name TEXT NOT NULL UNIQUE,
  tags TEXT,                          -- json array
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE versions (
  id TEXT PRIMARY KEY,                -- uuid v7
  stash_id TEXT NOT NULL REFERENCES stashes(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,           -- 1, 2, 3...
  patch_ref TEXT NOT NULL,            -- git ref in store repo
  source_repo_path TEXT,              -- abs path at save time
  source_origin TEXT,                 -- git remote origin URL at save
  source_sha TEXT,                    -- HEAD sha at save
  region_count INTEGER NOT NULL,
  file_count INTEGER NOT NULL,
  metadata_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(stash_id, version)
);

CREATE TABLE regions (
  id TEXT PRIMARY KEY,                -- uuid v7
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  region_name TEXT,                   -- nullable (anonymous hunks have no name)
  file_path TEXT NOT NULL,            -- repo-relative
  hunk_index INTEGER NOT NULL,        -- 1-indexed within file
  start_marker_present BOOLEAN NOT NULL DEFAULT 0,
  line_count INTEGER NOT NULL
);

CREATE TABLE applications (
  id TEXT PRIMARY KEY,                -- uuid v7
  stash_id TEXT NOT NULL REFERENCES stashes(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES versions(id),
  project_path TEXT NOT NULL,         -- abs path at apply time
  project_origin TEXT,                -- git remote origin URL at apply
  project_sha_at_apply TEXT,
  applied_at TEXT NOT NULL,
  state TEXT NOT NULL,                -- 'active' | 'unapplying' | 'unapplied' | 'orphaned'
  unapplied_at TEXT
);

CREATE UNIQUE INDEX idx_applications_active
  ON applications(stash_id, project_path)
  WHERE state = 'active';

CREATE TABLE projects (
  id TEXT PRIMARY KEY,                -- uuid v7
  path TEXT NOT NULL UNIQUE,
  origin TEXT,                        -- normalized git origin URL
  tree_hash TEXT,                     -- HEAD tree sha (cached)
  last_seen TEXT NOT NULL
);

CREATE INDEX idx_versions_stash ON versions(stash_id);
CREATE INDEX idx_applications_project ON applications(project_path);
CREATE INDEX idx_applications_stash ON applications(stash_id);
CREATE INDEX idx_regions_version ON regions(version_id);
```

Migrations follow the existing pattern: `src/stash/lib/stash-migrations.ts` defines `STASH_MIGRATIONS: Migration[]`, applied via `runMigrations()` from `src/utils/database/migrations.ts` on every read-write open.

### 6.3 Patch storage in bare git repo

Each stash version is a git commit in `~/.genesis-tools/stash/store/`, refs:
- `refs/stashes/<stash-uuid>/v<n>` — points to a commit whose tree contains only the changed files (with marker-stripped content).
- `refs/baselines/<stash-uuid>/v<n>` — points to a commit holding the pre-change versions of those same files (so `git apply --3way` can reconstruct the merge base).

To apply: `git fetch <store-repo> refs/baselines/<id>/v<n>:refs/.gtstash-baseline` then `git apply --3way` of `git diff baseline..version` (or directly the format-patch file we stored alongside).

This lets us:
1. Recover the original baseline blobs for `--3way` even when applying to an unrelated project.
2. Store-side garbage-collect old versions via `git gc` if disk grows.
3. Inspect any stash with `git -C ~/.genesis-tools/stash/store show refs/stashes/<id>/v<n>`.

## 7. Command Surface

### 7.1 Lifecycle table

| Command | Purpose | Mutates store | Mutates code | Interactive |
|---|---|---|---|---|
| `save <name> [--region|--staged|--unstaged|--all|--patch] [--tag T...] [--desc TEXT]` | Capture from working tree; create v1 or bump vN+1 | Yes (new version row + git ref) | No | Yes if `--patch` |
| `apply <name>[@vN] [--verbose-markers]` | Inject into cwd project | No (only `applications` row added) | Yes | Yes on conflict |
| `unapply <name>` | Surgical remove with diff review | Yes if user chooses `update` | Yes | Yes (state machine) |
| `update <name>` | Capture current state of applied regions in cwd as new vN+1 | Yes | No | No |
| `list [--project] [--tag T] [--applied]` | List stashes; filters | No | No | No |
| `show <name>[@vN] [--diff|--meta|--regions]` | Inspect stash | No | No | No |
| `versions <name>` | List all versions | No | No | No |
| `diff <name>` | Diff applied regions in cwd vs stored stash | No | No | No |
| `drop <name>[@vN] [--all-versions]` | Delete from store | Yes | No | Yes (confirm) |
| `where <name>` | List all projects on machine that currently have it applied | No | No | No |

### 7.2 Save modes (`tools stash save <name> [mode-flag]`)

- `--region <name>` (repeatable) — Save only specific author-marked regions discovered in the working tree.
- `--staged` — Save what's currently `git diff --cached`.
- `--unstaged` — Save what's currently `git diff` (unstaged tracked changes).
- `--all` — Save staged + unstaged + untracked.
- `--patch` — Interactive hunk picker (`git add -p` style, via clack).
- *(no flag, interactive TTY)* — clack menu offers the above; non-TTY without a flag errors with `suggestCommand()`.

**Name collision handling:** If `name` already exists, `save` automatically creates `vN+1` after a one-line stderr notice (`stash 'debug-logger' exists, creating v3`). No `--force` needed — versioning is the safety net.

**Marker handling on save:**
- If the working tree has `// #region @stash:debug-logger {...}` apply markers (from a previous apply), they are **stripped** from the saved patch — the patch content is "what the code looks like without marker decoration."
- If the working tree has bare `// #region @stash:foo` author markers (no JSON), they are **preserved** in the patch. Saved patches can carry author markers as semantic boundaries.
- The bare label form is the canonical way to author "this is a stashable region" without yet running save.

### 7.3 Apply (`tools stash apply <name>[@vN]`)

Algorithm:
1. **Resolve project context.** `cwd → git rev-parse --show-toplevel` → read `remote.origin.url` → look up `projects` row (insert if new).
2. **Resolve stash version.** Default latest; `@vN` pins.
3. **Compatibility check.** If `applications` row already exists for `(stash, project, state=active)`, error: `already applied; use unapply or update`. If the recorded `source_origin` differs from current project origin AND no sibling-clone match → warn but proceed (cross-project transplant is supported).
4. **Fetch baseline blobs.** `git fetch ~/.genesis-tools/stash/store refs/baselines/<id>/v<n>:refs/.gtstash-baseline`.
5. **Apply patch.** `git apply --3way --whitespace=fix <patch-file>`. On conflict markers: enter `ApplyConflictSession` (similar shape to unapply state machine).
6. **Decorate with markers.** Walk inserted hunks; wrap each with `// #region @stash:<name> {"id":...,"v":...}` opener and `// #endregion @stash:<name>` closer. Use language-appropriate comment syntax based on file extension.
7. **Record application.** Insert `applications` row with `state='active'`, `applied_at=now()`, `project_sha_at_apply=HEAD`.
8. **Cleanup.** `git update-ref -d refs/.gtstash-baseline`.

### 7.4 Unapply (`tools stash unapply <name>`) — state machine

**The center of gravity of the tool.** Multi-step, persistent, fully reviewable.

#### 7.4.1 Region classification

For each region recorded for this stash+project, locate its markers in the working tree and classify:
- **`unchanged`** — content between markers matches stored stash content exactly (modulo whitespace per `--whitespace=fix`).
- **`edited`** — markers present, content differs.
- **`missing`** — markers absent from the code (user manually deleted).
- **`new-extra`** — code contains additional `@stash:<name>` regions not present in any stored version.

#### 7.4.2 Decision menu (3 outcomes per ambiguous region)

| Decision | Store effect | Code effect | When applicable |
|---|---|---|---|
| `update` | New `vN+1` reflects current code (handles `edited`, `missing`, `new-extra` uniformly) | Remove region from code (or no-op if `missing`) | All ambiguous classes |
| `discard` | Unchanged | Remove using stored content (lose local edits) | `edited` only (others have nothing to discard) |
| `skip` | Unchanged | Unchanged; warn divergence | All ambiguous classes |

**`unchanged` regions are auto-removed with no prompt.** Final summary line reports the count: `14 regions unchanged, removed cleanly`.

#### 7.4.3 State machine

```
states:
  not_started → started → awaiting_decision[region_k] → … → staged → complete
                  ↓                ↓                              ↓
               aborted          aborted                       (no abort path
                                                              after staging)
```

Persisted at `~/.genesis-tools/stash/state/<project-hash>--unapply--<stash-id>.json` where `<project-hash>` is the first 12 hex chars of `sha256(abs(project_path))`. Stash-id in the filename is also the 6-char prefix.

```json
{
  "stashId": "3f2a8b...",
  "stashName": "debug-logger",
  "projectPath": "/Users/Martin/Tresors/Projects/col-fe-native-upgrade",
  "projectHash": "ab12cd",
  "startedAt": "2026-06-24T14:30:00Z",
  "regions": [
    {"id": "r1", "file": "src/app.ts", "hunk": 1, "class": "unchanged", "decision": "auto-remove"},
    {"id": "r2", "file": "src/app.ts", "hunk": 2, "class": "edited", "decision": null},
    {"id": "r3", "file": "src/lib/x.ts", "hunk": 1, "class": "missing", "decision": "skip"}
  ],
  "currentIndex": 1,
  "pausedAt": "2026-06-24T14:31:12Z"
}
```

`currentIndex` advances past `unchanged` and already-decided regions; stops on first `null` decision.

#### 7.4.4 Commands

```bash
tools stash unapply <name>                              # start; walks first ambiguous region
tools stash unapply <name> --continue                   # resume from last checkpoint
tools stash unapply <name> --continue --decision=update # decide current region (non-TTY)
tools stash unapply <name> --skip                       # alias for --continue --decision=skip
tools stash unapply <name> --abort                      # discard decisions, restore code, drop state
tools stash unapply <name> --status                     # show progress: "region 5 of 17 — file:src/app.ts hunk 2"

# Dangerous escape hatches (explicit, never default):
tools stash unapply <name> --continue --decision=discard-all-dangerous
tools stash unapply <name> --continue --decision=update-stash-all-dangerous
```

The `-dangerous` suffix is mandatory in the flag name — it's the only way to batch-decide and it's intentionally unergonomic.

#### 7.4.5 TTY vs non-TTY rendering

**TTY:** clack walks region by region. Above each prompt, render the region's full diff via `src/utils/diff` (unified format, colored, NO truncation). Prompt is `select` with the 1-3 applicable choices.

**Non-TTY:** process stops at the first ambiguous region, prints full diff to stderr, then prints `suggestCommand()` with all available decisions as concrete commands:
```
Region 2 of 17 — src/app.ts hunk 2 (class: edited)
[full diff to stderr]
Choose a decision:
  tools stash unapply debug-logger --continue --decision=update
  tools stash unapply debug-logger --continue --decision=discard
  tools stash unapply debug-logger --continue --decision=skip
Or abort:
  tools stash unapply debug-logger --abort
```

**Hard rule (for skill + agent):** never `| head` / `| tail` / narrow-grep unapply output. Full diff is the only proof the right decision was made. The skill makes this explicit; CI guard in `scripts/ci/` could lint for it in agent-authored shell.

### 7.5 Update (`tools stash update <name>`)

For a stash currently `state='active'` in cwd:
1. Find all regions via `applications` → `versions` → `regions`.
2. For each region: locate markers in current code, capture content between them.
3. Strip markers from captured content.
4. Build a patch from `baseline ↔ current-captured-content`.
5. Save as new `vN+1`.
6. Application's `version_id` does NOT change — the application still points to the version that was applied. Use `apply --reapply` (future) to re-baseline.

`update` errors if stash is not currently applied in cwd: `not applied here; use save to create a new stash from working tree`.

### 7.6 List / show / where

- `list` — table: `name | latest-version | tags | applied-here? | created`. With `--project`, filter to stashes whose `source_origin` matches cwd's origin OR cwd is a sibling clone of any application's project.
- `show <name>[@vN]` — header (name, version, tags, source, region count, file count), then either patch (`--diff`), metadata (`--meta`), or region inventory (`--regions`, default).
- `where <name>` — query `applications WHERE stash_name = ? AND state = 'active'`; print one project path per line. Useful for "I'm about to delete this stash — who's still using it?"

### 7.7 Diff / drop / versions

- `diff <name>` — for each applied region in cwd: side-by-side diff of (stored stash content) vs (current code content). Same renderer used inside unapply prompts.
- `drop <name>[@vN] [--all-versions]` — confirm prompt always. `--all-versions` required if multiple versions exist. Errors if any active application exists; `--orphan-active` flag to drop anyway (marks applications as `state='orphaned'`).
- `versions <name>` — `vN | created | regions | files | source | size`.

## 8. Sibling-Clone / Project Detection

A project is identified by, in priority order:
1. **`git config remote.origin.url`** (normalized: strip `.git`, lowercase host, drop user prefix). Two paths with the same origin → same project.
2. **Directory name pattern**: `<base>`, `<base>2`, `<base>-<suffix>` where they share the same `remote.origin.url`. (This handles `col-fe`, `col-fe2`, `col-fe-native-upgrade`.) Detection: walk siblings of cwd's parent, check origin matches.
3. **HEAD tree hash similarity (fallback for clones with no origin)**: Jaccard similarity of top-100 file paths > 0.7 → likely same project. Cached in `projects.tree_hash`.

`tools stash list --project` uses this to filter. `apply` uses it to suppress the cross-project-warning when transplanting between siblings.

## 9. The Skill (skill-creator output)

Skill name: `stash` (lives under `genesis-tools` plugin).

Trigger conditions: user says "stash this", "save this overlay", "apply my <name> stash", "pop my debug stash here", "what stashes do I have applied", or invokes `/stash`. The skill is **agent-facing** — it teaches the agent both the marker discipline AND the CLI workflow.

Skill content covers:
1. **Marker authoring discipline** — `// #region @stash:<name>` syntax, language-comment table, when to use inline form, when to use named regions vs. anonymous hunks.
2. **Save patterns** — when to use `--region` vs `--patch` vs `--all`; how to name stashes (kebab-case, prefixed by purpose: `debug-`, `feat-flag-`, `hotfix-`, `experiment-`).
3. **Apply / unapply workflow** — including the state machine; **explicit rule against `| head` / `| tail`** of diff output.
4. **Versioning intuition** — when to bump via re-`save` vs. `update`; how `apply name@vN` pins.
5. **Cross-project model** — when sibling detection helps; when to pass `--force-foreign` (future) for unrelated projects.
6. **Anti-patterns** — don't stash secrets; don't stash files >1MB (errors); don't stash binary files (errors).

## 10. Error Handling & Edge Cases

| Case | Behavior |
|---|---|
| Stash name collides on save | Auto-bump to vN+1 with stderr notice |
| Apply when stash already active in this project | Error: use `unapply` or `update` |
| Apply with 3-way merge conflict | Enter `ApplyConflictSession` state machine |
| Apply when source origin ≠ cwd origin and not sibling | Warn but proceed |
| Apply when baseline blobs missing from store | Fall back to `git apply --whitespace=fix` (fuzz); warn |
| Unapply when markers have corrupted JSON | Classify as `edited`, present in state machine; offer `--rescue` mode to regenerate from sqlite-tracked region positions |
| Unapply when application row missing but markers present | Reconstruct application row from marker JSON metadata; warn |
| Unapply with active state file already present | Error: `--continue`, `--abort`, or `--status` |
| Drop while applications active | Error unless `--orphan-active` |
| Binary file in save scope | Skip with warning; record in `metadata_json.skipped[]` |
| File > 1MB in save scope | Error; suggest `--force-large` (future, not v1) |
| Store repo corrupted | `tools stash doctor` (v1.1) — runs `git fsck`, rebuilds sqlite index from refs |
| Out-of-band region marker edits (user manually changed JSON) | Treat user edit as truth; warn if stash ID mismatches sqlite |
| Project moved (`projects.path` no longer exists) | On next `list --project`, mark as `last_seen` stale; offer `tools stash rebase-project <old> <new>` (v1.1) |

## 11. Testing Strategy

In-memory sqlite + tmpdir git repos per `*.test.ts`, alongside source. Key tests:

1. **Patch round-trip:** save → apply → unapply (all `update` decisions) → patch equals original.
2. **Drift tolerance:** save in repo A → modify nearby lines in target repo → apply still succeeds via 3-way.
3. **Version bumping:** save same name twice → versions table has 2 rows, refs `v1` and `v2` exist.
4. **State machine resumption:** unapply, decide region 1, `^C`, re-run with `--continue` → resumes at region 2.
5. **State machine abort:** unapply, decide region 1, `--abort` → code restored, state file deleted, application still `active`.
6. **Sibling-clone detection:** create `/tmp/a`, `/tmp/a2`, `/tmp/a-foo` with same origin → `list --project` from any returns stashes from any.
7. **Marker stripping on save:** working tree has apply markers from previous apply → saved patch has no markers.
8. **Marker preservation on save:** working tree has bare author markers → saved patch retains them.
9. **Multi-language markers:** apply to `.ts`, `.py`, `.html`, `.css` files in one stash → each uses its own comment syntax.
10. **Cross-project apply:** save in repo A with origin X → apply in repo B with origin Y → warning printed, application succeeds.
11. **Dangerous batch flags:** `--decision=update-stash-all-dangerous` skips prompts; default `--decision=update` does not.
12. **Inline marker form:** save → apply → unapply with `--decision=discard` removes the single line.

## 12. Logging & Output Discipline

Per project CLAUDE.md (`@app/logger`):
- **`logger`** for diagnostics — every external op (git invocation, sqlite open, store path), every decision-branch in state machine, every classification result.
- **`out`** for user-facing — clack prompts, summaries, diffs.
- **`out.result()`** only for machine-consumable output (e.g. `tools stash list --json`).
- Diffs always to stderr (via `out.log.info` / clack note) so `tools stash diff <name> > foo.diff` captures the diff content cleanly via `out.print()`.
- Day-stamped pino logs at `~/.genesis-tools/logs/` capture full unapply session including all decisions — auditable after the fact.

## 13. Out of Scope (v1)

- Remote sync / publishing (no server, no cloud, no shared stash libraries between machines).
- AST-based region detection or refactoring-aware patching.
- Auto-application on `cd` / direnv-style activation.
- Conflict-merge UI beyond what `git apply --3way` emits as in-file markers.
- A web/TUI dashboard (future: `tools stash ui`).
- Stash composition (one stash that depends on another) — author markers can overlap textually but no formal dependency graph.
- Cross-VCS support (Mercurial, jj) — git-only in v1.
- Encryption at rest — store is plaintext on disk.

## 14. Open Questions / Deferred

1. **Tagging UX** — `--tag debug --tag wip` works, but should there be a `tools stash tags` command to list/rename tags? Defer.
2. **Default stash name suggestion** — if no name given to `save`, infer from branch name + region label? Defer; v1 requires explicit name.
3. **Region grouping syntax** — should `// #region @stash:debug-logger.subsystem-a` create a hierarchy? Defer; v1 treats `.` as literal.
4. **Re-apply after upstream-baseline drift** — if applied baseline diverges far from current code, should there be a `tools stash refresh-baseline <name>`? Defer to v1.1.
5. **Conflict-resolution state machine for apply** — sketched in §7.3 but not fully specced. Likely mirrors unapply state machine; will spec when implementing.

## 15. Inspirations / Prior Art

Synthesized from the research agent's survey:
- **JetBrains Shelf** — hunk-level selectable, named, foldable, cross-project-within-IDE. The closest analog. Limitations: IDE-bound, no CLI, no versioning.
- **`git stash export`** (git 2.51+) — portable stash via fetch/push; we steal the "patches as git commits in a bare repo" idea.
- **`git apply --3way`** — drift-tolerant patch application via stored blob OIDs. Core primitive.
- **`quilt`** — patch series with fuzz tolerance; we steal the "named patches" idea.
- **`#region` foldable comments** — universal editor support; we extend the existing `@dbg` convention to `@stash`.

---

**End of spec.** Implementation plan to follow in `2026-06-24-StashTool-plan.md`.
