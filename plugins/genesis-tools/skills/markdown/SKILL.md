---
name: gt:markdown
description: Markdown notes that stay true to the code. Use when a note, report or vault page should show real code, a JSON value, a diff or a command's output instead of a hand-pasted copy; when the user says "transclude", "embed the lines", "{{lines …}}", "keep this excerpt current", "turn these file:// links into excerpts", "refresh the excerpts", "resolve the tokens"; and whenever you generate markdown with json2md (`tools json2md build`), because json2md documents resolve the same tokens.
---

# markdown

`tools markdown` works on markdown files. Its first verb, `resolve`, turns `{{kind …}}` tokens into
real excerpts INSIDE the file, wrapped so the next run can refresh them. The core is
`@genesiscz/utils/markdown/includes`; json2md uses the same code, so a generated document and a
hand-written note behave the same way. For tables, lists and the three-file generator pattern, load
`gt:json2md`: this skill covers what goes inside the prose.

## Pick the right door

| You want | Do this |
|---|---|
| Show lines of a file in a note, and keep them current | Write `{{lines path="src/a.ts" range="40-60"}}` on its own line, then `tools markdown resolve Note.md` |
| Refresh every excerpt of a note after the code moved | `tools markdown resolve Note.md` (again) |
| Resolve only the tokens added since the last run | `tools markdown resolve Note.md --new-only` |
| Give an old note excerpts for its `[a.ts:5](file:///…#L5)` links | `tools markdown resolve Note.md --convert-links` (`--context 12` lines from a single-line link) |
| See what a run would do, with nothing touched | add `--dry-run` |
| Excerpts in a generated report | put the token in a `{ raw: … }` or `p` block of the json2md render; `tools json2md build` resolves it |
| Which kinds exist, and which a note may not carry | `tools markdown tokens` |

## What a resolved token looks like

````
<!-- md:include sig=1d09778b24a3 {{lines path="/abs/src/getLoaderStatus.ts" range="5-15"}} -->
`src/getLoaderStatus.ts:5-15`
```ts
export const getLoaderStatus = …
```
_↳ captured 2026-10-01 16:09 UTC · src/getLoaderStatus.ts@HEAD 3ab8ab0d7 · re-check: `{{lines …}}`_
<!-- /md:include -->
````

- The first comment KEEPS the token. That is what makes a second run possible: every run resolves
  the bare tokens AND every block again from its kept token. It is not "only the new tags": an
  excerpt whose code changed is refreshed, which is the reason to use a token instead of a paste.
- `sig` is the content hash of the excerpt. A refresh whose content is the same leaves the block
  byte for byte, capture time included, so a re-run never rewrites a file for nothing.
- Obsidian and Genesis hide HTML comments; the dev-dashboard share page drops comment-only HTML. A
  reader sees the excerpt and its footer only.
- A token inside a sentence gets its own paragraph (blank lines around the block) and the marker says
  `inline`, so collapsing the block gives the sentence back exactly.

🛑 **Never edit inside a block by hand.** The next run replaces it. Change the token in the opening
comment (a new range, another file), or delete the whole block including both comments.

## Token kinds

`tools markdown tokens` prints the live list. Today:

| Kind | In a note | What it shows |
|---|---|---|
| `lines` | yes | `path`, `range="5-20"` or `anchor`, optional `commit` |
| `file` | yes | a whole file, cut after `max` lines |
| `symbol` | yes | one function, class, method, type or const by `name` |
| `json` | yes | one value by JSON Pointer or `$.a.b` path |
| `diff` | yes | a git diff (working tree against the merge base by default) |
| `tail` | yes | the last `n` lines of a log |
| `cmd` | yes | one allowlisted read-only command (git log/show/…, `tools ts skeleton`) |
| `url` | yes | a web page's title and a short excerpt |
| `pr-thread` | yes | a PR or MR, or one review thread with its hunk |
| `image` | **no** | it copies the picture into the decision log's own store; in a note write `![](path)` |

A bare `{{name}}` with no `key=value` is a prompt variable and stays as written. mdBook's
`{{#include path:10:20}}` works too. A token inside backticks or a code fence stays literal, which is
how to write about a token without resolving it.

## Safety: backups, patches, the log

Every file a run changes is copied first. One folder per run:

```
/tmp/GenesisTools/transclude/<YYYY-MM-DD_HH-MM-SS>/
    Analysis.md            the file as it was
    Analysis.md.patch      git diff of before → after
    Analysis.md.proposed   (dry run only) the result
    manifest.jsonl         one line per file: paths, sha256 before/after, counts, restore command
```

The command prints the restore line (`cp '<backup>' '<file>'`). The day log
(`~/.genesis-tools/logs/<date>.log`, `rg "markdown: file rewritten"`) has the same record, so the log
alone proves what changed an hour later. `/tmp` clears on a reboot: copy the patch somewhere durable
when a change must outlive it.

Before it writes, a run checks one invariant: collapsing every block back to its token must give the
text it started from (with `--convert-links`, plus the token lines it added). Anything else is refused
and nothing is written.

A token that fails (a moved file, a bad range) stays as written and is reported; a block whose token
fails keeps its old content. A run never loses text it could not replace.

## `--convert-links` rules

For each `[label](file:///abs/path#L5)` or `#L5-L12` link to a source file, it adds a `{{lines}}`
token under the paragraph (or list, or table) the link sits in. The link stays: it still opens the
file. Skipped, each with its reason in the output: links in code, links to a whole file, a file that
is not on this Mac, a paragraph that a code block already follows (a pasted excerpt), and an excerpt
the note already holds.

## json2md documents

`defineDocument({ …, transclude })`: on by default when the rendered body has a token. The excerpts
are captured at the build's own timestamp, so `tools json2md build` of an unchanged document stays
`unchanged` and `check` stays `clean`. When the code an excerpt shows changes, rebuild the document.
`transclude: false` keeps tokens literal (a document ABOUT tokens).
