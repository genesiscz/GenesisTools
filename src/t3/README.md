# tools t3

Adds GenesisTools accounts to [T3 Code](https://github.com/pingdotgg/t3code) as provider instances. Each instance
runs an agent (Claude, Codex or Grok) through `tools <agent> embed`, so T3 Code bills the account the instance names.
Use it when T3 Code should offer one provider per account, such as "Claude Code (work)" and "Codex (personal)".

## Quick start

```bash
tools t3 launchers install                    # write claude-tools, codex-tools, grok-tools to ~/.genesis-tools/bin
tools t3 providers sync                       # one T3 Code instance per account each agent can run (asks first)
tools t3 providers add claude --account work  # add or update one instance: gt-claude-work
tools t3 providers list                       # every instance in T3 Code's settings, with its account status
tools t3 providers doctor                     # read-only checks, with the commands that fix what they find
```

Run `launchers install` first: every instance points at a launcher. T3 Code reloads its settings file when it
changes, so you do not restart it.

## Commands

| Command | What it does |
|---|---|
| `launchers install` | Write the launcher scripts T3 Code runs as an agent binary |
| `providers list` | Every instance in the settings file, with its driver, binary and account |
| `providers add <alias>` | Add or update one instance `gt-<alias>-<account>` |
| `providers sync` | One instance per runnable account of every agent |
| `providers doctor` | Read-only checks of the launchers and the `gt-` instances |

`<alias>` is always `claude`, `codex` or `grok`. Every command takes `--json`. The root command also takes
`-v, --verbose` (verbose logging) and `--readme` (print this page).

### Launchers

```bash
tools t3 launchers install \
    [--bin-dir <dir>] \
    [--checkout <dir>] \
    [--account <alias>:<name> ...] \
    [--json]
```

Writes one launcher per agent, `claude-tools`, `codex-tools` and `grok-tools`, into `~/.genesis-tools/bin`, mode 755.
The embed command they run reads the account from `TOOLS_<ALIAS>_EMBED_ACCOUNT`, which the T3 Code instance sets.

| Flag | Default | What it does |
|---|---|---|
| `--bin-dir <dir>` | `~/.genesis-tools/bin` | The folder the launchers go in |
| `--checkout <dir>` | `tools` on PATH | The GenesisTools checkout to run |
| `--account <alias>:<name>` | none | Also write `<alias>-tools@<name>` (repeatable) |
| `--json` | off | Print the result as JSON |

- A launcher written for `--account claude:work` is `claude-tools@work`. It exports `TOOLS_CLAUDE_EMBED_ACCOUNT`
  itself, so it runs that account with no variable set by the host. In the file name, every run of characters
  other than letters, digits, `.`, `_` and `-` becomes `-`.
- The default checkout is the folder of `tools` on PATH, with symlinks resolved (the main checkout). When that folder
  is a linked git worktree, the install refuses, because a launcher outlives the worktree. Pass `--checkout` to use a
  worktree on purpose. The checkout must hold an executable `tools` file.
- The same content is a no-op (it only puts mode 755 back). The table shows LAUNCHER, ACCOUNT and STATUS
  (`created`, `updated` or `unchanged`), then the checkout.
- Two accounts whose file names come out equal (`work laptop` and `work-laptop` both become `@work-laptop`), or a
  launcher that already pins another account, refuse the whole install, and nothing is written.

A launcher looks like this (`claude-tools@work`; the env-driven `claude-tools` has no `export TOOLS_CLAUDE_EMBED_ACCOUNT` line):

```zsh
#!/bin/zsh
# claude for apps that embed it (T3 Code). Written by tools t3 launchers install; rewrite it with that command.
export PATH="$HOME/.bun/bin:$PATH"
export TOOLS_CLAUDE_EMBED_ACCOUNT='work'
# ... the --version fast path (see "How it works") ...
exec '/path/to/GenesisTools/tools' claude embed -- "$@"
```

### Provider instances

```bash
tools t3 providers list   [--settings <path>] [--json]
tools t3 providers add    <alias> [--account <value>] [--display-name <text>] \
                          [--steer [next|off]] [--json]
tools t3 providers sync   [--yes] [--json]
tools t3 providers doctor [--settings <path>] [--bin-dir <dir>] [--json]
```

The path flags point the commands at other files:

| Flag | Default | Taken by |
|---|---|---|
| `--settings <path>` | `~/.t3/userdata/settings.json` | list, add, sync, doctor |
| `--bin-dir <dir>` | `~/.genesis-tools/bin` | add, sync, doctor |
| `--backup-dir <dir>` | `~/.genesis-tools/t3/backups` | add, sync |

#### `providers list`

Prints every instance in the settings file, also the ones this tool does not own (marked `(not ours)`): ID, DRIVER,
NAME, BINARY, EMBED ACCOUNT and IN AI CONFIG, then the count of all and of owned (`gt-`) instances. IN AI CONFIG is:

- `exists`: the account is in the AI config, under the agent's provider.
- `auto`: the embed picks an account at each launch.
- `proxy`: a `proxy:<account>/<provider>` target, which goes through the ai-proxy.
- `missing`: no account has that name or id.
- `wrong-provider`: the name belongs to another provider's account.
- `invalid`: the value cannot be read (`proxy:` with no target).
- `none`: the instance sets no embed account variable.

#### `providers add <alias>`

```bash
tools t3 providers add claude --account work --steer next
tools t3 providers add codex --account auto --display-name "Codex (any account)"
```

Adds or updates one instance `gt-<alias>-<account slug>`:

- `driver`: the T3 Code driver of the agent's embed host protocol (table below).
- `config.binaryPath`: the env-driven launcher, `<bin-dir>/<alias>-tools`. When that file is missing, `add` warns
  and prints the `launchers install` command, and still writes the instance. If you passed `--settings`, remove it
  from the printed command: `launchers install` has no such flag.
- `environment`: `TOOLS_<ALIAS>_EMBED_ACCOUNT` set to the `--account` value.

| Agent | T3 Code driver | Embed host protocol |
|---|---|---|
| claude | `claudeAgent` | `claude-stream-json` |
| codex | `codex` | `codex-app-server` |
| grok | `grok` | `acp` |

The driver ids were checked against the T3 Code source on 2026-11-01.

- `--account <value>`: an account name or id, `auto`, or `proxy:<account>/<provider>`. Without it, a terminal shows
  a picker (`auto` and every runnable account). Outside a terminal, `add` fails and prints an example command.
- A runnable account is enabled, not tagged gate-only, and under the agent's provider (`anthropic-sub`, `openai-sub`
  or `grok-sub`). A Claude account also needs a long-lived token (`tools claude login-long`), because the Claude
  embed runs `tools claude run --sdk`, which runs a named account on that token. `add` refuses any other account.
- `proxy:<account>/<provider>` works only for an agent whose embed launcher serves the ai-proxy
  (`EmbedLauncher.servesProxy`; Claude today). `add` refuses it for Codex and Grok, because the instance could never
  start.
- `--display-name <text>`: the name T3 Code shows. A new instance gets `<Agent> (<account>)`, such as
  `Claude Code (work)`, `Codex (work)` or `Grok (work)`. Without the flag, an existing name stays, because T3 Code
  lets you rename an instance.
- `--steer next` adds `TOOLS_CLAUDE_EMBED_STEER=next`, and `--steer off` removes it. Without the flag, the variable
  stays as it is. A bare `--steer` asks in a terminal. It works for Claude only; for Codex and Grok it fails.
  With `next`, a steer (a message with `priority: "now"`, which aborts the running tool) waits for the next tool
  boundary instead. The Stop button still stops the command.

The instance id is `gt-<alias>-` plus the account in lower case, with every run of characters other than `a-z` and
`0-9` (so `_` and `.` too) turned into
`-`, no `-` at either end (an empty result becomes `default`), at most 64 characters, prefix included (T3 Code's id
rule is `^[a-zA-Z][a-zA-Z0-9_-]*$`). `alice@example.com` becomes
`gt-claude-alice-example-com`, and `auto` becomes `gt-claude-auto`. Two account names that map to one id
(`work laptop` and `work-laptop`, `Work` and `work`, or names whose ids differ only past the id's 64th character) are refused,
and nothing is written. If you edit the variable of `gt-claude-work` by hand to another account,
`tools t3 providers add claude --account work` puts `work` back.

A new instance has this shape (`enabled: true` because T3 Code leaves a Grok instance off without it; the binary path
is absolute in the file):

```json
"gt-claude-work": {
  "driver": "claudeAgent",
  "displayName": "Claude Code (work)",
  "enabled": true,
  "environment": [{ "name": "TOOLS_CLAUDE_EMBED_ACCOUNT", "value": "work", "sensitive": false }],
  "config": { "binaryPath": "~/.genesis-tools/bin/claude-tools" }
}
```

#### `providers sync`

Writes one instance per runnable account of every agent: every enabled account that is not gate-only, under the
agent's provider (`anthropic-sub`, `openai-sub`, `grok-sub`), and for Claude only the accounts with a long-lived
token. It prints a plan (INSTANCE, AGENT, ACCOUNT,
ACTION: `create`, `update` or `unchanged`), then asks "Write N instances into <path>?". Outside a terminal it needs
`--yes`, and without it exits 1 and writes nothing.

- `sync` never removes an instance, also not one whose account is gone. Remove it in T3 Code.
- It sets the driver, the binary and the account variable. It keeps a steer variable and a display name that are
  already there, and it makes no `auto` instance (use `add <alias> --account auto`).
- Nothing to change prints "Nothing to change" and writes no backup.

#### `providers doctor`

Only reads, and prints a table (CHECK `ok`, `warn` or `fail`; SUBJECT; DETAIL), then the commands that fix what it
found. It never runs them. It exits 1 when a check fails; warnings alone exit 0.

- Every launcher in the bin folder, env-driven and `@<account>`: present, executable, with the `embed --` exec line
  (an older form is a warning), a checkout with an executable `tools`, and the same text `install` writes today (a
  difference is a warning). A per-account launcher must pin an account that is in the AI config under its provider. One that is not
  executable, or has no account line, is a warning ("cannot read the account it pins"), not a failure.
- Every `gt-` instance: an embed account variable, the driver its agent needs, an executable binary, and an account
  that exists. A `proxy:` account on an agent whose launcher serves no ai-proxy is a failure, because it never starts.
- A settings file that is missing or not strict JSON is a failure.

A launcher fix always names the `--bin-dir` doctor checked, even when you passed none. An instance fix
(`providers add ...`) repeats the `--settings` and `--bin-dir` you passed. The fix for a missing instance binary is a
plain `tools t3 launchers install`, so add your `--bin-dir` to it yourself.

## How it works

T3 Code keeps its provider instances in `~/.t3/userdata/settings.json`. Each instance names a driver and a binary.
This tool points the binary at a launcher and puts `TOOLS_<ALIAS>_EMBED_ACCOUNT` in the instance's environment. When
T3 Code starts the binary, the launcher runs `tools <alias> embed -- <T3 Code's arguments>`, and the embed command
runs the real agent binary as that account. What each embed does (the Claude stream-json host, the Codex app-server
login, the Grok ACP session) is in the agent's own README.

Files:

- `~/.t3/userdata/settings.json`: T3 Code's settings, owned by T3 Code (`--settings`).
- `~/.genesis-tools/bin/<alias>-tools` and `<alias>-tools@<account>`: the launchers (`--bin-dir`).
- `~/.genesis-tools/t3/backups/settings-<timestamp>.json`: the settings file before each write, mode 600
  (`--backup-dir`).
- `<settings file>.gt-t3.lock`: the write lock, beside the settings file.
- `~/.genesis-tools/ai/config.json`: the AI accounts. They are read with `AiConfigStore.readOnly()`, without
  migrations; nothing here writes the AI config.
- `~/.genesis-tools/claude/embed-version.txt`: the last `--version` answer of the Claude binary.

It needs T3 Code started once (so the settings file exists), Bun in `~/.bun/bin` (the launcher puts it first on
PATH), and the agent binaries. The tool itself makes no network call and spends nothing. Each T3 Code turn bills the
account its instance names.

### The `--version` fast path

T3 Code runs `--version` on every status refresh of every instance (every 5 minutes; 14 Claude instances on
2026-11-02). A bare `--version` reads no login, so the launcher answers it from
`~/.genesis-tools/<alias>/embed-version.txt` without starting Bun, while the binary (`~/.bun/bin/<alias>` or
`~/.local/bin/<alias>`) still points where it did and is older than the saved answer. Anything else goes on to the
exec line. Only the Claude embed saves that answer today, so the Codex and Grok launchers always start Bun.

### How settings.json is written

T3 Code owns `~/.t3/userdata/settings.json` and reloads it when it changes. `tools t3` only adds or updates instances
whose id starts with `gt-`; every other byte stays as it was (the edit splices one member's text, so key order,
indentation and number spelling do not change). Inside an owned instance it sets `driver`, `config.binaryPath` and its
own variables, and keeps the rest (a display name or colour set in T3 Code, other variables, other config keys). When
the file has no `providerInstances` yet, it is added at the end of the root object.

Each write takes a lock (10 s timeout), re-reads the file and compares its hash with the one the change was planned
from. A change in between is merged again once; a second change refuses and writes nothing. The previous file is
copied to `~/.genesis-tools/t3/backups/settings-<timestamp>.json` (`--backup-dir`), and the new file is written
atomically. A symlinked settings path writes the file it points to. The file must be strict JSON (no comments, no
trailing commas), which is what T3 Code writes.

## Configuration

`tools t3` has no config file. It reads these:

- **Accounts**: the shared AI config. List them with `tools ai config account list`; add a Claude long-lived token with
  `tools claude login-long`.
- `TOOLS_CLAUDE_EMBED_ACCOUNT`, `TOOLS_CODEX_EMBED_ACCOUNT`, `TOOLS_GROK_EMBED_ACCOUNT`: the account an embed runs,
  set per instance. Empty or `auto` picks automatically.
- `TOOLS_CLAUDE_EMBED_STEER=next`: set by `--steer next`.
- `GENESIS_TOOLS_HOME`: moves the home under which `.genesis-tools` lives (launchers, backups, AI config). The T3 Code
  settings path stays under your real home.

## For agents

- Every command takes `--json` and prints one JSON object on stdout:
  - `launchers install`: `{ binDir, checkout, launchers: [{ path, spec: { alias, account }, status }] }`.
  - `providers list`: `{ settingsPath, instances: [{ id, owned, driver, displayName, enabled, binaryPath,
    embedAccount, embedAlias, accountStatus }] }`.
  - `providers add` and `providers sync`: `{ status: "written" | "unchanged", changed, settingsPath, backupPath }`.
  - `providers doctor`: `{ findings: [{ level: "ok" | "warn" | "err", subject, message, fix }] }`.
- Outside a terminal nothing prompts: `add` needs `--account`, `sync` needs `--yes`, and `--steer` needs a value.
- Exit code 1 on any error, for example: an unknown alias or account, `--steer` for Codex or Grok, a refused `proxy:` target, `sync` without
  `--yes` outside a terminal, a launcher or instance id collision, a missing or non-strict settings file, a file that
  changed twice during a write, and `doctor` with a failed check. Also: `add` without `--account` outside a terminal,
  an unknown `--steer` value,
  a malformed `--account` or no usable checkout for `launchers install`, and a settings lock that times out after
  10 s. On exit 1 there is no JSON: the message is on stderr (`ERROR: ...`), and `add` or `sync` may print an
  example command on stdout.
- Run `providers doctor --json` before and after a change; its `fix` fields are the commands to run.

## Troubleshooting

- **`No T3 Code settings at <path>`**: T3 Code has not written its settings yet. Start T3 Code once, or pass
  `--settings <path>`.
- **`<path> is not strict JSON, so tools t3 will not edit it`**: the file has comments or trailing commas. Fix the
  file by hand; T3 Code itself writes strict JSON.
- **`<path> changed twice while tools t3 was writing it`**: another writer (T3 Code) changed the file during both
  tries. Nothing was written. Run the command again.
- **`tools on PATH resolves to the worktree <dir>`**, **`No tools on PATH`**, **`tools on PATH (<path>) is not
  inside a GenesisTools checkout`** or **`<checkout> has no runnable tools entry point`**: `launchers install`
  cannot pick a checkout. Pass `--checkout <dir>` with a folder that holds an executable `tools`.
- **`... map to the same launcher <path>`** or **`... map to the same T3 Code instance id`**: two account names come
  out equal. Rename one of the accounts. For a launcher, you can also move the old file away first; for an
  instance, remove it in T3 Code first.
- **`No <provider> account "<name>" that <alias> can run in T3 Code`**: the account is disabled, gate-only, under
  another provider, or (Claude) has no long-lived token. Check `tools ai config account list`, then
  `tools claude login-long` for Claude.
- **`--steer works only for an agent whose embed launcher reads a steer variable`**: only Claude has a steer variable.
- **An instance does not start in T3 Code**: run `tools t3 providers doctor`. It names a missing launcher, a wrong
  driver, a gone account, or a `proxy:` target the agent cannot serve, and prints the fix.

## Related

- [tools claude](../claude/README.md): `tools claude embed`, `--sdk`, the steer variable, long-lived tokens.
- [tools codex](../codex/README.md): `tools codex embed` and the app-server login.
- [tools grok](../grok/README.md): `tools grok embed` over ACP.
- [tools ai](../ai/README.md): the accounts every instance names.
- [tools ai-proxy](../ai-proxy/README.md): the targets behind `proxy:<account>/<provider>`.
