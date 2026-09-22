# json2md

> **Render JSON as Markdown: tables, lists, sections, callouts, details and mermaid.**

`src/json2md/` is a thin CLI. Everything that renders lives in `@genesiscz/utils/json2md`
(`src/utils/json2md/`), so a downstream repo and any other consumer wrap the same core without going
through a CLI.

---

## Quick start

```bash
# Shape chosen from the data
tools json2md data.json

# Pick a sub-tree first
tools json2md data.json --select "items[?status=='open']"
tools json2md data.json --select '$.items[*].name'

# A finished document
tools json2md data.json --title "Report" --toc --frontmatter yaml --meta project=genesis

# Pipes and destinations
cat data.json | tools json2md - -o report.md
tools json2md data.json --clipboard
```

---

## Commands

| Command | What it does |
|---|---|
| `tools json2md [input]` | Render a JSON file, `-`, or piped input |
| `tools json2md init <name>` | Scaffold the three-file pattern: `.json`, `.ts`, `.md` |
| `tools json2md build <files...>` | Regenerate the `.md` for one or more document modules |
| `tools json2md check <files...>` | Report clean / stale / hand-edited, and exit non-zero when action is needed |

---

## Render options

| Option | Description | Default |
|---|---|---|
| `--from [format]` | `auto`, `json`, `jsonl`, `toml` | `auto` |
| `--repair` | Run `jsonrepair` over invalid JSON before parsing | off |
| `--mode [mode]` | `auto` detects the shape; `blocks` treats the input as a block document | `auto` |
| `--engine [engine]` | `string`, or `mdast` (not built in this release) | `string` |
| `-s, --select <expr>` | Sub-tree selection. JMESPath, or JSONPath when it starts with `$` | — |
| `--dialect [dialect]` | Force `jmespath` or `jsonpath` | auto-detected |
| `-t, --title <text>` | An H1 above the document | — |
| `--frontmatter [format]` | `yaml`, `json`, `toml` | `yaml` |
| `--meta <key=value...>` | Front-matter entries, repeatable | — |
| `--toc` | Insert a table of contents | off |
| `--provenance-scope <text>` | One sentence naming what the document covers | — |
| `--provenance-commit <sha>` | Commit the data was read at | — |
| `--stamp` | Append a stamp so a later hand edit can be detected | off |
| `--heading-level <n>` | Heading level for the outermost sections | `2` |
| `--collapse-depth <n>` | Wrap branches deeper than this in `<details>`; `0` disables | `3` |
| `--max-heading-depth <n>` | Deepest level that still gets a heading | `4` |
| `--key-case [style]` | One of 13 casings for keys used as headings and headers | `preserve` |
| `--title-key <key>` | Key whose value titles each section of an array of objects | — |
| `--mermaid` | Render tree-shaped arrays as a mermaid graph | off |
| `--columns <list>` | `key`, `key:Header`, or `key:Header:right`, comma separated | inferred |
| `--max-width <n>` | Width budget per table column | — |
| `--overflow [strategy]` | `wrap`, `truncateStart`, `truncateEnd` | `truncateEnd` |
| `--array-separator <text>` | Join array cells with this | `", "` |
| `--empty-text <text>` | What an empty table renders as | `_No rows._` |
| `--bullet <char>` | `-`, `*` or `+` | `-` |
| `--no-align` | Do not pad table cells to the column width | off |
| `-o, --output <file>` | Write the markdown to a file | stdout |
| `-c, --clipboard` | Copy the markdown to the clipboard | off |
| `--ask` | Ask where to put the output | off |

A flag with a closed value set is declared `--flag [value]`. Omitting the value prompts in a
TTY, and prints the possible values plus a filled-in command everywhere else.

---

## The three-file pattern

```
ConversionRegistry.json    the data
ConversionRegistry.ts      the only place a shape decision lives
ConversionRegistry.md      the output, never edited by hand
```

```bash
tools json2md init ./reports/ConversionRegistry --title "Conversion registry"
tools json2md build ./reports/ConversionRegistry.ts
tools json2md check ./reports/ConversionRegistry.ts
```

`build` is idempotent: it rebuilds at the file's own recorded timestamp first, so an unchanged
document keeps its original generated-at and never appears as a spurious diff.

### 🛑 Outside this repo, run `tools link install` once

The generated module always carries `@genesiscz/utils/json2md/document-file`, wherever it
lands. That resolves inside this repo already; anywhere else it needs one command per machine:

```bash
tools link install     # links under your home directory
tools link status      # check it
```

`init` detects a root where the package does not resolve and stops with that command rather
than scaffolding a module whose first build would fail.

Bun resolves a bare specifier from the importing file's folder, so nothing this tool does at
call time can fix it, and `bun doc.ts` fails the same way. Resolution walks up looking for
`node_modules/@genesiscz/utils`, so one symlink at an ancestor answers for everything below.
Full detail in `tools link --readme`.

### Hand-edit detection

Every generated file ends with a stamp recording the hash of the body **as the generator wrote
it**. That is the only fact that can separate the two reasons a file drifts, because a diff
against fresh output differs in both cases.

| Verdict | Meaning | Exit | `build` |
|---|---|---|---|
| `clean` | Matches what the generator produces now | 0 | writes nothing |
| `stale` | Untouched, but the data moved | 1 | rewrites |
| `hand-edited` | The body no longer hashes to the stamp | 1 | 🛑 refuses |
| `unstamped` | No stamp, so a hand edit cannot be ruled out | 0 | writes |
| `unsupported` | Stamp newer than this build | 1 | refuses |

On `hand-edited`, `check` prints the diff and the four places the edit could belong: the
`.json`, the `.ts` render function, a file that is not generated, or `--force` if it was a
mistake.

---

## Library

```ts
import { json2md, jsonToMarkdown, renderTable, defineColumns, pickColumns } from "@genesiscz/utils/json2md";

json2md([{ h2: "Results" }, { table: { rows } }]);
jsonToMarkdown(anyJson, { title: "Report" });
```

Blocks: `h1`–`h6`, `heading`, `p`, `blockquote`, `callout`, `ul`, `ol`, `tasks`, `dl`, `code`,
`table`, `link`, `img`, `hr`, `details`, `mermaid`, `badges`, `raw`, `nl`, `custom`. A block is
a single-key object; two keys is an error rather than a silent concatenation.

One row set at several column subsets:

```ts
const columns = defineColumns("all", ["id", "name", "owner", "status"]);
renderTable(rows, { columns: columns.columns });
renderTable(rows, { columns: pickColumns(columns, ["name", "status"]) });
renderGroupedTables(rows, { columns: columns.columns, group: { by: "owner", showCounts: true } });
```

---

## Behaviour worth knowing

- **Truncate first, escape second.** Escaping first and cutting afterwards can land the cut
  between a backslash and the pipe it escapes, merging two columns.
- **`0` and `false` survive.** Only `null` and `undefined` render blank. `emptyTokens: true`
  renders `` `null` ``, `` `""` ``, `` `[]` ``, `` `{}` `` as distinct visible tokens.
- **Escaping is on by default in the auto path.** Data is not a document author, so a value of
  `# Heading` does not become a heading and `<img onerror=…>` does not reach the renderer.
  Pass `escapeValues: false` when the data is trusted and meant to carry markdown.
- **Width is measured, not counted.** CJK glyphs take two cells and joined emoji take one, so
  columns line up.
- **Deep nesting and cycles are errors, not crashes.** Both throw a `Json2mdError` carrying a
  code and a JSON Pointer.
- **An empty table renders `_No rows._`**, never a header with no body.

---

## Errors

`Json2mdError` carries a `code`: `UNKNOWN_BLOCK`, `MULTI_KEY_BLOCK`, `NO_COLUMNS`,
`UNKNOWN_COLUMN`, `UNCOVERED_KEYS`, `MAX_DEPTH_EXCEEDED`, `CYCLIC_REFERENCE`, `INVALID_OPTION`,
`SELECT_FAILED`, `NO_DOCUMENT_EXPORT`, `DATA_NOT_FOUND`. Branch on the code, never on the
message text.

---

## Not built in this release

`--engine mdast` is declared and refuses with a clear message. It would need
`mdast-util-to-markdown`, `mdast-util-gfm` and `mdast-util-from-markdown`, which are not
dependencies of this repo. The string engine renders every block type the mdast one would; what
the mdast backend would add is guaranteed-valid output by construction and Markdown-to-JSON
round-trip.
