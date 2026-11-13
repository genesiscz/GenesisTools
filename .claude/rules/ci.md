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

## Rosters: patterns the architecture build removed (`scripts/ci/rosters/`)

A roster keeps one removed pattern from coming back (a bare `fetch` beside `Api.send`, a `launchctl` call outside the
launchd module, a lock deleted by hand). Each is a `<name>.definition.ts` (an ast-grep matcher, an optional finer test,
the owning module as `allowedIn`, the review candidate it guards), listed once in `rosters/index.ts`.
`bun scripts/ci/rosters/generate.ts` scans the tree and writes `rosters.json`: the files that still hold the pattern and
how many times. lint-rules turns every definition into a rule with those counts, so a new file with a match fails at
once, a listed file fails when its count grows, and a count that fell must be lowered (run the generator). The manifest
only shrinks: the generator never writes growth, `--check` exits 1 on it, and lint-rules refuses a `rosters.json` edited
up against the base. A new definition is seeded by the generator with what the tree holds that day. A real exception is
`// lint-rules-ignore: <why>` on the line, never a manifest edit. A new definition also gets a row in `ROSTER_CASES`
(`rosters.test.ts`): a planted violation, a look-alike and its real owner file; the test fails while a definition has
no row, and proves that lint-rules fails a new file with the pattern by name and leaves the owner alone.

**A roster is any lint baseline that keeps one architecture problem from coming back**: a pattern, its owner, and a
generated list of the places that still hold it, which only shrinks. Two kinds:

- A **pattern roster** (a `.definition.ts`) looks at one file. Matcher helpers in `define.ts`: `callTo(names)` (also an aliased import, `const x = api.name` and
  `const { name: x } = api`, each counted at the binding),
  `literal(/^state-file\.jsonl$/)` (a string's text, in quotes or a template), `importFrom(/^axios$/)` (an import,
  an `export … from` and a dynamic `import("axios")`), `declaration(/^name$/)` (a function, class, `const` or method
  of that name), and the `test` helper `argvFor(node, /cmux/i)` (an argv array passed to a call that names the
  program, or kept first in a variable or an object in a file that runs it, as `const TREE_ARGS = […]`).
- A **tree roster** (`rosters/tree.ts`) needs every file at once, so it is not in lint-rules. It runs in
  `bun scripts/ci/rosters/generate.ts --check --tree` (about 4 s; the pre-push hook and CI's "Tree roster guard"):
  - `roster-shared-export-redeclared`: a function named like a two-word export of `src/utils/**`, also with a copy
    affix (`myFoo`, `fooLocal`, `foo2`, `_foo`), declared outside its owner.
  - `roster-function-body-copied`: a function whose body is the body of a `src/utils/**` export, under any name, with
    its parameters named anything (comments and spacing ignored).
  - `roster-tool-dependency-added`: a tool imports a tool it did not import before, or `src/utils` imports a tool.
    The manifest key is `from → to`, not a file.
  `plugins/` is left out: a plugin file cannot import `src/utils`.
- A **Swift roster** (`rosters/swift.ts`, `SWIFT_ROSTERS`) is a regex per line, because ast-grep has no Swift grammar.
  Comments are always hidden; `strings: true` keeps string text (`maskSwiftNonCode(source, { keepStrings: true })`)
  for a pattern that reads a literal (`"GENESIS_TOOLS_HOME"`, `"--review"`). A line counts once, test targets are left
  out, and lint-rules checks them in `checkSwiftSource` with the counts of `rosters.json`. Ten patterns from the
  architecture plan (C04, C25, C46, C52) and the app's owners (socket clients, `GenesisToolsHome`, `PathOpener`,
  `Clipboard`); each proven by a plant on 2026-11-12. A wanted exception is `// lint-rules-ignore: <why>`
  on the line or the line above. Proven by plants on 2026-11-12: one file with all four violations failed the check
  with its file, line and the owner it copies; the same file with the ignore comments passed.

To find new rosters, run `bun scripts/ci/rosters/propose.ts`. It has four sources (`--source diff|pairs|census|shadowed|all`):

- `diff` (needs `--range <base>...<head>`): the call, import, constructor and argv shapes that the range removed from
  several files and added back in one module at most.
- `pairs` (needs `--range`): shape X was replaced by shape Y in N files of the range, so Y's module is the owner of X.
  It cannot see a pattern that is scoped to one folder.
- `census` (no range): shapes that one module of today's tree already holds almost alone (a package import, a state
  file's name, a program's argv). "Fully owned" comes first: a roster with an empty baseline stops the first leak.
- `shadowed`: the exported helpers that tools still redefine privately (`tools ts refactors --include shadowed`).

`--scaffold '<key>' --name <slug> --candidate C<n>` writes a NEW definition with the matcher and the owner as
`allowedIn` (`literal:<name>` gives `literal(/^name$/)`, `import:<pkg>` gives `importFrom` for the package and its
subpaths, `declare:<name>` gives `declaration(/^name$/)`). It refuses an existing file and writes nothing else. A test
(`propose.test.ts`) writes a scaffold of each kind, imports it and runs its matcher on the shape and its look-alikes. The ranking is a heuristic, so read each candidate before you make it a rule.
