# tools t3

Adds GenesisTools accounts to [T3 Code](https://github.com/pingdotgg/t3code) as provider instances. Each instance
runs an agent through `tools <agent> embed`, so T3 Code bills the account the instance names.

## Launchers

```bash
tools t3 launchers install [--bin-dir <dir>] [--checkout <GenesisTools checkout>] [--account <alias>:<name> ...]
```

Writes `<alias>-tools` for every agent (claude, codex, grok) into `~/.genesis-tools/bin`, mode 755:

```zsh
#!/bin/zsh
export PATH="$HOME/.bun/bin:$PATH"
exec '<checkout>/tools' claude embed -- "$@"
```

The embed command reads the account from `TOOLS_<ALIAS>_EMBED_ACCOUNT`, which the T3 Code instance sets. Each
`--account claude:work` also writes `claude-tools@work`, which exports that variable itself. The default checkout is
the one whose `tools` is on PATH (the main checkout); a worktree needs `--checkout`. The same content is a no-op.

## Provider instances

```bash
tools t3 providers list   [--settings <path>] [--json]
tools t3 providers add    <alias> --account <name|auto|proxy:<account>/<provider>> [--display-name <text>] [--steer next|off]
tools t3 providers sync   [--yes]
tools t3 providers doctor [--settings <path>] [--bin-dir <dir>] [--json]
```

- `add` writes one instance `gt-<alias>-<account slug>`: the agent's T3 driver (`claudeAgent`, `codex`, `grok`, from
  the embed launcher's host protocol), `config.binaryPath` = the env-driven launcher, and the embed variable in
  `environment`. `--steer next` adds `TOOLS_CLAUDE_EMBED_STEER=next` (Claude only); `--steer off` removes it.
- `sync` writes one instance per enabled account: Claude accounts with a long-lived token, every Codex (`openai-sub`)
  and Grok (`grok-sub`) account. It asks first in a terminal and needs `--yes` elsewhere. It never removes an instance.
- `doctor` only reads. It checks every launcher (present, executable, current form, an existing checkout) and every
  `gt-` instance (driver, binary, account in the AI config), and prints the commands that fix what it finds.

Accounts are read with `AiConfigStore.readOnly()`; nothing here writes the AI config.

## How settings.json is written

T3 Code owns `~/.t3/userdata/settings.json` and reloads it when it changes. `tools t3` only adds or updates instances
whose id starts with `gt-`; every other byte stays as it was (the edit splices one member's text, so key order,
indentation and number spelling do not change). Inside an owned instance it sets `driver`, `config.binaryPath` and its
own variables, and keeps the rest (a display name or colour set in T3 Code, other variables, other config keys).

Each write takes a lock, re-reads the file and compares its hash with the one the change was planned from. A change in
between is merged again once; a second change refuses and writes nothing. The previous file is copied to
`~/.genesis-tools/t3/backups/settings-<timestamp>.json` (`--backup-dir`), and the new file is written atomically.
The file must be strict JSON, which is what T3 Code writes.
