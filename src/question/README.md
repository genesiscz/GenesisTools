# tools question

> **Ask the user a blocking question, and capture the questions fired at agents mid-session with their answers.**

Two directions, one store:

1. **Ask** — the agent posts a question and waits. The form shows up on the dashboard `/qa` Pending section, raises a notification, and releases the agent when it is answered. `ask`, `wait`, `poll`, `answer`, `cancel`.
2. **Log** — the agent records a question it already answered itself, so a substantive answer given halfway through a long session is not lost in scrollback within an hour. `record`, `log`, `tail`.

Answering a pending form also writes a normal log entry, so `/qa` shows one list rather than two. Wire contract for other clients: `docs/qa-pending-contract.md`.

---

## Commands

| Command | Description |
|---------|-------------|
| `ask` (alias `post`) | Ask the user a question and leave it pending until they answer |
| `wait <id>` | Block until a pending form is answered, cancelled or times out |
| `poll [ids…]` | Show pending forms, or the status of the ids you name |
| `answer <id>` | Answer a pending form from the terminal |
| `cancel <id>` | Withdraw a pending form; a blocked waiter is released as cancelled |
| `record` | Record a question and answer pair after the fact. Used by the `question_answer` MCP tool and by scripts. |
| `log` | Show recorded pairs, oldest first, last N entries |
| `tail` (alias `answers`) | Live feed of pairs as they are recorded, with a backlog |
| `config` | Read or update the sink config: sound, notify, Obsidian template |
| `show <id>` | One decision or todo; `--versions` lists the texts later posts superseded, `--json` prints the stored row |
| `tokens` | The inline `{{kind …}}` tokens (table, or `--format json`); `tokens resolve "<text>"` previews a resolution |

### Asking

```bash
tools question ask -q "Ship the PR?" --choices yes,no          # prints the form, returns at once
tools question ask -q "Ship?" --choices yes,no --wait          # block until answered
tools question ask --json '[{"promptMarkdown":"Target?","choices":["staging","prod"]},{"promptMarkdown":"Notes?"}]'
tools question poll                                            # what is still waiting
tools question answer ask_5f1c… --choice yes
tools question cancel ask_5f1c…
```

`--wait` exits `0` answered, `1` not_found, `2` timeout, `3` cancelled, `4` budget exhausted, so a script can branch on the outcome. `budget_exhausted` means your own wait ran out while the form is still pending; the form is alive and you may wait again. `not_found` means no form carries that id, so waiting again will not help.

A partial submit is never stored: `answer` refuses a form that still has a required item blank. Answer a multi-item form in one call:

```bash
tools question answer ask_5f1c… --json '[{"itemId":"q1","freeText":"staging"},{"itemId":"q2","freeText":"after the migration"}]'
```

### `answer` flags

| Flag | Description |
|------|-------------|
| `-t, --text <text>` | Free-text answer |
| `--choice <id>` | Selected choice id (repeatable) |
| `--file <path>` | `@file` tag, relative to the form cwd (repeatable) |
| `--item <itemId>` | Which item this answers (single-item forms default to the only one) |
| `--json <answers>` | Answer several items at once: a JSON array of `AskAnswer` objects |

### `ask` flags

| Flag | Description |
|------|-------------|
| `-q, --q <question>` | The question, markdown allowed |
| `--choices <list>` | Comma-separated choice labels |
| `--multiple` | Allow more than one choice |
| `--no-free-text` | Do not offer a free-text box |
| `--file-tags` | Allow `@file` tags, resolved against the form cwd |
| `--image-paste` | Allow pasted images |
| `--optional` | The item may be left blank |
| `--json <items>` | Multi-question form as a JSON array of items |
| `--timeout <ms>` | Auto-retire the form after this long |
| `--wait` / `--wait-timeout <ms>` | Block, and for how long (default 120000) |
| `--source <name>` / `--session <id>` | Who is asking, and the session to attribute the answer to |
| `--no-notify` | Do not raise a notification for this form or these decisions |
| `--no-transclude` | Store `{{…}}` tokens as written instead of resolving them (see Inline tokens) |
| `--supersedes <id>` | Replace this open or drafted decision/todo with the one decision/todo item of the post |

## Quick start

```bash
tools question log                              # what has been captured
tools question log -l 20 --format ai
tools question log --unread
tools question log -p GenesisTools -t directive
tools question tail -n 5                        # backlog then follow
tools question config --list-sounds
tools question config --notify on --sound synth:soft
```

### `record` options

| Flag | Description |
|------|-------------|
| `--q <question>` | The question |
| `--a <answer>` | The answer, markdown allowed |
| `--a-file <path>` | Read the answer from a file instead |
| `--tag <tag>` | `question`, `action` or `directive` (default: `question`) |
| `--agent <label>` | Subagent attribution label |
| `--session <id>` | Override the session id |
| `--project <name>` | Override the project |

### `log` options

| Flag | Description |
|------|-------------|
| `-p, --project <name>` | Filter by project |
| `-t, --tag <tag>` | Filter by tag |
| `--unread` | Only unread entries |
| `-l, --limit <n>` | Limit the number of entries |
| `--format <fmt>` | `ai` or `json` (default: `ai`) |

### `config` options

| Flag | Description |
|------|-------------|
| `--sound [spec]` | `synth:<preset>`, `bundled:<file>`, `custom:<path>` or `off` |
| `--sound-volume <n>` | 0 to 1 |
| `--notify <onoff>` | `on` or `off` |
| `--obsidian <onoff>` | `on` or `off` |
| `--obsidian-vault <path>` | Set the Obsidian vault override |
| `--list-sounds` | List every available sound, bundled and synth, then exit |
| `--ask-via-question-tool [onoff]` | "Ask agents to use tools question instead of their native question tools?" `on` or `off`, default `off`. Without a value: a picker in a terminal, the possible values otherwise. Bare `tools question config` in a terminal opens the same picker. |

### The agent opt-in (`--ask-via-question-tool`)

No hook is involved. Agents learn about `tools question` from two texts of the genesis-tools MCP server: its server instructions and the `question_post` tool description, both read when the server starts. With the setting on, both tell agents to post every ❓ DECISION through `question_post` (or `tools question ask`). With it off (the default), both tell agents to ask with their native question tool (for example AskUserQuestion) and in their chat reply. A post still lands in the inbox either way, and its result says so. Every post's result also tells the agent that the inbox is a copy: the question must also be written in its own reply.

---

## Inline tokens

An item's `promptMarkdown`, `reasoning`, `proposal` and every choice label may carry `{{kind …}}` tokens. They are resolved **when the item is saved** (`tools question ask` and the MCP `question_post`), so the reader sees the code, diff or thread as it was when the question was asked, not as it is by the time they read it. The engine is `@genesiscz/utils/transclude` (`src/utils/transclude/`); `tools question` is its first user.

### Grammar

```text
{{<kind> key="value" key='value' key=value}}
```

- Params are **named and order-free**. The documented form is `key="value"` separated by spaces; `key: "value"` and commas between params are accepted too.
- Inside quotes only `\"`, `\'` and `\\` are escapes, so a Windows path such as `"C:\Users\dev\a.ts"` needs no doubling.
- A literal `{{` is written `\{{`.
- **A token always carries at least one `key=value` param**, or is the mdBook `{{#include …}}` form. So `{{diff}}` alone is not a token: write `{{diff path="."}}`.
- Two other `{{ }}` languages live in this repo, and the rule above keeps them apart:
  - Prompt variables (`src/utils/template.ts` `renderPrompt`, used by `src/hub/lib/prompts.ts`) are a bare `{{name}}`. A bare `{{lines}}` or `{{ name }}` is never a token and stays untouched for `renderPrompt`.
  - `tools automate` step params (`src/automate/lib/expressions.ts`) evaluate any `{{ … }}` as a JavaScript expression. That is a separate template language; transclusion is not wired into automate, so do not put tokens in automate presets.
- Tokens inside inline code (`` `…` ``) or a fenced code block stay literal, so a question about a template can quote `{{ user.name }}` safely.
- Relative paths resolve against the item's project path (`--project`, `projectPath`), else the calling harness's cwd. `~` is the home folder.
- mdBook aliases: `{{#include path}}` is `file`; `{{#include path:10:20}}`, `{{#include path:10}}`, `{{#include path::20}}` and `{{#include path:10:}}` are `lines`; `{{#include path:anchor}}` is `lines` with `anchor=` (the lines between `ANCHOR: anchor` and `ANCHOR_END: anchor`).

### The ten kinds

| Kind | Params (`*` required) | Example |
|------|-----------------------|---------|
| `lines` | `path*`, one of `range` / `anchor`, `commit` | `{{lines path="src/question/lib/decisions/store.ts" range="612-633"}}` |
| `file` | `path*`, `commit`, `max` (lines, default 200) | `{{file path="bunfig.toml" max=40}}` |
| `symbol` | `path*`, `name*` (`Class.member` for a member), `commit` | `{{symbol path="src/utils/transclude/engine.ts" name="transclude"}}` |
| `diff` | `path`, `base`, `staged` | `{{diff path="src/question/lib/decisions/store.ts"}}` |
| `tail` | `path*`, `n` (default 50, at most 1000) | `{{tail path="~/.genesis-tools/logs/2026-09-30.log" n=20}}` |
| `json` | `path*`, `pointer` (`/a/b/0` or `$.a.b[0]`), `commit` | `{{json path="package.json" pointer="/scripts/test"}}` |
| `cmd` | `run*`, `cwd`, `timeout` (ms, default 10000, at most 30000, never past the token's deadline) | `{{cmd run="git log --oneline -5"}}` |
| `url` | `url*`, `chars` (excerpt length, default 300) | `{{url url="https://rust-lang.github.io/mdBook/format/mdbook.html"}}` |
| `image` | `path*`, `alt` | `{{image path="/path/to/hub-before.png" alt="Hub before the fix"}}` |
| `pr-thread` | one of `url` / `pr`, `comment`, `max` (comments, default 10) | `{{pr-thread url="https://github.com/genesiscz/GenesisTools/pull/434#discussion_r4139866100"}}` |

What each one does:

- **`lines`, `file`, `json`**: with `commit=` the content comes from `git show <commit>:<path>`, which pins what the reader sees. Without it the working tree is read, and the token records the HEAD sha and whether the file had uncommitted changes (or is untracked), so the reader knows the lines may exist in no commit.
- **`symbol`**: TS/JS files are parsed with the TypeScript compiler (functions, classes, interfaces, types, enums, namespaces, `const`s and `Class.member`, leading doc comment included). Other languages use a heuristic: the first line reading `[modifiers] <keyword> <name>` (`def`, `func`, `function`, `fn`, `class`, `struct`, `enum`, `interface`, `protocol`, `extension`, `trait`, `impl`, `type`, `module`, `object`, `record`); a line ending in `:` ends at the next line indented no deeper, otherwise the braces are balanced, and with no `{` in three lines the definition is that one line.
- **`diff`**: by default the working tree (committed and uncommitted work) against the merge-base with the default branch (`origin/HEAD`, else `origin/main`, `origin/master`, `main`, `master`). `base=` picks another base; `staged=true` shows only the index.
- **`cmd`**: one allowlisted read-only command, never a shell: `git log|show|status|diff|blame|rev-parse|ls-files|shortlog|describe|merge-base` and `tools ts skeleton`, `tools git base|merged`, `tools question list|tokens`. Pipes, redirects, `;`, `&`, `$` and backticks outside quotes are refused, and so are git flags that write or run programs (`--output`, `--ext-diff`, `--textconv`, …). The exit code is always shown.
- **`url`** `[verify]`: a quoted card with the page title and a short excerpt (meta description, else the first real paragraph); the footer carries the fetch time. No cookies or auth are sent; the body read stops at 512 KB.
- **`image`**: copies the picture into `~/.genesis-tools/question/assets/` under its content hash and embeds that copy, so the picture survives the original being moved.
- **`pr-thread`** `[verify]`: a PR/MR header (title, state, author, description), or with a comment the whole review thread plus its diff hunk. `url` may carry `#discussion_r…`, `#issuecomment-…`, `#pullrequestreview-…` or `#note_…`; `pr` is `owner/repo#12`, `#12` (the cwd's `origin`) or `path#12`. It uses the `gh` / `glab` login already on the machine.

### Provenance footer

Every block ends with one short footer line, so a reader who opens the question days later does not mistake frozen text for the current state:

```text
_↳ captured 2026-09-30 17:11 UTC · src/a.ts@HEAD 545308d99, uncommitted changes · showing 40 of 212 lines · re-check: `{{file path="src/a.ts" max=40}}`_
```

It names the capture time, the exact source (path plus commit sha and the dirty or untracked flag, `$ command (exit N)`, `URL (HTTP 200)`, `owner/repo#N comment id`), how much is shown when the kind showed less than it read, `cut for size` when the character cap cut it, and the token that re-checks it. The token's `meta.provenance` carries the same fields plus the full command: `tools question tokens resolve '<token>'`. An inline result (an `image`) has no footer; its meta has the provenance.

### `substitute` and `verify`

Each kind has an `action`:

- **`substitute`** (the default) freezes the content at save time. That is right for a file, lines, a symbol, JSON or a diff, above all when pinned to a commit.
- **`verify`** stores the snapshot too, but keeps the token live. `url` and `pr-thread` are `verify` kinds, because a page or a review thread can change within hours. Future live kinds (CI status, ahead/behind counts, a port listening, an issue state) belong here.

```bash
tools question show d_3_<session> --recheck          # stores nothing
# unchanged: {{url url="https://example.com"}} (captured 2026-09-30 17:11 UTC)
# changed since capture: {{pr-thread pr="acme/widgets#7"}}: was "… · open · @alice", now "… · merged · @alice" (as of 2026-09-30 19:00 UTC; captured 2026-09-30 17:11 UTC)
# frozen (substitute, not re-checked): {{lines path="src/a.ts" range="1-5"}}
```

`recheck(tokens)` in the engine re-resolves each `verify` token and compares the sha256 of its content with the `signature` stored at capture (the footer is not part of the signature, and a `verify` kind keeps times out of its content, so an unchanged page stays "unchanged"). A changed token shows the first line that differs, as captured and as it reads now. `--json` prints the outcomes.

### Fail closed for external sinks

`transclude(text, { onFailure: "throw" })` resolves every token, then throws `TranscludeFailedError` listing each failure instead of writing markers. An externally visible sink (a PR comment, a message to someone) must use it, so it refuses to post rather than publish `⚠️ unresolved`. The question log uses the default, `onFailure: "mark"`.

### Limits

Every substitution passes a secret redactor (provider keys, forge tokens, JWTs, private keys, credentials in URLs, `TOKEN=…` assignments that look like a credential). One token may add at most 8,000 characters and one field at most 40,000; a cut ends with `… [truncated: N more chars, cap 8000]` and closes an open code fence first. Each token has a 10 s deadline.

### Failures

A token that cannot be resolved is **never dropped**. It is replaced in the text by a marker that keeps the raw token and the reason, as its own quote when the token stood on its own line:

```text
> ⚠️ unresolved `{{lines path="src/nope.ts" range="1-3"}}`: file not found: /…/src/nope.ts
```

The post itself still succeeds. `tools question ask` prints one stderr line per failed token, then a summary, and the MCP `question_post` result ends with the same lines:

```text
transclude: item 1 reasoning: {{tial path="x"}}: unknown kind "tial" (did you mean tail?)
transclude: item 1 promptMarkdown: {{lines path="a.ts" rng="1-3"}}: unknown param "rng" for lines (expected: path, range, anchor, commit; did you mean range?)
transclude: item 2 proposal: {{lines path="a.ts"}}: lines needs one of range, anchor
transclude: 3 resolved, 3 failed
```

Other reasons you will see: `missing required param "path" for lines (…)`, `param "n" of tail expects an integer, got "x"`, `duplicate param "path"`, `unterminated {{lines …: missing }}`, `range 900-910 starts past the end of a.ts (312 lines)`, `unknown commit "abc"`, `cmd: "git push" is not on the read-only list (…)`, `HTTP 404 from https://…`, `timed out after 10000 ms`.

Every token is logged to the day log (`~/.genesis-tools/logs/<date>.log`, component `transclude` / `question-transclude`): kind, params, milliseconds and characters for each substitution, the raw token and reason for each failure, and one summary per field.

### What is stored

The item keeps the **resolved** text (footers included) in its normal fields (`prompt`, `reasoning`, `proposal`, `options`), so the hub, the chat section and every reader show real content. Beside it, `source` holds the fields as written (tokens included, only the fields that changed) and `transclusions` holds every token with its field, status, reason, action, capture time, cwd, content `signature` (and the `snapshot` of a `verify` token) and meta (provenance, commit sha, URL status, stored image path). `tools question show <id> --json` prints both.

`--no-transclude` (CLI) and `transclude: false` (MCP) store the text as written.

### Discover and preview

```bash
tools question tokens                     # every kind: a table in a terminal, the help text when piped
tools question tokens --format json       # the definitions, generated from the registry
tools question tokens resolve '{{lines path="src/a.ts" range="1-5"}} and {{diff path="."}}'   # preview; stores nothing
echo '…' | tools question tokens resolve -
```

`tools question ask --help` ends with the same list, and the MCP server carries it in the `question_post` description and in the read-only `question_tokens` tool (definitions, or a preview with `text`). All of these are generated from one registry, so a new kind shows up everywhere without editing any copy.

### Adding a kind

A kind is one object in `src/utils/transclude/kinds/<name>.ts`, plus one line in `DEFAULT_TRANSCLUSIONS` (`kinds/index.ts`):

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

Params are validated from the definition before `resolve` runs (unknown names, required, types `string|int|range|path|url|enum|bool`, enum values, `requireOneOf` groups). `ctx` carries the cwd, a logger child, the token's AbortSignal and deadline, the character cap, the redactor, an argv runner (never a shell) and `fetch`. Throw `TransclusionError` for an expected failure; its message becomes the reason.

## Superseding a decision or todo

To correct an item nobody has answered yet, post it again with `supersedes`:

```bash
echo '[{"type":"decision","promptMarkdown":"Keep the cache? (now with numbers)","choices":["Keep","Drop"],"supersedes":"d_3_<session>"}]' \
  | tools question ask --json -
# or, for a post with exactly one decision or todo item:
tools question ask --json - --supersedes d_3_<session> < item.json
```

The MCP `question_post` item takes the same `supersedes` field.

- The item **keeps its id and number**, so "DECISION 3" in the chat and every link to it stay true. Its text, options, reasoning, refs and tokens are replaced; it goes back to `open`, and its chat section says `revision 2 (earlier text: tools question show d_3_<session> --versions)`.
- The earlier text is **not lost**: it moves to the item's `versions` list (revision, state, posted and superseded times, the draft the user had started). The inbox shows only the current version. `tools question show <id> --versions` lists all of them, oldest first.
- Only an `open` or `drafted` item can be superseded; an answer must keep pointing at the text it answered, so an answered, sent or closed item is refused (`cannot supersede d_3_x: it is answered, and only an open or drafted item can be replaced; post a new item instead`). The kind must match, and a pending form is not superseded (cancel it and post a new one).
- A post whose supersede is refused stores nothing, including its other items.

## Set up on a fresh clone

How a new user's agent learns this grammar: from the genesis-tools MCP server (its instructions and the `question_post` description list every kind, and `question_tokens` returns the definitions), from `tools question ask --help`, and from `tools question tokens`. The MCP server is not registered by `install.sh`, so register it once:

```bash
git clone https://github.com/genesiscz/GenesisTools && cd GenesisTools
bun install && ./install.sh          # puts `tools` on PATH (and builds GenesisTools.app on macOS)
source ~/.zshrc                      # or open a new terminal
tools genesis-tools-mcp install      # registers `tools genesis-tools-mcp` as the genesis-tools stdio server in Claude Code
tools genesis-tools-mcp install --agent codex   # the same for Codex
tools question tokens                # check: the ten kinds print
```

Restart the agent session afterwards: MCP servers are read when a session starts. In Claude Code, `/mcp` (or `claude mcp get genesis-tools`) shows the server as connected. An existing entry that runs `tools claude mcp` is the legacy alias of the same server and keeps working. The Claude Code plugin (`/plugin marketplace add genesiscz/GenesisTools`, then `/plugin install genesis-tools`) adds the skills; it does not register this server.

---

## Who calls `record`

You rarely do. The normal writer is the `question_answer` tool on the genesis-tools MCP server, which an agent calls right after answering something worth keeping. `tools claude mcp` starts that server, and the `question` skill tells the agent when to fire it.

`--a-file` exists because answers are often long and full of characters a shell would mangle. Scripts should prefer it over `--a`.

## Tags

`question` is an actual question. `directive` is an instruction you gave mid-session. `action` is something that was done. The distinction matters when reviewing: directives are what you asked for, and are the most useful filter when reconstructing why a session went the way it did.

## Notes

- The sound and notification settings fire when an entry is recorded, which turns the sink into a live signal that an agent answered something, not only an archive.
- With Obsidian enabled, entries can be written into your vault as well, using the configured template.
- Live feed for a dashboard rather than a terminal: the dev-dashboard exposes the same stream over SSE.

## Pending-form order and notifications

- **Oldest first.** `poll` and the dashboard's Pending section list forms oldest-created first, so a second agent's question never jumps ahead of one you are already looking at.
- **Banners open the hub.** With GenesisTools.app installed, a new form's banner and the banner for posted decisions open the hub's Inbox at that card (`GenesisTools --hub --question <id>` / `--decision <id>`). Without the app, a form's banner opens /qa and decisions raise no banner. Decisions announce themselves when they wait for you: a decision unless its `for` names someone else, a todo only with `for: "human"`. One banner per post.
- **Banner buttons.** For a form that is exactly one required item with two choices of opposite yes/no polarity ("Yes"/"No", "Accept"/"Reject", …), the banner carries one button per choice that answers the form directly, the same as running `tools question answer <id> --choice <id>`. A "staging"/"production" pair does not qualify: neither label has a polarity. Any other form's banner carries no buttons; the click itself already opens the form.
- **Retraction.** Answering, cancelling, or timing out a form removes its banner from Notification Center, wherever it is still sitting.
- **Not implemented: time-sensitive / break-through-DND banners.** The native layer supports `ignoreDnD`, but `GenesisTools.app`'s code-signing identity cannot carry the `timeSensitive` entitlement (`timeSensitiveSetting: notSupported` — see the repo's macOS notifications notes), so passing it would be silently ignored by the OS. A pending-form banner can still be swallowed by a system Focus mode.
