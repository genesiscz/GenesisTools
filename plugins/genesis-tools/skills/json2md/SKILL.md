---
name: gt:json2md
description: For generating markdowns efficiently from json data, use this gt:json2md skill
---

# json2md

Render JSON as Markdown. The core is `@genesiscz/utils/json2md`; `tools json2md` is a thin CLI
over it. Never hand-assemble a markdown table with string concatenation again.

## Pick the right door

| You want | Do this |
|---|---|
| A one-off document from a JSON file | `tools json2md data.json` |
| A document you regenerate whenever the data changes | The three-file pattern below |
| Markdown from inside your own TypeScript | `import { json2md } from "@genesiscz/utils/json2md"` |

## One-off rendering

The shape is chosen from the data. A uniform array of flat objects becomes a table, an array
of scalars becomes a list, a flat object of short values becomes a definition list, and
anything nested past `--collapse-depth` is wrapped in `<details>`.

```bash
tools json2md data.json
tools json2md data.json --select "items[?status=='open']"   # JMESPath
tools json2md data.json --select '$.items[*].name'          # JSONPath, auto-detected by the $
tools json2md data.json --title "Report" --toc --frontmatter yaml --meta project=genesis
tools json2md data.json --columns "id:ID:right,name:Name" --key-case capitalCase
cat data.json | tools json2md - -o report.md
```

Useful flags: `--from json|jsonl|toml`, `--repair`, `--mode auto|blocks`, `--max-width`,
`--overflow wrap|truncateStart|truncateEnd`, `--mermaid`, `--title-key`, `--clipboard`.
Run `tools json2md --help` for the full set.

## The three-file pattern

🛑 **This is the shape to reach for whenever a `.md` is generated from a `.json` that keeps
changing.** Three files sit beside each other:

```
ConversionRegistry.json    the data
ConversionRegistry.ts      the only place a shape decision lives
ConversionRegistry.md      the output, never edited by hand
```

Scaffold it, then regenerate whenever the data moves:

```bash
tools json2md init ./reports/ConversionRegistry --title "Conversion registry"
tools json2md init ./reports/Registry --data ./existing.json   # adopt data you already have
tools json2md build ./reports/ConversionRegistry.ts
tools json2md check ./reports/ConversionRegistry.ts
```

### 🛑 Outside this repo, run `tools link install` once

The import below is the same everywhere. It resolves inside GenesisTools already; anywhere else
— an Obsidian vault, a notes folder, `/tmp` — it needs one setup command, once per machine:

```bash
tools link install          # links under your home directory
tools link status           # check it, and whether the import actually resolves
```

`tools json2md init` detects this and stops with that exact command rather than scaffolding a
module that cannot build.

Why it is needed: Bun resolves a bare specifier from the **importing file's** folder, so nothing
json2md does at call time can fix it, and `bun doc.ts` fails the same way. Resolution walks up
looking for `node_modules/@genesiscz/utils`, so one symlink at an ancestor answers for
everything beneath it. See `tools link --readme`.

⚠️ Do **not** hand-write an absolute path to `document-file.ts` instead. It works, and it
commits a home directory into whatever repo the document lives in, so it runs on one machine.

The `.ts` looks like this:

```ts
import { defineDocument } from "@genesiscz/utils/json2md/document-file";

export default defineDocument<Data>({
    data: "./ConversionRegistry.json",
    options: { title: "Conversion registry", provenance: { scope: "every converted saga" } },
    render: (d) => [
        { badges: [{ label: "total", value: d.summary.total }] },
        { h2: "Items" },
        { table: { rows: d.items, columns: [{ key: "id", align: "right" }, "name", "status"] } },
    ],
});
```

## 🛑 Hand-edit detection: what to tell the user

Every generated `.md` ends with a stamp:

```
<!-- json2md:stamp v1 content=sha256:… source=sha256:… generator=Registry.ts … -->
```

`content` is the hash of the body **as the generator wrote it**. That one fact is what
separates the two reasons a generated file drifts. A diff against fresh output cannot
separate them, because fresh output differs in both cases.

`tools json2md check` returns one of five verdicts:

- **clean** — matches what the generator produces now. Exit 0.
- **stale** — the file is untouched and the data moved. Regenerating is safe. Exit 1.
- **hand-edited** — the body no longer hashes to the stamp. Someone typed into the generated
  file. Exit 1, and `build` REFUSES to overwrite it.
- **unstamped** — no stamp, so a hand edit cannot be ruled out. Exit 0.
- **unsupported** — the stamp is newer than this build. Exit 1.

**When you see `hand-edited`, do not run `--force` to make it go away.** Find out what the
edit was (`check` prints the diff) and move it to where it belongs:

1. it is a data fix → put it in the `.json`
2. it is a shape fix → put it in the `.ts` render function
3. it is one-off prose → put it in a file that is not generated
4. it really was a mistake → then `tools json2md build <file> --force`

Teach the user this rule once: **the `.md` is an artifact, not a document.** Editing it is
like editing a compiler's output. If they keep wanting to edit it, that is a signal the
generator is missing a feature, not that the guard is wrong.

⚠️ `build` is idempotent. It rebuilds at the file's own recorded timestamp first, so an
unchanged document keeps its original generated-at and never shows up as a spurious diff.

## Calling the library

```ts
import { json2md, jsonToMarkdown, renderTable, defineColumns, pickColumns } from "@genesiscz/utils/json2md";

json2md([{ h2: "Results" }, { table: { rows } }]);   // you describe the document
jsonToMarkdown(anyJson, { title: "Report" });        // the data describes itself
```

Blocks: `h1`–`h6`, `heading`, `p`, `blockquote`, `callout`, `ul`, `ol`, `tasks`, `dl`, `code`,
`table`, `link`, `img`, `hr`, `details`, `mermaid`, `badges`, `raw`, `nl`, `custom`.
A block is a single-key object. Two keys is an error, never a silent concatenation.

Add a block type without touching the core:

```ts
const options = withConverter({}, "kbd", (keys: string[]) => keys.map((k) => `<kbd>${k}</kbd>`).join(" + "));
json2md([{ custom: { type: "kbd", data: ["Cmd", "K"] } }], options);
```

### One row set, several column subsets

```ts
const columns = defineColumns("all", ["id", "name", "owner", "status", "updated"]);
renderTable(rows, { columns: columns.columns });                     // wide detail table
renderTable(rows, { columns: pickColumns(columns, ["name", "status"]) });  // narrow progress table
renderGroupedTables(rows, { columns: columns.columns, group: { by: "owner", showCounts: true } });
```

## What it already handles, so do not re-solve it

- A `|` or a line break in a cell. Cells are truncated FIRST and escaped SECOND, so a cut
  never orphans an escaping backslash.
- `0` and `false` survive; only `null` and `undefined` blank out. `emptyTokens: true` renders
  `` `null` ``, `` `""` ``, `` `[]` ``, `` `{}` `` as distinct visible tokens.
- CJK and emoji column alignment, via a display-width function rather than `.length`.
- Markdown and HTML injection from data values. Escaping is ON by default in the auto path;
  pass `escapeValues: false` only when the data is trusted and meant to carry markdown.
- Deep nesting. A cycle or a document past `maxDepth` throws a `Json2mdError` with a code and
  a JSON Pointer, instead of overflowing the stack.
- An empty table renders `_No rows._`, never a header with no body.

## Errors

Every failure is a `Json2mdError` with a `code`: `UNKNOWN_BLOCK`, `MULTI_KEY_BLOCK`,
`NO_COLUMNS`, `UNKNOWN_COLUMN`, `UNCOVERED_KEYS`, `MAX_DEPTH_EXCEEDED`, `CYCLIC_REFERENCE`,
`INVALID_OPTION`, `SELECT_FAILED`, `NO_DOCUMENT_EXPORT`, `DATA_NOT_FOUND`. Branch on the code,
never on the message text.
