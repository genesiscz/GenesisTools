# tools markdown-cli

Render a markdown file, or markdown from a pipe, as formatted terminal text: headings, lists, code blocks, tables,
alerts and task lists. Use it to read a document in the terminal without an editor, or to watch a doc re-render each
time you save it.

## Quick start

```bash
tools markdown-cli README.md                               # render a file
cat notes.md | tools markdown-cli                          # render markdown from a pipe
tools markdown-cli README.md --watch                       # re-render on every save
tools markdown-cli README.md --width 80 --theme light      # 80 columns, light palette
tools markdown-cli README.md --table-engine cards          # every table as stacked cards
tools markdown-cli README.md --color | less -R             # page through it in colour
```

## Commands

There is one command, `tools markdown-cli [options] [file]`, with no subcommands.

| Flag                    | What it does                       | Default   |
| ----------------------- | ---------------------------------- | --------- |
| `[file]`                | The markdown file; `-` reads stdin | see below |
| `-w, --watch`           | Re-render when the file changes    | off       |
| `--width <n>`           | Line width in columns              | see Width |
| `--theme <name>`        | `dark`, `light` or `minimal`       | `dark`    |
| `--table-engine <name>` | How tables are drawn (see Tables)  | `auto`    |
| `--no-color`            | Strip colour, on a terminal too    | off       |
| `--color`               | Keep colour in a pipe              | off       |
| `-v, --verbose`         | Verbose logging                    | off       |
| `--readme`              | Print this README and exit         |           |
| `-h, --help`            | Print the help and exit            |           |

### Where the markdown comes from

- A file argument always wins. A relative path resolves from the current folder.
- `-` reads stdin.
- With no file, the tool reads stdin when stdin is not a terminal (a pipe or a redirect), and prints its help when stdin is a terminal.
- A file that does not exist prints `File not found: <absolute path>` and exits 1.

Fixed on 2026-10-04 (#452): the tool used to check stdin first, so any run whose stdin was not a terminal (an agent,
cron, an editor, CI) rendered the empty stdin instead of the file it was given.

### Colour

- Colour follows stdout. A terminal gets colour; a pipe or a file gets plain text, so
  `tools markdown-cli README.md > plain.txt` is already plain.
- `--no-color` strips colour on a terminal too.
- `--color` keeps colour in a pipe, for `| less -R`.
- An explicit flag wins over the terminal check. Without a flag, `FORCE_COLOR` does not bring colour into a pipe.

Fixed on 2026-08-27: colour used to be on by default, so piped output carried raw escapes (`cat -v` showed
`^[[91m`).

### Width

- Without `--width`, prose wraps at the terminal width minus 2, at most 120 columns. When the terminal reports no
  width (a pipe, `script`, some CI runners or editor terminals that report 0 columns), prose wraps at 80.
- `auto`, `ascii` and `cards` tables fit the terminal width minus 2; `cli-table3` and `plain` ignore the width. When the terminal reports 20 columns or fewer, or no width, tables fit
  100 columns. In a pipe, prose is 80 wide and tables up to 100, so pass `--width` to get one width for both.
- With `--width <n>`, prose wraps at n and `auto`, `ascii` and `cards` tables fit n. A line that is still longer than n after wrapping (a long
  code line, a long URL) is cut at n.

Fixed on 2026-10-04: a terminal that reported 0 columns used to put every word on its own line.

### Watch mode

`--watch` needs a file. It clears the screen, renders the file, and prints
`--- Watching <path> for changes (Ctrl+C to stop) ---` under it. Each save clears the screen and renders again. The
watcher is `chokidar`. Ctrl+C stops it with exit code 130. With stdin as the source, `--watch` is ignored and the
tool renders once.

### Themes

The theme sets the border colour of `ascii` and `cards` tables, the card label colour, and the colours of the Mermaid
header and rules. Table headers are bold in every theme. Alerts, headings, code and links have the same colours in
every theme. The `cli-table3` and `plain` engines do not use the theme.

### Tables

| Engine       | Look                                                 |
| ------------ | ---------------------------------------------------- |
| `auto`       | `ascii` while the table fits, else `cards`           |
| `ascii`      | A box; wide columns shrink, long cells wrap          |
| `cards`      | One `● <first cell>` block per row, `label  value`   |
| `cli-table3` | The `tools port` box: rules between rows             |
| `plain`      | Padded columns, no borders, cells cut at 50 chars    |
| `html`       | cli-html draws the `<table>`, hard-cut at its width  |

- `auto` measures the table against the width from the Width section.
- `ascii` shrinks the widest column first, never below 8 characters, and wraps the cell text instead.
- `cards` takes the first cell of a row as its title, wraps each value with a hanging indent, and skips an empty
  cell.
- `cli-table3` is the shared `createBoxTable`. It sizes each column to its content, so a wide table runs past the
  right edge.
- `plain` is the shared `formatTable`.
- `ascii` keeps the column alignment of `:---:` and `---:`; `plain` keeps right alignment.
- In every engine except `html`, a cell holds plain text. Bold, italics and code lose their styling, a link keeps
  its text and loses its URL, and inline HTML such as `<br>` is dropped.

## How it works

The tool is a thin wrapper around the shared renderer in `src/utils/markdown/` (`@genesiscz/utils/markdown`).
markdown-it turns the markdown into HTML, and cli-html turns the HTML into terminal text. Tables are drawn outside
cli-html and put back after it, because cli-html re-wraps its output and would break the box lines.

The same renderer draws a README in the `tools` picker and for `tools <tool> --readme`, so a document looks the same
in all three places.

The tool keeps no data and no config, reads no environment variables of its own, makes no network calls and costs
nothing. It reads only the file you name or stdin.

### What it renders

- GitHub alerts (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`) get an icon and a title. The bar beside them has the same colour for every alert type and every theme.
- Task lists (`- [ ]`, `- [x]`) get checkboxes.
- A fenced code block in a programming language (ts, python, …) gets line numbers. A shell, config or plain block
  does not: `bash`, `sh`, `shell`, `zsh`, `fish`, `console`, `terminal`, `text`, `plain`, `json`, `yaml`, `yml`,
  `toml`, `xml`, `markdown`, `md`, `ini`, `env`, `diff`, or no language.
- Mermaid is not drawn. The tool prints a `📊 MERMAID DIAGRAM` header, then the source between two rules. The source lines run together into one wrapped paragraph, so open the file to read the diagram line by line. A block without the
  `mermaid` tag counts too when its first line is `gantt`, `sequenceDiagram`, or `graph` with `TB`, `BT`, `RL`,
  `LR` or `TD`.
- Raw HTML is passed to cli-html, and bare URLs become links.
- Prose gets typographic replacements: straight quotes become curly quotes and `--` becomes a dash. Code spans and
  code blocks keep their text as written, so copy commands from code, not from prose.

## For agents

- Always pass the file path. An agent's stdin is not a terminal, so with no file the tool reads stdin and renders
  whatever is there, often nothing.
- Piped output is plain text. There is no `--json` mode.
- Pass `--width` when the output must not depend on the terminal.
- Exit codes: 0 after a render, 1 for a missing file or another error, 130 when Ctrl+C stops watch mode.
- There is no MCP tool and no plugin skill for this tool. The `gt:markdown` skill belongs to `tools markdown`.

## Troubleshooting

- **Escape codes such as `^[[91m` in a saved file.** `--color` keeps colour in a pipe. Drop it, or pass
  `--no-color`.
- **A table shows as cards.** The `auto` engine found it wider than the width. Pass a larger `--width`, or
  `--table-engine ascii` to keep the box with wrapped cells.
- **A table runs past the right edge.** The `cli-table3` and `plain` engines size columns to content (`plain` up to 50
  characters a cell). Use `ascii` or `cards`.
- **Code lines end mid-word at the right edge.** `--width` cuts lines that are still too long after wrapping. Pass
  a larger width.
- **Prose and tables have different widths in a pipe.** Prose falls back to 80 columns and tables to 100. Pass
  `--width`.

## Related

- [tools markdown](../markdown/README.md): resolves `{{kind …}}` tokens inside a note. This tool only displays.
- [tools json2md](../json2md/README.md): writes markdown from JSON to stdout, for example
  `tools json2md data.json | tools markdown-cli`.
- [tools github](../github/README.md): `tools github review 42 --md` writes a report and prints
  `View: tools markdown-cli <path>`.
- [tools mcp-web-reader](../mcp-web-reader/README.md): fetches a page as markdown, for example
  `tools mcp-web-reader https://example.com | tools markdown-cli`.
- [tools tools](../tools/README.md): the picker shows each tool's README through the same renderer.
