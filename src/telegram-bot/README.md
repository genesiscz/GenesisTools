# tools telegram-bot

A Telegram bot for GenesisTools, over the Bot API. It sends messages to your chat, answers commands from your phone
(`/status`, `/tasks`, `/run`, `/tools`), and posts agent ❓ DECISIONs with one answer button per letter. It gets
updates by long-polling, or through a webhook behind a Cloudflare tunnel.

It is the companion of [`tools telegram`](../telegram/README.md). That tool signs in as your own user over MTProto to
read your personal chats. This one is a bot: no MTProto sign-in, and it is meant for notifications and remote control.

## Quick start

```bash
# One time: paste the token from @BotFather, then send the bot any message so it learns your chat
tools telegram-bot configure

# Send a message to your chat
tools telegram-bot send "Build finished"

# Send a command's output (the message argument is required; --stdin replaces it)
make test 2>&1 | tail -20 | tools telegram-bot send --stdin -

# Answer /status, /tasks, /run, /tools and /help from the phone (long-polling; Ctrl+C stops)
tools telegram-bot start

# Post the decisions of the project in ~/Projects/app with letter buttons
tools telegram-bot decisions enable app
```

## Commands

Global options: `-v, --verbose` (verbose logging), `--readme` (print this page), `-V, --version`. Every subcommand
takes `--help`.

### Set up and send

| Command | What it does |
|---|---|
| `configure` | Interactive setup: bot token, then the chat (see below) |
| `send <message>` | Send one message to the commands chat |
| `send ... --parse-mode <mode>` | `MarkdownV2` or `HTML`; plain text when left out |
| `send ... --stdin` | Read the text from stdin; `<message>` is still required and ignored |

`configure` steps:

1. If a config exists, it asks before it overwrites it.
2. It asks for the token (format `123456:ABC...`) and checks it with `getMe`.
3. It deletes any webhook and drops the updates that waited.
4. It waits for you to send the bot a message: six long polls of 30 seconds, so about 3 minutes. That message's
   chat becomes the commands chat.
5. It saves the config and sends a test message.

`send` does not clip the text. Telegram refuses a message over 4096 characters.

### Run the bot

| Command | What it does |
|---|---|
| `start` | Long-poll Telegram and answer chat commands and button presses |
| `start --webhook` | Run the webhook receiver instead (see [The receiver](#the-receiver)) |
| `--url <url>` | Public https URL Telegram delivers to; stored for later runs |
| `--port <n>` | Local receiver port; default 8319, the registered one |
| `--path <path>` | Receiver path; must equal the path of the public URL |
| `--delete-on-exit` | Delete the webhook when the receiver stops |

`--url`, `--port`, `--path` and `--delete-on-exit` need `--webhook`. Without it, `start` exits 1 and says so.

If you pass `--port` to `start --webhook`, pass the same `--port` to `webhook tunnel`. The tunnel rule does not read
the port the receiver uses; it defaults to 8319.

At start the bot registers its command menu with Telegram (`setMyCommands`). It prints each allowed message and
command to the terminal.

### What the bot answers in the chat

| Chat command | Reply |
|---|---|
| `/status` | Whether the `tools automate` daemon runs, and its active schedules with their next run |
| `/tasks` | The last 10 automate runs: id, preset, OK or FAIL, duration, trigger |
| `/run` | The automate presets with their descriptions |
| `/run <preset>` | Runs `tools automate run <preset>` (120 s limit), replies with the result and output |
| `/tools <command> [args]` | Runs any `tools` command on this Mac (30 s limit), replies with its output |
| `/help` | The command list |

- `/run` takes only the first word as the preset name and ignores the rest. Its reply says `completed`, or
  `failed (exit N)` with the exit code, and then the output.
- `/tools` splits its arguments on spaces. Quotes are not parsed. Example: `/tools claude usage`.
- The output of `/run` and `/tools` is stripped of colors and clipped to Telegram's 4096 characters.
- Rate limits: 20 commands per 60 seconds in total, and a cooldown of 5 s for `/tools` and 10 s for `/run`. A
  limited command gets "Too many requests. Try again in Ns."
- Only the commands chat reaches these commands. `/run` and `/tools` run code on this Mac, so treat the commands
  chat as a remote shell.

### Webhook

| Command | What it does |
|---|---|
| `webhook status [--json]` | What Telegram reports for the webhook. Read-only |
| `webhook set [--url <url>]` | Call `setWebhook` without running a receiver (turns polling off) |
| `webhook set --rotate-secret` | Replace the secret; restart the receiver afterwards |
| `webhook delete` | Delete the webhook so polling works again |
| `webhook tunnel` | Print the cloudflared rule change as a diff. Read-only |
| `webhook tunnel --apply` | Back up, write, validate, and restart the tunnel |

`webhook tunnel` options: `--url <url>` (default: the stored URL), `--port <n>` (default 8319; it does not read the
receiver's port), `--config <path>` (default `~/.cloudflared/config.yml`).

`webhook status` prints the mode (`webhook` or `polling`), the webhook URL, the pending updates, the last delivery
error with its time (in Europe/Prague time), the allowed update kinds, the configured URL, the receiver port and
whether the secret is stored. It warns when Telegram's URL differs from the configured one.

### Decisions

| Command | What it does |
|---|---|
| `decisions list [--json]` | The projects that post, and whether the text goes too |
| `decisions enable <project>` | Post this project's decisions, letters only |
| `decisions enable <project> --text` | Also post the prompt and the option texts |
| `decisions disable <project>` | Stop posting this project's decisions |
| `decisions chat <chatId>` | Post decisions to another chat than the commands chat |

## How it works

### Where data lives

| Path | What it holds |
|---|---|
| `~/.genesis-tools/telegram-bot/config.json` | The config, with the bot token in plain text (mode 0600) |
| `~/.genesis-tools/telegram-bot/cache/messages.json` | Posted decision messages, kept 14 days |
| `~/.genesis-tools/telegram-bot/backups/` | cloudflared config backups from `webhook tunnel --apply` |
| `~/.genesis-tools/security/vault.json` | The webhook secret, at `telegram-bot/webhook-secret` |

Every write of `config.json` keeps mode 0600. The `decisions` commands and the webhook URL and secret edit it under
a file lock. The message memory lets a closed decision drop its buttons and lets a press edit its message. A message
it forgot (after 14 days) keeps its buttons, but a press still gets an answer.

### What it calls

- The Telegram Bot API, through grammY, at `apiRoot` or Telegram's own server.
- `tools automate run` for `/run`, and any tool for `/tools`. `/status` reads the automate database and its launchd
  state directly, and `/tasks` reads the database.
- The question tool's act door for button presses.
- `cloudflared` and `launchctl` for `webhook tunnel --apply`.

### What it needs

- A bot from @BotFather and network access to Telegram.
- For the webhook: `cloudflared` installed, a tunnel that serves your public host (on macOS the launchd job
  `com.cloudflare.cloudflared`), and the receiver running.
- No macOS permissions. Nothing costs money.

The receiver is the registered service `telegram-webhook` (port 8319, launch command
`tools telegram-bot start --webhook`) in `src/utils/ui/dashboards.ts`. ⚠️ A bare `tools services up` starts every
registered server that is not listening, this one included. With a stored webhook URL it sets the webhook and turns
polling off. Keep a polling bot with `tools services up --except telegram-webhook`.

### Decisions with letter buttons

A project can post its ❓ DECISIONs to Telegram, one message each with one button per option letter. A press answers
the decision through the same door as the hub (`src/question/lib/act/act.ts`), and the message then says where the
answer went:

- `→ b sent to the agent`
- `→ b saved; it goes with the session's next prompt`
- `→ b may have arrived; nothing confirms it`
- `Not sent: <the reason>`

A decision answered elsewhere loses its buttons, and its message gets the line "Closed in another place (the hub, the
chat or the phone)."

```bash
tools telegram-bot decisions enable app          # letters only (the label and the project)
tools telegram-bot decisions enable app --text   # also the prompt and the option texts; Telegram stores them
tools telegram-bot decisions disable app
tools telegram-bot decisions list --json
tools telegram-bot decisions chat -1001234567890  # another chat than the commands chat; restart the bot after
```

- `<project>` is the decision's project, the repository folder name. Every project is off until you enable it.
- The text is a second opt-in because Telegram keeps what it is sent. Without `--text` the message holds the label
  (`❓ DECISION 3: <title>`), the project and session, one line on how to answer, and the recommended letter.
- With `--text`, the prompt is clipped at 3000 characters, each option at 300, and the whole message at 3800, so the
  outcome line that an edit adds still fits. Buttons go 4 per row.
- A decision that takes several letters gets one toggle button per letter and a Send button. A toggle redraws the
  keyboard with the ticked letters; Send answers with them.
- Only decisions that wait for you and have options are posted. TODO items are never posted, because a button on
  TODO 1 would answer DECISION 1 of the same session.
- Decisions are posted when an agent posts them (`tools question ask`, the MCP `question_post`). That follows the
  question config's `sinks.notifyPending`, which is on by default.
- A button is an act token that expires after 7 days. Telegram retries a press with the same callback id, which is
  the idempotency key, so a retry answers once. A second tap after the answer finds the decision closed and only
  shows a toast.
- The bot must run (`start` or `start --webhook`) to receive presses. It takes presses from the commands chat and the
  decisions chat, and commands from the commands chat only, so a decisions group never gains `/run` or `/tools`.

### Two ways to receive updates

A bot either polls or has a webhook. Telegram never allows both.

| Mode | Command | How updates arrive |
|---|---|---|
| Polling | `start` | The bot asks Telegram (`getUpdates`) in a loop. It removes any webhook first. |
| Webhook | `start --webhook` | Telegram posts each update to your public URL. A small receiver on this Mac takes it. |

Both modes run the same handler pipeline: the chat allowlist, the rate limits, then the commands and the button
presses. A webhook adds only the receiver in front of it.

#### The receiver

`tools telegram-bot start --webhook [--url <public https url>] [--port <n>] [--path <path>] [--delete-on-exit]`

- Listens on `127.0.0.1` only, on the registered port 8319 (entry `telegram-webhook` in `src/utils/ui/dashboards.ts`;
  `webhook status` prints it). Only the tunnel connector on this Mac reaches it.
- `--url` is the public https URL Telegram delivers to. It is stored in the config, so later runs need no flag. No
  host is built in, because this repo is public. The URL must use https and carry no credentials, query or fragment.
- `--path` defaults to the path of the URL. The tunnel forwards the path unchanged, so the two must be equal.
- It listens first and calls `setWebhook` after, so Telegram never posts to a closed port. The call carries the URL,
  the secret token and `allowed_updates: ["message", "callback_query"]`: commands and button presses, which is all
  the handlers read. Polling and the setup poll of `configure` pass the same list, because Telegram keeps the last
  one it was given.
- A clean stop (Ctrl+C or SIGTERM) waits up to 15 seconds for the updates still running, and leaves the webhook set.
  Telegram then queues updates while the bot is down and retries them. `--delete-on-exit` removes it instead.

#### Security model

The public route is open to the internet, so the receiver trusts nothing it has not checked. The checks run in this
order, and every refusal has an empty body:

1. Wrong path: 404.
2. Header `X-Telegram-Bot-Api-Secret-Token` missing or not equal to the secret: 401. The compare is constant time.
   This check runs for every method, so a probe learns nothing about the route.
3. Method other than `POST`: 405. Content type other than JSON: 415.
4. Body over 64 KiB: 413.
5. Body that is not JSON with a numeric `update_id`: 400.
6. 100 accepted updates already waiting to run: 503 with `Retry-After: 5`, and Telegram sends it again.

A valid update is answered 200 once its body is read and checked, and handled afterwards, one at a time, in the order
the bodies finished arriving. Telegram delivers over several connections at once (`max_connections` defaults to 40),
so a slow upload can be overtaken by a later update, and the receiver does not put updates back in `update_id` order.
A repeated `update_id` (Telegram retries when it saw no 2xx) is handled once. The receiver remembers the last 1024
ids.

Past the receiver the pipeline is the polling one. An update from a chat that is not allowed is dropped without a
reply, and only its chat id and update id are logged (at debug level), never its content. The rate limits apply to
the commands chat.

**The secret** is 32 random bytes (base64url), created on the first `webhook set` or `start --webhook`. It lives in
the encrypted vault at `telegram-bot/webhook-secret`, and the config keeps only a pointer to it. It is never printed,
never in a URL, never logged.

- Rotate it with `webhook set --rotate-secret`, then restart the receiver.
- A rotation hands the new secret to Telegram first and stores it only after Telegram accepted it. A refused or failed
  call leaves the old secret stored and the running webhook working.
- `webhook set` and a rotation hold the same lock while they talk to Telegram, so two of them run one after the other.
- A receiver that is already running keeps the secret it started with until you restart it.
- The bot token is masked in every error message the webhook commands print.

`webhook status`, and `webhook tunnel` without `--apply`, only read. They change nothing.

The optional config key `apiRoot` points `send`, `start`, the `webhook` commands and the decision posts at another
Bot API server, such as a self-hosted one. It must be https, or http on a loopback address, because every request to
it carries the bot token. Telegram's own server is the default. `configure` and the automate step `notify.telegram`
always use Telegram's own server.

### Going live

Replace `<your-host>` with the public host your tunnel serves.

```bash
# 1. Point the tunnel's webhook path at the receiver. Prints a diff.
tools telegram-bot webhook tunnel --url https://<your-host>/telegram-webhook

# 2. Apply it: backs up the cloudflared config, writes it, validates it, restarts the tunnel.
tools telegram-bot webhook tunnel --url https://<your-host>/telegram-webhook --apply

# 3. Start the receiver (also calls setWebhook). Keep it running.
tools telegram-bot start --webhook --url https://<your-host>/telegram-webhook

# 4. Check what Telegram reports: the URL, pending updates, the last delivery error.
tools telegram-bot webhook status
```

Steps 1 to 3 use the default port 8319. To use another port, pass the same `--port <n>` in steps 1, 2 and 3.

Step 2 writes the cloudflared config (`~/.cloudflared/config.yml` unless you pass `--config`) after it copies the file
to `~/.genesis-tools/telegram-bot/backups/config.yml.<YYYYMMDD-HHMMSS>.bak`. A second backup in the same second gets a
`-2` suffix, so no backup is replaced.

- If `cloudflared tunnel ingress validate` rejects the result, the original is put back and the tunnel is not
  restarted.
- If the file changed on disk since the diff was made, nothing is written. Run the command again.
- Only the rule for this host and path changes. An existing rule for them is replaced where it stands; a new one goes
  in front of the host's catch-all. Every other line stays byte for byte.
- The rule is anchored (`^/telegram-webhook$`), because cloudflared reads `path:` as an unanchored regex and
  `/telegram-webhook` alone would also capture `/api/telegram-webhook-stats`.
- On macOS the restart is `launchctl kickstart -k gui/<uid>/com.cloudflare.cloudflared`. Elsewhere, or when the
  restart fails, the rules stay written and you restart the tunnel yourself.

To undo step 2, copy the newest file in the backups folder over the config and restart the tunnel:
`launchctl kickstart -k gui/$(id -u)/com.cloudflare.cloudflared`.

`webhook set` does step 3's `setWebhook` without running a receiver. Telegram then queues updates until one runs.

### Going back to polling

```bash
# Stop the receiver (Ctrl+C), then either:
tools telegram-bot webhook delete   # remove the webhook, keep it off
tools telegram-bot start            # polling removes the webhook itself
```

Updates that queued while the receiver was down are delivered to polling. Nothing is lost. `configure` also deletes
the webhook, but it drops the updates that queued.

## Configuration

`config.json` is version 2. Its keys:

| Key | Set by | Meaning |
|---|---|---|
| `botToken` | `configure` | The bot token |
| `botUsername`, `configuredAt` | `configure` | The bot's name and the setup time |
| `chats.commands` | `configure` | The chat for commands, `send` and presses |
| `chats.notifications` | by hand | The chat for notify and shops alerts; else `commands` |
| `chats.decisions` | `decisions chat` | The chat for decision posts; else `commands` |
| `apiRoot` | by hand | Another Bot API server (https, or http on loopback) |
| `webhook.url` | `webhook set`, `start` | The public webhook URL, from `--url` |
| `webhook.secret` | first webhook run | A vault pointer to the secret, never the value |
| `decisions.projects.<name>.text` | `decisions enable` | `true` with `--text`, else `false` |

- A version 1 file (one flat `chatId`, written before 2026-11-03) is read as `chats.commands` and written in the new
  shape on the next save.
- 🛑 `configure` writes a new file with only the token, the commands chat, the bot name and the date. A reconfigure
  drops the decisions projects, the other chats, `apiRoot` and the webhook URL. Run `decisions enable`,
  `decisions chat` and `webhook set --url` again afterwards. The vault keeps the secret, and the next webhook run
  restores its pointer.

Other tools use this bot:

- The notify channel (`tools notify`) and the shops alerts (`TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`) keep their
  own token and chat when they name both. A setting with only a chat sends through this bot to that chat. A blank
  setting uses this bot and its notifications chat.
- The automate step `notify.telegram` sends to the notifications chat, through Telegram's own server.
  `tools automate configure` runs `tools telegram-bot configure` for you.

## For agents

- `--json` on `webhook status`: `mode`, `url`, `pendingUpdates`, `lastError`, `lastErrorAt`, `maxConnections`,
  `ipAddress`, `allowedUpdates`, `configuredUrl`, `receiverPort`, `secretStored`.
- `--json` on `decisions list`: `{ chat, projects }`. `chat` is the chat decisions post to (null when the bot is not
  configured), and `projects` maps each name to `{ text }`.
- Exit codes: 0 on success. 1 when a command needs the bot and it is not configured, a Telegram call fails, or a
  setting is invalid. 130 when Ctrl+C stops `start`.
  - `decisions list` exits 0 without a config, and its `--json` prints `chat` as null.
  - `configure` exits 0 after an invalid token or a timeout. It prints the error.
- `configure` is interactive (prompts and a wait for a phone message), so an agent cannot run it.
- `start` runs until Ctrl+C or SIGTERM, so run it in the background. `start --webhook` is also the registered
  `telegram-webhook` service.
- `send` is the simple way to reach the user's phone: `tools telegram-bot send "<text>"`.
- To post decisions, post them with `tools question ask` or the MCP `question_post`. This tool has no MCP tools and
  no plugin skill of its own.

## Troubleshooting

- **Button presses never arrive, commands work.** Telegram keeps the last `allowed_updates` list it was given, and a
  list without `callback_query` blocks every later press. Run `start` or `webhook set` again: both pass the full list.
  `webhook status` shows the list Telegram holds.
- **The bot left polling mode by itself.** Something started the webhook receiver, most often a bare
  `tools services up`. `webhook status` shows `Mode: webhook`. Stop the receiver and run `start` again, and use
  `tools services up --except telegram-webhook` from then on.
- **Presses from the decisions chat are ignored.** The bot reads the chats at start. Restart it after
  `decisions chat`.
- **Telegram delivers nothing, and the receiver runs on another port.** `webhook tunnel` wrote a rule for 8319. Run
  `webhook tunnel --port <n> --apply` with the receiver's port.
- **`webhook status` shows a 401 in the last error.** The receiver's secret differs from Telegram's, most often after
  `--rotate-secret`. Restart the receiver.
- **"Telegram's URL differs from the configured one."** Run `webhook set`, with `--url` if the stored URL is wrong.
- **"These options need --webhook."** `--url`, `--port`, `--path` and `--delete-on-exit` belong to webhook mode.
- **"No public webhook URL is set."** Pass `--url https://<your-host>/telegram-webhook` once; it is stored.
- **"--path ... differs from the path of the public URL."** Leave `--path` out, or make it equal to the URL's path.
- **"cloudflared rejected the new rules."** The original config is back in place. Fix the rest of the file, then run
  `webhook tunnel --apply` again.
- **"Telegram accepted the new secret but it could not be stored."** Telegram and the vault now differ. Run
  `webhook set --rotate-secret` again.
- **cloudflared answers 502 for a large request.** The receiver reads bodies up to 1 MiB, so it can answer 413. Past
  that, Bun closes the connection and cloudflared reports 502 instead.
- **`configure` says "Timed out waiting for message".** It waits about 3 minutes. Run it again and send the bot a
  message sooner.
- **A decision post or its edit seems lost.** A decision post, and the edit that closes it when it is answered
  elsewhere, wait at most 10 seconds for Telegram. On 2026-11-05 Telegram answered 502 and 504, and an edit with no
  limit held `tools hub widget call` open until the widget killed it at 120 s. A post that fails is logged; the
  decision itself stays stored.

## Related

- [telegram](../telegram/README.md): the user-account MTProto client.
- [question](../question/README.md): the decisions this bot posts, and the act door its buttons use.
- [automate](../automate/README.md): the presets and runs behind `/status`, `/tasks` and `/run`.
- [notify](../notify/README.md): the notification dispatcher that can send through this bot.
- [shops](../shops/README.md): watchlist alerts that can send through this bot.
- [dev-dashboard](../dev-dashboard/README.md): shares the tunnel host with the webhook path.
- [ai-proxy](../ai-proxy/README.md): writes its own ingress rule into a cloudflared config too.
- [services](../services/README.md): `tools services up` starts the registered `telegram-webhook` receiver.
