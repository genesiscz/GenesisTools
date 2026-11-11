# tools cc

`tools cc` is a short front door to [`tools claude`](../claude/README.md): it forwards its arguments and picks the
subcommand for you, so resuming a Claude Code session needs none. It is a dispatcher, not a separate tool: use it at
the terminal, and use `tools claude` in scripts.

## Quick start

```bash
tools cc                      # pick one of this folder's 20 latest sessions and resume it
tools cc "timelog sync"       # resume the session that discussed this
tools cc -l                   # list this folder's recent sessions, resume nothing
tools cc -a "auth refactor"   # search every project, not just this folder
tools cc opus                 # launch Claude Code on Opus, on the account with the right headroom
tools cc history "worktree"   # forwarded: tools claude history "worktree"
```

The installer adds no bare `cc` command, and macOS already has one: `/usr/bin/cc` is the C compiler. For the
short form, add your own alias, for example `alias cc='tools cc'` in `~/.zshrc`. A shell alias applies only to
your interactive shell, so build scripts still reach the compiler.

## Routing

`tools cc` looks at the first word only.

| What you type                 | What actually runs                    |
|-------------------------------|---------------------------------------|
| `tools cc`                    | `tools claude resume`                 |
| `tools cc <query>`            | `tools claude resume <query>`         |
| `tools cc -l`, `-a`, `-n <n>` | `tools claude resume -l` (and so on)  |
| `tools cc opus` / `fable`     | `tools claude start opus` / `fable`   |
| `tools cc <pass-through> ...` | `tools claude <pass-through> ...`     |
| `tools cc --readme`           | prints this file                      |

The pass-through words are `tail`, `history`, `resume`, `desktop`, `usage`, `code`, `info`, `config`, `daemon`,
`migrate`, `login`, `login-long`, `login-secondary`, `logout`, `start`, `run`, `exec` and `doctor`.

Every other first word is a resume query. That is the point: `tools cc "auth bug"` searches your sessions for
"auth bug" instead of failing on an unknown command. Quote a query of several words: `resume` takes one argument,
so `tools cc auth bug` fails with `too many arguments for 'resume'`. The routing has three consequences:

- A `tools claude` command that is not on the list does not run. `tools cc who` searches your sessions for
  "who", and resumes the session when only one matches. The same happens with `export`, `memory`, `summarize`,
  `transcript`, `migrate-to`, `warmup`, `mcp`, `anchor`, `spending`, `embed`, `proxy`, `codex`, `teams`, `cmux`,
  `wait`, `message`, `decide`, `active`, `queue`, `worker` and `help`. Run those as `tools claude <command>`.
- To search for a word that is on the list, put `resume` in front: `tools cc usage` opens the usage dashboard,
  `tools cc resume usage` searches for "usage".
- `migrate` is on the list, but `tools claude` has no `migrate` command (its command is `migrate-to`), so
  `tools cc migrate` fails. Use `tools claude migrate-to codex`.

The match ignores case, but the word reaches `tools claude` as you typed it, and `tools claude` knows only the
lower-case names. Type subcommands in lower case (`opus` and `fable` work in any case).

All arguments go through unchanged, the first word included, so every flag of the target command works here.
`tools cc start work -- --model opus` reaches `claude` with `--model opus`, and `tools cc --help` prints the help
of `tools claude resume`.

## Commands

### Resume (the default)

```bash
tools cc [query] [-l] [-a] [-n <n>]
```

| Flag                 | What it does                                                    |
|----------------------|-----------------------------------------------------------------|
| `[query]`            | A session id prefix, a session name, or words to search for     |
| `-l, --list`         | Print the matching sessions and resume nothing                  |
| `-a, --all-projects` | Search every project (default: this folder)                     |
| `-n, --limit <n>`    | How many sessions to show (default: 20)                         |

With no query, you get this folder's most recent sessions in a table picker. Subagent sessions are left out. A
query finds sessions in this order:

1. An exact session id, a transcript path, or a session id prefix.
2. A session whose title or summary contains the query.
3. A search of the transcripts, unless the query already is one session's id, path or whole name. It adds every
   session whose transcript mentions the query, up to `-n`.

A full session id (a UUID) searches every project, with or without `-a`. With `-l`, a query also matches the branch,
the project and the first prompt, so the list can differ from what a resume offers.

Then:

- One match resumes without a question.
- Several matches open the table picker. Without a terminal, `tools cc` prints the table and exits 1.
- A running session that your query names (its title or id), or the only match, goes on top in a "Running in cmux"
  section. Enter there focuses its tab. Its row under "Resume from history" still starts a second copy, and the row
  says so. Without a terminal, no scan for running sessions runs.

Resume runs `claude --resume <id>` through your interactive shell (`$SHELL -ic`), in the folder the session
recorded. When that folder is gone (a removed worktree, for example), it warns and starts in the current folder.

Resume picks no account: Claude Code uses its own login, or whatever your shell wrapper sets. To resume on a saved
account, use `tools cc start <account> -r <query>`.

### Launch Claude Code

- `start|run [name]`: launch Claude Code with an account's saved long-lived token. `[name]` matches an account
  by exact name or substring, and `auto` picks the account with the most headroom. Main flags: `--pick`,
  `-a, --autopick`, `-m, --model <spec>`, `-e, --effort <level>`, `-r, --resume [query]`, `-c, --continue`,
  `--keychain`, `--cmux`, `--tmux`, `--sdk`, `--cross-messages`, `--no-cross-messages`. Arguments after `--` go
  to `claude`.
- `opus`, `fable`: smart aliases for `start`, described below.
- `exec`: run any command with an account's long-lived token in its environment, so `claude -p` in a hook or CI
  does not depend on the keychain login: `tools cc exec [-a <account>] [--no-verify] [--] <command> [args...]`.

#### Smart aliases: `tools cc opus` and `tools cc fable`

They run `tools claude start opus` and `tools claude start fable`. `start` reads the word as a model and a way to
pick the account. When one of your accounts is really named `opus` or `fable`, that account wins and no smart pick
happens.

- Both set the model: the current Opus or Fable model with the 1M context window (`[1m]`). An explicit
  `-m, --model` wins.
- `opus` spends what is left over. It wants at least 10% weekly headroom, puts accounts whose 5-hour window is
  spent last, keeps Fable-capable accounts for Fable work, and among the rest takes the emptiest, so a half-spent
  week is used before a fresh one. When no account has 10% weekly left, it takes the fullest one and warns.
- `fable` wants room for a long run. It looks only at accounts with Fable access and more than 1% Fable left. The
  room of an account is the smaller of its Fable and weekly buckets. Every account within 10 points of the best
  counts as enough, and among those, the one whose Fable window resets soonest wins.
- Before the launch it prints the account it picked and its headroom.
- It never blocks a launch. When usage data is missing or no account qualifies, it says so and opens the normal
  account picker.

### Sessions

- `tail [query]`: live-tail a session or a subagent. Main flags: `--no-follow`, `--stop-on-finish`,
  `--include <spec>` (`thinking`, `tools`, `agents` and finer specifiers), `-t, --last-turns <n>` (default: 5),
  `-c, --last-calls <n>`, `-a, --agent <id>`, `-l, --list-sessions`, `-o, --output <file>`, `--raw`,
  `--timestamps`.
- `history [query]`: search conversation history. Main flags: `--all`, `-p, --project <name>`, `--since <date>`,
  `--until <date>`, `-l, --limit <n>` (default: 20), `--exact`, `--regex`, `--json`, `-f, --file <pattern>`,
  `-t, --tool <name>`, `-c, --context <n>`, `--commit <hash>`, `-q, --query <text>`. Subcommands: `index`,
  `extract-shell-quirks`, `dashboard`.
- `resume [query]`: the default path above, by name. Use it to search for a word that is itself a pass-through.

### Accounts and usage

- `login [name]`: OAuth login that adds an account, with auto-refresh.
- `login-long [name]`: attach a long-lived token to an account (`--setup-token` mints it through OAuth).
  `start`, `run`, `opus`, `fable` and `exec` need one.
- `login-secondary [name]`: a second OAuth grant on an account, used only by `start --keychain`.
- `logout [name]`: remove tokens. `--oauth`, `--long-lived`, `--secondary`, `--both`, `--all`, `-y, --yes`.
- `config`: `add <name>`, `remove <name>`, `rename <old> [new]`, `refresh [name]`, `show`,
  `cross-messages [accept|hold]`.
- `info [name]`: account info and cached usage, with no network call. `--format text|json` (default: text).
- `usage`: the usage dashboard (a TUI). `--account <name...>`, `--range 60m|6h|24h|7d`, `--json`, `--no-tui`,
  `--fresh`, `--watch`. Subcommand: `sessions`.
- `daemon`: `register`, `unregister`, `status` for background usage polling.
- `doctor`: find running pinned sessions that bill the keychain account instead of their pin. `--identity` also
  proves which account each token bills and spends one 1-token completion per account.

### Other

- `desktop`: sync skills from `~/.claude/skills/` to Claude Desktop. `--all`, `--list`.
- `code`: `versions`, `unpack <version>`, `diff <v1> <v2>` and `bisect <from> <to>` over the published Claude Code
  CLI bundles.
- `migrate`: on the pass-through list, but it does not exist in `tools claude`. See Routing.

`-a` means a different thing per command: all projects on the resume path, auto-pick on `start`, an agent id on
`tail`, an account on `exec`.

The full manual for each of these commands is [`tools claude`](../claude/README.md).

## How it works

- `tools cc` is one file, `src/cc/index.ts`. It reads the first argument, picks the route, and spawns
  `bun run src/claude/index.ts` with the routed arguments, from the same checkout and with your terminal's
  stdin, stdout and stderr. It exits with that process's exit code. In a worktree, `./tools cc` runs that
  worktree's `tools claude`.
- `--readme` as the first argument is handled by `tools cc` itself and prints this file. All other flags go to
  `tools claude`.
- `tools cc` has no config and stores nothing. The data belongs to `tools claude`:
  - the session history index: `~/.genesis-tools/claude-history/index.db`
  - the transcripts: Claude Code's home, `~/.claude` or `$CLAUDE_CONFIG_DIR`
  - the accounts: `~/.genesis-tools/ai/config.json`, with the credentials encrypted in
    `~/.genesis-tools/security/vault.json`
  - the command that resume starts: `~/.genesis-tools/claude/resolved-command.json`
- Resume starts the first of `ccc`, `cc` and `claude` whose `--version`, run in your interactive shell, prints
  "Claude Code". So a wrapper function in your rc file wins over the plain binary. The answer is cached for 7 days,
  and an edit of `~/.zshrc` (or `~/.bashrc`) clears it.
- `GENESIS_TOOLS_HOME` replaces the home folder for GenesisTools data: the files go to `$GENESIS_TOOLS_HOME/.genesis-tools/`
  instead of `~/.genesis-tools/`.
- Cost: the resume path reads only local history and the running processes. A launch uses your Claude
  subscription. `doctor --identity` spends one tiny completion per account.

## For agents

- In a script, call `tools claude <command>`, not `tools cc`. A mistyped or unlisted word becomes a resume
  search, and a single match starts an interactive Claude Code session.
- `tools cc` has no JSON output of its own. The JSON flags belong to the commands: `tools claude history --json`,
  `tools claude usage --json`, `tools claude info --format json`.
- `tools cc -l` and `tools cc <query> -l` list sessions without a terminal and never resume.
- Without a terminal, a query that matches several sessions prints them and exits 1 with
  `Ambiguous claude resume (N matches)` (`Claude` with a capital C when there was no query). Pass a session id
  from that table.
- The exit code is the exit code of `tools claude`.
- The plugin skill `gt:claude-history` (`plugins/genesis-tools/skills/claude-history/SKILL.md`) explains how
  history search and provider-scoped resume work.

## Troubleshooting

- **`tools cc who` (or `teams`, `cmux`, `proxy`, ...) searches sessions instead of running the command.** Only
  the pass-through words reach their `tools claude` command; every other word is a resume query. Run
  `tools claude who`.
- **`error: too many arguments for 'resume'`.** A query of several words was not quoted. Run
  `tools cc "auth bug"`, not `tools cc auth bug`.
- **`tools cc usage` opens the dashboard when you meant to search for "usage".** The word is a pass-through. Run
  `tools cc resume usage`.
- **`tools cc migrate` fails with an unknown command.** `tools claude` names that command `migrate-to`. Run
  `tools claude migrate-to codex`.
- **`tools cc Tail` fails with an unknown command.** The route ignores case, but `tools claude` does not. Type
  `tools cc tail`.
- **`No Claude sessions for ~/Projects/app (current folder)`.** Without `-a`, resume searches only the current
  folder. Run `tools cc -a <query>`. With a query the message is `No claude session matches "<query>" in this project scope`;
  the fix is the same.
- **`Ambiguous claude resume (N matches)`.** There was no terminal for the picker. Pass a session id from the
  printed table, or run the command in a terminal.
- **`Recorded directory is gone: ... Starting in ... instead.`** The folder the session ran in was removed (a
  deleted worktree, for example). The session resumes in the current folder, so run the command from the folder
  you want it to start in.
- **`This session belongs to <home>, not the selected Claude home`.** The session lives in another Claude home
  (`CLAUDE_CONFIG_DIR`). Nothing was migrated. Run the command it prints, which sets `CLAUDE_CONFIG_DIR` for you.
- **`No accounts with a long-lived token.` from `tools cc opus`.** The smart aliases launch through `start`, which
  needs a saved token. Run `tools claude login-long <name>` first.
- **`cc` prints a compiler error.** Without your own alias, bare `cc` is `/usr/bin/cc`, the C compiler. Type
  `tools cc`, or add `alias cc='tools cc'` to `~/.zshrc`.

## Related

- [`tools claude`](../claude/README.md): the full manual for every command `tools cc` forwards to.
- [`tools cmux`](../cmux/README.md): the terminal tabs that resume focuses when a session already runs.
- [`tools codex`](../codex/README.md): the same resume search for Codex sessions.
- [`tools ai`](../ai/README.md): the account store that `start`, `opus` and `fable` read.
