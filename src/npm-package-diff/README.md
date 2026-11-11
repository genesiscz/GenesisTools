# tools npm-package-diff

Installs two versions of one npm package into a temporary folder and shows what changed between them, file by file.
Use it before an upgrade, or to hand a reviewer a report. It works with npm, yarn, pnpm and bun, and prints a
terminal diff, a side-by-side view, a unified patch, an HTML page or JSON.

## Quick start

```bash
# What changed in the type definitions (the default filter is **/*.d.ts)
tools npm-package-diff @types/react 18.0.0 18.2.0

# The package's own JavaScript, side by side, with a summary box
tools npm-package-diff lodash 4.17.20 4.17.21 \
    --filter "node_modules/lodash/**/*.js" \
    --format side-by-side \
    --stats

# An HTML report with a Line by Line / Side by Side toggle
tools npm-package-diff @types/node 18.0.0 20.0.0 --format html -o report.html

# A unified patch of every file the package itself ships
tools npm-package-diff express 4.17.0 4.18.0 \
    --filter "node_modules/express/**" \
    --format unified \
    -o express.patch

# JSON for a script or an agent
tools npm-package-diff @types/node 18.0.0 20.0.0 --format json > diff.json
```

## Commands

The tool is one command with no subcommands:

```bash
tools npm-package-diff <package> <version1> <version2> [options]
```

All three arguments are required. Without them the tool prints its usage and exits 1. `<package>` may be scoped
(`@types/node`). Each version goes into a temporary `package.json` as the dependency spec, so an exact version, a
range (`^4.17.0`) or a dist-tag (`latest`, `next`) all work.

### What to compare

| Flag                   | Default     | What it does         |
|------------------------|-------------|----------------------|
| `-f, --filter <glob>`  | `**/*.d.ts` | The files to compare |
| `-e, --exclude <glob>` | none        | The files to skip    |

Both globs match the path inside the temporary project, such as `node_modules/lodash/fp.js`. Things to know:

- The default `**/*.d.ts` also matches the type files of every dependency. Put the package in the glob to see only
  its own files: `--filter "node_modules/@types/react/**/*.d.ts"`.
- `**` and `*` do not enter a dot folder (`node_modules/.bin`, `node_modules/.pnpm`). Name the folder in the glob to
  reach it, for example `node_modules/.pnpm/**/*.js`. pnpm's files still show through the `node_modules/<package>`
  link.
- `--filter "**/*"` also lists the temporary project's own `package.json` (its name holds the version) and, under
  bun, its `bun.lock` and the `bunfig.toml` the tool writes (identical, so it shows only in the JSON `files` list
  and the counts). Scope the glob to `node_modules/<package>/**` to leave them out.
- Each flag takes one glob. Use braces for several: `--exclude "**/{test,tests,__tests__}/**"`.
- Every matched file is read as UTF-8 text. Keep binaries (`.node`, `.wasm`, images) out with `--exclude`.

### Output

| Flag                    | Default    | What it does                                          |
|-------------------------|------------|-------------------------------------------------------|
| `-F, --format <name>`   | `terminal` | `terminal`, `side-by-side`, `unified`, `html`, `json` |
| `-o, --output <file>`   | stdout     | Write the chosen format to a file                     |
| `-p, --patch <file>`    | none       | Writes the file like `-o` (`-o` wins), see below      |
| `--context <lines>`     | `10`       | Unchanged lines around each change                    |
| `--line-numbers`        | on         | Line numbers in the terminal view                     |
| `--word-diff`           | off        | Word-level changes in the terminal views              |
| `--stats`               | off        | A box with file counts per status                     |
| `--sizes`               | off        | Old size, new size and difference per changed file    |
| `--use-delta`           | off        | Draw each file with delta                             |
| `--delta-theme <theme>` | none       | Accepted, not passed to delta yet                     |
| `--paging`              | off        | Pipe the output through `less -R -F -X`               |

The formats:

- `terminal`: one block per changed file, with its status (Added, Removed, Renamed, Modified) and the changed lines
  in color. Added and Removed show one size. Renamed and Modified show the size before and after and
  `+additions -deletions`. Identical files are hidden.
- `side-by-side`: the old version on the left, the new one on the right, each column half the terminal width.
  Longer lines are cut.
- `unified` (`patch` is the same): one unified diff of every added, removed, renamed and modified file.
- `html`: a page that draws that unified diff with diff2html 3.4.51: a header with the package, the versions and the
  counts of modified, added and removed files, a file list, and a Line by Line / Side by Side toggle. The page loads
  diff2html from cdn.jsdelivr.net, so it needs the network when you open it.
- `json`: a summary for scripts, described under [For agents](#for-agents).

Rules the flags follow:

- `-o` and `--patch` write the chosen `--format`. With `terminal` or `side-by-side` that file is empty, so pair them
  with `--format unified`, `html` or `json`. With `-o` set, the terminal views print nothing. With `--patch` they
  still print the whole diff to the screen and write the empty file; `--paging`, `--stats` and `--sizes` also still
  act.
- `--stats`, `--sizes` and `--paging` act only in the two terminal views, and not when `-o` is set (`--patch` does not
  stop them). Line numbers show
  only in the `terminal` view. `--paging` does not page delta's output: delta writes straight to the terminal.
- `--line-numbers` is on by default and has no `--no-` form. Turn it off with `"lineNumbers": false` in the config
  file.
- `--word-diff` changes the terminal views and the counts. The `unified` and `html` patches stay line based.

### Install

| Flag                         | Default  | What it does                                  |
|------------------------------|----------|-----------------------------------------------|
| `-m, --package-manager <pm>` | `auto`   | `auto`, `npm`, `yarn`, `pnpm` or `bun`        |
| `--npmrc <path>`             | nearest  | The `.npmrc` to copy into both installs       |
| `--timeout <ms>`             | `120000` | Stop one install after this many milliseconds |
| `-k, --keep`                 | off      | Keep the temporary folder and print its path  |

### General

| Flag                  | What it does                                             |
|-----------------------|----------------------------------------------------------|
| `-c, --config <path>` | Read this config file instead of `./.npmpackagediffrc`   |
| `-s, --silent`        | Hide the spinners and notices. Errors still print        |
| `-v, --verbose`       | Debug lines, and the package manager's own output live   |
| `--help-full`         | The long help (`-?`; quote it in zsh: `'-?'`)            |
| `--readme`            | Print this README                                        |
| `-h, --help`          | The short help                                           |

`-s` and `--silent` differ. Both stop the spinners, but the notices on stdout (such as `Output written to: …`) stop
only for the long form `--silent`. The cleanup spinner writes to stderr either way (one line in a terminal, two when
stderr is captured). The config sample in
`--help-full` lists keys that have no effect (see [Configuration](#configuration)), and its `--patch` example writes
an empty file without `--format unified`.

### More examples

```bash
# A major upgrade of the package's own code, with counts and sizes
tools npm-package-diff express 4.21.0 5.0.0 \
    --filter "node_modules/express/**/*.js" \
    --stats \
    --sizes

# An HTML record of a security-sensitive package
tools npm-package-diff jsonwebtoken 8.5.1 9.0.0 \
    --filter "node_modules/jsonwebtoken/**/*.js" \
    --format html \
    -o jsonwebtoken-audit.html

# A private package, with a chosen package manager and .npmrc
tools npm-package-diff @acme/ui 1.0.0 2.0.0 \
    --package-manager pnpm \
    --npmrc ~/Projects/app/.npmrc

# A big diff in a pager, with the install kept to look at afterwards
tools npm-package-diff typescript 4.9.5 5.0.4 --paging --keep
```

## How it works

1. **Temporary folder.** `$TMPDIR/npm-diff-<package>/`, with each character that is not a letter or a digit turned
   into `-` (`@types/node` becomes `npm-diff--types-node`), and one subfolder per version. A run deletes that folder
   first if it exists, and again at the end unless you pass `--keep`.
2. **Registry config.** The tool copies the nearest `.npmrc` (from the current folder up to `/`), or the one
   `--npmrc` names, into both version folders. Relative `cafile`, `certfile` and `keyfile` values are rewritten
   against the source file's folder, so `./certs/ca.pem` still resolves. The search has no home-folder check: run from a folder
   under your home with no closer `.npmrc`, it copies `~/.npmrc` into both installs. Under bun the tool also writes
   a `bunfig.toml` from the `[install]` table of the nearest `bunfig.toml` or `.bunfig.toml`, with `minimumReleaseAge`
   forced to `0` and `minimumReleaseAgeExcludes`
   removed (since 2026-06-23). A diff often targets a release from today, which the project's supply-chain age gate
   would refuse. Only bun's age gate is lifted. A `--npmrc` path that does not exist prints a warning, and then no
   `.npmrc` is copied at all.
3. **Install.** Both versions install at the same time, each with `--ignore-scripts`, so no install script of the
   package runs on your Mac. npm runs with `--no-package-lock`, pnpm and yarn with `--no-lockfile`.
4. **Package manager.** `auto` looks at the lockfiles in the current folder only. `bun.lock` or `bun.lockb` picks bun
   (the text `bun.lock` counts since 2026-09-07), `pnpm-lock.yaml` picks pnpm, `yarn.lock` picks yarn.
   `package-lock.json` is not checked. Without a lockfile it takes the first of pnpm, bun and yarn on your PATH, and
   npm last. The install spinner names the package manager it picked.
5. **Read.** After both installs finish, the tool reads every file under each version folder. It follows symlinks
   (pnpm links `node_modules/<package>` into its store) and skips a link that points back up the tree. Until
   2026-10-05 a watcher with fixed sleeps recorded the files during the install, missed a fast or cached install and
   printed nothing.
6. **Compare.** A file that both versions have is modified or identical. A file that only one version has is paired
   as a rename when one file of the other version shares the longest path tail with it, at least the file name and
   with no tie. So `apis/x.d.ts` and `dist/apis/x.d.ts` show as one renamed file with its diff. The rest are added
   or removed. When the filter matches nothing in either version, the tool says so and prints both file counts.
7. **Output and cleanup.** The chosen format prints or goes to the file, then the temporary folder goes away.

The tool reaches the npm registry (or the registries your `.npmrc` names) through the package manager, and nothing
else. It costs no money. It needs the chosen package manager on your PATH, `less` for `--paging`, and delta for
`--use-delta` (`brew install git-delta`).

`--keep` leaves the copied `.npmrc`, with any auth tokens in it, in the temporary folder. The tool warns when that
happens. That includes a `~/.npmrc` the search picked up.

## Configuration

The tool reads `.npmpackagediffrc` in the current folder, or the file that `--config` names. The file is JSON;
comments and trailing commas are accepted. A flag on the command line wins over the file, and the file wins over
the built-in default.

Only six keys take effect: `filter`, `format`, `packageManager`, `timeout`, `context` and `lineNumbers`.

```jsonc
{
  // Only the package's own files, not its dependencies
  "filter": "node_modules/my-lib/**/*.{js,d.ts}",
  "format": "side-by-side",
  "packageManager": "pnpm",
  "timeout": 180000,
  "context": 5,
  "lineNumbers": false
}
```

Other keys (`exclude`, `stats`, `sizes`, `npmrc`, `paging`, `useDelta`, `wordDiff`, `keep`, `silent`, `output`,
`patch`, `deltaTheme`) are read but ignored: the file only replaces a flag's built-in default, and these flags have
none. Pass them as flags. A config file that does not parse prints a warning, and the run goes on with the defaults.
A `--config` path that does not exist is skipped without a message.

The tool has no environment variables of its own. The temporary folder follows `TMPDIR`, and the installs run with
your environment. `DEBUG` counts: any value except `0`, `false`, `off` or `no` acts like `-v`, which sends debug
lines and the package manager's output to stdout and drops a failed install's error tail.

## For agents

- `--format json` prints only the JSON on stdout. Spinners, warnings and the "No differences" notice go to stderr.
  Leave out `-v` (its debug lines go to stdout), unset `DEBUG` (or set `DEBUG=0`) and leave out `--keep`
  (it prints the kept path on stdout after the JSON).
  With `-o`, stdout carries one line: `Output written to: <path>`.
- The JSON has this shape (values invented):

```json
{
  "package": "my-lib",
  "version1": "1.4.0",
  "version2": "1.5.0",
  "timestamp": "2026-11-09T10:00:00.000Z",
  "filter": "**/*.d.ts",
  "stats": { "total": 2, "added": 0, "removed": 0, "renamed": 1, "modified": 1, "identical": 0 },
  "files": [
    {
      "file": "node_modules/my-lib/index.d.ts",
      "status": "modified",
      "oldSize": 4120,
      "newSize": 4390,
      "additions": 14,
      "deletions": 6
    },
    {
      "file": "node_modules/my-lib/types.d.ts → node_modules/my-lib/dist/types.d.ts",
      "status": "renamed",
      "oldPath": "node_modules/my-lib/types.d.ts",
      "newPath": "node_modules/my-lib/dist/types.d.ts",
      "oldSize": 900,
      "newSize": 950,
      "additions": 2,
      "deletions": 1
    }
  ]
}
```

- `status` is `added`, `removed`, `renamed`, `modified` or `identical`. Identical files are listed too. The JSON
  holds no patch text: use `--format unified` when you need the lines.
- `additions` and `deletions` count diff parts, not lines. A whole new line can count as two (its text and its
  newline), and with `--word-diff` they count words. For an added or removed file they are line counts. Read them as
  the size of a change.
- `stats.total` of `0` means the filter matched no file in either version.
- Exit codes: `0` when the comparison ran, changed or not. `1` for missing arguments, a failed or timed-out install,
  `--use-delta` without delta, or any other error. Ctrl-C or SIGTERM exits `0` and leaves the temporary folder.
  So decide "changed" from the JSON:

```bash
tools npm-package-diff my-lib 1.4.0 1.5.0 --format json --silent > diff.json
jq -e '.stats.added + .stats.removed + .stats.renamed + .stats.modified > 0' diff.json >/dev/null \
    && echo "my-lib 1.5.0 changed its type definitions"
```

- There is no MCP tool, REPL toolset or plugin skill for this tool.

## Troubleshooting

- **`No files match --filter "**/*.d.ts" in either version`.** The package ships no `.d.ts` files (react keeps its
  types in `@types/react`). Compare `@types/<package>`, or pass `--filter "**/*.js"` (or `"**/*"` for every file).
- **`No differences in the N file(s) matching …`.** The matched files are identical. Widen the filter. `-v` prints
  how many files matched in each version.
- **`install failed with code 1` with a 404, 401, 403 or `ENEEDAUTH`.** A private package. The tool copies the
  nearest `.npmrc` and `bunfig.toml` from your current folder, so run it from inside the project (on the VPN when the
  registry is internal), or pass `--npmrc <path>`. The error ends with the last 1,600 characters of the package
  manager's output. `-v` shows all of it live.
- **`Installation timed out after 120000ms`.** A slow registry or a big package. Raise the limit:
  `--timeout 300000`.
- **`Executable not found in $PATH: "pnpm"`.** The package manager you asked for is not on your PATH. Install it, or
  pick another with `-m`.
- **The terminal view shows the first change of a file, then only gray lines, and later changes are missing.** A
  known defect: `--context` reaches the `terminal` view as text, so the trailing context after the first change runs
  far past the number you asked for and skips the changed lines inside it. Set `"context": 10` as a number in
  `.npmpackagediffrc` and do not pass `--context`, or use `--format side-by-side`, `unified`, `html` or
  `--use-delta`, which are not affected. A replay of the view's loop on 2026-11-09 showed 2 of 4 changed lines with
  `"10"` and all 4 with `10`.
- **The output file is empty.** `-o` or `--patch` with the `terminal` or `side-by-side` format. Add
  `--format unified`, `html` or `json`.
- **Nothing prints at all.** An unknown `--format` name prints one empty line. Use one of the five names.
- **`--stats` or `--sizes` print nothing.** They work only in the two terminal views, without `-o`.
- **`Delta is not installed but --use-delta was specified`, exit 1.** The check runs after both installs and exits
  without the cleanup, so the temporary folder stays. Run `brew install git-delta` (or
  `cargo install git-delta`).
- **A key in `.npmpackagediffrc` does nothing.** Only six keys take effect. See [Configuration](#configuration).
- **Two runs of the same package at once fail.** Both use `$TMPDIR/npm-diff-<package>/`, and each run deletes it
  first. Run them one after the other.
- **A temporary folder is left after Ctrl-C, or after the delta error.** The exit skips the cleanup (and the copied
  `.npmrc`). The next run of the same package removes it.
- **Slow, or out of memory, on a big package.** The tool reads every matched file whole. Narrow `--filter` to the
  files you need.
