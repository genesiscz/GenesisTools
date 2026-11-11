# tools json2md

Render JSON (or JSON Lines, or TOML) as Markdown: tables, lists, definition lists, sections, callouts,
`<details>` and mermaid. Use it for a one-off report from a JSON file, or for a document you regenerate every time
its data changes, with a guard that refuses to overwrite a hand edit.

`src/json2md/` is a thin CLI. Everything that renders lives in `@genesiscz/utils/json2md` (`src/utils/json2md/`),
so a downstream repo and any other consumer wrap the same core without going through a CLI.

## Quick start

```bash
# Render a file; the shape is chosen from the data
tools json2md data.json

# Render one sub-tree: JMESPath, or JSONPath when the expression starts with $ ('$.items[*].name')
tools json2md data.json --select "items[?status=='open']"

# A finished document with a title, a contents list and YAML front matter
tools json2md data.json --title "Report" --toc --meta project=app

# Read stdin, write a file
cat data.json | tools json2md - -o report.md

# A document you regenerate: scaffold it, then rebuild it when the data changes
# (tools json2md check ./reports/Inventory.ts tells you whether it needs that)
tools json2md init ./reports/Inventory --title "Inventory"
tools json2md build ./reports/Inventory.ts
```

## Commands

```
tools json2md [input] [options]   render a file, "-" (stdin), or piped input
tools json2md build <files...>    regenerate the .md of one or more document modules
tools json2md check <files...>    report clean, stale or hand-edited; exit 1 when action is needed
tools json2md init <name>         scaffold the three-file pattern: .json, .ts, .md
```

The root command also takes `-v, --verbose` (verbose logging) and `--readme` (print this page). Every command takes
`-h, --help`.

The root command and `init` both declare `--title`, so options are parsed by position: a flag typed after a
subcommand belongs to that subcommand. Without this, `init --title X` silently produced an untitled document.

### Render (the default command)

`[input]` is a file path, `-` for stdin, or nothing when data is piped in.

Input and selection:

| Option | What it does | Default |
|---|---|---|
| `--from [format]` | `auto`, `json`, `jsonl`, `toml` | `auto` |
| `--repair` | Run `jsonrepair` over invalid JSON first | off |
| `-s, --select <expr>` | Render only a sub-tree | whole input |
| `--dialect [dialect]` | Force `jmespath` or `jsonpath` | from `$` |
| `--mode [mode]` | `auto` detects the shape; `blocks` reads the input as a block document | `auto` |
| `--engine [engine]` | `string`; `mdast` is not built (see below) | `string` |

Document:

| Option | What it does | Default |
|---|---|---|
| `-t, --title <text>` | An H1 above everything except the front matter | none |
| `--toc` | Insert a table of contents built from the body | off |
| `--frontmatter [format]` | Emit front matter: `yaml`, `json`, `toml` | off |
| `--meta <key=value...>` | Front-matter entries, repeatable | none |
| `--provenance-scope <text>` | One sentence naming what the document covers | none |
| `--provenance-commit <sha>` | The commit the data was read at | none |
| `--stamp` | Append a stamp so a later hand edit can be detected | off |

`--meta` alone turns front matter on, in YAML. Either provenance flag adds a provenance header (Generated, Commit,
Scope lines).

Shape:

| Option | What it does | Default |
|---|---|---|
| `--heading-level <n>` | Heading level of the outermost sections | `2` |
| `--collapse-depth <n>` | Fold sections at this depth or deeper into `<details>` (outermost = 0); `0` disables | `3` |
| `--max-heading-depth <n>` | Deepest level that still gets a heading; below it, a bold line | `4` |
| `--key-case [style]` | Casing for keys used as headings, terms and headers | `preserve` |
| `--title-key <key>` | Key whose value titles each section of an array of objects | none |
| `--mermaid` | Render tree-shaped arrays as a mermaid graph | off |
| `--bullet [char]` | Unordered list marker: `-`, `*`, `+` | `-` |

`--key-case` takes one of 13 values: `preserve`, `camelCase`, `capitalCase`, `constantCase`, `dotCase`,
`kebabCase`, `noCase`, `pascalCase`, `pathCase`, `sentenceCase`, `snakeCase`, `titleCase`, `trainCase`.

`--mermaid` applies to a table whose rows carry `id` and `parent` or `parentId`.

The shape flags (`--heading-level`, `--collapse-depth`, `--max-heading-depth`, `--title-key`, `--mermaid`) apply to
`--mode auto` only. `--mode blocks` uses the headings and sections that the blocks declare. The table flags and
`--bullet` still apply.

Tables:

| Option | What it does | Default |
|---|---|---|
| `--columns <list>` | `key`, `key:Header` or `key:Header:right`, comma separated | inferred |
| `--max-width <n>` | Width budget per column | none |
| `--overflow [strategy]` | `wrap`, `truncateStart`, `truncateEnd` | `truncateEnd` |
| `--array-separator <text>` | Join array cells with this | `", "` |
| `--empty-text <text>` | What an empty table renders as | `_No rows._` |
| `--no-align` | Do not pad cells to the column width | padded |

The third part of a `--columns` entry may be `left`, `center` or `right`.

Output:

| Option | What it does |
|---|---|
| `-o, --output <file>` | Write the markdown to a file |
| `-c, --clipboard` | Copy the markdown to the clipboard |
| `--ask` | Ask stdout, clipboard or a file; only in an interactive terminal |

With none of them, the markdown goes to stdout. When several are given, `-o` wins over `-c`, and `-c` over `--ask`.

A flag with a closed value set is declared `--flag [value]` (`--from`, `--mode`, `--engine`, `--dialect`,
`--frontmatter`, `--key-case`, `--overflow`, `--bullet`). Omitting the value prompts in a TTY, and prints the
possible values plus a filled-in command everywhere else, with exit 1. An unknown value is an error with the same
suggestion. `--bullet x` and `--dialect xpath` used to run silently with a value the caller did not ask for.

Number flags (`--heading-level`, `--collapse-depth`, `--max-heading-depth`, `--max-width`) take a non-negative whole
number, and anything else is an error.

### build

```bash
tools json2md build ./reports/Inventory.ts ./reports/Owners.ts
```

| Option | What it does |
|---|---|
| `--force` | Overwrite even when the markdown was edited by hand |
| `--dry-run` | Render and report, but write nothing |
| `--no-merge-frontmatter` | Drop front-matter keys the document does not set |

Each file reports one outcome: written, would be written (dry run), already up to date, or refused. The command
exits 1 when any file was refused. An error inside a module (no `defineDocument` export, a missing data file) stops
the run at that file.

### check

```bash
tools json2md check ./reports/Inventory.ts      # the module
tools json2md check ./reports/Inventory.md      # or the output; its stamp names the module
tools json2md check --quiet ./reports/*.ts      # silent when everything is clean, for CI
```

It prints a table (DOCUMENT, VERDICT, DATA, NOTE). For every document that needs action it then prints what to do
and a diff of what regenerating would change. The diff aligns lines on their longest common subsequence, so one
inserted line does not mark every later line as changed; past 2000 lines it falls back to a positional comparison.

A document that was never generated fails `check`, so a CI gate catches a missing output.

### init

```bash
tools json2md init ./reports/Inventory --title "Inventory"
tools json2md init ./reports/Owners --data ./owners.json   # adopt data you already have
```

| Option | What it does | Default |
|---|---|---|
| `--title <text>` | The document title | the base name |
| `--data <json>` | An existing JSON file to adopt as the data | `<name>.json` |

`init` writes `<name>.ts`, writes sample data to `<name>.json` when that file is missing, and then builds
`<name>.md`. A trailing `.json`, `.ts` or `.md` on `<name>` is ignored.

The scaffolded `render` function reads the sample's `summary` and `items`. With `--data`, edit `render` in the `.ts`
to match your data, then run `tools json2md build <name>.ts`. Until you do, the first build inside `init` throws a
`TypeError` and `init` exits 1.

- It refuses (exit 1) when `<name>.ts` already exists, or when a markdown file it may not overwrite (unstamped or
  hand-edited) already sits at the output path. The `.json` and `.ts` are written before that refusal, so a second
  `init` fails with `<name>.ts already exists`. Move the old `.md` aside or run `build --force` instead.
- `--data` must point at an existing file. A typo in it used to create sample data at the mistyped path and carry
  on, turning a bad path into a valid but unrelated document.
- When `@genesiscz/utils` does not resolve from the folder yet, `init` still writes the `.json` and `.ts`, prints the
  fix (see [Outside this repo](#outside-this-repo-run-tools-link-install-once)), and stops before the first build
  with exit 0. The build would otherwise fail with a resolution error that reads like a bug in the document.

## The three-file pattern

Reach for this whenever a `.md` is generated from a `.json` that keeps changing.

```
Inventory.json    the data
Inventory.ts      the only place a shape decision lives
Inventory.md      the output, never edited by hand
```

The `.md` is an artifact, not a document. Editing it is like editing a compiler's output. If someone keeps wanting
to edit it, the generator is missing a feature.

The `.ts` that `init` writes looks like this (shortened):

```ts
import { defineDocument } from "@genesiscz/utils/json2md/document-file";

export default defineDocument<Data>({
    data: "./Inventory.json",
    options: { title: "Inventory", provenance: { scope: "generated from the JSON beside this file" } },
    render: (d) => [
        { badges: [{ label: "total", value: d.summary.total }, { label: "done", value: d.summary.done }] },
        { h2: "Items" },
        { table: { rows: d.items, columns: [{ key: "id", align: "right" }, { key: "name", header: "Name" }] } },
    ],
});
```

`defineDocument` fields:

| Field | Meaning |
|---|---|
| `data` | The data file, relative to the `.ts`. Required. |
| `render` | `(data) => blocks`. Required. |
| `out` | The output path. Default: the `.ts` path with `.md`. |
| `options` | `title`, `frontmatter`, `frontmatterFormat`, `provenance`, `toc`, and the render options. |
| `command` | The rebuild command the stamp records. Default: `tools json2md build <path>`. |
| `unstamped` | Skip the stamp, for a file a person keeps editing. Every rebuild then needs `--force`, and `check` always reports `unstamped` (exit 0), so it cannot see that the file is stale. |
| `transclude` | `false` keeps `{{kind …}}` tokens literal. Default on. |

`defineDocument` checks `data` and `render` itself, so `bun Inventory.ts` reports a wrong field too, not only the
CLI. The data file is read by its extension: `.toml` as TOML, `.jsonl` or `.ndjson` as JSON Lines, anything else as
JSON that may carry comments and trailing commas (a `.jsonl` data file is parsed strictly).

⚠️ Do not hand-write an absolute path to `document-file.ts` in place of the package import. It works, and it commits
a home directory into whatever repo the document lives in, so it runs on one machine. An earlier `init` wrote such a
path when the package did not resolve; it now always writes the package import.

### build is idempotent

`build` rebuilds at the file's own recorded timestamp first. Only when that output still differs has something real
changed, so an unchanged document keeps its original generated-at time and never appears as a spurious diff.

The stamp records the rebuild command with a path that works from anywhere: relative when the module is inside the
current folder, absolute otherwise. A command recorded as `json2md build ../../../…` worked from exactly one place.

### Hand-edit detection

Every generated file ends with a stamp, an HTML comment that renders as nothing:

```
<!-- json2md:stamp v1 content=sha256:… source=sha256:… generator=Inventory.ts generated=… command=… -->
```

`content` is the hash of the body as the generator wrote it, and `source` is the hash of the data. The content hash
is the only fact that can separate the two reasons a file drifts, because a diff against fresh output differs in
both cases.

| Verdict | Meaning | `check` | `build` |
|---|---|---|---|
| `clean` | Matches what the generator produces now | 0 | writes nothing |
| `stale` | Untouched, but the data or the generator moved | 1 | rewrites |
| `hand-edited` | The body no longer hashes to the stamp | 1 | 🛑 refuses |
| `unstamped` | No stamp, so a hand edit cannot be ruled out | 0 | refuses |
| `unsupported` | Stamp newer than this build | 1 | refuses |

Every refusal is lifted by `--force`. Overwriting is the one outcome that cannot be undone from the repository,
because the edit exists nowhere else.

On `hand-edited`, do not reach for `--force` to make it go away. `check` prints the diff; move the edit to where it
belongs, then rebuild:

1. a data fix goes in the `.json`;
2. a shape fix goes in the `.ts` render function;
3. one-off prose goes in a file that is not generated;
4. a mistake is overwritten with `tools json2md build <file> --force`.

On `unstamped` (a hand-written file at the output path, or a stamp that was removed), build once with `--force` when
nothing in it needs keeping. That starts the tracking. On `unsupported`, upgrade GenesisTools rather than rebuild.

### Front matter other tools add

Another tool may add a key to a generated file's YAML front matter, for example a notes vault's `sessions:` list.
That is not a hand edit. The stamp lists the keys the document wrote (`frontmatter=title,date,tags`), and only those
keys count toward the content hash. `build` keeps every other top-level key, byte for byte, at the end of the block.
A key the document sets always takes the document's value, and a key the document stopped setting is removed. Pass
`--no-merge-frontmatter` to drop the other keys. JSON and TOML front matter are not merged.

### Real code in the prose

A `{{lines path="src/a.ts" range="5-20"}}` token (or `symbol`, `json`, `diff` and the other kinds) in a `raw` or
`p` block becomes an excerpt at build time. Relative paths resolve from the module's folder. The excerpts are
captured at the build's own timestamp, so a rebuild of an unchanged document stays unchanged and `check` stays
clean. When the code an excerpt shows changes, rebuild. The tokens run on every build and check, including `url`
(HTTP fetch) and `pr-thread` (`gh api`); see How it works. The token kinds and `tools markdown resolve` for
hand-written notes are in [`tools markdown`](../markdown/README.md).

### Outside this repo: run `tools link install` once

The generated module always imports `@genesiscz/utils/json2md/document-file`, wherever it lands. That resolves
inside this repo already. Anywhere else (a notes folder, a scratch project) it needs one setup per machine:

```bash
tools link install     # one tsconfig under your home directory covers every folder beneath it
tools link status      # check it, and whether the import resolves
```

Bun resolves a bare specifier from the importing file's folder, so nothing this tool does at call time can fix it,
and `bun doc.ts` fails the same way. The fix is one `tsconfig.json` with a `paths` mapping at an ancestor folder.
Bun reads the nearest tsconfig above the importing file and applies it before any `node_modules` walk, so a project
with its own tsconfig is not touched by it.

`init`, `build` and `check` test this before Bun loads the module, so Bun's auto-installer never tries to download
the package. They name one of three fixes:

- under your home directory: `tools link install`;
- outside it (`/tmp`, `/Volumes/…`): `tools link install --root <folder>`, because Bun never reads `~/tsconfig.json`
  for a file outside home, and the home install would report success and change nothing;
- 🛑 a nearer `tsconfig.json` hides the mapping: `tools link install --root <that project>`. Bun reads only the
  nearest tsconfig, so a folder that grew its own small project cuts off every document beneath it.
  `tools link status` names the file and prints `tools link install --root <that project>`.

The test follows the module's own imports, local helpers included. A module that never imports the package gets no
link advice; a helper one file away that does is caught. Full detail is in [`tools link`](../link/README.md).

## How it works

- **No config, no storage.** The tool reads the input you name and writes only to stdout, the `-o` file, the
  clipboard, or the document's `.json`, `.ts` and `.md`. The render command makes no network calls. It needs no macOS
  permission and costs nothing. Its log lines go to the shared GenesisTools day log, `~/.genesis-tools/logs/<date>.log`.
- **`{{kind …}}` tokens are resolved on every `build`, `check` and `init`.** `url` fetches the page over HTTP,
  `pr-thread` runs `gh api` or `glab api`, and `cmd` runs an allowlisted read-only git or `tools` command. Set
  `transclude: false` in the document to keep the tokens literal.
- **stdout carries only the document.** Every status line goes to stderr, so `tools json2md x.json > x.md` yields the
  markdown and nothing else. The one exception is an enum-flag error: the suggested command goes to stdout, so check
  the exit code before you use the file.
- **Input format.** With `--from auto`, the file extension wins: `.jsonl` and `.ndjson` are JSON Lines, `.toml` is
  TOML, `.json` and `.jsonc` are JSON. Without an extension, text that opens with a comment or a scalar is JSON, text
  where every line opens with `{` is JSON Lines, other `{` or `[` text is JSON, and the rest is TOML.
- **JSON input may carry comments and trailing commas** without `--repair`. JSON Lines is strict: each line must be
  plain JSON unless `--repair` is given (render command only). `--repair` (off by default) adds a `jsonrepair` pass,
  per line for JSON Lines. It is off because a silent repair turns a typo into wrong output instead of an error.

### How the shape is chosen

| Value | Renders as |
|---|---|
| An array of scalars | a list |
| An array of flat objects with mostly the same keys | a table |
| Any other array of objects | sections, titled by `--title-key`, else by the parent key and a number (`users 1`, `users 2`), or `Item 1`, `Item 2` at the top level |
| A flat object, longest value 80 characters or fewer | a definition list |
| A flat object with a longer value | a key and value table |
| A nested object | its scalar fields, then one section per nested key |
| A string with a line break | paragraphs, split at blank lines |

The outermost sections are depth 0. With the default 3, sections at depth 3 (the fourth level) and deeper fold into
`<details>`. Otherwise it gets a heading, or a bold line past
`--max-heading-depth`. "Mostly the same keys" means a key uniformity of 0.6 or more: on average, each key appears
in 60% of the rows.

The library exposes the thresholds the CLI does not: `tableUniformity` (0.6), `definitionMaxLength` (80),
`tableMinRows` (1), `codeThreshold` (0, off: a longer string becomes a fenced block) and `maxDepth` (64).

### Behaviour worth knowing

- **Truncate first, escape second.** Escaping first and cutting afterwards can land the cut between a backslash and
  the pipe it escapes, merging two columns.
- **`0` and `false` survive.** Only `null` and `undefined` render blank. `emptyTokens: true` renders `` `null` ``,
  `` `""` ``, `` `[]` ``, `` `{}` `` as distinct visible tokens.
- **Escaping is on by default in the auto path.** Data is not a document author, so a value of `# Heading` does not
  become a heading and `<img onerror=…>` does not reach the renderer. Pass `escapeValues: false` when the data is
  trusted and meant to carry markdown.
- **Width is measured, not counted.** CJK glyphs take two cells and joined emoji take one, so columns line up.
- **Deep nesting and cycles are errors, not crashes.** Both throw a `Json2mdError` carrying a code and a JSON
  Pointer.
- **An empty table renders `_No rows._`**, never a header with no body.

## Library

```ts
import { json2md, jsonToMarkdown, renderTable, defineColumns, pickColumns } from "@genesiscz/utils/json2md";

json2md([{ h2: "Results" }, { table: { rows } }]);   // you describe the document
jsonToMarkdown(anyJson, { title: "Report" });        // the data describes itself
```

Blocks: `h1` to `h6`, `heading`, `p`, `blockquote`, `callout`, `ul`, `ol`, `tasks`, `dl`, `code`, `table`, `link`,
`img`, `hr`, `details`, `mermaid`, `badges`, `raw`, `nl`, `custom`. A block is a single-key object; two keys is an
error rather than a silent concatenation. `--mode blocks` feeds a JSON file of these blocks to `json2md()`.

`callout` takes a `kind` (`note`, `abstract`, `info`, `todo`, `tip`, `success`, `question`, `warning`, `failure`,
`danger`, `bug`, `example`, `quote`), an optional `title` and `fold` (`open` or `closed`, for Obsidian), and
`labelCase: "lower"` for `[!warning]` where the default is `[!WARNING]`.

One row set at several column subsets:

```ts
const columns = defineColumns("all", ["id", "name", "owner", "status"]);
renderTable(rows, { columns: columns.columns });
renderTable(rows, { columns: pickColumns(columns, ["name", "status"]) });
renderGroupedTables(rows, { columns: columns.columns, group: { by: "owner", showCounts: true } });
```

A new block type, without touching the core:

```ts
const options = withConverter({}, "kbd", (keys: string[]) => keys.map((k) => `<kbd>${k}</kbd>`).join(" + "));
json2md([{ custom: { type: "kbd", data: ["Cmd", "K"] } }], options);
```

`registerDocumentCommands(program, env)` in `src/json2md/commands/document.ts` mounts `build`, `check` and `init` on
another program. The environment (`commands/document-env.ts`) holds what depends on the host: the stamp's rebuild
command, the transclusion hints, the package check and the scaffold import.

### Errors

`Json2mdError` carries a `code`: `UNKNOWN_BLOCK`, `MULTI_KEY_BLOCK`, `NO_COLUMNS`, `UNKNOWN_COLUMN`,
`UNCOVERED_KEYS`, `MAX_DEPTH_EXCEEDED`, `CYCLIC_REFERENCE`, `INVALID_OPTION`, `SELECT_FAILED`,
`NO_DOCUMENT_EXPORT`, `DATA_NOT_FOUND`, `INVALID_DEFINITION` (a `defineDocument` field of the wrong shape). Branch
on the code, never on the message text.

## For agents

- There is no `--json` output: the output is the markdown, on stdout alone.
- Exit codes: 0 on success. 1 on any error, a bad or missing enum value outside a TTY, and `--engine mdast`. `build`
  exits 1 when it refused a file. `check` exits 1 for `stale`, `hand-edited`, `unsupported`, a missing output, or a
  `.md` whose stamp names no generator, or a module from which `@genesiscz/utils` does not resolve (`build` counts
  that as a refusal); `clean` and `unstamped` exit 0.
- `tools json2md check --quiet <modules...>` is a CI gate: silent and 0 when no document fails. An `unstamped` output
  also exits 0, so a 0 does not prove every document is clean, and the gate cannot catch an unstamped output that is
  stale.
- Never hand-assemble a markdown table with string concatenation; call the library or the CLI.
- Plugin skills: `gt:json2md` (this tool) and `gt:markdown` (the `{{kind …}}` tokens).

## Troubleshooting

**`@genesiscz/utils does not resolve from <folder> yet.`** The document sits outside this repo and the package is
not linked there. Run the command the message prints; see
[Outside this repo](#outside-this-repo-run-tools-link-install-once).

**`<file> is not valid JSON: …`** The input has a syntax error that comments and trailing commas do not explain.
Fix it, or pass `--repair` to run `jsonrepair` first. For JSON Lines the message names the line.

**`<file>.md has no stamp naming its generator, so it cannot be checked.`** `check` was given a `.md` that no
document module wrote: a hand-written file, or a one-off render with `--stamp`, which records no generator, or a path that does not exist
(a typo, or a document never generated). Pass the `.ts` module instead.

**`init --data` fails with `undefined is not an object`.** The scaffolded `render` expects the sample data. Edit
`render` in the `.ts` for your data, then run `build`; do not run `init` again.

**`build` refuses an `unstamped` file.** A file without a stamp sits at the output path. Build once with `--force` if
nothing in it needs keeping.

**A flag prints a list of values and exits 1.** An enum flag got no value outside a TTY. Copy the filled-in command
it prints.

**`The mdast backend is not built in this release.`** `--engine mdast` is declared but refuses. It would need
`mdast-util-to-markdown`, `mdast-util-gfm` and `mdast-util-from-markdown`, which are not dependencies of this repo.
The string engine renders every block type the mdast one would; what the mdast backend would add is guaranteed-valid
output by construction and Markdown-to-JSON round-trip.

## Related

- [`tools link`](../link/README.md): makes `@genesiscz/utils` resolve outside this repo.
- [`tools markdown`](../markdown/README.md): the `{{kind …}}` tokens and their excerpts.
