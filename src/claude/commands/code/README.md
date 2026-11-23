# Claude Code Unpack / Diff / Bisect

Pinpoint code changes across npm-published `@anthropic-ai/claude-code` releases.

Modern Claude Code (≥ ~2.1.6x) ships as a Bun-compiled native binary per platform — the real JS bundle is embedded inside, not published as `cli.js`. This tool fetches any published version, extracts the embedded bundle, beautifies + AST-normalizes it for diffing, and bisects version ranges to find exactly when a pattern appeared.

Built to answer a real regression: scheduled/cron-fired slash commands stopped being slash-parsed when `skipSlashCommands: true` was added to the cron scheduler's enqueue call in **2.1.196** (last-good = 2.1.195). See [anthropics/claude-code#75837](https://github.com/anthropics/claude-code/issues/75837).

## Subcommands

### `versions`

List published versions with publish dates.

```bash
tools claude code versions
tools claude code versions --from 2.1.185 --to 2.1.197
tools claude code versions --json
tools claude code versions --force   # bypass 1h packument cache
```

| Flag | Description |
|------|-------------|
| `--from <version>` | Range start (inclusive) |
| `--to <version>` | Range end (inclusive) |
| `--json` | Emit JSON array of `{ version, published }` |
| `--force` | Bypass the 1h packument cache |

### `unpack`

Fetch + extract one version's `cli.js` bundle.

```bash
tools claude code unpack 2.1.196
tools claude code unpack 2.1.185 --beautified
tools claude code unpack 2.1.185 --normalized
tools claude code unpack 2.1.185 --platform darwin-arm64 --force
```

| Flag | Description |
|------|-------------|
| `--platform <platform>` | Platform package suffix (default: host, e.g. `darwin-arm64`) |
| `--beautified` | Also produce `beautified.js` and print its path |
| `--normalized` | Also produce `normalized.js` and print its path |
| `--force` | Re-download even if cached |

### `diff`

Chunk-based, identifier-normalized diff between two versions.

```bash
tools claude code diff 2.1.195 2.1.196
tools claude code diff 2.1.195 2.1.196 --pattern cron_fire
tools claude code diff 2.1.195 2.1.196 --pattern cron_fire -o /tmp/cron-diff.txt
tools claude code diff 2.1.195 2.1.196 --mode normalized
```

| Flag | Description |
|------|-------------|
| `--pattern <regex...>` | Only show changed chunks matching ALL patterns |
| `--mode <mode>` | `chunks` (default) \| `normalized` \| `raw` |
| `--context <n>` | Unified diff context lines (default: 3) |
| `--max-chunks <n>` | Cap rendered chunk pairs without `--pattern` (default: 20) |
| `--platform <platform>` | Platform package suffix |
| `-o, --output <file>` | Write diff to file instead of stdout |

**Why chunks mode is default:** consecutive versions differ by ~60% of lines in raw beautified output due to minifier identifier churn. AST normalization collapses that to ~7%, and chunk hashing (split on top-level declarations) is move-invariant — 92% of chunks are byte-identical across consecutive versions.

### `bisect`

Walk published versions in a range; report where a code pattern transition happens.

```bash
# Probe mode (fast — runs on raw minified bundle, no beautify)
tools claude code bisect 2.1.185 2.1.197 \
  --pattern '"cron_fire"' \
  --pattern 'skipSlashCommands'

# Chunks mode (slower — beautify + normalize each version)
tools claude code bisect 2.1.185 2.1.197 \
  --mode chunks \
  --pattern isMeta \
  --pattern cron_fire
```

| Flag | Description |
|------|-------------|
| `--pattern <regex...>` | **Required.** First = anchor; rest must co-occur in its window (probe mode) |
| `--mode <mode>` | `probe` (default) \| `chunks` |
| `--window-before <n>` | Probe window chars before anchor (default: 800) |
| `--window-after <n>` | Probe window chars after anchor (default: 200) |
| `--platform <platform>` | Platform package suffix |
| `--json` | Emit JSON `{ versions, transitions }` |

**Probe vs chunks:** probe mode searches raw minified text with windowed co-occurrence — fast enough to bisect 9 versions in seconds (download + extract only). Chunks mode beautifies and normalizes each version first — use when you need AST-stable chunk hashes rather than raw-text proximity.

## Cache layout

Under `~/.genesis-tools/claude-code/`:

```text
cache/
  packument.json                      # { fetchedAt, packument }  (TTL 1h)
  bundles/<version>-<platform>/
    meta.json                         # BundleMeta
    cli.js                            # raw minified entrypoint (~17MB)
    <other loader-1 modules>.js       # by basename
    beautified.js                     # derived, lazy (esbuild, ~22MB)
    normalized.js                     # derived, lazy (oxc, ~22MB)
```

Tarballs and native binaries are held in memory only — never written to cache.

## Worked example: cron slash-command regression

Find when `skipSlashCommands` appeared next to the cron `onFire` enqueue:

```bash
tools claude code bisect 2.1.185 2.1.197 \
  --pattern '"cron_fire"' \
  --pattern 'skipSlashCommands'
```

Expected output:

```text
2.1.185	2026-06-20	absent
2.1.186	2026-06-22	absent
2.1.187	...	absent
2.1.190	...	absent
2.1.191	...	absent
2.1.193	2026-06-25	absent
2.1.195	2026-06-26	absent
2.1.196	2026-06-29	PRESENT
2.1.197	2026-06-30	PRESENT

Transition: 2.1.195 → 2.1.196 (published 2026-06-26 → 2026-06-29)
Inspect: tools claude code diff 2.1.195 2.1.196 --pattern 'cron_fire' 'skipSlashCommands'
```

Inspect the culprit diff:

```bash
tools claude code diff 2.1.195 2.1.196 --pattern 'cron_fire' 'skipSlashCommands' -o /tmp/cron-diff.txt
```

The `+` side shows `skipSlashCommands: true, modelScheduledOrigin: true` on the cron enqueue call; the `-` side lacks both.

## Packaging notes

- **Native-binary era (≥ ~2.1.6x):** main package is a ~19KB wrapper; real code lives in per-platform optionalDependencies (`@anthropic-ai/claude-code-darwin-arm64` etc.) as a Bun-compiled Mach-O/ELF binary with embedded JS module graph.
- **Legacy era (e.g. 2.1.45):** `package/cli.js` ships directly in the main tarball — the tool handles both shapes automatically.
- **Identifier churn:** naive line diffs of consecutive versions show ~60% changed lines (minifier name shifts). AST normalization + chunk hashing reduces noise to the actual logic changes.

## Patch a local executable

Use the interactive picker to review and update the Claude executable on PATH.
Pass `--binary <file>` to manage a different executable.

```sh
tools claude code patch --backup
tools claude code patch --diff-preview
tools claude code patch --diff-apply
```

The picker finds each patch's module automatically and reports why any patch
is unavailable. Previously applied patches start selected. Deselect one to
revert it. The preview shows exact removed and inserted source spans as quoted
strings, including padding. `--diff-preview` prints the diff and exits.
`--diff-apply` prints the same diff and asks before writing.

The first confirmed update automatically saves a pristine
`<executable>.genesis-original` backup. `--backup` saves it immediately.
Each update rebuilds the selected set from that backup. Deselecting every
patch restores the original executable byte for byte. If an external
update replaces a managed executable, start from an unmodified executable at
a fresh path so the old backup and patch state remain available.

### Inspect or create a separate executable

The patch commands read the native executable found on PATH by default. Pass
`--binary <file>` to inspect a different executable. The default target is the
entrypoint. Use `--module <name>` to target a chunk by its full embedded name,
as listed in the unpacked bundle metadata.

```sh
tools claude code status
tools claude code check --patch version-label
tools claude code patch ./patched-cli.js --patch version-label
tools claude code repack ./claude.patched --patch version-label
tools claude code install ./claude.patched ~/.local/bin/claude-patched
~/.local/bin/claude-patched --version
```

`check` and `status` read the embedded source. `check` exits nonzero if the
selected edits cannot be applied together. `patch` writes the edited source for
inspection. `repack` applies the same definitions directly to the executable,
clears the edited module's cached bytecode, and ad-hoc signs the new file.
`install` verifies the signature and copies the executable to the specified
destination. Output paths must be unused and their parent directories must exist.

Register an opt-in `definePatch({ id, description, find, replace })` in
`src/claude/lib/patches/`. Each edit needs a unique literal match in the target
module and an equal-length UTF-8 replacement. The sample `version-label` patch
changes the text printed by `--version`. Repack supports thin Mach-O executables
on macOS with Bun's 52-byte module records. The npm unpack, diff, and bisect
commands retain their existing version-based workflow.

For a structural match, register `definePatch({ id, description, ast })`.
The `ast(program)` callback receives Oxc's parsed program and returns matching
source spans as `{ start, end, replacement }`. Return a match for the patched
form too so `status` can recognize it. A unique match is required. Shorter
replacements are padded with spaces to preserve the executable layout.

Both forms accept optional `versions`, for example
`versions: [">=2.1.328 <2.2.0", "2.2.3"]`. The executable's entrypoint header
supplies the version without running the binary. At least one range must match
before the source is checked. Omit `versions` to check source alone.
`check` and `status` explain version mismatches, missing or ambiguous matches,
and invalid AST edits.
