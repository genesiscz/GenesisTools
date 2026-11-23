# tools work

One store of work items: handoffs, their tasks, things an agent saw and did not fix, epics and todos, with typed
references between them. The library is `src/utils/work/` (package code); this folder is the command line and the
adapters of its ports.

## The store

- `~/.genesis-tools/work/work.db` (SQLite, WAL). Rows are the truth; `applyChange` is the only writer of item rows
  and writes a journal entry (`changes`) in the same transaction.
- An item has a type (`epic, handoff, feature, bug, incident, task, test, cleanup, check, idea, risk, limit, todo`)
  and a state (`spotted, open, active, done, dropped, reopened`).
- References: `parent` (at most one, the plan tree), `member` (a handoff holds an item in a slot such as `t5`),
  `related`, `duplicate-of`, `recheck-of`, `follow-up-of`, `blocks`, `spotted-in`.
- Ids: a new item is `w_` plus 8 characters. A task born in a handoff keeps `h_x:t5` for good. Every command takes
  an id or `<handoff>:<slot>`.

## Handoff storage

The work database is authoritative for handoff rows and events. The handoff executor folds tasks, ticks, claims and
text into that database. It copies new events to the legacy JSONL log for rollback. Work sends member actions through
the same executor. Types, severity, parents, references, pointers and spotted items are written directly to Work.

After a change of the hook, restart the long-running processes (the hosted MCP child, the dev-dashboard server, the
hub server, `tools handoff watch`), then:

```bash
tools work migrate backfill     # safe to repeat
tools work doctor --parity      # a pure read: 0 differences expected
```

## Commands

```text
tools work spot "<title>" --type <type> [--where <path:line>] [--why "<text>"] [--user-sees "<text>"]
     [--severity <level>] [--cost "<text>"] [--existed-before] [--production] [--during <ref>]
tools work add "<title>" --type <type> [--parent <ref>] [--under <handoff>] [--for <who>]
tools work edit <ref> [--type] [--severity] [--parent] [--for] [--title] [--where] [--why] [--user-sees] [--during]
tools work link|unlink <ref> <related|duplicate-of|recheck-of|follow-up-of|blocks> <ref>
tools work list [--project <p>] [--under <ref>] [--spotted-in <handoff>] [--state <s,…>] [--type <t,…>]
     [--tag <t>] [--severity <l,…>] [--worker <me|session>] [--fields …] [--json]
tools work show <ref> [--section body|log|refs|context]      tools work dump <ref> --out <file>
tools work triage [--project <p>]
tools work accept <ref,…> [--type] [--severity]      tools work drop <ref,…> --why "<text>"
tools work handoff "<title>" --from <ref,…> [--target <agent>]
tools work finish <ref> --proof "<text>" [--commits <sha,…>]
tools work log <ref> --result <fixed|partly|failed|limit> [--note "<text>"] [--measured "<number, unit, target>"]
tools work reopen <ref> --why "<text>" [--deliver never]
tools work comment <ref> "<text>"
```

Also: `tree`, `context`, `config` (`config set <path> <json>`), `claim`, `release`, `comment`, `batch`, and the admin
commands `dump`, `migrate backfill`, `doctor --parity`.

Every write takes `--request-id <id>` (a repeat returns the stored reply), `--dry-run` (writes nothing),
`--owner-said "<words>"` (records the words in the journal) and `--override "<why>"` (does a write that a role rule
refuses, see below). Every command takes
`--json` (the whole reply object), `--json-compact`, `--toon`, `--md` or `--format <f>`. Warnings and next actions go
to stderr.

## Role rules and the override

Each write checks a role rule of the item's type. By default anyone may spot, comment, log, reference and reopen.
Finish, edit and drop of an epic or a note (idea, risk, limit) need a lead or the owner, and nobody may claim a note.
Accept needs the poster, a lead or the owner, and an idea needs the owner. A handoff has its own rules.

A refused write answers `ROLE_REFUSED`. When an override is allowed, repeat it with `--override "<why>"` (MCP:
`override`). By default anyone may override a refused `finish` or `drop`, and nobody may override any other verb.
A rule that names nobody is never overridden, and neither is an item held in a handoff slot.

```bash
tools work finish w_ab12cd34 --proof "merged in owner/repo#42" --override "the owner asked me to close it"
```

Turn it off or on per type in the rules: `rules.types.<type>.overrides.<verb>` takes `"anyone"` or a list of roles
(`[]` turns it off). `tools work config` prints the effective `override` line of each verb beside its `write` line.

Each change of an overridden write carries two stamp facts: `role-override` (the reason) and `role-override.rule`
(the rule and the roles the session held). The actor of the change says who did it. `tools work show <ref> --section
log` ends that log line with `[override: <why>; <rule>]`, and `--section context` prints the stamp.

## One method table, four doors

`workApi` (`src/utils/work/api.ts`) lists every method once. `toCliCommands` makes the commands above from it, the
MCP group `work` (enabled by default, `src/work/mcp/genesis-tools.ts`) serves `work_context`, `work_list`, `work_show`,
`work_spot`, `work_reopen` and `work_write { method, params }`, and the node REPL toolset `work` answers
`await work.list({ project: "GenesisTools" })` with the reply object. Each method has a formatter in
`src/utils/work/formatters.ts`; a method without one does not compile.

- `spot` pairs the item with `--during`, else with the caller's one live claim, else with the live claim of its lead
  (a native subagent shares its session; a delegated T3 child finds its parent thread's session). With none it
  warns `CONTEXT_MISSING`.
- `triage` is the dangling check: spotted and not judged; spotted during a handoff that is finished; reopened with no
  live worker; active with a worker that is not alive. Each row carries its context and its next actions.
- `reopen` moves the item, sends the reason to the last finisher (else the last claimer) with the key
  `work-reopen:<item>:<seq>`, and records the receipt: `delivered`, `queued`, `nobody-alive` or `unknown`. An unknown
  outcome is never sent again.
