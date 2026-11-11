# tools tools

An interactive browser for every GenesisTools command, opened by plain `tools`.
Type part of a tool's name to find it, then run the tool, read its README, list its subcommands, or copy its command
to the clipboard. Use it when you do not remember a tool's exact name or what its subcommands are.

## Quick start

```bash
# Open the browser (the usual way: tools with no arguments)
tools

# The same browser, by its own name
tools tools

# In a worktree: browse that worktree's tools, not the main checkout's
./tools

# Not interactive: print every tool name and exit 0 (for scripts and agents)
tools --help
```

## Commands

The browser has no subcommands and reads no flags. `tools tools --help` and `tools tools --readme` open the browser
too, because the tool never reads its arguments. To read this page in a terminal, open the browser, pick `tools`, and
choose **View README**.

### The tool list

The first screen lists every tool, 12 rows at a time, each with a one-line hint. Type to filter.

| Key | What it does |
|-----|--------------|
| Any character | Filter the list (letters, digits, `-`). A case-insensitive substring of the tool name. |
| Backspace | Delete the last typed character. |
| Up, Down | Move the cursor. `↑ N more` and `↓ N more` count the hidden rows. |
| Enter | Open the action menu for the tool under the cursor. |
| Esc, Ctrl-C | Quit (in this list only). The browser prints `Bye!` and exits 0. |

The filter does not search the hints. To find a tool by what it does, scroll the list or search the READMEs.

### The action menu

| Action | What it does |
|--------|--------------|
| Run | Runs `tools <name>` with no arguments, then the browser exits. |
| View README | Renders `src/<name>/README.md`, then shows the menu again. |
| Explore subcommands | Lists the tool's top-level commands and options. |
| Copy command to clipboard | Copies `tools <name>`, then returns to the tool list. |
| Back to list | Returns to the tool list. Esc and Ctrl-C do the same here. |

**View README** is in the menu only when the tool has a `README.md`.

**Explore subcommands** shows a second list of the tool's commands. Pick one to copy `tools <name> <command>` to the
clipboard, or pick **Back**. Then it prints the tool's top-level options and shows the action menu again. It shows the
first level only: it does not walk into nested command groups.

## How it works

- **What it lists.** The browser scans the `src/` folder of the checkout whose code runs. A tool is a folder
  `src/<name>/` with an `index.ts` or `index.tsx`, or a single file `src/<name>.ts` or `src/<name>.tsx`. The `tools`
  wrapper uses the same rule, so the browser and `tools --help` list the same names (109 each on 2026-11-09).
  `tools` on PATH lists the checkout that `install.sh` put on PATH; `./tools` in a worktree lists that worktree.
- **What it leaves out.** A folder without an entry file (shared code, a dashboard bundle) is not a tool. `utils` and `Internal` are
  listed because their folders have an `index.ts`. The wrapper's short aliases have no entry file of their own, so
  they are not in the list either (`src/voice-memos/` holds only an old README): `tools calendar`, `tools reminders`
  and `tools voice-memos` run `tools macos <same name>`, and `tools usage` runs `tools ask usage`.
- **The hint.** Each row's hint is the first line of `src/<name>/README.md` that is not blank, a heading, a `---` rule,
  or an image or badge line. A hint longer than 80 characters is cut to 77 plus `...`. A tool without a README shows
  its name in title case (`utils` shows `Utils`). A single-file tool `src/<name>.ts` still takes its hint from
  `src/<name>/README.md`. So the first prose line of a README is that tool's hint: a blockquote such as
  `> **Some text**` shows with its `>` and `**`.
- **Run.** The browser starts `tools <name>` through the same checkout's `tools` wrapper, with the terminal's input
  and output, and exits with that tool's exit code. Since 2026-09-24 it goes through the wrapper, exactly as typing the
  name does. Before, it ran the tool's entry file directly and skipped `genesisAppLauncher()`, so macOS gave Calendar,
  Contacts, Accessibility and Full Disk Access requests to the terminal instead of GenesisTools.app. A
  permission-gated tool picked from the menu could then return empty where the same tool typed by name returned data.
- **View README.** It renders the file with the shared terminal markdown renderer, the one that `tools markdown-cli`
  and each tool's `--readme` use.
- **Explore subcommands.** It runs `bun run <entry file> --help` directly, not through the wrapper, and waits at most
  5 seconds. It reads the `Options:` and `Commands:` sections of Commander's help text. A command row is Commander's
  full term: the name, `|alias`, `[options]` and argument placeholders. So a copied command can read
  `tools <name> list|ls [options] <id>`: edit it before you run it. Commander's own `help [command]` row is in the list
  too.
- **Code.** Listing and hints are in `src/tools/lib/discovery.ts` (`discoverTools`, `getReadme`), Explore in
  `src/tools/lib/introspect.ts` (`introspectTool`), and the list widget is `searchSelect` in
  `src/utils/prompts/clack/search-select.ts`.
- **Side effects.** The browser writes nothing to disk, keeps no config, and makes no network calls. It writes only
  to the clipboard (`pbcopy` on macOS, through the `clipboardy` package). A tool you start with **Run** does whatever
  that tool does.

## For agents

The browser is interactive only, and it has no `--json` output, MCP tool or plugin skill. Without a terminal it draws
the list once and exits 0 (observed 2026-11-09 with input from `/dev/null`), so a script learns nothing from it.

```bash
# Every tool name, one per line under a usage header; exits 0 with or without a terminal
tools --help

# A tool's commands and flags
tools <tool> --help

# A tool's README (most tools; this one opens the browser instead)
tools <tool> --readme
```

`tools <text>` with no exact match prints `No exact match for <text>. Did you mean?` and offers a list of tool names
that contain the text, or that have a dash-separated part starting with it. With no match it prints
`Tool not found: <text>` and exits 1.

Exit codes of the browser: 0 after you quit, the tool's own code after **Run**, and 1 on an unexpected error.

## Troubleshooting

- **Explore subcommands says `No subcommands or options found.`** The tool's `--help` is not in Commander's format,
  or it took more than 5 seconds to print. Run `tools <name> --help` in the terminal instead.
- **A tool is not in the list.** Its folder has no `index.ts` or `index.tsx`, or the name is a wrapper alias. For a
  folder without an entry file, `tools <name>` prints `No entry point:` and how to run a file inside it by path.
- **A hint shows `>`, `**` or a cut sentence.** The hint is the README's first prose line. Make that line one plain
  sentence of 80 characters or fewer.
- **A tool picked with Run returns empty data where the same tool typed by name works.** That was the launcher bug
  fixed on 2026-09-24. If it still happens, check the grants with `tools macos permissions`; it exits 1 while a grant
  is missing.

## Related

- [tools markdown-cli](../markdown-cli/README.md): the renderer behind **View README**, as a tool of its own.
- [tools macos](../macos/README.md): `tools macos permissions` reports which grants GenesisTools.app holds.
- [tools genesis-tools](../genesis-tools/README.md): `logs failures` lists the failed runs of any tool started
  through the `tools` wrapper, which includes **Run**.
