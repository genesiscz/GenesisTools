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

## Shadow mode (until the switch)

The old handoff log stays the writer of a handoff's tasks, ticks, claims and text. The old executor calls
`ingestLegacyHandoff` after each event it appends, so the store follows it. A `finish`, `drop`, `reopen`, `comment`
or title edit of a handoff member goes through the old log, and the hook brings it back. Types, severity, parents,
references, pointers and spotted items are written to the store directly.

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

Every write takes `--request-id <id>` (a repeat returns the stored reply) and `--dry-run` (writes nothing).
Warnings and next actions go to stderr; `--json` prints the whole reply object.

- `spot` pairs the item with `--during`, else with the caller's one live claim, else with the live claim of its lead
  (a native subagent shares its session; a delegated T3 child finds its parent thread's session). With none it
  warns `CONTEXT_MISSING`.
- `triage` is the dangling check: spotted and not judged; spotted during a handoff that is finished; reopened with no
  live worker; active with a worker that is not alive. Each row carries its context and its next actions.
- `reopen` moves the item, sends the reason to the last finisher (else the last claimer) with the key
  `work-reopen:<item>:<seq>`, and records the receipt: `delivered`, `queued`, `nobody-alive` or `unknown`. An unknown
  outcome is never sent again.
