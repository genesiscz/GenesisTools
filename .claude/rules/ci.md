---
paths:
  - ".github/**"
  - "scripts/ci/**"
  - ".githooks/**"
  - "scripts/git/install-hooks.ts"
---

# CI scripts, guards and git hooks

Loaded by Claude Code when you read, write or edit a file under `.github/`, `scripts/ci/` or `.githooks/`.

- **A guard is worthless until it is proven to catch.** Plant a real violation, watch the guard exit non-zero and name the file, then remove the plant. Every guard here that was not checked this way enforced nothing: `if rg …` read the exit code 127 of a missing ripgrep (the ubuntu runner has none) as "no matches" and printed OK for weeks.
  - Exit code 0 means matched and 1 means no match. Anything else is a broken scan: abort and name the reason.
  - Use `git grep -P` in anything CI runs, never `rg`. Git is always present and searches tracked files only.
- **Lint the diff, not the tree, and not with `biome --changed`.** Under CI's depth-1 checkout it finds zero files, and biome exits 1 on "No files were processed". `scripts/ci/lint-changed.sh` passes `git diff --name-only --diff-filter=ACMR <base> HEAD` to biome with an `[ -f ]` test per path. The base is `github.event.pull_request.base.sha`, which already is the merge base, so no history fetch is needed.
- **Git runs the `.githooks/` scripts as config hooks** (`hook.genesis-tools-<name>`, through `/bin/sh -c`), set by `scripts/git/install-hooks.ts` from package.json `prepare`, never through `core.hooksPath`. Git executes a hook-folder file directly, macOS checks the first execution of every new file in syspolicyd, and a worktree's hooks are new files: on 2026-10-14 a stuck syspolicyd froze every such first execution at `_dyld_start`, and a rebase hung 41 minutes. A config hook runs only while `core.hooksPath` is unset, so `git -c core.hooksPath=/dev/null …` still turns every hook off. A new hook needs a `#!` line (its interpreter becomes the command) and one `bun install`. Check what runs with `git hook list <event>`.
- **A dashboard that does not render fails CI.** `scripts/ci/dashboard-smoke.ts` boots each Vite dashboard a
  change can reach (all of them when `src/utils/` changes) and fetches `/`; a 5xx or no answer fails it with the
  server's own error from its log. CI's checks job runs it after the TypeScript check, on a runner with an empty home
  (the "no config yet" case). The pre-push hook ran it until 2026-11-05 and no longer does (Martin, decision 21): ten
  agents pushing at once booted eighty Vite servers and exhausted the Mac's file handles. Run it by hand before a push
  that touches a dashboard or `src/utils/`. It exists because `tools clarity ui` answered 500 for a day (2026-10-22)
  while tsc, the tests and its own launch passed; a launch now also reports a 5xx page and exits 1
  (`reportBrokenDashboard`).
- **`lint-rules.ts` and `placeholder-check.sh` scan tracked files only** (`git ls-files`). Run them after the last commit, or after `git add` of every new file. A run before staging proves nothing about a new file.

## The transcript-seam lints

Moved from `.claude/rules/agent-transcripts.md` (2026-11-11), which names them in one line.

- **Four more lints guard the same seam** (2026-10-25). Their lists in `scripts/ci/` were emptied on 2026-10-30, so
  a new offender fails the lint at once:
  - `no-hand-built-claude-home`, `no-hand-built-codex-grok-home` (`native-home-ratchet.ts`): a path into
    `~/.claude`, `~/.codex`, `~/.grok` or their env overrides goes through `nativeHome(kind)`, `nativeHomePath(kind,
    ...segments)`, `claudeJsonPath()`, `nativeSessionRoots(kind)` or `primaryCodexHome()` in
    `src/utils/providers/session-paths.ts`. `CODEX_HOME` is a comma list; `CLAUDE_CONFIG_DIR` moves `.claude.json` too.
  - `no-harness-name-branch` (`harness-ratchet.ts`): `x.harness === "codex"` or a `case "grok":` in a tool is a
    provider member, or an exhaustive table keyed by the harness type (`satisfies Record<HarnessName, …>`), never a
    comparison at the call site. Hook facts per harness are `HARNESS_HOOK_FACTS` in `src/agents/lib/hooks/payload.ts`;
    worker facts are `WorkerCapabilities` in `src/utils/worker/capabilities.ts`.
  - `no-hook-payload-read`: a hook payload field (`transcript_path`, `tool_input`, …) is read in
    `src/agents/lib/hooks/payload.ts` only; add a typed `HookPayload` field there. Claude's statusline input is a
    different shape with its own owner, `StatuslineInput` in `src/utils/agents/hooks/statusline-input.ts`.
  - `no-agent-name-in-command-match`: finding a running agent by its command line goes through
    `classifyCommand`, `isAgentProcess` or `runsAgent` in `src/utils/process/classify.ts`.

## Rosters: patterns the architecture build removed (`scripts/ci/rosters/`)

A roster keeps one removed pattern from coming back (a bare `fetch` beside `Api.send`, a `launchctl` call outside the
launchd module, a lock deleted by hand). Each is a `<name>.definition.ts` (an ast-grep matcher, an optional finer test,
the owning module as `allowedIn`, the review candidate it guards), listed once in `rosters/index.ts`.
`bun scripts/ci/rosters/generate.ts` scans the tree and writes `rosters.json`: the files that still hold the pattern and
how many times. lint-rules turns every definition into a rule with those counts, so a new file with a match fails at
once, a listed file fails when its count grows, and a count that fell must be lowered (run the generator). The manifest
only shrinks: the generator never writes growth, `--check` exits 1 on it, and lint-rules refuses a `rosters.json` edited
up against the base. A new definition is seeded by the generator with what the tree holds that day. A real exception is
`// lint-rules-ignore: <why>` on the line, never a manifest edit.

To find new rosters, run `bun scripts/ci/rosters/propose.ts --range <base>...<head>`. It ranks the call, import,
constructor and argv shapes that the range removed from several files and added back in one module at most, and the
exported helpers that tools still redefine privately (`tools ts refactors --include shadowed`). `--scaffold '<key>'
--name <slug> --candidate C<n>` writes a NEW definition with the matcher and the owner as `allowedIn`. It refuses an
existing file and writes nothing else. The ranking is a heuristic, so read each candidate before you make it a rule.
