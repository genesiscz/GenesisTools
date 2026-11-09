# tools json

Convert data between JSON and TOON (Token-Oriented Object Notation), and infer a TypeScript interface, a JSON Schema
or a short skeleton from a JSON value. TOON is a compact, line-based format for uniform data, so the main use is to
shrink JSON before a language model reads it. The tool checks the size and prints whichever form is smaller.

`tools json` comes with GenesisTools (`bun install && ./install.sh` puts `tools` on your PATH) and needs only Bun.

## Quick start

```bash
# JSON in: prints TOON, or compact JSON when that is smaller
tools json data.json

# TOON in: prints indented JSON
cat data.toon | tools json

# Shrink an API answer before an agent reads it
curl -s https://api.example.com/users | tools json

# Always indented JSON: pretty-print a file, or turn JSON Lines into one array
tools json events.jsonl --to-json

# TypeScript interfaces for the data
tools json schema data.json

# The shape of the data on one line
tools json schema data.json -f skeleton --compact
```

## Commands

Global options on every command: `-v, --verbose` (`convert`: detection and size details on stderr; `schema`: debug log
lines), `--readme` (print this
page) and `-h, --help`.

### `tools json [convert] [file]`

The default command, so `tools json data.json` and `tools json convert data.json` are the same. It reads the file, or
stdin when you pipe data in.

| Flag            | What it does                                                    |
| --------------- | --------------------------------------------------------------- |
| `-t, --to-toon` | Always print TOON, also when compact JSON is smaller            |
| `-j, --to-json` | Always print JSON, indented by two spaces                       |
| `--validate`    | Exit 1 on "other text" (below) instead of passing it through    |
| `-v, --verbose` | Print the detected format and the size comparison on stderr     |

You cannot give `--to-toon` and `--to-json` together. What it prints for each kind of input:

| Input            | No flag                    | `--to-toon` | `--to-json`   |
| ---------------- | -------------------------- | ----------- | ------------- |
| JSON             | TOON or compact JSON       | TOON        | indented JSON |
| JSONL            | the same, for one array    | TOON        | indented JSON |
| JSON inside text | the same, for the JSON     | TOON        | indented JSON |
| TOON             | indented JSON              | error       | indented JSON |
| other text       | the text, unchanged        | unchanged   | unchanged     |

"TOON or compact JSON" means the smaller of the two in bytes. "Other text" passes through with exit code 0; add
`--validate` to make it an error.

#### JSON to TOON

```json
{
    "users": [
        { "id": 1, "name": "Alice", "role": "admin" },
        { "id": 2, "name": "Bob", "role": "user" }
    ]
}
```

`tools json` prints:

```
users[2]{id,name,role}:
  1,Alice,admin
  2,Bob,user
```

#### TOON to JSON

Pipe the TOON above back in and `tools json` prints the indented JSON:

```json
{
  "users": [
    {
      "id": 1,
      "name": "Alice",
      "role": "admin"
    },
    {
      "id": 2,
      "name": "Bob",
      "role": "user"
    }
  ]
}
```

#### Verbose mode

```bash
tools json data.json --verbose
```

On stderr, the lines carry this content for the JSON above (the exact marks and any repeated debug lines can differ):

```
Detected format: JSON
Compact JSON size: 86 bytes
TOON size: 52 bytes
✓ TOON is 39.5% smaller (34 bytes saved)
Returning TOON format
```

On stdout, the TOON table. Records with different keys can tip the other way: for the input of the `schema` example
below, TOON is 97 bytes and compact JSON is 95, so verbose mode says `⚠ Compact JSON is 2.1% smaller (2 bytes saved)`
and the tool prints compact JSON.

#### Recipes

```bash
# Save TOON for a prompt. Use -t: the default mode can print compact JSON instead
tools json data.json --to-toon > data.toon

# Turn a TOON answer back into JSON
tools json response.toon --to-json > response.json

# Check which form is smaller, and by how much
tools json large-data.json --verbose > /dev/null
```

#### JSON inside text

An error line such as `API 400: {"success": false}` holds a JSON value inside prose. `tools json` finds the JSON from
the first `{` to the last `}` (or `[` to `]`) and converts only that part, so it prints `success: false`. The text
around the JSON (`API 400:`) is not printed.

#### When TOON helps

- TOON wins on flat data, uniform arrays, tables and lists of records: the example above is 39.5% smaller.
  [Rules.md](Rules.md) cites 30 to 60 percent fewer tokens than JSON for this kind of data.
- JSON wins on deeply nested or irregular data, and when a person must read it. You do not have to choose: in the
  default mode the tool compares both sizes and prints the smaller one.
- Use `--verbose` to see why the tool chose a format.

### `tools json schema [file]` (alias `infer-schema`)

Reads one JSON value from a file, from `-` (stdin), or from stdin when you pipe data in, and prints its shape.

| Flag                    | What it does                                                    |
| ----------------------- | --------------------------------------------------------------- |
| `-f, --format <format>` | `typescript` (default), `schema` or `skeleton`                  |
| `-n, --name <RootName>` | Name of the root interface, default `Root` (typescript only)    |
| `--compact`             | One line per interface, or the whole result on one line         |
| `-c, --clipboard`       | Also copy the result to the clipboard                           |

```bash
tools json schema data.json                       # TypeScript interfaces
tools json schema data.json -f skeleton           # the type tree, indented
tools json schema data.json -f schema --compact   # JSON Schema on one line
curl -s https://api.example.com/users | tools json schema -n UserPage --clipboard
```

For this input:

```json
{
    "users": [
        { "id": 1, "name": "Alice", "email": "alice@example.com" },
        { "id": 2, "name": "Bob" }
    ],
    "total": 2
}
```

`tools json schema` prints:

```ts
interface User {
  id: number;
  name: string;
  email?: string;
}

interface Root {
  users: User[];
  total: number;
}
```

and `tools json schema -f skeleton --compact` prints:

```
{ users: { id: integer, name: string, email?: string }[], total: integer }
```

How the inference works:

- Every item of an array is merged into one shape. A key that is missing from some items becomes optional (`?`).
- A nested interface takes its name from its key in PascalCase, singular for an array (`users` gives `User`,
  `categories` gives `Category`). A second interface with the same name gets a number (`Root2`).
- Skeleton and JSON Schema keep `integer` apart from `number`. TypeScript prints both as `number`.
- `-n` renames only the root interface. A property that is literally called `Root` keeps its name. The name must be a
  valid TypeScript identifier, and it does nothing for `schema` and `skeleton`.
- The JSON Schema output has `type`, `properties`, `required` and `items`, and no `$schema` key.
- `schema` accepts comments and trailing commas in its input. `convert` does not (see Troubleshooting).

## How it works

- **No state.** The tool has no config file, no environment variables, no stored data, no network access and no Mac
  permissions. It reads one input and writes one result. It costs nothing.
- **Streams.** The result goes to stdout. Verbose lines, errors and the clipboard message go to stderr, so a pipe gets
  only the result. Diagnostics also go to the shared day log, `~/.genesis-tools/logs/<date>.log`.
- **Detection order** (`detectFormat` in `commands/convert.ts`):
  1. JSON, with the strict parser (no comments, no trailing commas).
  2. JSONL: JSON objects or arrays one after another, with no text left over. The tool converts them as one array.
  3. TOON, read by `@toon-format/toon`.
  4. JSON inside text, as in the example above.
  5. Anything else is "other text".
- **Why TOON comes before JSON inside text.** A TOON table header such as `users[3]{id,name,role}:` holds `[3]`, which
  is valid JSON. When the embedded-JSON check ran first, a TOON round trip lost all its rows and printed `[3]`. The
  fix of 2026-09-09 (commit ff94cad449) tries TOON first. The embedded-JSON check still wins for a line like
  `API 400: {"success": false}`: TOON reads that line as one key whose value is the raw JSON text, and the tool treats
  that as the sign of JSON inside text.
- **Size comparison.** The tool counts UTF-8 bytes (`Buffer.byteLength`) of the TOON output and of compact JSON (no
  whitespace). TOON must be strictly smaller to win, so a tie prints JSON.
- **Input.** The tool reads the input, then trims leading and trailing whitespace before detection. Other text
  therefore passes through without its leading and trailing blank lines.
- **Libraries.** `@toon-format/toon` (version 4.1.1) encodes and decodes TOON. Schema inference is
  `formatSchema` from `@genesiscz/utils/json-schema`, which `tools debugging-master expand --schema` and
  `tools har-analyzer expand --schema` also use. `clipboardy` writes the clipboard, and `commander` parses the
  arguments.

## For agents

- [Rules.md](Rules.md) tells agents to read JSON from files and APIs through `tools json`
  (`curl -s https://api.example.com/data.json | tools json`), to save tokens. `jq` is a different tool: it filters
  and queries JSON, while `tools json` changes the format.
- The conversion keeps the data: `commands/convert.test.ts` checks that the TOON the tool writes decodes back to the
  same value. The one exception is JSON inside text, where the prose around the JSON is dropped.
- Do not assume that the output is TOON. In the default mode it can be compact JSON. Use `--to-json` when a JSON
  parser reads the result, and `--to-toon` when you need TOON.
- Exit codes: 0 on success, also when other text passes through unchanged; 1 on every error. Add `--validate` to
  find out whether the input was data at all.
- The tool has no `--json` flag and no MCP tool. In code, do not spawn `tools json`: import `toToon` and `fromToon`
  from `src/json/lib/toon.ts`, or `formatSchema` from `@genesiscz/utils/json-schema` (the rule is in
  `.claude/rules/tools.md`).

## Troubleshooting

- **`tools json -` says `Error: File not found: <folder>/-`.** Only `schema` reads `-` as stdin. For a conversion,
  pipe the data in and give no file argument.
- **A JSON file with comments comes back unchanged.** The conversion uses the strict JSON parser, so a file with `//`
  comments or trailing commas is "other text". Remove the comments first. `tools json schema` accepts them.
- **One line of plain text comes back in quotes** (`echo hello | tools json` prints `"hello"`). A single line of text
  is a valid TOON document (a string), so the tool converts it to JSON. For the same reason `--to-toon` on it fails
  with `Error: Input is already in TOON format`. Text with several lines is usually not valid TOON, so it passes
  through as "other text". Lines shaped `key: value` are TOON objects: `echo "Status: ok" | tools json` prints the JSON
  object `{"Status": "ok"}`, and so does multi-line `key: value` text such as simple YAML or mail headers. `--validate`
  catches only input that is neither format.
- **`--to-toon` or `--to-json` printed my text unchanged.** A forced format does not check the input. Add
  `--validate`, and the tool exits 1 with `Error: Input is neither valid JSON, JSONL, nor TOON format`.
- **`tools json schema` on a JSONL file fails with `Invalid JSON input`.** `schema` reads one JSON value. Convert the
  lines to one array first: `tools json events.jsonl --to-json | tools json schema`.
- **`-n User` printed two `interface User` blocks.** The rename does not check for a clash with a nested interface:
  data with a `users` array already has an interface `User`. Choose a name that is not in use, such as `UserPage`.
- **An array at the root gives one interface and no array type.** For `[{"id": 1}]`, the TypeScript output is only
  `interface Root { id: number }` (with `--compact`): it describes one item. The skeleton shows the array: `{ id: integer }[]`.
- **A type such as `string | null[]`.** An array whose items have more than one type prints without parentheses. Read
  it as `(string | null)[]`. An empty array prints as `unknown[]`, and a value nested deeper than 20 levels prints
  as `unknown`.
- **`--clipboard` printed a warning.** The copy failed, and the result is still on stdout.
- **`tools json-schema` does not exist.** It was merged into `tools json schema` on 2026-10-05 (commit d8d674dbb0).
  Its `-m, --mode` is now `-f, --format`. The default is now `typescript`, not `skeleton`. The output is now indented
  by default, so `--pretty` is gone and `--compact` gives the old one-line form.
- **Any other error.** Run again with `--verbose`: a conversion error then also prints its stack trace. Failed runs
  are also listed by `tools genesis-tools logs failures`.

Other error messages: `Error: Cannot specify both --to-toon and --to-json. Choose one.`,
`Error: No input provided. Provide a file path or pipe data via stdin.` (a conversion with no file and no pipe, or
empty input), `No input. Pass a JSON file, "-", or pipe JSON in.` (`schema` with no file and no pipe),
`No JSON input provided (empty input).` (empty input to `schema`), `File not found: <file>` (`schema` with a missing
file, no `Error:` prefix) and `Invalid root interface name` (a bad `-n`).

## Related

- [`tools json2md`](../json2md/README.md): render JSON as Markdown tables and lists.
- [`tools debugging-master`](../debugging-master/README.md): `expand --schema` uses the same schema inference.
- [`tools har-analyzer`](../har-analyzer/README.md): `expand --schema` prints the shape of a captured response.
- [`tools ts`](../ts/README.md) and [`tools indexer`](../indexer/README.md): both can print TOON themselves
  (`--toon`, `search --format toon`).
- [Rules.md](Rules.md): the instructions for agents.
- TOON: the guide at https://toonformat.dev/guide/llm-prompts and the library at https://github.com/toon-format/toon.
