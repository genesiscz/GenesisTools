---
name: fable-replace
description: Verified, transactional find/replace for code and docs. Use INSTEAD of sed, perl, python s.replace() or repeated Edit calls whenever you change text in a file: one literal edit, a rename across 50 files, an insert under a line, a new file, a comment sweep. Every op is checked (a needle must match exactly as declared), the batch is all-or-nothing with a backup, and a MISS tells you which line to re-read. Triggers on "replace", "rename everywhere", "sweep", "batch edit", "mass replace", "insert after", "fable replace", and on any edit you were about to do with a shell one-liner.
---

# fable-replace — verified editing, from a heredoc or a script

## The one rule

**Never edit text with `sed`, `perl -pi`, `python -c "s.replace(...)"` or a Bash heredoc that
rewrites a whole file.** They do not verify: a needle that does not match is a silent no-op,
a needle that matches twice edits both, and nothing tells you. Use the CLI below. It is one
call, needs no code, and refuses to write anything unless every op matched exactly as declared.

The Edit tool is fine for ONE edit in ONE file you have just read. From two edits up, the CLI
is fewer calls and the only option that verifies.

## Quick path: the CLI (use this 90% of the time)

```bash
bun "${CLAUDE_PLUGIN_ROOT}/skills/fable-replace/scripts/cli.ts" <<'FRSPEC'
@@ src/foo/widget.ts
<<<
const gate = getLinkGate(link);
===
const gate = getActionDisabledState(link);
>>>
<<< after
import React from "react";
===
import { thing } from "pkg";
>>>
@@ src/foo/new-file.ts
<<< create
export const fresh = 1;
>>>
FRSPEC
```

The harness substitutes `${CLAUDE_PLUGIN_ROOT}` at load time; if you see the placeholder
unsubstituted, build the path from the "Base directory for this skill" line printed when this
skill loaded. Keep the quotes: an install path can contain spaces.

- `@@ path` starts a file section (relative to cwd, or absolute).
- `<<<` … `===` … `>>>` is one op: the exact current text, then the replacement. Bodies are
  raw lines; there is NO escaping, which is why a quoted heredoc is the right carrier. Only a
  line that is exactly `===` or `>>>` is special inside a block.
- ⚠️ Pick a heredoc delimiter that cannot appear in the bodies (`FRSPEC`, not `EOF`): a body
  line equal to the delimiter ends the heredoc early and zsh rejects the whole command.
  A whole-file `create` body is the usual victim: a file that contains a line `EOF` cuts the
  heredoc there and the parser reports `block never closed with >>>` with the last lines it
  read. For big bodies write the spec with the Write tool and pass `--spec <file>`.
- Bodies are literal, line for line. An empty last line in an `after`/`before`/`append` body
  is a real blank line in the file (the usual "insert this block, then a gap"). A multi-line
  anchor for `after` inserts below the anchor's LAST line; `before` inserts above its FIRST.
- Compose big specs programmatically when the replacement text already exists somewhere:
  `{ echo '@@ f.ts'; echo '<<< after'; echo 'anchor'; echo '==='; git show ref:f.ts | sed -n '10,40p'; echo '>>>'; } | bun cli.ts`
  keeps placement and verification in the tool while the text comes from the source of truth.
- Default contract: the needle occurs **exactly once**. Twice is a MISS (ambiguous), zero is a
  MISS (stale). Modifiers on the `<<<` line change it:

| marker | meaning |
|---|---|
| `<<<` | literal replace, exactly once |
| `<<< count=all` / `count=3` | every occurrence / exactly three |
| `<<< optional` | SKIP instead of MISS when absent; use for re-runnable specs |
| `<<< label=free text` | name shown in the report (rest of the line, so put it LAST; a modifier written after it is a spec error, and `label="…"` keeps a word like `regex` as text) |
| `<<< regex flags=gi count=2` | body 1 is a JS regex source, body 2 may use `$1`; `count` pins the match count |
| `<<< fuzzy` | whitespace-insensitive literal |
| `<<< after` (anchor `===` lines) | insert whole lines after the line holding the unique anchor |
| `<<< before` (anchor `===` lines) | same, before it |
| `<<< append` (lines) | append at end of file |
| `<<< delete` (lines) | remove these lines, newline included |
| `<<< block` (from `===` to `===` replacement) | replace the region between two anchors; empty replacement deletes it |
| `<<< create` (content) | create a new file; refuses to overwrite an existing one |

Per-file post-conditions go between `@@` and the first op: `expect: text` (must be present
afterwards), `absent: text` (must be gone). Both repeatable. `# comments` and blank lines are
allowed outside blocks.

`block` is the only op with THREE bodies: the from-anchor, the to-anchor, then what replaces
the whole region. Leave the third body empty to delete it.

```
@@ src/foo/widget.ts
<<< block label=drop the legacy branch
// ── Legacy parity ──
===
// ── end legacy ──
===
>>>
```

The region includes both anchors. ⚠️ An EMPTY third body is one empty line, not nothing, so
the five lines above collapse to a single blank line rather than vanishing. That is usually
what you want between two declarations; when it is not, put the following line in the third
body instead, or use `delete`. `block` is no more markdown-aware than `append` is, so read
the `--dry --diff` output before the real run.

Flags: `--dry` (preview diffs, write nothing), `--diff` (show diffs on a real run too),
`--verify "bun run test src/x.test.ts"` (runs after writing, captured and trimmed: a pass shows
its last 5 lines, a fail shows the first 40 and last 60 and saves the whole output as
`verify-output.txt` in the backup dir; a red check NEVER rolls the sweep back, see exit 3 below;
a `|`, a `;` chain or a background `&` outside quotes is refused before anything is written;
⚠️ in a scratch tree `bunx tsgo --noEmit` reports `Cannot find module 'bun:test'` on perfectly
correct code, because the copy has no bun-types or tsconfig: scope tsgo to the non-test files,
or verify with a `bun -e 'import("./x.ts")'` smoke import instead),
`--cwd <dir>`, `--partial`, `--quiet`, `--spec <file>` (the spec from a file instead of stdin:
use it whenever a heredoc is refused by a sandbox hook or gets long), `--rollback <backupDir>
[--force]` (undo the sweep whose backup dir a run printed), `--api [query]`, `--help`.

Exit 0: everything landed, or the dry run is clean. Exit 1: at least one MISS (**nothing was
written**, also on `--dry`; a `--partial` run with misses is 1 too). Exit 2: malformed spec,
unknown flag, missing file, `--dry` together with `--verify`. **Exit 3: the sweep IS written**,
and something after the write is unhappy: the verify failed (or could not be measured: a
timeout, a signal), or `leftoversCheck` found stale prose. An unknown or misspelled flag is an
error, so `--dyr` can never turn a preview into a real write.

After `SWEEP WRITTEN, VERIFY FAILED`: the files hold the sweep, so do NOT re-send the spec (it
would MISS: the needles are gone). Read the head and tail it printed, send a SMALL follow-up
spec for the fix, and run the check again. To undo everything instead, run the exact
`--rollback <dir>` line it printed.

Rules that the spec format does not say out loud:

- **`before` and `after` keep the anchor line.** Never repeat it inside the body; the report
  flags a body that starts or ends with the anchor line, because it would appear twice.
- **A body line that must be exactly `===` or `>>>` is written `\===` or `\>>>`.** A bare
  `>>>` closes the block early; a bare `===` starts an extra body (the error names its line).
  For content full of such lines, use the JSON form: a top-level array of FileEdit objects.
- **Ops apply in order, each sees the previous op's output.** Converting call sites AND the
  declaration in one spec: put the declaration edit last, or write a regex that cannot match
  the already converted line, or the syntax check will stop you with a parse error.
- **Regex replacements follow JavaScript rules:** `$1` is a group, `$&` the whole match, `$$`
  a literal dollar. A literal `$` in the replacement body must be `$$`.
- **`fuzzy` forgives whitespace on the FIND side only.** The replacement lands exactly as
  typed, indentation and line endings included.
- **Build spec text with `printf '%s\n'`, never `echo`,** when a shell loop writes it: zsh's
  `echo` turns `\b` into a backspace byte, and the parser now refuses control characters
  with that hint instead of reporting "regex matched nothing" 62 times.
- **`append` is not markdown-aware:** it adds no separating blank line. End the previous
  content with a blank line in the body when the file needs one.

### Reading a MISS

Every MISS says why, and where to look. The hints, in order of what the runner tries:

- *the REPLACEMENT is already in the file* — the edit was applied before. Re-running is not an
  error in itself; add `optional` if the spec must be re-runnable.
- *matches when ALL whitespace is ignored (first at line N)* — indentation, tabs or a line
  break differ. Re-read line N and paste the exact text, or use `fuzzy`.
  ⚠️ A literal needle is a SUBSTRING match, so this fires only when your needle carries MORE
  whitespace than the file. A needle with LESS leading indentation than the file line still
  matches silently, and the file's own indentation survives, because only the matched span is
  replaced. So "it matched" does not prove you copied the line exactly.
- *matches when case AND whitespace are ignored (line N)* — a letter-case typo in the needle.
- *matches after Unicode normalization (line N)* — the file and the needle spell an accented
  word with different code points (NFC vs NFD). Copy the text from the file, or use `fuzzy`.
- *anchor occurs N× but never at the start of a line* — an indented `after`/`before` anchor
  carries its indentation on purpose; copy the leading whitespace exactly.
  An anchor that does NOT start with whitespace is matched anywhere in the line, mid-line
  included; it must still be unique, and the insert lands on its own line above or below.
- *"from" anchor occurs N× (lines …)* — a `block` needs a unique start; add context.
- *first line found at line N, text diverges at line M: file has "…", needle has "…"* — your
  copy of the file is stale from line M on.
- *expected exactly 1 occurrence(s), found 3 at line(s) 12, 40, 77* — add surrounding
  context, or say `count=3` when all three are meant.
- *no line of the file contains the needle's first line* — wrong file, or the text is gone.

A MISS is not a failure of the tool. It is the tool telling you your model of the file is
wrong, before anything was written. Re-read, fix the op, re-run.

A MISS in a big multi-file spec re-sends the whole spec, because nothing was written. When the
files are independent, `--partial` writes the clean files and the follow-up spec carries only
the missed file's ops; the run still exits 1, so the miss is not lost.

## When you need a script instead

Use the TypeScript API when the CLI cannot express it: recon (find the files first, count the
occurrences), a rename across many files with a pinned count per file, comment sweeps, a
replacer FUNCTION, file delete/rename in the same transaction.

```bash
bun "${CLAUDE_PLUGIN_ROOT}/skills/fable-replace/scripts/cli.ts" --api     # every function + params + docs
```

Every function with more than two inputs takes ONE object, so `--api` shows every field and
its doc next to the signature (`--api rename` narrows it). Contract of the script API:

- **`run()` throws a `FableReplaceError`** (its `code` is the exit code: 1 misses or a
  partial write; 2 pre-flight; 3 written but the verify failed or stale prose survived, with
  the captured verdict in `err.report.verify`) instead of exiting your process. Catch it if
  you want to continue; an uncaught one still ends the script non-zero. `throwOnFailure: false`
  restores the exit behaviour.
- **A red `verifyCommand` keeps the files written**, exactly like the CLI. A script with no
  model in the loop that wants the old atomic behaviour writes it in three lines:
  `catch (err) { rollback({ backupDir }); throw err; }`. `rollback` is exported.
- **Unknown option keys are a pre-flight error** with a "did you mean" hint: `dry: true` is
  not `dryRun: true`, and used to be a silent real write.
- **`partial: true` still fails when anything missed:** the clean files are written, then the
  error is thrown. `report.ok` is false.
- **The thrown error carries the report:** `err.report` is the same `RunReport` a green run
  returns, so a catch reads `err.report.written` / `.missCount` / `.files` instead of parsing
  the message. A pre-flight refusal (code 2) happens before any file is planned, so there
  `err.report` is undefined.
- **`findFiles` needs `containing`:** it is the content filter, not an option. Omitting it
  throws rather than returning `[]`, which used to read as "no file holds the symbol".
- **`renameSymbolAcross` refuses a file that both imports and declares the symbol** (a local
  wrapper) unless `includeShadowed: true`; `countMatches` prints the same split, and
  `shadowedFiles({ files, name })` returns it.
- **`findFiles` roots may be plain files** (`README.md`, `CLAUDE.md`) as well as directories.
- **`insertAfter` is same-line and verbatim** (add your own space or newline);
  `insertLinesAfter` inserts whole lines under the anchor's line.

The shapes you will use most:

```ts
import { countMatches, findFiles, leftovers, renameSymbolAcross, run, scratchDir } from "${CLAUDE_PLUGIN_ROOT}/skills/fable-replace/scripts/replace-utils";

const files = findFiles({ roots: ["src"], containing: /\boldName\b/ });
const counts = countMatches({ files, pattern: "oldName" }); // per-file numbers, zero-match and shadowing warnings

await run({
  edits: [
    { file: "src/a.ts", ops: [{ find: "old", replace: "new" }], absentAfter: ["old"] },
    ...renameSymbolAcross({ files: counts, oldName: "oldName", newName: "newName" }), // counts pinned per file
  ],
  backupDir: scratchDir("rename-oldName"),
  verifyCommand: "bunx tsgo --noEmit",
  leftoversCheck: { names: ["oldName"], dirs: ["."] },
});
```

`scripts/example.ts` is a fuller template. `--dry` on argv previews. The modules, if you need
to read one: `types.ts` (every shape), `edit-one-file.ts` (ops), `comments.ts` (comment and
line sweeps), `rename-symbols.ts`, `recon.ts`, `sweep-many-files.ts` (the runner),
`backup-and-rollback.ts`, `spec.ts` (the CLI format). `replace-utils.ts` re-exports all.

## Recon before a sweep

Ops are literal. Copy the text verbatim from the file, indentation included; a MISS means your
mental model of the file is stale, which is the point. Traps that each cost a wasted round:

- **Match the thing, not the statement shape.** Hunting import specifiers with a pattern
  anchored on `import … from` misses multi-line imports, `export … from` barrels, dynamic
  `import("…")` and type-only positions. Match the quoted specifier itself.
- **One grep shape is never the whole picture.** The same module is imported as
  `"@pkg/format"`, `"@pkg/format.ts"` and `"./format"` in one repo.
- 🛑 **Never pipe recon through `head`/`tail` on its way to a file.** `head` exits early,
  SIGPIPE kills `tee` and `rg`, and the file is truncated. A trial captured 109 of 411 matches
  this way. Redirect to the file first, then read it.
- 🛑 **`--type tsx` is not a ripgrep type.** `rg -l foo --type ts --type tsx` matches nothing
  and exits 0. Use `-g '*.ts' -g '*.tsx'`. Treat any surprisingly empty recon as broken
  instrumentation, not an answer.
- 🛑 **Never count with `rg --heading … | wc -l`.** Heading mode adds a filename line and a
  blank per file. Use `countMatches`, or `rg -o … | wc -l`.
- **`countMatches` prints the `expect:` numbers** and warns about zero-match files (a
  guaranteed MISS) and files that DECLARE a symbol of the same name (renaming those changes an
  unrelated helper). Do not transcribe counts by hand.

## 🛑 Every op OK does not mean the sweep is complete

The report only proves the ops you DECLARED matched. It cannot know about a call site your
recon never found. A 50-file rename once reported zero MISS and was still broken. So:

- **Put the project's own check in `--verify` / `verifyCommand`** on every real sweep. A red
  check keeps the sweep written, exits 3 and prints the undo command; fix forward with a small
  follow-up spec. Write the BARE command: a `|`, a `;` chain or a background `&` outside quotes
  is refused in pre-flight (exit 2, nothing written), because both `/bin/sh` and `pipefail` lie
  about a pipeline's exit code, and the CLI trims the output itself. `&&`, `||` and redirects
  are fine; `2>/dev/null` only warns. The escape hatch names the risk in the command:
  `--verify "bash -c 'set -o pipefail; bun run test | tail -3'"`. A pipe inside `$( )` is
  refused too: the check is a quote scanner, not a shell parser. The same rule applies to a
  check you run AFTER the CLI: never `cli.ts … ; bun run test | tail -3` in one Bash call,
  because the `;` and the pipe hide the test's exit code from you as well.
- **A green check does not mean the sweep was RIGHT.** A blanket rename across 71 files
  typechecked while renaming three unrelated local helpers that shared the name. Read the diff
  (`--dry` first, `--diff` on the real run).
- **`expectAfter` / `expect:` and `absentAfter` / `absent:` are plain substring checks**, not
  word-boundary matches. They cannot see structure; a dropped brace passes them. That is what
  the built-in syntax check is for: every edited `.ts/.tsx/.js/.jsx` is parsed after the ops,
  and a file that stopped parsing fails the batch with the line number.
- **A rename is not finished when the code is green.** Sweep README, CLAUDE.md, docs and plans
  that name the symbol. `leftoversCheck` (script) fails the run when the old name survives in
  prose while leaving the verified code written; `leftovers({ names, dirs })` is the manual form.

## Renames: the two forks

- **Renaming a PUBLIC API:** the `export { old }` barrel line is in scope, rename it and its
  consumers, the old name should disappear.
- **Renaming an INTERNAL helper that a barrel still publishes as `old`:** alias on the way in
  (`import { newName as old }`), keep `export { old }` exactly, leave the barrel's consumers
  untouched. A blanket regex rename silently breaks this contract.

The two look identical in a grep and want opposite edits. Grep for `export {` before any
blanket rename, and say in the sweep which fork you chose. If the brief does not say, ask.

Several symbols in overlapping file sets: build one file list per symbol from `countMatches`
(a listed file that lacks the symbol is a MISS), and wrap the batch in `mergeFileEdits` so a
shared file is not "listed twice". `sameOpsAcross` carries ONE op list and therefore ONE
`expect`; the moment per-file counts differ, build the edits from the counts map instead.

## Guards that fire before anything is written

- `node_modules` paths are refused (`allowNodeModules` overrides).
- Generated files are refused: `*.gen.ts`, `dist/`, `build/`, or a header comment saying
  `@generated` / `DO NOT EDIT` (only a real comment counts; a module that EMITS such text is
  not itself generated). Fix the generator. `allowGenerated: true` per file overrides.
- Syntax check on every edited script, with the line that broke.
- `renameTo` refuses an existing target, a target claimed twice, or a target also edited.
- A reused `backupDir` is refused (the CLI always makes a fresh one).
- Two sweeps racing into ONE `backupDir` are refused: the manifest is created exclusively, so
  the loser aborts before writing instead of overwriting the winner's manifest and silently
  losing its own undo.
- A file that is not valid UTF-8 is refused. The whole file is read as text and written back,
  so one stray cp1252 byte would silently become U+FFFD far from your edit.
- A file that changed on disk between the read and the write is refused and the batch rolls
  back: the ops were computed against a snapshot, and writing anyway erases whoever wrote in
  between while still reporting OK.
- A file listed twice in one batch is refused; merge the ops.

## Rollback

`backupDir` (the CLI prints it) holds the originals plus a manifest with a hash of what was
written. Undo from the shell:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/skills/fable-replace/scripts/cli.ts" --rollback /var/folders/…/fable-replace-cli-1234-AbCdEf
```

or `rollback({ backupDir })` in a script. Both restore byte-for-byte and SKIP any file that
changed after the sweep wrote it, reporting it as drifted; `--force` / `force: true` restores
those too. A file that is already back at its original content is reported as such, not as
drift. Stacked sweeps unwind newest-first or refuse. `backupOverwrite: true` is a one-way
door: the original content in the old snapshot becomes unrecoverable. 🛑 Never
`git checkout --` as the undo; it destroys uncommitted work.

A restore that the filesystem itself blocks (a file some later command chmod'd read-only, a
full disk) never stops the others: each entry is restored inside its own guard, the survivors
come back, and the blocked ones land in `report.failed` plus the thrown error's message. Those
files still hold the SWEPT content, so fix the cause and re-run the rollback; the backup is
intact.

## Recipe: positional arguments to one object

```
<<< regex count=6 label=call sites first, declaration last
(?<!function )describeMail\(\s*([^,]+?)\s*,\s*([^,]+?)\s*,\s*([^)]+?)\s*\)
===
describeMail({ subject: $1, sender: $2, mailbox: $3 })
>>>
<<<
function describeMail(subject: string, sender: string, mailbox: string): string {
===
function describeMail({ subject, sender, mailbox }: { subject: string; sender: string; mailbox: string }): string {
>>>
```

`\s*,\s*` survives a call that wraps its arguments over several lines; a literal `, ` does
not. `count=6` was measured first (`countMatches`, or a deliberately wrong count whose MISS
reports the real number and the lines).

🛑 **The lookbehind is not optional.** A three-parameter DECLARATION has the same comma and
paren shape as a three-argument CALL, so the call-site regex matches the declaration too and
the count comes out one too high. Reordering the ops does not help: the already-destructured
declaration still matches the same naive pattern. If your count is exactly one above what
`countMatches` reported, this is why. Keep `(?<!function )`, and add the declaration's own
prefix (`(?<!const )`, a method name) when it is not a plain `function`. Never "fix" the
mismatch by raising `count`: that rewrites the declaration with the call-site template and
produces garbage.

## Comment sweeps (script only)

`dropComments` (`containing` or `matching`): the COMMENT goes, code on the same line stays;
string, template and regex aware, and it knows the JSX tag shapes `</Foo>` and `<Foo />`. It
does not model JSX TEXT: a comment-shaped run inside rendered text (`<p>/* note */</p>`, a
URL in a paragraph) counts as a comment, so on .tsx files keep the predicate narrow and read
`--dry --diff`. `deleteLines`: the WHOLE line goes. For
`}, [onConfirm]); // eslint-disable-line` the first keeps the statement, the second deletes it.
Both refuse to run without a predicate.

## Housekeeping

- 🛑 `/tmp` is shared machine-wide. Two agents sweeping in parallel overwrote each other's
  log at `/tmp/sweep-dry.log`. The CLI uses `scratchDir()`; scripts must too. Every scratch
  and backup dir lives under `<tmp>/fable-replace/`, and every CLI run prunes that root:
  age-only (older than 12 h), manifest-gated (only a dir this tool created and finished, or
  an empty one), at most 50 per run, never the current run's dir. `--prune` runs it now. A
  reboot empties the temp folder anyway; the prune matters on machines that stay up for weeks.
- One spec or script per logical sweep, so the report maps to one reviewable change.
- Every real CLI run, rollback and prune is journaled to `~/.genesis-tools/fable-replace/journal.jsonl`
  (a `--dry` run writes nothing at all, not even the journal, and never prunes)
  (`GENESIS_TOOLS_HOME` or `FABLE_REPLACE_HOME` move it). The spec text is never stored there,
  only its size and hash; the text goes to `<backupDir>/spec.frspec`. `--history [N]` lists the
  last runs with outcome, tokens and backup dir; `--stats [days]` sums outcomes, tokens written
  and read back, the tokens wasted on failed runs (no dollar figure: multiply by your model's
  output rate), and the top MISS reasons.
- Literal ops match RAW BYTES: a find that spans a string-concatenation boundary in the source
  can never match. Split it per line.
- `bun scripts/selftest.ts` after touching anything under `scripts/`; it must end with
  `ALL SELFTESTS PASSED`. It pins every op kind, the spec parser, the CLI end to end, the
  transaction, every guard and the rollback contract.
