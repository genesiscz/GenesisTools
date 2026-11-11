# tools handoff

A handoff is a task list that one agent session (or you) gives to another agent session: Claude, Codex, Grok or
Copilot, in this project or another one. Agents post and work handoffs through the genesis-tools MCP tools
(`handoff_post`, `handoff_get`, `handoff_list`, `handoff_action`). This CLI follows the event stream of those
handoffs live and moves a handoff to another project.

## Quick start

```bash
tools handoff watch                          # follow every handoff live, one line per event
tools handoff watch --since 6h --once        # print the last six hours of events, then exit
tools handoff watch fix-active-filter        # follow one handoff by its readable name or its id
tools handoff watch --since 2d --json        # replay two days as JSON lines, then follow
tools handoff modify h_x1y2z3ab --project ~/Projects/app   # file a handoff under another project
```

## Commands

### `watch [handoffs...]`

Prints one line per handoff event. With no argument it follows every handoff. An argument is a handoff id (the
`h_` prefix is optional) or a readable name; give several to follow several.

| Flag | Default | What it does |
|---|---|---|
| `--since <duration>` | `0` | Replay events from this long ago first: `90s`, `30m`, `6h`, `2d` |
| `--once` | off | Print the replay and exit instead of following |
| `--json` | off | One raw JSON event per line |

Each line holds the local time (24-hour), the handoff id, its readable name in parentheses, the event, a short
detail, and `by <agent>:<first 8 characters of the session id>`. The events and their detail:

- `post`: the title and the task count.
- `claim`: how it was claimed (`target-match` or `explicit`). `unclaim` has no detail.
- `check_task`: the task id, the proof answer (cut to 180 characters) and the commit ids in brackets.
- `deny_task`: the task id and the reason. `uncheck_task`, `undeny_task` and `modify_task`: the task id.
- `comment`: the text, cut to 220 characters. `add_tasks`: how many tasks were added.
- `modify_handoff`: the new project, when the event moved the handoff.
- `attach`, `finish`, `cancel`, `reopen`: no detail.

Notes:

- `--since 0` (the default) replays nothing. So `--once` without `--since` prints nothing and exits.
- A duration is a whole number with `s`, `m`, `h` or `d`. Anything else exits 1 with the accepted forms.
- A name argument resolves from the names posted or renamed in the last 30 days. For an older handoff, pass its id.
- A live event also matches by the handoff's current name, so a handoff renamed after the watch started is still
  followed. The replay matches by id only.
- `watch` reads the raw log, so it also prints actions the store refused (for example a `modify_handoff` from a
  session that is not the poster). The outcome of each event is in the handoff's events: `handoff_get` with
  `include: ["events"]`.
- `--json` prints the raw event. A `post` event, and every event sent with an `editId` (for example `modify
  --edit-id`), carries the handoff's `editId` (the poster's edit credential), so keep that output private.
- The follow moves to the new day file at midnight. The replay and the live tail can overlap; events are
  de-duplicated by their uid. Ctrl-C stops it.

### `modify <handoff> --project <name|path>`

Moves a handoff to another project. It is the `modify_handoff` action of `handoff_action` with only `project` set.
`<handoff>` is an id or a readable name.

| Flag | What it does |
|---|---|
| `--project <name\|path>` | Required. The project the handoff is for: a project name or a repository path |
| `--edit-id <editId>` | The poster's edit credential, when this is not the session that posted it |
| `--json` | Print the whole response (`handoff`, `results`, `info`) as JSON |

- A bare name is kept as given. A path is resolved like the poster stamp: a subfolder names its repository, and a
  linked worktree names its main checkout. A path that is not a folder is refused, and nothing is written.
- Only the poster may move a handoff: the session that posted it (same session id), or anyone with its `editId`
  (the `he_` prefix is optional). A plain terminal has no session id, so there you always need `--edit-id`.
- The move is kept in the handoff's events with `fromProject` and `project`.
- A `done` or `cancelled` handoff refuses every change. Reopen it first with `handoff_action reopen_handoff`.
- On success it prints `<id> is now under project <name>`. A refused move prints the reason and exits 1. An unknown
  id stops with an error that points to `handoff_list`. A name that several handoffs carry stops with an error that
  lists their ids.

To change the title, name, description, target or refs, use `handoff_action modify_handoff` through MCP.

## How it works

The four MCP tools of the `genesis-tools` server do the work. The server instructions and the tool descriptions
tell an agent the whole protocol; the first parts of this section are the short form.

### Post

`handoff_post { title, tasks, description?, target?, name?, refs?, project? }` creates a handoff. Each task has
`text` and an optional `acceptanceCriteria`. The response holds the final task ids (`t1`, `t2`, ...), the `editId`,
and a `paste` block. Paste that block into the chat of the agent that should do the work: it tells the agent how to
read, claim and check off the handoff.

- `project` files the handoff under the project it is for: a name or a repository path. Without it, the project of
  the poster's working folder is used. `postedByContext` always keeps the poster's real folder.
- `name` is a readable slug (lowercase letters, digits and hyphens, at most 60 characters). Without it, the name is
  made from the title. A later title edit never changes the name. When a name is already taken, `info` says so,
  and a lookup by that name is refused with the candidate ids.
- `paste.runLink` is a link that starts Claude for the handoff in a new cmux surface. It runs
  `tools claude run auto`, which picks the account with the most headroom, in the handoff's checkout. It is there
  only when the browser-router preset `cmux-claude` is on, the target harness is Claude or unset, and there is a
  folder to open (a bare project name for another project has none).

### Address

`target` names who the handoff is for. It never describes the poster (that is `postedBy`).

- `sessionId`: the receiving session. A leading part of the id that ends at a hyphen (at least 8 characters, such
  as the first segment) also matches. That session claims the handoff by itself on every plain `handoff_get` while it holds no
  claim (pass `unclaim: true` to release it), unless `agent` names another harness.
- `sessionName`: a hint only. Names are not unique, so it never claims.
- `agent`: the receiving harness: `claude`, `codex`, `grok` or `copilot`. Other spellings such as `claude-code`
  are stored as the canonical name. An unknown value is stored in lowercase. It can never prove a match or a
  mismatch, so every session that reads the handoff gets a "Recipient unverifiable" warning, and `handoff_post` adds
  an info line.

A session that is not the target gets a line in `warnings` that tells it not to work the handoff. A warning never
blocks: the work stays possible when the user says so. A session whose own identity cannot be detected is told the
check was unverifiable.

### Work

1. `handoff_get { id }` or `{ name }` reads the handoff. Read `warnings` first.
2. `handoff_get { id, claim: true }` claims it. Several sessions may claim one handoff.
3. `handoff_action { id, actions: [...] }` records the work. Each action is `{ action: "<verb>", ... }`:
   `check_task { taskId, proof: { answer, commitIds?, context?, screenshots?, attachmentIds? } }`,
   `deny_task { taskId, reason }`, `uncheck_task { taskId }`, `undeny_task { taskId }`,
   `add_tasks { tasks }`, `modify_task { taskId, text?, acceptanceCriteria? }`,
   `comment { text, screenshots?, attachmentIds? }`, `attach_file { path, taskId?, note? }`. A task may carry an
   explicit `id`. A verb with no payload may be a bare string. `editId` goes at the top level of `handoff_action`.
   To unclaim, call `handoff_get { id, unclaim: true }`.
4. `finish_handoff` closes it. It is refused while a task is neither checked nor denied, unless `force: true`.

Short forms are accepted: `done` and `finish` for `finish_handoff`, `check` = `check_task`, `deny` = `deny_task`,
`uncheck` = `uncheck_task`, `add` = `add_tasks` and `modify` = `modify_task` (not `modify_handoff`). Checking a denied
task, or denying a checked one, is refused unless `force: true`.

### Who may do what

| Verb | Allowed for |
|---|---|
| `claim`, `unclaim` | Any session with a session id |
| `check_task`, `uncheck_task`, `deny_task`, `undeny_task`, `comment`, `attach_file` | A claimer or the poster |
| `finish_handoff` | A claimer |
| `add_tasks`, `modify_task`, `modify_handoff`, `cancel_handoff` | The poster |
| `reopen_handoff` | The poster, or the claimer whose own finish closed it |

The poster is the posting session (strict session id match) or a caller with the `editId`. `handoff_get` returns
the `editId` to the posting session. The dev-dashboard acts as the human owner: it has both rights and shows the
`editId`.

### Status

A handoff is `open`, `claimed`, `done` or `cancelled`. The first claim moves it to `claimed`, and the last unclaim
moves it back to `open`. `finish_handoff` sets `done` and `cancel_handoff` sets `cancelled`. `done` and `cancelled`
refuse every action except `reopen_handoff`, which restores `open` or `claimed` and keeps the task states.

### List and read

- `handoff_list` lists all projects, newest update first, 20 rows by default (`limit`, `offset`). Filters: `open`,
  `mine` (posted by, claimed by or targeted at this session), `project`, `agent` and `session`. The last two read
  the target, never the poster, and are off unless you pass them.
- `include` scopes a response: `tasks`, `claimedBy`, `comments`, `attachments`, `events`, `postedBy`,
  `postedByContext`. The default on `handoff_get` and `handoff_action` is `["tasks"]`. `handoff_get` with
  `include: ["events"]` alone returns only the events, `info` and any `warnings`. `handoff_list` takes
  `include: ["tasks"]` for task previews with clipped proofs.
- An action that the fold refuses (permission or status) is still written to the log. Its event carries
  `outcome.applied: false` and the reason, so the trace never reads as though it happened. An action with bad
  arguments, or a project path that is not a folder, is refused before anything is written.

### Storage

Handoffs share the question tool's storage root, `~/.genesis-tools/question/`:

| Path | What it holds |
|---|---|
| `handoff/<YYYY-MM-DD>.jsonl` | The event log, one append-only file per local day. It is the source of truth |
| `handoff/attachments/<handoff id>/<attachment id>.<ext>` | Attached files, never changed after the write |
| `qa.db` | SQLite read model folded from the log, the same database the dev-dashboard `/qa` page opens |

- Every read folds the new log bytes into `qa.db` first. The fold re-reads its byte offset inside the write
  transaction, so several processes can append and read at once and no event applies twice. When the events table is
  new under existing handoffs, the model is rebuilt from the log.
- The caller is stamped from its session: `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID` or `GROK_SESSION_ID` in an
  agent's shell, or the resolved caller of the MCP server. A plain terminal has no session id: it cannot claim, and
  it acts as the poster only with the `editId`.
- An attachment is at most 10 MB. `attach_file` and `proof.screenshots` copy a local file (an absolute path on this
  Mac) into the store. The dashboard stores pasted or dropped files the same way.
- Nothing here calls a network service or costs money. The run link needs the browser-router `cmux-claude` preset,
  the router's link host and cmux. A link whose token cannot be saved is left out, and a click after the first one
  asks first.

### Other ways in

- The dev-dashboard `/qa` page, tab "Agent tasks", shows handoffs live and can post, edit and attach.
- `tools hub handoff <session> --post` builds a markdown handoff from a session's prompts (no model call) and posts
  it. Its open items become the tasks, and `--owner` posts as the human owner. The GenesisTools.app hub has the same
  composer (`tools hub --handoff`).

## Configuration

There is no config file. Environment variables:

| Variable | Effect |
|---|---|
| `GENESIS_TOOLS_HOME` | A home folder to use instead of `~`; the store is `<GENESIS_TOOLS_HOME>/.genesis-tools/question/` |
| `QUESTION_LOG_BASE` | Moves the question log; `handoff/` moves beside it. `qa.db` stays put |
| `GENESIS_TOOLS_MCP_CAPABILITIES` | The MCP groups to expose; `handoff` is the group of the four tools |

## For agents

- Use the MCP tools to post and work handoffs. From a shell, `tools scripts call` reaches the same tools:

```bash
tools scripts describe 'genesis-tools.handoff_post'          # every parameter before you write a call
tools scripts call genesis-tools.handoff_list '{"limit":5}'  # one call, the result on stdout
```

- `tools handoff watch --json` gives one JSON event per line for a script or a monitor.
- Exit codes: `modify` exits 1 when the move is refused, and `watch` exits 1 on a bad `--since`. An unknown or
  ambiguous handoff and a missing `--project` also exit 1.
- The `gt:mcp-scripting` skill covers `tools scripts` calls and scripts that import `genesis-tools.handoff_*`.
- When an agent says it has no handoff tools, enable the genesis-tools MCP server for it, and check that
  `GENESIS_TOOLS_MCP_CAPABILITIES` is unset or names `handoff`. For the HTTP gateway, the capabilities header
  (written by mcp-manager) decides, not the env.

## Troubleshooting

- **"Poster credential required"**: you are not the posting session, or you run from a plain terminal. Pass
  `--edit-id he_...`. The posting session gets it from `handoff_get`, and the dev-dashboard shows it.
- **"Handoff is done" or "Cancelled by the poster"**: a closed handoff takes no change. Reopen it with
  `handoff_action reopen_handoff` (the poster, or the claimer whose finish closed it).
- **A name "is ambiguous"**: several handoffs carry that name. Pass one of the ids the error lists.
- **"is not a folder on this Mac"**: the `--project` path does not exist. Pass an existing repository path or a
  project name.
- **"Not a claimer of this handoff"**: claim first with `handoff_get { id, claim: true }` or a leading
  `{ action: "claim" }`. Checking a denied task or denying a checked one also needs `force: true`.
- **"This session has no sessionId"**: a claim came from a process with no agent session. Claim from the agent's
  own session.
- **`watch` by name shows nothing**: the name is older than 30 days, or you used `--once` without `--since`.

## Related

- [question](../question/README.md): the store root and the `/qa` page that handoffs share.
- [genesis-tools-mcp](../genesis-tools-mcp/README.md): the MCP server with the `handoff_*` tools.
- [dev-dashboard](../dev-dashboard/README.md): the "Agent tasks" tab.
- [hub](../hub/README.md): `tools hub handoff` and the handoff composer.
- [scripts](../scripts/README.md): call the handoff MCP tools from a shell or a script.
- [browser-router](../browser-router/README.md): the `cmux-claude` preset behind the run link.
- [cmux](../cmux/README.md) and [claude](../claude/README.md): where the run link starts Claude.
