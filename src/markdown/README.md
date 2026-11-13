# tools markdown

Keep markdown notes true to the code. You write a `{{kind …}}` token in a note (lines of a file, a symbol, a
JSON value, a diff, a command's output), and `tools markdown resolve` puts the real excerpt into the file. The
token stays in the file beside its excerpt, so the next run refreshes the excerpt when the code moves.

## Quick start

```bash
tools markdown tokens                             # every kind, and the ones a note may not carry
tools markdown resolve Note.md                    # bare tokens become include blocks; old blocks are refreshed
tools markdown resolve Note.md --new-only         # only the bare tokens; old blocks stay as they are
tools markdown resolve Note.md --dry-run          # proposal and patch in the run folder; the note untouched
tools markdown resolve Note.md --convert-links    # first, a {{lines}} token under every link to source lines
tools markdown resolve a.md b.md --cwd ~/Projects/app   # several notes; relative paths from one folder
```

A token on its own line in `Note.md`:

```
{{lines path="src/a.ts" range="40-60"}}
```

## Commands

### `resolve <files...>`

Resolves every token in each file into an include block, and resolves every existing block again from its
kept token.

| Flag | What it does |
|---|---|
| `--new-only` | Resolve only bare tokens; leave existing include blocks as they are |
| `--convert-links` | First add a `{{lines}}` token under every link to lines of a source file |
| `--context <n>` | Lines an excerpt shows from a single-line link (default 12, a positive whole number) |
| `--cwd <dir>` | Resolve relative token paths from here (default: each file's own folder) |
| `--dry-run` | Write the proposal and its patch beside the backup; leave the files alone |

For each file it prints one line per token, with its line number and one of these actions:

- `added`: a bare token became a block.
- `refreshed`: a block's content changed, so the block was written again.
- `unchanged`: the content is the same, so the block stays byte for byte, capture time included.
- `kept`: an existing block that `--new-only` did not touch.
- `failed`: the token did not resolve (a moved file, a bad range). The reason follows on the line.
- `skipped`: a kind a note may not carry (`image`), or a token that does not parse.

With `--convert-links` it also prints `link→token` for each token it added and `link kept` with the reason
for each link it left alone. At the end it prints the run folder that holds the backups.

### `tokens`

Lists every token kind with its parameters, and says which kinds a note may not carry and why. In the
parameter list, `*` marks a required parameter, `:int`, `:bool`, `:range` or `:url` names a type (a path or a string
has no suffix), and `=value` shows a default.

| Flag | What it does |
|---|---|
| `--json` | An array of `{ name, params, description, supported, why }` on stdout |

The tool also takes `-v, --verbose` (debug lines on the console) and `--readme` (prints this page).

## Writing tokens

A token is `{{kind key="value" …}}`. `tools markdown tokens` prints the live list. Today:

| Kind | Parameters | Shows |
|---|---|---|
| `lines` | `path*`, `range` or `anchor`, `commit` | a line range or an mdBook `ANCHOR` region |
| `file` | `path*`, `commit`, `max=200` | a whole file, cut after `max` lines |
| `symbol` | `path*`, `name*`, `commit` | one function, class, `Class.method`, type or const |
| `json` | `path*`, `pointer`, `commit` | one value by `/a/b/0` or `$.a.b[0]`; empty: the file |
| `diff` | `path`, `base`, `staged=false` | a git diff, by default against the merge base |
| `tail` | `path*`, `n=50` (at most 1000) | the last lines of a log; reads only the final megabyte |
| `cmd` | `run*`, `cwd`, `timeout=10000` | one allowlisted read-only command, no shell |
| `url` | `url*`, `chars=300` | a web page's title and a short excerpt |
| `pr-thread` | `url` or `pr`, `comment`, `max=10` | a PR or MR, or one review thread with its hunk |
| `image` | not in a note | in a note, write `![](path)` instead |

Examples:

```
{{lines path="src/a.ts" range="10-40" commit="HEAD~1"}}
{{symbol path="src/a.ts" name="Store.save"}}
{{json path="package.json" pointer="/scripts/test"}}
{{diff path="src/a.ts" base="HEAD~1"}}
{{cmd run="git log --oneline -5"}}
{{pr-thread pr="owner/repo#42"}}
```

- Relative paths resolve from the note's own folder, or from `--cwd`. A `cmd` token and a `diff` without
  `path` run there too, so a note outside the repository needs `--cwd`, a `cwd` on the `cmd` token, or
  absolute paths.
- `range` takes `10-40`, `10`, `10-` (to the end) or `-40` (from the start). Without `commit`, `lines` and
  `file` read the working tree and record the HEAD sha and a dirty flag.
- `cmd` runs only `git log`, `show`, `status`, `diff`, `blame`, `rev-parse`, `ls-files`, `shortlog`,
  `describe` and `merge-base`, plus `tools ts skeleton`, `tools git base|merged` and
  `tools question list|tokens`, each with a fixed set of flags. Its `timeout` is in milliseconds (default 10000).
  The 10 s token deadline still applies in `resolve`, so a larger value has no effect there.
- `json` reads JSONC too: comments and trailing commas are fine.
- A day log path (`~/.genesis-tools/logs/<date>.log`) still works in `lines`, `file`, `json`, `symbol` and
  `tail` after the daily pass compresses it to `.zst`.
- mdBook's `{{#include path:10:20}}` works too (also `path`, `path:10`, `path::20`, `path:10:`,
  `path:anchor`).
- A bare `{{name}}` with no `key=value` is a prompt variable and stays as written.
- A token inside backticks or a fenced code block stays literal, and `\{{` writes a literal `{{`. That is how
  you write about a token without resolving it.

### What a resolved token looks like

````
<!-- md:include sig=1d09778b24a3 {{lines path="src/a.ts" range="5-15"}} -->
`src/a.ts:5-15`
```ts
export const status = …
```
_↳ captured 2026-10-01 16:09 UTC · src/a.ts@HEAD 3ab8ab0d7 · re-check: `{{lines …}}`_
<!-- /md:include -->
````

- The opening comment keeps the token. That is what lets the next run resolve the block again.
- `sig` is the content hash of the excerpt. A refresh with the same content leaves the block as it was, so a
  re-run never rewrites a file for nothing.
- Obsidian and Genesis hide HTML comments, and the dev-dashboard share page drops them. A reader sees the
  excerpt and its footer only.
- A token inside a sentence gets its own paragraph, and its marker says `inline`, so the sentence comes back
  exactly when the block is collapsed. A one-line result stays inline in its sentence.
- A block inside a fenced example or inline code is text: it is not refreshed.

Never edit inside a block by hand: the next run replaces it. Change the token in the opening comment, or
delete the whole block with both comments.

### `--convert-links`

For each link to lines of a source file, `[a.ts:5](/abs/src/a.ts#L5)` or `#L5-L12` (with or without
`file://`), it adds a `{{lines}}` token under the paragraph, list or table that holds the link. The link stays,
so it still opens the file. A single-line link gets `--context` lines from that line on.

Only absolute paths with a source extension count (`.ts`, `.swift`, `.py`, `.yaml`, `.sql` and about 30
more; not `.md` or `.json`). Links to other extensions are ignored without a line in the output. A link inside a code
block, in inline code or on a line of an include block is ignored. It
skips, with a reason in the output: a link to a whole file, a file that is not on this Mac, a paragraph that a
code block already follows (an excerpt pasted by hand), and an excerpt the note already holds.

## How it works

The resolver is `@genesiscz/utils/markdown/includes` (`resolveIncludes`, `collapseIncludes`,
`codeLinksToTokens`), on top of the shared token engine `@genesiscz/utils/transclude`. `tools question` and
`tools json2md build` use the same engine, so a generated document and a hand-written note behave the same way.

### Backups, patches and the day log

Every file a run changes is copied first. One folder per run, private to your user:

```
/tmp/GenesisTools/transclude/<YYYY-MM-DD_HH-MM-SS>-<pid>/
    Note.md            the file as it was
    Note.md.patch      git diff of before and after
    Note.md.proposed   (dry run only) the result
    manifest.jsonl     one line per file: paths, sha256 before and after, counts, restore command
```

- The command prints the restore line for each written file (not in a dry run): `cp '<backup>' '<file>'`.
- Two notes with the same name in one run get their own slots (`Note.md`, `2-Note.md`).
- The day log `~/.genesis-tools/logs/<date>.log` gets the same record, so the log alone says an hour later what
  changed and how to put it back: `rg "markdown: file rewritten" ~/.genesis-tools/logs/<date>.log`. Only today
  and yesterday stay plain. An older day is `<date>.log.zst`: read it with
  `tools compress cat <plain name> | rg …` or `rg -z`.
- `/tmp` clears on a reboot. Copy the patch somewhere durable when a change must outlive it.

### What a run refuses

- Before it writes, a run checks one invariant: collapsing every block back to its token must give the text it
  started from (with `--convert-links`, plus the token lines it added). Anything else is refused, and nothing
  is written.
- A token that fails stays as written, and a block whose token fails keeps its old content. A run never loses
  text it could not replace.
- A note that an editor saved while its tokens resolved is refused, not overwritten.
- The note is replaced atomically and keeps its own file mode. A symlinked note is replaced at its target, so
  the link stays a link.

### Limits and outside calls

- Tokens resolve one after another. Each one has 10 seconds and at most 8,000 characters; a longer excerpt is
  cut with a visible `[truncated: …]` marker and `cut for size` in its footer.
- `lines`, `file`, `symbol` and `json` read files up to 5 MB (a `.zst` file by its content size). A bigger file
  fails with `<path> is N MB; the limit is 5 MB`. For a big log, use `tail`.
- Secret-shaped values (API keys, tokens, JWTs, private keys, credentials in URLs, cookie headers) are masked in
  the excerpt and its footer. The masking is pattern-based, so a miss is possible.
- `url` fetches the page with no cookies or auth. `pr-thread` uses the `gh` or `glab` login already on the Mac.
  Nothing costs money.
- A plain `resolve` refreshes every block, so a note with `url`, `pr-thread` or `cmd` tokens makes those calls
  on every run. `--new-only` resolves only the new tokens. `--dry-run` still resolves every token.
- The patch needs `git` on the PATH. A `git diff` that takes longer than 15 seconds is stopped.

## For agents

- `tools markdown tokens --json` prints the kind list as JSON on stdout.
- `resolve` exits 1 when a file does not exist, is not a file, or is refused, and when `--context` is not a
  positive whole number. A token that fails does not change the exit code: read the `failed` lines. A bad file does not stop the run: the
  other files are still resolved and written, and exit 1 means at least one file was not written.
- The plugin skill `gt:markdown` has the full rules. For tables, lists and generated reports, use `gt:json2md`.

## Troubleshooting

- **`the result differs outside the include blocks`**: the invariant check failed, so nothing was written,
  with or without `--dry-run`. Check the include comments that were edited by hand. To find the token that
  causes it, remove tokens one at a time in a copy of the note and run again.
- **`the file changed on disk while its tokens were resolved`** or **`the file changed on disk while its replacement
  was written`**: an editor saved the note during the run. Run the command again.
- **A warning that the patch is empty or incomplete, or that the patch or manifest line was not written**: in a
  real run the note was written, and the backup is the way back (the printed restore line uses it). In a
  `--dry-run` nothing was written, and the `.proposed` file holds the result.
- **`failed` with a reason**: a moved file, a bad range, a symbol that is gone, or a timeout. Fix the token in
  the opening comment (or the bare token) and run again. The old excerpt stays until then.
- **`skipped` on an `image` token**: a note may not carry it. Write `![](path)` instead.

## Related

- [json2md](../json2md/README.md): `tools json2md build` resolves the same tokens in generated documents.
- [question](../question/README.md): resolves tokens once in decision log items; it lists every kind in depth.
- [ts](../ts/README.md): `tools ts skeleton`, which a `cmd` token may run.
- [compress](../compress/README.md): `tools compress cat` reads an older, compressed day log.
