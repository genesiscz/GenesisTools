# tools genesis-tools-mcp

One MCP server, named `genesis-tools`, that gives Claude Code, Codex and Grok the GenesisTools agent tools. With it an
agent can ask the user and log answers, post decisions to the native inbox, hand tasks to another agent session and
annotate screenshots. It also carries the MCP tools of other GenesisTools tools: Jev, macOS control, web fetch, AI
usage, and the opt-in Alza and Waze groups. The same stdio process serves every host, and a capability list picks
which tools a host sees.

## Quick start

```bash
tools genesis-tools-mcp install                 # register the server with Claude Code (run it in a terminal)
tools genesis-tools-mcp install --agent codex   # the same for Codex; --agent grok for Grok
tools genesis-tools-mcp                         # start the stdio server (a host runs this, not you)
GENESIS_TOOLS_MCP_CAPABILITIES=question_answer,handoff tools genesis-tools-mcp   # serve only those groups
tools genesis-tools-mcp --readme                # print this page
```

## Commands

| Command | What it does |
| --- | --- |
| `tools genesis-tools-mcp` | Start the stdio server. It reads JSON-RPC on stdin until stdin ends. |
| `tools genesis-tools-mcp install` | Register the server. `--agent claude` (default), `codex` or `grok`. |
| `tools claude mcp` | Legacy alias of the server. Host entries that still run it keep working. |
| `tools claude mcp install` | The same install, through the alias. |

Global options: `-v, --verbose` (verbose logging), `--readme`, `-h, --help`. The server itself takes no flags; the
environment variable `GENESIS_TOOLS_MCP_CAPABILITIES` configures it (see [Configuration](#configuration)).

### `install`

- It stores the command `tools genesis-tools-mcp`, the stable global command, never a worktree path, so the
  registration survives when a worktree goes away.
- It writes through mcp-manager. First it writes the `genesis-tools` entry in the unified config
  `~/.genesis-tools/mcp-manager/config.json`, then the entry of the one harness you named:
  - Claude Code: top-level `mcpServers` in `~/.claude.json`. The name also leaves `disabledMcpServers`.
  - Codex: `[mcp_servers.genesis-tools]` in `~/.codex/config.toml`. The command always uses that file. It ignores
    `CODEX_HOME` and the mcp-manager harness homes. With another Codex home, run `tools mcp-manager sync`, which
    applies the harness homes, or edit that `config.toml` by hand.
  - Grok: `[mcp_servers.genesis-tools]` in `~/.grok/config.toml` (`command`, `args`, optional `env`). Every other key
    of that file stays as it was.
- It keeps the `env` and the `_meta` that the unified entry already holds, so a capability list stored there survives
  a re-install. An `env` that you typed only into `~/.claude.json` does not survive: `install` writes the unified entry
  over it.
- Each write shows a diff, asks "Are these changes okay?" and keeps a backup in `~/.mcp-manager/backups/`. Without a
  terminal it prints `!!! CHANGES NOT APPLIED !!!` and writes nothing. This command has no `--yes`.
- It refuses before any write when the harness has no config file yet (`<agent> has no config file at <path>`). Start
  the harness once, then run `install` again. It exits 1.
- `--agent` takes only `claude`, `codex` or `grok`. Any other value exits 1 and names the three.
- `tools update` checks, read-only, whether Claude Code has the server. If not, in a terminal it offers to register it
  (default no). Without a terminal it prints the install command. With no Claude config yet, it says to start Claude
  Code first.

## Tools and capabilities

Every tool belongs to a capability. Unset, a host gets every capability except the opt-in `alza` and `waze`.

- `question_answer`: `question_answer`, `inbox_send`.
- `inbox`: `inbox_send` alone.
- `question_ask`: `question_post`, `question_wait`, `question_poll`, `question_respond`, `question_cancel`,
  `question_update`, `question_tokens`.
- `decision`: `question_post`, `question_poll`, `question_update`, `question_tokens`.
- `handoff`: `handoff_post`, `handoff_get`, `handoff_list`, `handoff_action`.
- `annotate`: `annotate_image`.
- `jev`: `jev_route`, `jev_compact`, `jev_verify`, `jev_verify_templates`, `jev_grep`.
- `control`: `control_find`, `control_get`, `control_run`, `control_workflow_run`.
- `fetch`: `fetch_markdown`, `fetch_raw`, `fetch_jsonld`.
- `usage`: `usage_limits`, `usage_series`, `usage_forecast`, `usage_advise`.
- `alza` (opt-in): `alza_*`, 43 tools.
- `waze` (opt-in): `waze_*`, 15 tools.

`inbox_send` is registered only on a Mac with the native inbox, whatever the capability list says (see
[Native inbox](#native-inbox)).

### Questions, decisions and the inbox

- `question_answer` logs a user question with your complete answer (markdown) into the local question store, for
  later review. It takes `question`, `answer`, `tag` (`question`, `directive` or `action`), optional `refs`, and
  screenshots as `images` (paths) or `attachments`. Browse the log with `tools question log` and `tools question tail`.
- `question_post` creates a pending form and returns its id at once. The form lands in the dev-dashboard `/qa` Pending
  section and raises a notification. It blocks only with `wait: true`, because a blocking ask hangs agent loops.
  - An item with `type: "decision"` or `type: "todo"` is not a form. It is numbered in the session's decision log
    (`❓ DECISION N`, `TODO N`; numbers are never reused), and the result is the markdown block to paste into the
    reply. Pass `number` when the reply already numbered it, so the log and the chat agree.
  - Item text may carry inline `{{kind key="value"}}` tokens (`lines`, `file`, `symbol`, `diff`, `tail`, `json`,
    `cmd`, `url`, `image`, `pr-thread`). They are resolved when the item is saved; `transclude: false` stores them as
    written.
  - To correct an unanswered item, post it again with `supersedes: <id>`.
  - An item takes screenshots as `attachments` only. `images` is refused there.
- `question_wait` blocks until a form is answered, cancelled or times out. Its `waiter` is `answered`, `timeout`,
  `cancelled`, `budget_exhausted` or `not_found`.
- `question_poll` checks forms without blocking. With no `ids` it reports every form still pending.
- `question_respond` submits an answer. The user normally answers on the dashboard, so it is for automation, or for
  an answer the user gave somewhere else. Never invent one.
- `question_cancel` withdraws a form. A blocked `question_wait` then returns `cancelled`.
- `question_update` records progress on decisions and todos you posted (acknowledged, implemented, commit refs,
  verdict, comments, a copy of a chat answer, superseded by a newer item), several items per call.
- `question_tokens` is read-only. It lists the inline tokens `question_post` resolves (parameters, types, defaults,
  examples), or previews a text. See [`../question/README.md`](../question/README.md).
- `inbox_send` sends the user a message, with screenshot paths in `images`, to the native widget inbox.

Screenshots are PNG, JPEG or WebP. They are validated and copied into durable storage. To pair two of them, add
`comparison: {group: "layout", role: "before"}` and the same with `role: "after"`.

Capability notes:

- `question_ask` is an explicit set, not a `question_` prefix, so it never includes `question_answer`.
- `decision` predates the merge of the decision tools into `question_post`. A config that names it gets what posting
  and updating a decision needs, without the rest of the ask surface.
- `question_answer` includes `inbox_send` because both write the after-the-fact store and block nobody. So the
  existing `question_answer` configs got `inbox_send` without an edit.

The same surface from the CLI: `tools question ask|wait|poll|answer|cancel` (the CLI `answer` verb is
`question_respond`), and `tools question message "<text>" --image /abs/shot.png` for `inbox_send`. Answering a form
also writes it into the question log, so `/qa` stays one list.

### Native inbox

`nativeInboxState()` (`src/utils/macos/native-inbox.ts`) is `none`, `installed` or `running`. It is macOS only.

- `installed`: `~/Applications/GenesisTools Preview.app` exists, or `~/Applications/GenesisTools.app` exists with the
  staging defaults key `GenesisToolsStagingFaces` (`bun scripts/native/staging.ts on`). A normal install has neither.
- `running`: a widget `worker.lock` (`~/.genesis-tools/hub/widget/worker.lock`, or the Preview bundle's
  `~/.genesis-tools/widget-preview/data/worker.lock`) holds the live pid of the `tools hub widget watch` process that
  the widget keeps open.
- The state is remembered for 15 s in a process, so a resident server that asks per request pays nothing.

The server instructions, the `question_post` description and the `inbox_send` tool follow the state. With `none`,
nothing mentions the inbox and `inbox_send` is not registered. With `installed`, an agent may post and must also ask
in the chat. With `running`, a post reaches the user.

`tools question config --ask-via-question-tool` decides one thing only: whether `question_post` replaces the agent's
native question tool for decisions. It never lifts the chat ask while the widget is not running. The precedence is
written down in `src/question/lib/inbox-guidance.ts`.

Each computation of the state also writes `~/.genesis-tools/app/native-inbox.json`, only when its content changes.
The file is never created for `none`. The plugin's SessionStart hook
(`plugins/genesis-tools/hooks/native-inbox-hint.ts`) reads that file, because a plugin file cannot import the state
function, and decides `running` itself from the widget locks. No file means no native app. Grok 1.0.44 ignores
SessionStart stdout, so Grok learns the same text from the server instructions.

### Handoffs

A handoff is a task list for another agent session, in any project.

- `handoff_post {title, tasks}` creates one and returns a `paste` block for the receiving agent's chat. Pass
  `project` (a name or a repository path) when the handoff is for another project. The default is the project of
  your working folder.
  - `target` is `{sessionId}`, `{sessionName}` or `{agent}`, where `agent` is the recipient harness (`claude`,
    `codex`, `grok` or `copilot`).
  - Give it a readable name, or let one be derived from the title, so it can be fetched by name. A name that several
    handoffs share is refused with the candidate ids instead of a guess.
- `handoff_get {id}` or `{name}` reads it, with `include: ["tasks"]` by default. Read `warnings[]` first: it fires
  when the handoff is addressed to another session or another harness. It is a warning, never a block. A session whose
  own identity cannot be detected is told the check was unverifiable. `include: ["events"]` returns the activity
  trace, where a refused action carries `outcome.applied: false` and the reason.
- `handoff_list` lists recent handoffs, newest-updated first, for every project. It is never filtered by recipient
  unless you pass `agent` or `session`. The filters `project`, `open` and `mine` narrow it further.
- `handoff_action` takes an ordered `actions` array, addressed by id or name like `handoff_get`.
  - The receiver claims it (`claim`, or `claim: true` on `handoff_get`; `unclaim` releases), then works the tasks:
    `check_task` with proof, `uncheck_task` (it keeps prior proof), `deny_task` with a reason, `undeny_task`,
    `comment` and `attach_file` (a local screenshot or log).
  - `finish_handoff` is refused until every task is checked or denied; `force: true` overrides it, and
    `reopen_handoff` undoes it.
  - The poster edits from its own session with `add_tasks`, `modify_task`, `modify_handoff` (its `project` moves the
    handoff to another project), `cancel_handoff` and `reopen_handoff`. From another session it passes the `editId`.
  - An unknown verb is refused with the list of valid verbs.

Progress is live on the dev-dashboard `/qa` "Agent tasks" tab. From the CLI, `tools handoff watch` follows handoffs
and `tools handoff modify <handoff> --project <name|path>` moves one to another project.

### Image annotation

`annotate_image` draws onto an existing image from a JSON plan, in natural image pixels: `highlight`, `box`,
`ellipse`, `arrow`, `label`, `blur` (to redact), `crop` (always applied last) and `grid` (labelled gridlines that help
you find coordinates).

- `input` must be an absolute path to an existing PNG or JPEG. The original is never changed.
- `output` defaults to a copy beside the input: `shot.png` becomes `shot-annotated.png`. The output is always PNG:
  a JPEG input `shot.jpg` becomes `shot-annotated.png`, and an output path that ends in `.jpg` still gets PNG bytes.
  An output equal to the input is refused.
- `preset` is `review-red` (default), `callout-amber` or `redact`. A style value on an annotation overrides it.
- It returns JSON: `{ok, output, width, height, annotations, warnings}`. Read the output file to check it.

### Groups from other tools

Each group is an adapter, `src/<tool>/mcp/genesis-tools.ts`, over the same handlers as that tool's own MCP server. A
tool added there appears here with no edit to this server.

- `jev` (`src/jev/mcp/genesis-tools.ts`, the registry that `tools jev mcp` serves alone). `jev_route` maps a plain
  request to one GenesisTools command line without running it. `jev_compact` shrinks a transcript, log or diff with
  Jev-judged drops. `jev_verify` judges claims against a document per template, and `jev_verify_templates` lists the
  templates. `jev_grep` finds the source that implements, calls or tests a behavior, and uploads eligible source under
  the root to the configured Jev provider. None of them acts on the machine. The group imports the evaluation stack,
  about 80 MB resident (measured 2026-10-01), so it loads only for a list that can expose it.
- `control` (`src/control/mcp/genesis-tools.ts`, the same core as `tools control`). `control_find` and `control_get`
  read a running macOS app's elements without raising or focusing anything. `control_workflow_run` is the preferred
  way to act: a versioned plan run against fresh observations, each step verified before the next. It makes no model
  call. `control_run` takes a `control run` plan inline. Its `type`, `set` and `hotkey` steps refuse while another
  app is frontmost, unless `steal_focus`. The group is on by default, and it needs the Accessibility grant
  (`tools control doctor`).
- `fetch` (`src/fetch/mcp/genesis-tools.ts`, the same tools as `tools fetch mcp`). `fetch_markdown`, `fetch_raw` and
  `fetch_jsonld` read a web page as Markdown, raw HTML or schema.org JSON-LD (products, every offer with seller and
  price, breadcrumbs). Transport `plain`, `chrome` (a real Chrome fingerprint for Cloudflare-walled sites) or `auto`
  (default: it retries once through Chrome when a bot wall refuses plain fetch). The result names the transport. The
  Chrome worker ends after a minute idle and restarts on demand.
- `usage` (`src/ai/mcp/genesis-tools.ts`). Read-only AI usage answers with the same core and envelopes as
  `tools ai usage limits`, `tools ai usage limits series`, `tools hub forecast` and `tools ai usage limits advise`.
  They read the last poll's snapshots and the history store, and never poll a provider.
- `alza` (`src/alza/mcp/genesis-tools.ts`, opt-in). The tools `tools alza mcp` serves, prefixed `alza_`: catalog,
  reviews, price history, basket, orders, watchdogs and the PC builder. Nothing places an order or pays. Account tools
  need a sign-in, which the user runs in a terminal: `tools alza auth login`. See
  [`../alza/README.md`](../alza/README.md).
- `waze` (`src/waze/mcp/genesis-tools.ts`, opt-in). The tools `tools waze mcp` serves, prefixed `waze_`: police and
  every report along a trip, route, jams, departure times, exports, history, hotspots and `waze_doctor`. It is opt-in
  because it drives the user's real Brave over CDP, in one background live-map tab. See
  [`../waze/README.md`](../waze/README.md).

## How it works

- **Transport.** stdout carries JSON-RPC only. Diagnostics go to the logger: the day log
  `~/.genesis-tools/logs/<date>.log` and stderr, never stdout. The CLI imports the MCP SDK (about 180 ms) only when
  the server starts.
- **Instructions.** The server sends instructions at `initialize`: the question surfaces, decisions, inline tokens,
  handoffs, and the Jev, control and fetch groups. The INBOX paragraph is there only when the Mac has the native inbox.
- **Lazy groups.** A group from another tool loads only when the capability list can expose it. A server builds one
  registry per instruction variant and keeps it.
- **Shutdown.** The loaded groups hold children (the fetch and Alza Chrome workers, the Waze live-map tab), and the
  server closes them when it stops, so no child outlives the host. The stdio server closes them when stdin ends (the
  stdio transport does not close on EOF). The gateway's hosted child closes them on SIGTERM, which the gateway sends
  to stop it, and on SIGINT. The hosted child's drain path does not close them: when its code changes or the gateway
  exits, it finishes the requests in flight and exits without closing the groups.
- **Errors.** An unknown tool name is a JSON-RPC `MethodNotFound` error. A handler that throws returns a result with
  `isError: true` and the text `<tool> failed: <message>`, and the day log gets a warning `mcp tool handler failed`.
- **Data.** The server keeps no store of its own. The question and handoff tools write the question store under
  `~/.genesis-tools/question/` (the Q and A log, `qa.db`, pending forms, `decisions/`, and `handoff/<date>.jsonl`).
  Recorded screenshots are copied to `~/.genesis-tools/attachments/images/`. `annotate_image` writes beside its input.
  `GENESIS_TOOLS_HOME` replaces the home folder that holds `.genesis-tools`, so the tree moves to
  `$GENESIS_TOOLS_HOME/.genesis-tools/`. The full layout is in
  [`../question/README.md`](../question/README.md).
- **Cost.** The question, handoff, annotate, control, fetch, usage, Alza and Waze tools call no paid API.
  `jev_route`, `jev_verify` and `jev_grep` call the Jev model, which is paid. `jev_compact` calls it only with
  `llm: true` (one request per 20 calls). `jev_verify_templates` costs nothing. See
  [`../jev/README.md`](../jev/README.md).

### Served by the mcp-manager gateway (HTTP)

`tools mcp-manager gateway host genesis-tools` serves this server from the mcp-manager gateway for Claude and Codex.
Like `install`, it shows each diff and asks. Without a terminal it is a dry run unless you pass `-y`
(`tools mcp-manager -y gateway host genesis-tools`). If you decline the change to the unified config, the harness
configs stay as they were.
They get an HTTP entry that points at the gateway instead of one stdio child per session. The other harnesses keep
stdio: Cursor sends no identity, and Grok passes its session id only in a stdio child's env. `--off` gives Claude and
Codex the stdio entry back.

- The server runs in a child process of the gateway (`src/genesis-tools-mcp/hosted-child.ts`). The child exits once
  its source changes, and the next call starts the new code; the gateway needs no restart.
- It is stateless: every request gets a fresh server from the same registry. The caller is the harness process that
  owns the connection. When the one owner is a command that an agent started (`tools scripts call`, a persisted
  script), that command's own environment names the session, as it does for a local run of a tool. A request whose
  caller the gateway cannot name is recorded as `unknown`, never as the gateway's own session.
- The stored `GENESIS_TOOLS_MCP_CAPABILITIES` value becomes the `X-Genesis-Mcp-Capabilities` header. A request without
  the header gets the default set; the gateway's own environment never narrows it.
- A session that started before `gateway host` keeps its stdio server until it restarts.

See [`../mcp-manager/README.md`](../mcp-manager/README.md) for the gateway.

## Configuration

`GENESIS_TOOLS_MCP_CAPABILITIES` is a comma-delimited list of capability names.

- Names are trimmed and lowercased.
- Unset or empty enables every capability except the opt-in `alza` and `waze`.
- An unknown name enables nothing. The retired `boards` capability enables nothing.
- A list replaces the default set. There is no "everything plus `alza`" value: name each capability you want. The
  default set is `question_answer`, `question_ask`, `handoff`, `annotate`, `jev`, `control`, `fetch` and `usage`
  (the inbox and decision sets are inside these).

```bash
GENESIS_TOOLS_MCP_CAPABILITIES=question_answer,handoff,annotate
GENESIS_TOOLS_MCP_CAPABILITIES=question_answer,question_ask,handoff,annotate,jev,control,fetch,usage,alza
```

The second line is the default set plus `alza`. Leave `control` out and the `control_*` tools disappear.

A host sets the variable in the server's process env. In Claude Code that is the `env` of the `genesis-tools` entry in
`~/.claude.json`:

```json
{
  "mcpServers": {
    "genesis-tools": {
      "type": "stdio",
      "command": "tools",
      "args": ["genesis-tools-mcp"],
      "env": { "GENESIS_TOOLS_MCP_CAPABILITIES": "question_answer,question_ask,handoff,annotate" }
    }
  }
}
```

An older entry with `command: tools` and `args: ["claude", "mcp"]` is the legacy door and still works. Codex and Grok
launch the same command as a stdio server, with the variable in the `env` of their `[mcp_servers.genesis-tools]` entry.

To keep a list across `install` runs, store it in the unified config, for example through mcp-manager:

```bash
tools mcp-manager install genesis-tools "tools genesis-tools-mcp" \
    -t stdio \
    -e "GENESIS_TOOLS_MCP_CAPABILITIES=question_answer,question_ask,handoff" \
    -p claude
```

Other settings that change what the server says:

- `tools question config --ask-via-question-tool on|off`: whether `question_post` replaces the native question tool
  for decisions (see [Native inbox](#native-inbox)).
- A stdio server reads that setting and the inbox state once, when the host starts it. The instructions are a
  snapshot; the note that each post returns carries the live inbox state. Restart the host session to pick up a change.

## For agents

- **Discovery.** `tools/list` carries every schema, and each description carries its usage rules. The server
  instructions hold the rules across tools.
- **Results.** Every tool answers text, mostly JSON; each description names its shape. The Alza and Waze tools also
  return `structuredContent`. A failure is a result with `isError: true`.
- **From a script.** `tools scripts call genesis-tools.handoff_list '{"limit":5}'` calls one tool without loading the
  server into a session; `tools scripts tools 'genesis-tools.*'` lists them. The plugin's `mcp-scripting` skill covers
  it, and [`../scripts/README.md`](../scripts/README.md) is the manual.
- **Plugin.** The `question` skill (`/question`) answers a question and saves it with `question_answer`. The
  SessionStart hook `native-inbox-hint.ts` tells a new session when to use the inbox.
- **Standalone servers.** A host that wants one group alone can run `tools jev mcp`, `tools fetch mcp`,
  `tools alza mcp` or `tools waze mcp` instead.
- **Worktrees.** `tools` on PATH runs the main checkout. In a linked worktree, `./tools genesis-tools-mcp` runs that
  worktree's code; `install` still stores the global command.

## Troubleshooting

- **`install` prints `!!! CHANGES NOT APPLIED !!!`.** It ran without a terminal, so it declined every write. Run it in
  a terminal. An agent hands the command to the user.
- **`install` says `<agent> has no config file`.** The harness never started on this Mac. Start it once, then run
  `install` again.
- **A tool is missing from `tools/list`.** Check the capability list: an unknown name enables nothing, `alza` and
  `waze` need their names, and `inbox_send` needs the native inbox. The day log shows what the server resolved:
  `rg "tool registry resolved" ~/.genesis-tools/logs/<date>.log` prints the capabilities, the tools, the
  `askViaQuestionTool` setting and the inbox state.
- **A change does not show.** A stdio entry keeps the server it started with. Restart the host session after a code
  change, a new capability list or a new `--ask-via-question-tool` value. An entry served by the gateway picks up
  code and setting changes on the next call.
- **Claude or Codex went back to stdio after `gateway host`.** `install` writes the stored stdio entry into the harness
  you named. Run `tools mcp-manager gateway host genesis-tools` again: it writes the gateway entry back.
- **A tool answers `<tool> failed: <message>`.** Its handler threw. The day log has `mcp tool handler failed` with the
  tool name and the error.
- **A `waze_*` tool reports no browser.** Start Brave with its debugging port, then check with `waze_doctor` or
  `tools waze doctor`:

  ```bash
  tools chrome-devtools restart --browser brave --port 9222
  ```

## Related

- [`../question/README.md`](../question/README.md): the question store, the decision log and the `tools question` CLI.
- [`../mcp-manager/README.md`](../mcp-manager/README.md): the unified config, `install`, `sync` and the gateway.
- [`../claude/README.md`](../claude/README.md): `tools claude mcp`, the legacy alias.
- [`../hub/README.md`](../hub/README.md): the widget that shows the native inbox.
- [`../jev/README.md`](../jev/README.md), [`../control/README.md`](../control/README.md),
  [`../fetch/README.md`](../fetch/README.md), [`../ai/README.md`](../ai/README.md),
  [`../alza/README.md`](../alza/README.md), [`../waze/README.md`](../waze/README.md): the tools behind each group.
- [`../scripts/README.md`](../scripts/README.md): call these tools from a script.
- [`../update/README.md`](../update/README.md): `tools update`, which offers the Claude Code registration.
