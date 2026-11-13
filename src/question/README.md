# tools question

Agents ask the user questions here, and the answers come back to the agent. The tool also keeps the questions
the user fired at an agent mid-session, with the agent's answers, so a substantive answer is not lost in scrollback.

It covers three jobs on one store:

1. **Ask and wait.** An agent posts a question and waits. The form shows up in the hub's Inbox and on the
   dev-dashboard `/qa` Pending section, raises a notification, and releases the agent when it is answered.
2. **Decisions and todos.** An agent numbers a `❓ DECISION N` or `TODO N` in a per-session decision log. The user
   answers it in the widget, the hub, a banner, a phone or the chat, and the answer is typed back into the session.
3. **Log.** An agent records a question it already answered, or sends the user a message with screenshots, so the
   answer stays reviewable later. Answering a pending form also writes a log entry, so `/qa` shows one list.

## Quick start

```bash
tools question ask -q "Ship the PR?" --choices yes,no --wait   # ask, block until answered
tools question inbox                                          # every session waiting for you
tools question list --all-sessions                            # decisions and todos, as JSON
tools question log -l 20                                      # the last 20 recorded Q→A entries
tools question message "Build is green:" --image /abs/shot.png # a card in the widget inbox
tools question tokens                                         # the inline {{kind …}} tokens
```

## Commands

`tools question` with no arguments prints the help. Every command below was checked with `--help`.

### Pending forms (ask and wait)

| Command | What it does |
|---------|--------------|
| `ask` (alias `post`) | Post a question and leave it pending until the user answers |
| `wait <id>` | Block until a form is answered, cancelled or times out (`--timeout <ms>`) |
| `poll [ids…]` | Show pending forms, or the status of the ids you name |
| `answer <id>` | Answer a pending form, or a decision (`d_<n>_<session>`) with `--option` and `--text` |
| `cancel <id>` | Withdraw a pending form; a blocked waiter is released as cancelled |

`ask`, `wait`, `poll`, `answer` and `cancel` take `--format human|json` (default `human`).

### Decisions and todos

| Command | What it does |
|---------|--------------|
| `list` | Decisions and todos grouped by session (the hub's read model); flags below |
| `show <id>` | One decision or todo; `--versions`, `--recheck`, `--json` |
| `update` | Change several decisions and todos in one call, JSON on stdin |
| `draft <id> --text <t>` | Save the user's unsent draft answer on a decision |
| `send` | Deliver a session's answered decisions as one message |
| `chat-answers --session <id>` | Find chat answers to open decisions in a whole transcript |
| `repair` | Fix rows that an older agent flow left in the wrong state |
| `stale` | Blocking decisions that wait too long; can install a 5-minute check |
| `act <token> --key <k>` | Answer one decision letter from an act token (banner and phone buttons) |
| `transcript-rows` | Where each `❓ DECISION N` was first asked in a transcript |

### The inbox

| Command | What it does |
|---------|--------------|
| `inbox` | Sessions waiting for you: decisions in their last reply, open decisions, pending forms |
| `inbox answer` | Answer decisions (typed into the session as one message) or a pending form |
| `inbox draft` | Mark or clear a decision's pick and note; sends nothing |
| `inbox dismiss` | Drop a decision that no longer matters, without sending anything |
| `inbox send` | Promote a session's drafted answers and deliver them as one message |
| `inbox target` | Where a session's answers would go now: a cmux pane, a codex worker, or nothing |

### The Q→A log

| Command | What it does |
|---------|--------------|
| `record` | Record a question and answer after the fact (the `question_answer` MCP tool uses it) |
| `message [text…]` | Send the user a message with screenshots to the widget inbox (CLI twin of `inbox_send`) |
| `log` | Show recorded entries, oldest first, the last N |
| `tail` (alias `answers`) | Live feed of entries as they are recorded, after a backlog |

### Tokens and settings

| Command | What it does |
|---------|--------------|
| `tokens` | List the inline `{{kind …}}` tokens (`--format human\|json`) |
| `tokens resolve [text…]` | Preview the resolution of a text; stores nothing (`-` reads stdin, `--cwd <path>`) |
| `config` | Read or change the sinks (sound, notify, Obsidian) and the agent opt-in |

## Asking: pending forms

```bash
tools question ask -q "Ship the PR?" --choices yes,no          # prints the form id, returns at once
tools question ask -q "Ship?" --choices yes,no --wait          # block until answered
tools question ask --json '[{"promptMarkdown":"Target?","choices":["staging","prod"]},{"promptMarkdown":"Notes?"}]'
tools question poll                                            # what is still waiting
tools question wait ask_5f1c… --timeout 600000                 # wait again later
tools question answer ask_5f1c… --choice yes
tools question cancel ask_5f1c…
```

`ask` flags:

| Flag | Meaning |
|------|---------|
| `-q, --q <question>` | The question, markdown allowed |
| `--choices <list>` | Comma-separated choice labels |
| `--multiple` | Allow more than one choice |
| `--no-free-text` | Do not offer a free-text box |
| `--file-tags` | Allow `@file` tags, resolved against the form cwd |
| `--image-paste` | Allow pasted images |
| `--optional` | The item may be left blank |
| `--json <items>` | Items as a JSON array; `-` reads stdin (see below) |
| `-p, --project <path>` | The project the question is about (default: the harness checkout) |
| `--source <name>` | Who is asking (agent, skill, app) |
| `--session <id>` | The session to attribute the answer to |
| `--timeout <ms>` | Auto-retire the form after this long (at most one day; 0 or omitted: never) |
| `--wait` | Block until answered, cancelled or timed out |
| `--wait-timeout <ms>` | How long `--wait` blocks (default 120000, at most one day per call) |
| `--no-notify` | Raise no notification for this form or these decisions |
| `--no-transclude` | Store `{{…}}` tokens as written (see Inline tokens) |
| `--supersedes <id>` | Replace this open or drafted decision or todo |

A time value must be a whole number of milliseconds. `10ms` or `1.5` is refused, not read as a prefix.

**Exit codes of `--wait` and `wait`:** `0` answered, `1` not_found, `2` timeout, `3` cancelled, `4` budget exhausted.
A script can branch on them. `budget_exhausted` means your own wait ran out while the form is still pending: the
form is alive and you may wait again. `not_found` means no form has that id, so waiting again will not help.

`answer` flags:

| Flag | Meaning |
|------|---------|
| `-t, --text <text>` | Free-text answer |
| `--option <letter>` | Decision: the chosen option letter, for example `b` |
| `--choice <id>` | Selected choice id (repeatable) |
| `--file <path>` | `@file` tag, relative to the form cwd (repeatable) |
| `--item <itemId>` | Which item this answers (a single-item form defaults to its only item) |
| `--json <answers>` | Answer several items at once: a JSON array of `AskAnswer` objects |

A partial submit is never stored: `answer` refuses a form that still has a required item blank. Answer a
multi-item form in one call:

```bash
tools question answer ask_5f1c… \
    --json '[{"itemId":"q1","freeText":"staging"},{"itemId":"q2","freeText":"after the migration"}]'
```

### Pending-form order and notifications

- **Oldest first.** `poll` and the dashboard's Pending section list forms oldest-created first, so a second agent's
  question never jumps ahead of one you are already looking at.
- **Banners open the hub.** With GenesisTools.app installed, a new form's banner and the banner for posted decisions
  open the hub's Inbox at that card (`GenesisTools --hub --question <id>` or `--decision <id>`). Without the app, a
  form's banner opens `/qa` and decisions raise no banner. A decision announces itself when it waits for you: a
  decision unless its `for` names someone else, a todo only with `for: "human"`. One banner per post.
- **Banner buttons.** A form that is exactly one required item with two choices of opposite yes/no polarity
  ("Yes"/"No", "Accept"/"Reject", …) gets one button per choice. A button answers the form directly, the same as
  `tools question answer <id> --choice <id>`. A "staging"/"production" pair does not qualify: neither label has a
  polarity. Any other form's banner has no buttons; the click opens the form.
- **Retraction.** Answering, cancelling or timing out a form removes its banner from Notification Center.
- **Pending banners are on by default.** They follow `sinks.notifyPending` in the config, not `sinks.notify`: a
  pending form means an agent is blocked, so silence there is a hang. `--no-notify` turns them off for one post.
- **Not implemented: time-sensitive or break-through-DND banners.** The native layer supports `ignoreDnD`, but the
  code-signing identity of GenesisTools.app cannot carry the `timeSensitive` entitlement
  (`timeSensitiveSetting: notSupported`), so the OS would ignore it. A system Focus mode can still swallow a
  pending-form banner.

The wire contract for other clients of pending forms is
[docs/qa-pending-contract.md](../../docs/qa-pending-contract.md).

## Decisions and todos

An item with `type: "decision"` or `type: "todo"` is not a form. It is numbered in the session's decision log
(`❓ DECISION N`, `TODO N`; numbers are never reused), and the post prints the markdown section to paste into the
chat reply. Its id is `d_<n>_<session>` (a todo is `t_…`).

```bash
echo '[{"type":"decision","title":"Cache","promptMarkdown":"Keep the cache?","choices":["Keep it","Drop it"],"recommended":"a","blocking":true}]' \
    | tools question ask --json -
tools question list                                   # this session's decisions, as markdown
tools question list --session <id> --status answered,sent --json
tools question show d_3_<session>
tools question answer d_3_<session> --option b --text "after the release"
```

### Item fields for `--json`

`--json` takes an array of items, or a whole `question_post` payload
`{ items, projectPath?, source?, sessionHint?, timeoutMs? }`.

| Field | Meaning |
|-------|---------|
| `promptMarkdown` | Required. The question, markdown allowed (not `prompt` or `question`) |
| `choices` | Answer options: labels, or `{ id, label }` objects (not `options`) |
| `type` | `question` (default, a pending form), `decision` or `todo` |
| `title` | Decision or todo: the short title after the number |
| `recommended` | Decision: the recommended letter (`"b"`), or a set (`"ac"`) |
| `proposal` | Decision: what you would do |
| `reasoning` | Decision: markdown reasoning |
| `confidence` | Decision: `high`, `medium` or `low` |
| `blocking` | Decision: true when you cannot continue without the answer |
| `for` | Who acts on it: `human` (default for a decision), `agent` or a model name |
| `reevaluateWhen` | A condition that reopens it, for example "after the PR merges" |
| `refs` | Decision: `[{ path, line?, endLine?, sha? }]`; the first ref's lines become the excerpt |
| `number` | The number your chat reply already shows, so the log matches it |
| `supersedes` | Id of an open or drafted item this one replaces (see below) |
| `attachments` | Any item: `[{ "type": "image", "path": "/abs/shot.png", "label": "After" }]` |
| `allowMultiple` | Question: several choices. Decision: any set of options (letters like `"ac"`) |

`id`, `allowFreeText`, `allowFileTags`, `allowImagePaste` and `required` apply to question items only. With
`allowMultiple` on a decision, every inbox shows check boxes and one Send.

`list` flags: `--type decision|todo|all` (default `all`), `--session <id>` (default: the session running the
command), `--all-sessions`, `--status [list]` and `--json`. Without `--json` it prints the items as markdown;
`--all-sessions` always prints JSON (`{ sessions, events }`).

### States

Decision states: `open`, `drafted`, `answered` (stored, waiting for delivery), `sent`, `acknowledged`,
`implemented`, `dismissed`, `superseded`. `list --status` takes any of them; `waiting` is the printed name of `open`.
`--status` with no value opens a picker in a terminal.

### `update`: record progress and chat answers

`update` reads JSON on stdin: `{ updates: [{ id, state?, answer?, option?, draft?, commitRefs?, verdict?, comment?,
supersededBy? }] }`, an array of those, or one. The reply is each item's id, number and state; `include: [fields]`
or `["all"]` adds more. It is the CLI twin of the `question_update` MCP tool.

- **The user answered in chat.** Record it in the same turn, so the inbox stops asking:
  `{ id, state: "acknowledged", option, answer: "<the user's words or a short copy>" }`. `open` and `drafted` may
  move straight to `acknowledged` when the row then has `option` or `answer`. Nothing is delivered: every send reads
  `answered` rows only.
- **A later decision replaced it.** `{ id, state: "superseded", supersededBy: "d_<n>_<session>", comment: "<why>" }`.
  `superseded` is legal from `open`, `drafted`, `sent` and `acknowledged`, for decisions only, and is terminal. It
  needs `supersededBy` or a `comment`. `supersededBy` must name another stored decision (any session). The old item
  keeps its text and number; the widget card links to the new one.
- **`answeredVia`** on a stored row says who stored the answer: `inbox` (the move to `answered`: widget, hub, CLI
  `answer`), `agent` (a move from `open` or `drafted` to `acknowledged`), or `automatic_heuristic` (the decision Stop
  hook read an unambiguous answer from the chat; `recordChatAnswers` in `src/question/lib/decisions/store.ts`). The
  store sets it; no `update` can claim `automatic_heuristic`.
- **The Stop hook reads chat answers only when you turn it on.** `decisions.chatAnswers` in the agents hooks config
  is `off` by default. `record` stores each unambiguous answer as above and sends the agent back once per unclear
  one; `remind` stores nothing and sends the agent back once per decision to record what it finds:
  `tools agents hooks config set decisions.chatAnswers record --write`.
- **`update` is the agent door.** A state of `answered` or `sent` on a decision is stored as `acknowledged`, with a
  comment that says why, because only a send queues or delivers an answer. The user's answer goes through `answer`
  or `inbox answer`. An answer the user gave in the inbox or the chat stays: an agent's different text goes into a
  comment.

```bash
echo '{"updates":[{"id":"d_3_<session>","state":"acknowledged","option":"b","answer":"b, after the release"}]}' \
    | tools question update
```

### Superseding a decision or todo (`supersedes` on a post)

To correct an item nobody has answered yet, post it again with `supersedes`:

```bash
echo '[{"type":"decision","promptMarkdown":"Keep the cache? (now with numbers)","choices":["Keep","Drop"],"supersedes":"d_3_<session>"}]' \
    | tools question ask --json -
# or, for a post with exactly one decision or todo item:
tools question ask --json - --supersedes d_3_<session> < item.json
```

The MCP `question_post` item takes the same `supersedes` field.

- The item **keeps its id and number**, so "DECISION 3" in the chat and every link to it stay true. Its text,
  options, reasoning, refs and tokens are replaced, and it goes back to `open`. Its chat section says
  `revision 2 (earlier text: tools question show d_3_<session> --versions)`.
- The earlier text is **not lost**. It moves to the item's `versions` list (revision, state, posted and superseded
  times, the draft the user had started). The inbox shows only the current version. `show <id> --versions` lists
  all of them, oldest first.
- Only an `open` or `drafted` item can be superseded. An answer must keep pointing at the text it answered, so an
  answered, sent or closed item is refused (`cannot supersede d_3_x: it is answered, and only an open or drafted
  item can be replaced; post a new item instead`). The kind must match. A pending form is not superseded: cancel it
  and post a new one.
- A post whose supersede is refused stores nothing, including its other items.

### Delivery: `send` and `inbox send`

```bash
tools question send --session <id> --dry-run      # print the message and the route; change nothing
tools question send --session <id>                # deliver every answered decision as one message
tools question inbox target --session <id>        # where answers would go right now
```

The route depends on the session's provider (`--provider claude|codex|grok`, else the stored value). The routes are
tried in this order, and the first live one gets the answers:

- **Claude**: an owned headless worker that runs this session resumes it with one more turn that carries the answers
  (channel `resume`), then the session's own Claude peer socket, then its live cmux pane.
- **Grok**: an owned headless worker (channel `resume`), then the Grok leader socket its TUI runs in, then its live
  cmux pane.
- **Codex**: only through its `tools codex` worker, by steer. A Codex session is never typed into.
- `send --force` types into the cmux pane even while the session shows a question, plan or permission dialog.
- **No live route**: the answers stay queued (channel `queued`). They reach the session by themselves only when a
  queue entry for that exact session was saved, or when `decisions.injectAnswers` is on in the agents hooks config
  (default off), which puts them into the session's next prompt. `inbox target` reports that switch as
  `queueHookOn`. Otherwise only a later send delivers them.

`inbox send` promotes drafted answers first. Its extra flags serve the hub: `--wait-live <seconds>` waits for the
pane, `--resume-target <label>` waits for a pane the resume dialog reopened, and `--in-session` prepares the
session's own prompt and keeps the answers pending until `--ack-prompt <receipt>` (or `--release-prompt <receipt>`
after a rejection).

### Maintenance commands

- `chat-answers --session <id> [--transcript <path> --provider claude|codex|grok] [--apply]` reads the whole
  transcript (no byte cap) for the user's chat answers to open decisions, the backlog the decision Stop hook could
  not reach. It reports only. `--apply` stores each unambiguous answer as `acknowledged` with `answeredVia`
  `automatic_heuristic`.
- `repair [--apply]` turns chat answers that agents recorded as `answered` (no delivery) into `acknowledged`, so no
  send delivers them again, and turns drafted rows with nothing staged back into `open`. It reports only.
  `--apply` backs up `decisions.jsonl` and `events.jsonl` first.
- `stale` lists blocking decisions that wait past `decisions.staleness` in the agents hooks config
  (`tools agents hooks config`; default: warn after 30 minutes, alarm after 120, `notify` true). `--notify` raises
  one notification per threshold crossing and remembers it.
  `--install` registers the `question-stale-decisions` daemon task (`stale --notify` every 5 minutes);
  `--uninstall` removes it.
- `act <token> --key <key> [--json]` answers one decision letter from a stored act token. The Mac banner's letter
  buttons, the Telegram button and the phone (`POST /api/act`) use the same door. `--key` is the idempotency key, so
  a double click answers once. A token expires after 7 days. A refused act exits 1.
- `transcript-rows --transcript <path>` (or `--session <id>`, slower) prints the row of each `❓ DECISION N` first
  ask and the question tool calls with their times. It reads only what was appended since the last call, from an
  index that every caller shares. `--json` prints `{ transcript, provider, file, offset, scanned, asks, calls,
  issues }`.

## The inbox

`tools question inbox` lists sessions that wait for you, active in the last `--hours <n>` hours (default 72), as a
table. `--json` prints `{ sessions, scanned, elapsedMs }`; the hub's Inbox mode reads it.

`inbox` also writes. It stores each unposted `❓ DECISION N` block it lists as an open decision under that number,
so the widget, which reads only the decision log, counts it too. A number the log already has, in any state, is left
alone, and the agent's own later post of that number becomes the next revision. This is `decisions.harvestListed` in
the agents hooks config, on by default; turn it off with
`tools agents hooks config set decisions.harvestListed false --write`.

| Flag | Meaning |
|------|---------|
| `--session <id>` | Every decision of this one session, in every state |
| `--all-items` | With `--session --json`: also its todos, newest Q→A entries and pending forms, plus a `cursor` |
| `--since <cursor>` | With `--all-items`: only what changed since that cursor; an unknown cursor gets the whole answer |
| `--transcript <path>` | With `--session`: the transcript file, so it is not looked up by id |
| `--transcript-provider <kind>` | The provider of `--transcript` (default `claude`) |

The subcommands take `--session <id>` too:

```bash
tools question inbox answer --session <id> --decision 3 --option b --dry-run
tools question inbox answer --session <id> --batch '[{"number":3,"option":"b","text":"note"}]'
tools question inbox answer --form ask_5f1c… --answers '[{"itemId":"q1","selectedChoices":["c1"]}]'
tools question inbox draft --session <id> --decision 3 --option ac     # an empty --option clears the pick
tools question inbox dismiss --session <id> --decision 4
tools question inbox send --session <id> --dry-run
```

- `inbox answer` also takes `--text <answer>`, `--provider`, `--cwd <path>` (kept on a decision stored from its
  transcript), `--image itemId=path` (repeatable, with `--form`) and `--dialog <provider:session:toolCallId>`, which
  answers an agent's own question dialog by pressing `--option`'s key in it.
- `--expected-revision <n>` on `answer`, `draft` and `dismiss` refuses the call when the agent re-posted the decision
  since that revision, so the user never answers a text they did not see.

## The Q→A log

### `record`

You rarely run it yourself. The normal writer is the `question_answer` tool of the genesis-tools MCP server, which
an agent calls right after answering something worth keeping. The `question` plugin skill tells the agent when.

| Flag | Meaning |
|------|---------|
| `--q <question>` | The question (required) |
| `--a <answer>` | The answer, markdown allowed |
| `--a-file <path>` | Read the answer from a file |
| `--tag <tag>` | `question`, `action`, `directive` or `message` (default `question`) |
| `--image <path>` | A PNG, JPEG or WebP screenshot (repeatable) |
| `--attachments-file <path>` | A JSON array of image attachments with optional comparison roles |
| `--json` | Print the receipt with the durable attachment paths |
| `--agent <label>` | Subagent attribution label |
| `--session <id>` | Override the session id |
| `--project <name>` | Override the project |
| `--project-path <path>` | The source worktree, for repository context |
| `--source-message-file <path>` | A JSON object with only the known native `messageId`, `turnId` or `toolCallId` |

`--a-file` exists because answers are often long and full of characters a shell would mangle. Scripts should
prefer it over `--a`.

**Tags.** `question` is a real question. `directive` is an instruction the user gave mid-session. `action` is
something that was done. `message` is a message to the user (see below). Directives are what the user asked for,
so they are the most useful filter when you reconstruct why a session went the way it did.

### Images on recorded answers

The `question_answer` MCP tool takes an `attachments` array, or plain paths in `images`. The CLI takes `--image`
(repeatable), or the full array from a JSON file:

```bash
tools question record --q "Did the layout fix work?" --a-file answer.md --image /abs/after.png
tools question record --q "Did the layout fix work?" \
    --a-file answer.md \
    --attachments-file screenshots.json \
    --json
tools question log --session <id> --format json
```

```json
[
  { "type": "image", "path": "/abs/before.png", "label": "Before", "comparison": { "group": "layout", "role": "before" } },
  { "type": "image", "path": "/abs/after.png", "label": "After", "comparison": { "group": "layout", "role": "after" } }
]
```

- Only `type` and `path` are required. Still PNG, JPEG and WebP files only: no URLs, no base64. Header dimensions
  are checked before full decoding, and animated PNG or WebP files are refused.
- Each comparison group can hold one before and one after image. Duplicate roles are refused.
- The whole batch is validated before the answer is recorded, then copied into the durable attachment folder. The
  receipt and the history carry ids, durable paths, content hashes, dimensions, MIME types and byte counts. Moving
  the original screenshot later does not break the archived copy.
- Limits: 24 images, 25 MiB each, 100 MiB per batch, 48 million pixels per image. An invalid or missing image fails
  the recording; it never disappears silently from the answer.
- Older text-only records stay valid and read with an empty attachments list. Native archive cards and the
  comparison viewer are separate consumers of this format.

### `message`: messages and screenshots to the inbox

```bash
tools question message "Build is green, the hub after the fix:" --image /abs/hub-after.png
tools question message --title "Blocked" --file notes.md
```

Flags: `--image <path>` (repeatable), `--title <title>` (default: the first line of the text), `--file <path>`
(markdown text), `--agent <label>`, `--session <id>` (only outside Claude, Codex or Grok), `--project-path <path>`
(relative `--image` and `--file` paths resolve here), `--json`.

A message is a Q→A entry tagged `message`. The widget shows it as an unread, expandable card under the posting
session (status "Message"). The session is the stamp handoffs use: `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID` or
`GROK_SESSION_ID` in a harness child, or the resolved caller of the MCP gateway. `question_post` items (and
`ask --json` items) take `attachments` too: the screenshots are copied into the question store and embedded in the
item's prompt. The widget lifts every markdown image, `{{image}}` token and bare absolute image path of a card into
its preview strip.

### `log` and `tail`

```bash
tools question log                              # what has been captured (last 50)
tools question log -l 20 --format json
tools question log --unread
tools question log -p app -t directive
tools question tail -n 5                        # a backlog of 5, then follow
```

`log` flags: `-p, --project <name>`, `-t, --tag <tag>`, `--session <id>` (filtered before the limit), `--unread`,
`-l, --limit <n>` (default 50), `--format ai|json` (default `ai`). `tail -n, --lines <n>` sets the backlog (default
10, `0` for none). For a dashboard rather than a terminal, the dev-dashboard serves the same stream over SSE.

## Inline tokens

An item's `promptMarkdown`, `reasoning`, `proposal` and every choice label may carry `{{kind …}}` tokens. They are
resolved **when the item is saved** (`tools question ask` and the MCP `question_post`), so the reader sees the code,
diff or thread as it was when the question was asked. The engine is `@genesiscz/utils/transclude`
(`src/utils/transclude/`); `tools question` is its first user.

### Grammar

```text
{{<kind> key="value" key='value' key=value}}
```

- Params are **named and order-free**. The documented form is `key="value"` separated by spaces; `key: "value"`
  and commas between params work too.
- Inside quotes only `\"`, `\'` and `\\` are escapes, so a Windows path such as `"C:\Users\dev\a.ts"` needs no
  doubling.
- A literal `{{` is written `\{{`.
- **A token always has at least one `key=value` param**, or is the mdBook `{{#include …}}` form. So `{{diff}}`
  alone is not a token: write `{{diff path="."}}`.
- Two other `{{ }}` languages live in this repo, and the rule above keeps them apart:
  - Prompt variables (`renderPrompt` in `src/utils/template.ts`, used by the hub's prompts in
    `src/hub/lib/prompts.ts`) are a bare `{{name}}`. A bare `{{lines}}` or `{{ name }}` is never a token and stays
    for `renderPrompt`.
  - `tools automate` step params (`src/automate/lib/expressions.ts`) evaluate any `{{ … }}` as a JavaScript
    expression. Transclusion is not wired into automate, so do not put tokens in automate presets.
- Tokens inside inline code or a fenced code block stay literal, so a question about a template can quote
  `{{ user.name }}` safely.
- Relative paths resolve against the item's project path (`--project`, `projectPath`), else the calling harness's
  cwd. `~` is the home folder.
- mdBook aliases: `{{#include path}}` is `file`. `{{#include path:10:20}}`, `{{#include path:10}}`,
  `{{#include path::20}}` and `{{#include path:10:}}` are `lines`. `{{#include path:anchor}}` is `lines` with
  `anchor=` (the lines between `ANCHOR: anchor` and `ANCHOR_END: anchor`).

### The ten kinds

| Kind | Params (`*` required) | Example |
|------|-----------------------|---------|
| `lines` | `path*`, one of `range` / `anchor`, `commit` | `{{lines path="src/a.ts" range="612-633"}}` |
| `file` | `path*`, `commit`, `max` (lines, default 200) | `{{file path="bunfig.toml" max=40}}` |
| `symbol` | `path*`, `name*` (`Class.member` for a member), `commit` | `{{symbol path="src/a.ts" name="transclude"}}` |
| `diff` | `path`, `base`, `staged` (default false) | `{{diff path="src/a.ts"}}` |
| `tail` | `path*`, `n` (default 50, at most 1000) | `{{tail path="~/.genesis-tools/logs/2026-09-30.log" n=20}}` |
| `json` | `path*`, `pointer` (`/a/b/0` or `$.a.b[0]`), `commit` | `{{json path="package.json" pointer="/scripts/test"}}` |
| `cmd` | `run*`, `cwd`, `timeout` (ms, default 10000, at most 30000) | `{{cmd run="git log --oneline -5"}}` |
| `url` | `url*`, `chars` (excerpt length, default 300) | `{{url url="https://example.com"}}` |
| `image` | `path*`, `alt` | `{{image path="/abs/hub-before.png" alt="Before"}}` |
| `pr-thread` | one of `url` / `pr`, `comment`, `max` (comments, default 10) | `{{pr-thread pr="owner/repo#42"}}` |

What each one does:

- **`lines`, `file`, `json`**: with `commit=` the content comes from `git show <commit>:<path>`, which pins what the
  reader sees. Without it the working tree is read, and the token records the HEAD sha and whether the file had
  uncommitted changes (or is untracked), so the reader knows the lines may exist in no commit. `json` accepts JSONC
  (comments and trailing commas).
- **`symbol`**: TS and JS files are parsed with the TypeScript compiler (functions, classes, interfaces, types,
  enums, namespaces, `const`s and `Class.member`, leading doc comment included). Other languages use a heuristic:
  the first line reading `[modifiers] <keyword> <name>` (`def`, `func`, `function`, `fn`, `class`, `struct`, `enum`,
  `interface`, `protocol`, `extension`, `trait`, `impl`, `type`, `module`, `object`, `record`). A line ending in `:`
  ends at the next line indented no deeper. Otherwise the braces are balanced, and with no `{` in three lines the
  definition is that one line.
- **`diff`**: by default the working tree (committed and uncommitted work) against the merge-base with the default
  branch (`origin/HEAD`, else `origin/main`, `origin/master`, `main`, `master`). `base=` picks another base;
  `staged=true` shows only the index.
- **`tail`**: reads only the final megabyte of the file.
- **`cmd`**: one allowlisted read-only command, never a shell: `git log|show|status|diff|blame|rev-parse|ls-files|
  shortlog|describe|merge-base`, `tools ts skeleton`, `tools git base|merged` and `tools question list|tokens`.
  Pipes, redirects, `;`, `&`, `$` and backticks outside quotes are refused, and so are git flags that write or run
  programs (`--output`, `--ext-diff`, `--textconv`, …). The exit code is always shown. Its timeout never runs past
  the token's deadline.
- **`url`** `[verify]`: a quoted card with the page title and a short excerpt (meta description, else the first real
  paragraph); the footer has the fetch time. No cookies or auth are sent, and the body read stops at 512 KB.
- **`image`**: copies the picture into `~/.genesis-tools/question/assets/` under its content hash and embeds that
  copy, so the picture survives the original being moved or deleted.
- **`pr-thread`** `[verify]`: a PR or MR header (title, state, author, description), or with a comment the whole
  review thread plus its diff hunk. `url` may carry `#discussion_r…`, `#issuecomment-…`, `#pullrequestreview-…` or
  `#note_…`. `pr` is `owner/repo#12`, `#12` (the cwd's `origin`) or `path#12`. It uses the `gh` or `glab` login
  already on the machine.

### Provenance footer

Every block ends with one short footer line, so a reader who opens the question days later does not mistake frozen
text for the current state:

```text
_↳ captured 2026-09-30 17:11 UTC · src/a.ts@HEAD 545308d99, uncommitted changes · showing 40 of 212 lines · re-check: `{{file path="src/a.ts" max=40}}`_
```

It names the capture time, the exact source (path plus commit sha and the dirty or untracked flag,
`$ command (exit N)`, `URL (HTTP 200)`, `owner/repo#N comment id`), how much is shown when the kind showed less than
it read, `cut for size` when the character cap cut it, and the token that re-checks it. The token's
`meta.provenance` has the same fields plus the full command (`tools question tokens resolve '<token>'` shows it).
An inline result (an `image`) has no footer; its meta has the provenance.

### `substitute` and `verify`

Each kind has an `action`:

- **`substitute`** (the default) freezes the content at save time. That is right for a file, lines, a symbol, JSON
  or a diff, above all when pinned to a commit.
- **`verify`** stores the snapshot too, but keeps the token live. `url` and `pr-thread` are `verify` kinds, because
  a page or a review thread can change within hours. Future live kinds (CI status, ahead/behind counts, a listening
  port, an issue state) belong here.

```bash
tools question show d_3_<session> --recheck          # stores nothing
# unchanged: {{url url="https://example.com"}} (captured 2026-09-30 17:11 UTC)
# changed since capture: {{pr-thread pr="acme/widgets#7"}}: was "… · open · @alice", now "… · merged · @alice" (as of 2026-09-30 19:00 UTC; captured 2026-09-30 17:11 UTC)
# frozen (substitute, not re-checked): {{lines path="src/a.ts" range="1-5"}}
```

`--recheck` re-resolves each `verify` token and compares the sha256 of its content with the `signature` stored at
capture. The footer is not part of the signature, and a `verify` kind keeps times out of its content, so an
unchanged page stays "unchanged". A changed token shows the first line that differs, as captured and as it reads
now. `--json` prints the outcomes.

### Fail closed for external sinks

`transclude(text, { onFailure: "throw" })` resolves every token, then throws `TranscludeFailedError` with each
failure instead of writing markers. An externally visible sink (a PR comment, a message to someone) must use it,
so it refuses to post rather than publish `⚠️ unresolved`. The question log uses the default, `onFailure: "mark"`.

### Limits

Every substitution passes a secret redactor (provider keys, forge tokens, JWTs, private keys, credentials in URLs,
`TOKEN=…` assignments that look like a credential). One token may add at most 8,000 characters and one field at
most 40,000. A cut ends with `… [truncated: N more chars, cap 8000]` and closes an open code fence first. Each
token has a 10 s deadline.

### Failures

A token that cannot be resolved is **never dropped**. The text gets a marker that keeps the raw token and the
reason, as its own quote when the token stood on its own line:

```text
> ⚠️ unresolved `{{lines path="src/nope.ts" range="1-3"}}`: file not found: /…/src/nope.ts
```

The post itself still succeeds. `tools question ask` prints one stderr line per failed token, then a summary, and
the MCP `question_post` result ends with the same lines:

```text
transclude: item 1 reasoning: {{tial path="x"}}: unknown kind "tial" (did you mean tail?)
transclude: item 1 promptMarkdown: {{lines path="a.ts" rng="1-3"}}: unknown param "rng" for lines (expected: path, range, anchor, commit; did you mean range?)
transclude: item 2 proposal: {{lines path="a.ts"}}: lines needs one of range, anchor
transclude: 3 resolved, 3 failed
```

Other reasons you will see: `missing required param "path" for lines (…)`, `param "n" of tail expects an integer,
got "x"`, `duplicate param "path"`, `unterminated {{lines …: missing }}`, `range 900-910 starts past the end of a.ts
(312 lines)`, `unknown commit "abc"`, `cmd: "git push" is not on the read-only list (…)`, `HTTP 404 from https://…`,
`timed out after 10000 ms`.

Every token is logged to the day log (`~/.genesis-tools/logs/<date>.log`, components `transclude` and
`question-transclude`): kind, params, milliseconds and characters for each substitution, the raw token and reason
for each failure, and one summary per field.

### What is stored

The item keeps the **resolved** text (footers included) in its normal fields (`prompt`, `reasoning`, `proposal`,
`options`), so the hub, the chat section and every reader show real content. Beside it, `source` holds the fields as
written (tokens included, only the fields that changed). `transclusions` holds every token with its field, status,
reason, action, capture time, cwd, content `signature` (and the `snapshot` of a `verify` token) and meta
(provenance, commit sha, URL status, stored image path). `tools question show <id> --json` prints both.

`--no-transclude` (CLI) and `transclude: false` (MCP) store the text as written.

### Discover and preview

```bash
tools question tokens                     # every kind: a table in a terminal, the help text when piped
tools question tokens --format json       # the definitions, generated from the registry
tools question tokens resolve '{{lines path="src/a.ts" range="1-5"}} and {{diff path="."}}'   # stores nothing
echo '…' | tools question tokens resolve -
```

`tools question ask --help` ends with the same list. The MCP server has it in the `question_post` description and
in the read-only `question_tokens` tool (definitions, or a preview with `text`). All of these come from one
registry, so a new kind shows up everywhere without editing any copy.

### Adding a kind

A kind is one object in `src/utils/transclude/kinds/<name>.ts`, plus one line in `DEFAULT_TRANSCLUSIONS`
(`kinds/index.ts`):

```ts
export const headTransclusion = defineTransclusion({
    name: "head",
    description: "The first n lines of a file.",
    params: [
        { name: "path", type: "path", required: true, description: "The file." },
        { name: "n", type: "int", default: 20, description: "How many lines." },
    ],
    examples: ['{{head path="README.md" n=5}}'],
    action: "substitute", // the default; "verify" for an answer that can change within hours
    async resolve(params, ctx) {
        const text = await Bun.file(params.string("path")).text();
        return { markdown: text.split("\n").slice(0, params.int("n")).join("\n"), block: true };
    },
});
```

Params are validated from the definition before `resolve` runs (unknown names, required, types
`string|int|range|path|url|enum|bool`, enum values, `requireOneOf` groups). `ctx` has the cwd, a logger child, the
token's AbortSignal and deadline, the character cap, the redactor, an argv runner (never a shell) and `fetch`.
Throw `TransclusionError` for an expected failure; its message becomes the reason.

## How it works

Everything lives under `~/.genesis-tools/question/`. `GENESIS_TOOLS_HOME` replaces the home folder, so the data
moves to `$GENESIS_TOOLS_HOME/.genesis-tools/question/`:

| Path | What it holds |
|------|---------------|
| `log/<date>.jsonl` | The Q→A log, one day file, append-only (`QUESTION_LOG_BASE` moves it) |
| `qa.db` | SQLite: the read model over the log, and the pending forms (`qa_pending`) |
| `pending/<date>.jsonl` | Form lifecycle events; the dashboard tails them |
| `decisions/decisions.jsonl` | The decision and todo log |
| `decisions/events.jsonl` | Its event log |
| `assets/` | Images from `{{image}}` tokens and item attachments, named by content hash |
| `config.json` | The settings (`QUESTION_CONFIG_PATH` moves it) |
| `cache/` | Act tokens (`act-tokens.json`, owner-only), notices, the inbox scan and transcript-rows indexes |

- The JSONL files are the record. A write to `log/<date>.jsonl` or `pending/<date>.jsonl` is one `O_APPEND` line,
  so many agents can write at once without a lock. `qa.db` catches up from the log files when a reader opens it. The
  dashboard tails the pending event files, so a form created by a CLI in another terminal reaches the browser with no
  shared memory and no daemon between.
- The decision log is a locked JSONL document. Each post or update reads it, numbers or patches the rows and writes
  it back under one file lock, so two posts never take the same number and a rewrite never drops a row another
  writer added.
- Durable copies of recorded screenshots go to `~/.genesis-tools/attachments/images/`.
- The Obsidian sink is on by default. It writes each entry into a vault at `obsidianPathTemplate`. The vault root
  is `obsidian.vaultRoot` in `~/.genesis-tools/plugins/config.json` (set it with `config --obsidian-vault`), else
  Obsidian's active vault.
- Banners open the hub's Inbox when GenesisTools.app is installed; without the app a form's banner opens the
  dev-dashboard `/qa`.
- Delivery resumes an owned worker, writes to a Claude peer socket or a Grok leader socket, types into a cmux pane,
  or steers a `tools codex` worker (see Delivery above). `stale --install` registers a task with `tools daemon`.
- The `cmd`, `url` and `pr-thread` tokens run git, fetch a page, or call `gh` or `glab`. Nothing in this tool calls
  a paid API.

## Configuration

`tools question config` with no flag, in a terminal, opens a picker. Each flag writes `config.json` and prints the
whole config.

```bash
tools question config --list-sounds                          # every bundled and synth sound
tools question config --notify on --sound synth:soft-chime
tools question config --sound-volume 0.4
tools question config --obsidian off
tools question config --ask-via-question-tool on
```

| Key | Default | Flag |
|-----|---------|------|
| `sinks.obsidian` | `true` | `--obsidian on\|off` |
| `sinks.sound` | `false` | `--sound <spec>` turns it on, `--sound off` turns it off |
| `sinks.notify` | `false` | `--notify on\|off` |
| `sinks.notifyPending` | `true` | none; edit the file |
| `sound` | `bundled:switch.wav` | `--sound synth:<preset>\|bundled:<file>\|custom:<path>` |
| `soundVolume` | `0.6` | `--sound-volume <0..1>` |
| `obsidianPathTemplate` | `{project}/Questions/{date}.md` | none; edit the file |
| `askViaQuestionTool` | `false` | `--ask-via-question-tool on\|off` |

- The synth presets are `blip`, `knock`, `soft-chime` and `subtle-bell`. An unknown preset or bundled name fails and
  prints the sound list.
- `sinks.sound` and `sinks.notify` fire when an entry is recorded. That makes the log a live signal that an agent
  answered something, not only an archive.
- A `config.json` that does not parse is never replaced with defaults by a save: the save fails and leaves it
  untouched. Readers use defaults until it is fixed and log a warning.

### The agent opt-in (`--ask-via-question-tool`) and the native inbox

Agents learn about `tools question` from the genesis-tools MCP server instructions and the `question_post`
description (both read when the server starts), from the note every post returns, and from the plugin's
SessionStart hook `native-inbox-hint.ts`. What they are told depends first on this Mac's native inbox
(`nativeInboxState()`, `src/utils/macos/native-inbox.ts`):

- `none` (no native app): nothing about the inbox at all, and no `inbox_send` tool.
- `installed` (the widget can run here but does not): agents may post, and must ALSO ask the user in the chat.
- `running`: agents post decisions, messages and screenshots to the inbox when they need the user.

The opt-in only decides whether `question_post` REPLACES the agent's native question tool for `❓ DECISION`s (on),
or whether the agent asks natively as usual (off, the default). It never removes the chat ask while the widget is
not running, and every question is always also written in the chat reply. A change reaches agent sessions started
after it. The texts and this order live in one file, `src/question/lib/inbox-guidance.ts`.
`--ask-via-question-tool` with no value opens a picker in a terminal; elsewhere it prints the values and exits 1.

### Environment variables

| Variable | Effect |
|----------|--------|
| `QUESTION_CONFIG_PATH` | Another `config.json` |
| `QUESTION_LOG_BASE` | Another folder for the Q→A day files |
| `GENESIS_TOOLS_HOME` | Another home folder: data goes to `$GENESIS_TOOLS_HOME/.genesis-tools/question/` |
| `GENESIS_TOOLS_MCP_CAPABILITIES` | Which MCP tools the server exposes (see For agents) |

## For agents

- **MCP tools** (the genesis-tools server, `tools genesis-tools-mcp`): `question_post`, `question_wait`,
  `question_poll`, `question_cancel`, `question_respond` (the CLI `answer`), `question_update`, `question_tokens`,
  `question_answer` (the CLI `record`) and `inbox_send` (the CLI `message`). `GENESIS_TOOLS_MCP_CAPABILITIES` filters
  them: `question_ask` is the blocking ask set, `decision` is `question_post`, `question_poll`, `question_update` and
  `question_tokens`, `question_answer` also brings `inbox_send`, and `inbox` brings `inbox_send` only.
- **JSON output**: `--format json` on `ask`, `wait`, `poll`, `answer`, `cancel` and `tokens`; `--json` on `list`,
  `show`, `inbox`, `record`, `message`, `act` and `transcript-rows`; `log --format json`. `update`, `send`,
  `chat-answers`, `repair` and `stale` always print a result object. `inbox answer`, `draft`, `dismiss`, `send` and
  `target` always print a result object too, and a refusal (a missing `--session`, an `--expected-revision`
  mismatch) is `{ error }`.
- **Exit codes**: see `--wait` above. `act` exits 1 when refused; `list --status` exits 1 on a cancelled picker. The
  inbox subcommands exit 1 on a refusal (`inbox target` only for a missing `--session`).
- **The plugin skill** `question` (`plugins/genesis-tools/skills/question/SKILL.md`) tells an agent when to log an
  answer with `question_answer`, and to record chat answers to its decisions with `question_update`.

### Publishing from an agent into the widget

- Post a pending question or a decision when the user must choose. Collect the answer with `question_wait`,
  `question_poll` or the CLI. Log a finished answer or milestone with `question_answer` or `tools question record`.
  Publish real results and review evidence, never a timer of repeated unchanged status messages.
- Attach screenshots as local image attachments, with a label and an optional comparison group and role. The
  importer copies the bytes into durable storage, and the receipt returns those paths. A text-only file reference
  makes no image preview. A pending form must allow image paste; its returned `mediaContext` holds the prepared
  image and video evidence beside the typed answers.
- Repository and session context is gathered automatically. Read the returned context before you claim a result
  reached a particular session. A shared Codex app-server can own several transcripts, so an HTTP socket cannot
  identify one thread: that case is reported as unanchored, never guessed.
- When the harness gives the exact session id, pass `sessionHint` and the absolute `projectPath` to
  `question_answer` (or to `question_post`). Do not derive an id from a file name. If the connected MCP server is
  older than these fields, run `tools question record --json` from the agent's own worktree: the CLI uses that
  process's harness context. `--session` and `--project-path` take a context you know.
- `sourceMessage` is optional and holds only the native `messageId`, `turnId` or `toolCallId` the harness really
  gave. Leave it out when you do not have one. The stored `transcriptAnchor` tells native ids, a receipt-time
  approximation and a missing identity apart. A normalized parser id such as `codex-3` is not a native id. Earlier
  decision revisions keep their own repository facts and transcript anchor.
- Logging an answer does not ask an agent to resume. A widget follow-up can use only a verified delivery route; do
  not promise delivery from a transcript path or a guessed worker name.

## Set up on a fresh clone

An agent learns this tool from the genesis-tools MCP server, from `tools question ask --help` and from
`tools question tokens`. `install.sh` does not register the MCP server, so register it once:

```bash
git clone https://github.com/genesiscz/GenesisTools && cd GenesisTools
bun install && ./install.sh                    # puts `tools` on PATH (and builds GenesisTools.app on macOS)
source ~/.zshrc                                # or open a new terminal
tools genesis-tools-mcp install                # registers the genesis-tools stdio server in Claude Code
tools genesis-tools-mcp install --agent codex  # the same for Codex (grok works too)
tools question tokens                          # check: the ten kinds print
```

Restart the agent session afterwards: MCP servers are read when a session starts. In Claude Code, `/mcp` (or
`claude mcp get genesis-tools`) shows the server as connected. An existing entry that runs `tools claude mcp` is the
legacy alias of the same server and keeps working. The Claude Code plugin (`/plugin marketplace add
genesiscz/GenesisTools`, then `/plugin install genesis-tools`) adds the skills; it does not register this server.

## Troubleshooting

- **`--wait` returns exit 4.** Your wait budget ran out (default 120000 ms). The form is still pending: run
  `tools question wait <id>` again, with a longer `--timeout` if needed.
- **`Obsidian vault not found` when recording.** No vault resolves. Run
  `tools question config --obsidian-vault <path>`, open your vault in Obsidian once, or turn the sink off with
  `--obsidian off`.
- **`cannot supersede …: it is answered`.** Only an open or drafted item can be replaced. Post a new item instead,
  then mark the old one `superseded` with `update`.
- **The inbox keeps asking a decision the user answered in chat.** Record it with `update` (state `acknowledged`).
  For an older backlog, run `chat-answers --session <id>`, then `--apply`.
- **Answers stay queued and never reach the session.** No live route was found, and `decisions.injectAnswers` is
  off by default. `tools question inbox target --session <id>` shows the route and `queueHookOn`. Send again once
  the session is live, or turn the hook on with `tools agents hooks config set decisions.injectAnswers true --write`.
- **A chat answer an agent stored as `answered` is about to be delivered again, or a row is stuck in `drafted`.**
  Run `tools question repair` to see the plan, then `repair --apply`.
- **`tail` shows nothing new after midnight.** It follows the day file that was current when it started. Start it
  again.
- **A token shows `⚠️ unresolved`.** The reason follows the marker. Preview with `tools question tokens resolve
  '<token>'` before you post.

## Related

- [dev-dashboard](../dev-dashboard/README.md): the `/qa` page with the Pending section and the live feed.
- [hub](../hub/README.md): the native Inbox that shows forms, decisions and messages.
- [genesis-tools-mcp](../genesis-tools-mcp/README.md): the MCP server with the `question_*` and `inbox_send` tools.
- [agents](../agents/README.md): the hooks config (`decisions.staleness`, the decision Stop hook).
- [codex](../codex/README.md): the worker that receives Codex answers by steer.
- [daemon](../daemon/README.md): runs the `question-stale-decisions` task.
- [telegram-bot](../telegram-bot/README.md): decision buttons on the phone.
- [notify](../notify/README.md): macOS notifications.
- [automate](../automate/README.md): its `{{ … }}` expressions are a different template language.
