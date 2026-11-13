# tools open

Opens files, folders and URLs the way macOS `open` does, and logs every open with the agent that asked for it: the
harness, the session id and title, the project, the branch and the commit. Agents use it instead of a bare `open`, so
`tools open log` can later answer which session opened a file, a page or an app, and why.

## Quick start

```bash
tools open notes.md                      # open with the default app
tools open -a Cursor src/index.ts        # open with a named app (open -a)
tools open -R ~/Downloads/report.pdf     # reveal in Finder (open -R)
tools open -g https://example.org/ --why "the docs the user asked for"   # keep the app in the background, log why
tools open log                           # the 20 newest opens, with agent and session
tools open log --session a7346bf7 --json # the opens of one session, as JSON
```

## Commands

### `tools open <targets...>`

Opens one or more files, folders or URLs in one `open` call and appends one record to the log. With no target it
prints the help. Without `--json`, a successful open prints nothing on stdout.

| Flag                | What it does                                    |
|---------------------|-------------------------------------------------|
| `-a, --app <app>`   | Open with this app (`open -a`)                  |
| `-b, --bundle <id>` | Open with the app of this bundle id (`open -b`) |
| `-R, --reveal`      | Reveal in Finder instead of opening (`open -R`) |
| `-g, --background`  | Do not bring the app to the front (`open -g`)   |
| `--why <text>`      | Why it is opened, kept in the log               |
| `--json`            | Print the logged record as JSON on stdout       |

```bash
tools open -b com.apple.TextEdit notes.md todo.md   # two files, one app, one record
tools open "~/Projects/app"                          # a quoted ~ is expanded too
tools open mailto:alice@example.com                  # a URL goes to the app of its scheme
```

The flags apply to every target of the call. The tool sorts each target before `open` runs:

- An existing path (relative to the current folder, with a leading `~` expanded) is a `file` or a `folder`. `open`
  gets its absolute path.
- A word that starts with a URL scheme (`https:`, `mailto:`, `cursor:`) and is not an existing local path is a `url`.
  `open` gets it as you typed it.
- Anything else is `missing`. `open` still gets its absolute path, and the tool warns
  `<name>: no such file or folder (<path>)`.

Gotchas:

- A local file wins over a name that looks like a URL scheme: `report:2026.txt` in the current folder opens that
  file.
- `tools open log` runs the log command. To open a file that is literally named `log`, pass `./log`.
- A failed open still writes its record, with the exit code and the stderr of `open`. The tool prints that stderr as
  an error and exits with the same code. The stdout of `open` is dropped.

### `tools open log`

Lists the logged opens, newest first, with the agent and session that opened each.

| Flag              | What it does                                                     |
|-------------------|------------------------------------------------------------------|
| `-n, --limit <n>` | How many records (default 20; `0` or a non-number also gives 20) |
| `--session <id>`  | Only opens by this agent session; a prefix of the id is enough   |
| `--json`          | Print the records as a JSON array on stdout                      |

The table has these columns:

- `WHEN`: Prague local time in Czech date format, such as `5. 11. 2026 19:34:39`.
- `OPENED`: the absolute path or URL of each target, one per line.
- `HOW`: `reveal`, the app (or else the bundle id) and `exit <code>` when they apply; a plain open that worked shows
  `open`.
- `AGENT`, `SESSION` (the first eight characters of the id), `PROJECT` and `WHY`.

Long cells are cut, and an empty `SESSION`, `PROJECT` or `WHY` cell shows a dash. The last line names the log file.
With no records it prints `No opens logged yet (<log path>).`

`log` reads only the newest 4 MB of the log, so `--session` cannot find an older open. Every record stays in the
file, so search the file for those:

```bash
rg a7346bf7 ~/.genesis-tools/open/opens.jsonl
jq -c 'select(.caller.agent == "codex") | {at, why, argv}' ~/.genesis-tools/open/opens.jsonl
```

## How it works

- **What runs.** The tool starts macOS `open` with the flags in a fixed order (`open -a <app> -b <id> -R -g
  <targets>`), so it works on macOS only. It needs no network and costs nothing.
- **Who asked.** The caller comes from the shared agent identity module. It is the same stamp the question and answer
  log keeps (`whoIsCallingHere` with `STAMP_FACETS`: the folder, its git facts and the session title). The agent and
  the session come from the harness's own variable: `CLAUDE_CODE_SESSION_ID` (Claude Code), `CODEX_THREAD_ID`
  (Codex), `GROK_SESSION_ID` (Grok) or `COPILOT_AGENT_SESSION_ID` (Copilot). `CLAUDECODE` (Claude Code) or
  `CODEX_CI=1` (Codex) names the agent without a session, so AGENT can be known while the session id is `null`. From
  a plain terminal the agent is `unknown` and the session id is `null`.
- **The log.** `~/.genesis-tools/open/opens.jsonl` (`GENESIS_TOOLS_HOME` replaces the home folder when it is set, so the log is
  `$GENESIS_TOOLS_HOME/.genesis-tools/open/opens.jsonl`; the day log moves the same way). The tool appends
  one JSON record per open and never trims the file.
- **The day log.** Each open also writes one line to `~/.genesis-tools/logs/<date>.log`: `opened` at debug level, or
  `open failed` as a warning with the stderr. A non-zero exit is a failed run, so it shows in
  `tools genesis-tools logs failures`.

One record has these fields:

- `at`: the time of the open, ISO 8601 in UTC.
- `targets`: one `{ given, path, kind }` per target. `kind` is `file`, `folder`, `url` or `missing`; a URL has no
  `path`.
- `app`, `bundleId`, `reveal`, `background`, `why`: present only when set.
- `argv`: the exact `open` command line.
- `exitCode`, and `stderr` when `open` wrote any.
- `caller`: `agent` (`claude-code`, `codex`, `grok`, `copilot` or `unknown`), `sessionId`, `isInAgent`, `aiAgent`
  (the `AI_AGENT` label, when the host takes one), `sessionTitle`, `project`, `repoRoot`, `cwd`, `isWorktree`,
  `worktreePath`, `branch`, `commitSha` and `commitMessage`.

## For agents

- Open things for the user with `tools open`, not a bare `open`, and pass `--why` with a few words. The record then
  carries your harness, session, project and branch.
- `--json` prints the record on stdout. Warnings and errors go to stderr. `log --json` prints an array, newest first,
  and `[]` when the log is empty.
- The exit code is 0 on success, otherwise the exit code of `open`.

## Troubleshooting

- **A file in `~/Downloads`, `~/Desktop` or `~/Documents` reads as missing.** The check runs in the `tools` process,
  and macOS privacy can hide that folder from it. The path still goes to `open`. Run `tools macos permissions` to see the
  grant, then `tools macos permissions request downloads` (or `desktop`, `documents`) to ask for it.
- **`AGENT` shows `unknown` and `SESSION` shows a dash.** The command ran outside an agent, or in a shell that did not get
  the harness's session variable (see "Who asked" above).
- **`log` misses an older open.** It reads only the newest 4 MB of the log. Search the file with `rg` or `jq`.

## Related

- [`tools question`](../question/README.md): the question and answer log, which keeps the same caller stamp.
- [`tools genesis-tools`](../genesis-tools/README.md): `logs failures` lists failed opens with the other failed runs.
- [`tools macos`](../macos/README.md): `permissions` shows the folder grants of GenesisTools.app.
