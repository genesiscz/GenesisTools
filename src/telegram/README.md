# tools telegram

A Telegram client that signs in as **your own user account** over MTProto, not as a bot. It reacts to new
messages from the chats you pick (speak them, show a notification, or answer with an LLM), gives you a terminal
chat view with an AI assistant and reply suggestions, and keeps a local, searchable copy of your history.

Use [`tools telegram-bot`](../telegram-bot/README.md) when you want a bot that sends notifications. Use this tool
when the messages are in your personal chats: to mirror them into AI workflows, follow a chat from the terminal,
or answer with a local agent.

## Quick start

```bash
# Sign in as your user and pick the chats to watch (one time)
tools telegram configure

# React to new private messages from those chats: say, notify, or auto-reply
tools telegram listen

# Chat with one contact in the terminal, with /ask, /suggest and /pick
tools telegram watch alice

# Copy messages into the local database (first run: the newest 100 per chat)
tools telegram history download --all

# Keyword search in one chat
tools telegram history search alice "dinner"

# Filter by date and sender; fetches any missing date range from Telegram first
tools telegram history query --from alice --since "last week" --sender them
```

A contact argument is the display name (any case), the numeric user ID, or the username of a chat you chose in
`configure`. Quote a name with spaces: `"Alice Example"`.

## Commands

Global flags: `-v, --verbose` (verbose logging), `--readme` (print this file), `-V, --version`, `-h, --help`.

### Setup

| Command | What it does |
|---------|--------------|
| `configure` | Wizard: sign in, pick chats, set actions and AI modes per chat |
| `contacts` | List the watched chats with their actions; remove one |

`configure` takes no flags. It runs these steps:

1. If a saved session still works, it skips the sign-in. Otherwise it asks for the API ID and API hash. Both are
   pre-filled with a built-in pair, so you can press Enter. Your own pair comes from https://my.telegram.org/apps.
2. It asks for your phone number with the country code, the code Telegram sends you, and your 2FA password if
   you have one.
3. It loads your 200 most recent chats (people, groups and channels; bots and Saved Messages are left out) and
   lets you tick the ones to watch. Chats you watch already are ticked.
4. For each chat it asks:
   - **Actions** for `listen` (at least one, default `notify`): `say` (speak it), `ask` (auto-reply with an LLM),
     `notify` (notification).
   - The **system prompt** for auto-replies, when you chose `ask`.
   - **AI modes**: Auto-Reply, Chat Assistant (`/ask` in `watch`), Message Suggestions (`/suggest`), and for each
     ticked mode whether to pick a custom model.
   - The **context window**: how many recent messages `watch` shows (1 to 500, default 30).

The chats you tick replace the saved list, so a chat you untick is dropped. The list offers only your 200 most
recent chats. A watched chat that is no longer among them is not shown, so a rerun of `configure` removes it.
`contacts` takes no flags either; its only edit is removing one chat, so use it to drop one chat without a full
rerun.

### Live

| Command | What it does |
|---------|--------------|
| `listen` | Run each chat's actions on every new private message; Ctrl+C stops |
| `watch [contact]` | Full-screen chat with one contact; asks which one when you omit it |

`watch` option: `--context-length <n>` sets the number of recent messages to show for this run.

On start, `listen` fetches the newest 100 messages of each chat into the database and keeps the last 30 as the
LLM context. It then works as follows:

- It reacts only to private chats. Messages in a group or channel you picked do not run any action.
- It ignores messages you send yourself, and it skips a message ID it handled already (it remembers the last 500).
- It runs the actions in the order you chose them. `ask` shows "typing…" in the chat while the model works, then
  waits a random 2 to 5 seconds before it sends the reply.
- It writes each incoming private message from a watched chat, and each auto-reply, to the history database.
  It does not store the new messages of a watched group or channel. Only its start-up fetch and the edits below
  reach the database; `history download`, `history query` and `watch` store the rest.
- It records edits in every chat the account sees, not only the watched ones. An edit to a stored message saves
  the old and new text. An edited message that is not stored yet is saved as a new message, without its old text.
- It marks a deletion only for a message that is already in the database.
- It logs each incoming message (the name and a preview) and each action result (`[ask] OK "<reply>"`,
  `[say] FAILED: <error>`) to stderr. `-v` adds debug lines.

`watch` syncs the new messages of the chosen chat, then opens the chat view. Text that does not start with `/` is
**sent as you** when you press Enter. Turn on `/careful` if you want to send only through `/send`. Tab switches
between the chat and the contact list. The contact list counts unread messages from your other watched chats. A
chat you switch to shows what the database holds; it is not synced again.

| Slash command | What it does |
|---------------|--------------|
| `/ask <question>` | Ask the assistant model a question |
| `/suggest [prompt]` | Get reply suggestions for the last 10 messages |
| `/pick <n> [text]` | Send suggestion n, or your edited text instead |
| `/send <text>` | Send a message; careful mode only (chat mode prints the usage line) |
| `/careful` | Toggle careful mode: plain text is not sent |
| `/model` | Show the models; `/model <mode> <provider>/<model>` sets one |
| `/style` | Sum up your style from your last 200 messages here |
| `/attachment <id>` | List the attachments of message `<id>` |
| `/contacts` | Open the contact list |
| `/quit`, `/exit` | Leave `watch` |
| `/help` | Print the list |

- `/model` takes the mode `assistant`, `suggestions` or `autoReply`. The change lasts for this `watch` run only
  and is not saved.
- `/pick` with your own text records the suggestion and what you really sent. The next suggestions for that chat
  get up to five of these corrections as examples.
- `/attachment` only lists. Its help line says "List/download", but you download with
  `history attachments fetch`.

### History

All of these are `tools telegram history <command>`.

| Command | What it does |
|---------|--------------|
| `download [contact]` | Copy messages from Telegram into the database |
| `embed [contact]` | Make semantic embeddings for stored messages |
| `search <contact> <query>` | Keyword, semantic or hybrid search |
| `export <contact>` | Write a chat as JSON, CSV or text |
| `stats [contact]` | Message counts and date ranges |
| `query` | Filter by date, sender and text; fetches missing ranges |
| `attachments list` | List the attachments of a chat |
| `attachments fetch` | Download one attachment |

**`download [contact]`** with `--since <date>`, `--until <date>` (YYYY-MM-DD), `--limit <n>`, `--all` (every
watched chat). With no contact and no `--all`, it asks which chat. The first run of a chat fetches only the newest
100 messages (or `--limit`). Later runs fetch only the messages after the last one stored. To backfill older
messages, give `--since`: the tool then fetches only the date ranges the database does not hold yet. At the end it
asks whether to make embeddings now, so run it in a terminal.

A `--until` date in YYYY-MM-DD form means 00:00 UTC at the start of that day, and the range ends there. This is
true for `download`, `search`, `export`, `query` and `attachments list`. To include a whole day, give the next
day. The example below covers January to June 2025:

```bash
tools telegram history download alice \
    --since 2025-01-01 \
    --until 2025-07-01
```

**`embed [contact]`** with `--all`. It embeds every stored message that has no embedding yet. Messages shorter
than 3 characters and messages in an unsupported language are skipped.

**`search <contact> <query>`** with `--since <date>`, `--until <date>` (YYYY-MM-DD), `--semantic` (vector
search), `--hybrid` (keyword and vector results merged), `--limit <n>` (default 20). Plain keyword search uses the
SQLite full-text index. If the query cannot be embedded, it falls back to keyword search.

**`export <contact>`** with `--format <fmt>` (required: `json`, `csv` or `txt`), `--since <date>`,
`--until <date>`, `-o, --output <path>` (default: stdout). It reads the database only.

```bash
tools telegram history export alice \
    --format csv \
    -o ~/Projects/app/alice.csv
```

**`stats [contact]`** shows total, sent, received and embedded counts with the first and last date. With no
contact it prints one table row per chat and a summary.

**`query`** with `--from <contact>` (required), `--since <date>`, `--until <date>`, `--sender <who>` (`me`,
`them` or `any`, default `any`), `--text <pattern>`, `--local-only`, `--limit <n>`.

- Dates take natural language ("yesterday", "last week") or YYYY-MM-DD.
- `--text` matches a substring, and deleted messages are left out.
- `--limit` keeps the newest n results.
- When you give a date and no `--local-only`, `query` first fetches the parts of that range the database does not
  hold. Without a date it reads the database only, but it still connects to Telegram unless you pass
  `--local-only`.

**`attachments list`** with `--from <contact>` (required), `--since <date>`, `--until <date>`,
`--message-id <id>`. It lists what the database knows: kind, file name, index and whether the file is downloaded
(`dl`) or not (`--`). Attachments are indexed by `download`, by `query` with a date, and by the sync when
`watch` starts. `listen` and the live messages in `watch` do not index them. Run `history download <contact>`
before you fetch an attachment that came in during `listen`, or `fetch` fails with "Attachment not found".

**`attachments fetch`** with `--from <contact>` (required), `--message-id <id>` (required),
`--attachment-index <n>` (default 0), `--output <path>`. It prints the path, the size and the SHA-256. A file
already downloaded is not fetched again.

```bash
tools telegram history attachments fetch \
    --from alice \
    --message-id 4242 \
    --attachment-index 0
```

## How it works

The tool talks to Telegram through the GramJS library (the `telegram` npm package) with your user session. All
data lives under `~/.genesis-tools/telegram/`. With `GENESIS_TOOLS_HOME` set, it is under
`$GENESIS_TOOLS_HOME/.genesis-tools/telegram/`:

```text
~/.genesis-tools/telegram/
  config.json                    API ID and hash, session string, watched chats (mode 600)
  history.db                     SQLite: messages, full-text index, embeddings, edits,
                                 attachments, synced date ranges, suggestion corrections
  ai-sessions/                   saved AI chats for auto-replies and /ask
  chats/<chat id>/attachments/   files from `history attachments fetch`
```

- **The session string in `config.json` is a full login** to your account. The tool sets the file to mode 600
  each time it saves it. Do not share or commit it. To revoke it, end the session in Telegram's list of active
  sessions.
- **Everything is sent as you.** Auto-replies, `/send`, `/pick` and plain text in `watch` come from your account.
  Take care when you turn on `ask` for a chat.
- **LLM calls cost money**: the `ask` action, `/ask`, `/suggest` and automatic suggestions. They go through the
  `tools ask` chat layer. With no model set, the provider is `openai` with the catalog's OpenAI chat model
  (`MODEL_ROLES.openai.chat` in `src/utils/ai/catalog/roles.ts`, `gpt-5-chat-latest` on 2026-11-09). The provider
  needs a working account; see [`tools ask`](../ask/README.md).
- **Auto-replies get more expensive during one `listen` run.** For each incoming message, `ask` adds a new
  "[Recent conversation]" block (up to 30 lines) to that chat's AI session, and every call sends all earlier
  blocks again. The input tokens of each auto-reply therefore grow until you restart `listen`.
- **Embeddings and language detection run on the Mac** through Apple's NaturalLanguage framework (DarwinKit).
  They are free, but they need macOS. Semantic search covers English, Spanish, French, German, Italian, Portuguese
  and Chinese. Keyword search covers every language.
- `say` speaks "<name> says: <text>" (or "<name> sent <media>") with the default profile of
  [`tools say`](../say/README.md), and a muted profile stays silent.
- `notify` sends "Telegram: <name>" through the shared notification dispatcher that
  [`tools notify`](../notify/README.md) configures.
- When Telegram answers a date-range fetch with `FLOOD_WAIT`, the tool waits the time Telegram asks for (30 seconds
  if it gives none), doubles the wait on each try, and gives up after 5 retries.

## Configuration

`configure` writes `~/.genesis-tools/telegram/config.json`. An old version 1 file is read as version 2 and is
written as version 2 on the next save. You can edit these per-chat keys by hand (under `contacts[]`):

| Key | Default | Used by |
|-----|---------|---------|
| `actions` | `["notify"]` | `listen`, run in this order |
| `replyDelayMin`, `replyDelayMax` | 2000, 5000 ms | wait before an auto-reply |
| `watch.contextLength` | 30 | messages `watch` shows |
| `modes.autoReply.provider`, `.model`, `.systemPrompt` | `openai` | the `ask` action |
| `modes.assistant.provider`, `.model`, `.systemPrompt`, `.temperature` | `openai`, 0.7 | `/ask` |
| `modes.suggestions.provider`, `.model`, `.temperature` | `openai`, 0.8 | `/suggest` |
| `modes.suggestions.count` | 3 | suggestions per call |
| `modes.suggestions.trigger` | `manual` | `auto`, `hybrid`: suggest after a message |
| `modes.suggestions.autoDelayMs` | 5000 | wait before an automatic suggestion |
| `modes.suggestions.enabled` | `true` | `false` makes `/suggest` return nothing |
| `styleProfile.enabled`, `.rules` | off, `[]` | style examples for `/suggest` |

- The default auto-reply prompt asks for a casual, short answer (one or two sentences) in the language of the
  incoming message. It replies only to the latest message.
- With `trigger` set to `auto` or `hybrid`, `watch` shows suggestions 5 seconds after an incoming message, and they
  stay on screen for 30 seconds. `/suggest` works in every trigger mode.
- A style rule picks example messages from the database. Its fields are `id`, `sourceChatId`, `direction`
  (`outgoing` or `incoming`), `limit` (default 500), `since`, `until` and `regex`. A regex longer than 200
  characters, or one that looks catastrophic, is skipped with a warning. `/suggest` sends 15 examples.
- The keys `globalDefaults`, `watch.enabled`, `watch.runtimeMode`, `modes.suggestions.allowAutoSend`,
  `modes.suggestions.systemPrompt`, `styleProfile.previewInWatch`, `styleProfile.refresh` and `modes.*.maxTokens`
  are in the file format, but no command reads them yet. `/suggest` always builds its own prompt. The flags
  `modes.autoReply.enabled` and `modes.assistant.enabled` only set what the wizard ticks first.
- **A rerun of `configure` resets every `modes.*` key of each chat you keep to its default.** It loses custom
  models, temperatures, `trigger`, `count`, `autoDelayMs`, `modes.assistant.systemPrompt` and
  `modes.suggestions.enabled: false`. It keeps `actions`, `watch.contextLength`, `watch.runtimeMode`,
  `styleProfile`, the reply delays and, when you tick both `ask` and Auto-Reply, the auto-reply prompt. Apply your
  hand edits again after a rerun, and pick the custom models again in the wizard.

There are no environment variables of its own. `GENESIS_TOOLS_HOME` replaces the home directory, so the data is
then under `$GENESIS_TOOLS_HOME/.genesis-tools/telegram/`.

## For agents

- There is no `--json` flag. For machine-readable output use `history export <contact> --format json`: a JSON
  array of `messages` rows (`id`, `chat_id`, `sender_id`, `text`, `media_desc`, `is_outgoing`, `date_unix`,
  `date_iso`, `edited_date_unix`, `is_deleted`, `deleted_at_iso`, `reply_to_msg_id`), on stdout or in `-o`.
  Export keeps messages marked deleted (`is_deleted` is 1); `query` leaves them out. A range with no messages
  prints the warning "No messages found in the specified range." on stdout instead of `[]`, and exits 0.
- `history query` prints one line per message, `<local date> → <text>` for sent and `<local date> ← <text>` for
  received, then `<n> message(s) found`. Use `--local-only` to keep it offline.
- `configure`, `contacts` and `watch` need a terminal. `watch` without one prints "this view needs an interactive
  terminal" and exits 1. `download` and `embed` ask for a chat when you give none, and `download` always ends with
  a yes/no question.
- Exit codes for `listen` and `watch`: they exit 1 when the tool is not configured, when no contacts are
  configured, or when the session expired.
- Exit codes for the `history` commands:
  - They print the error and exit 0 for an unknown contact, an invalid `--format` value, no config, or a missing
    or expired session.
  - `query` also exits 0 for a date it cannot read (`Invalid --since date`). `attachments list` ignores such a
    date.
  - A Telegram error during the `download` sync prints "Sync error" and the run still exits 0.
  - They exit 1 with `ERROR: <message>` on stderr for a date that `download`, `search` or `export` cannot read,
    an attachment that is not indexed, or a Telegram error during `query` or `attachments fetch`.
  - A missing required option (`--format`, `--from`, `--message-id`) is a usage error and exits 1.
  - Check the output, not only the exit code.
- There is no MCP server, node-repl toolset or plugin skill for this tool.

## Troubleshooting

- **"Not configured. Run: tools telegram configure"**: there is no config or no session. Run `configure`.
- **"Session expired"**: Telegram no longer accepts the saved session, for example after you ended it in the list
  of active sessions. Run `configure` again to sign in.
- **`Contact "x" not found`** from a `history` command: the name must match a chat from `configure` by display
  name, user ID or username (`@alice` works too). The message lists the names it knows.
- **`watch alice` opens the chat picker**: `watch` found no match. It accepts `alice` but not `@alice`.
- **`listen` does nothing for a group**: `listen` reacts only to private chats. Use `watch` for a group.
- **Auto-replies use the default prompt or model**: the wizard saves your prompt and model for `ask` only when you
  also tick the Auto-Reply mode. Run `configure` again and tick both, or set `modes.autoReply` in the file.
- **Unticking Chat Assistant or Message Suggestions changes nothing**: both are on by default, and the wizard does
  not turn them off. Set `modes.suggestions.enabled` to `false` in the file to stop suggestions. A rerun of
  `configure` sets it back to `true`.
- **`/ask` does not know the conversation**: the assistant gets only its system prompt and your earlier `/ask`
  questions. The history-search tools in `AssistantEngine.ts` are defined but not passed to the model. Use
  `history search`, `history query` or `/suggest` for questions about the chat itself.
- **Only 100 messages after the first download**: a first sync without `--since` takes the newest 100. Run
  `download <contact> --since <date>` to backfill.
- **"Some messages were in unsupported languages"**: semantic search covers only the seven languages above. Use
  keyword search for the rest.
- **`search --semantic` prints "Embedding failed" and "Could not embed query"**: the on-device embedding did not
  run (it needs macOS). The results you get are keyword results.

## Related

- [`tools telegram-bot`](../telegram-bot/README.md): the Bot API flavor, for notifications and remote control.
- [`tools notify`](../notify/README.md): the multi-channel notification dispatcher (it can send to Telegram too)
  that the `notify` action uses.
- [`tools say`](../say/README.md): the speech profiles the `say` action uses.
- [`tools ask`](../ask/README.md): the LLM layer and model picker behind auto-replies, `/ask` and `/suggest`.
