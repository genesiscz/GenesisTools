# tools notify

Sends one notification to every channel you switched on: a macOS banner from GenesisTools.app, a Telegram message,
a webhook, speech through `tools say`, and a push to your phone. It can also ask a question in a banner and wait for
the typed answer, show what macOS allows the app to do, and list every notification any GenesisTools surface sent.
Use it at the end of a long command or in a script that needs a person's answer.

## Quick start

```bash
tools notify "Build finished"                         # every enabled channel; a banner by default
tools notify "Deploy done" -t CI -s staging --sound Hero --open https://example.com   # title, subtitle, sound, click URL
tools notify ask "Ship it?" --choice yes:Ship --choice no:Wait   # waits up to 300 s, prints the answer
tools notify status                                   # the grant and the banner style macOS gives the app
tools notify history --since 2h                       # what pinged you in the last two hours, and why
tools notify config                                   # switch channels on and set them up (interactive)
```

Chain it after a long command:

```bash
bun run build && tools notify "Done" -t Build --sound Glass
```

## Commands

| Command | What it does |
|---|---|
| `[message]` | Send to every enabled channel |
| `config` | Interactive wizard for each channel |
| `ask <question>` | Ask in a banner, wait for typed text or a button |
| `reply <id>` | Read the answer to an `ask --no-wait` |
| `status` | The grant, banner style and sound macOS gives the app |
| `authorize` | Ask macOS for the notification grant |
| `settings` | Open System Settings > Notifications for the app |
| `list` | The app's banners still in Notification Center |
| `remove [ids...]` | Take the app's banners out of Notification Center |
| `history` | Rows of the notification ledger |
| `phone devices` | The phones that registered for push |
| `phone remove <id>` | Forget one phone |
| `phone apns` | Set the APNs key a real phone needs |
| `phone test` | One test push to every registered phone |

`tools notify -v ...` prints debug lines. `tools notify --readme` prints this page. `tools notify` with no message
prints the help and exits 0.

### Send (the root command)

| Flag | Meaning |
|---|---|
| `-t, --title <title>` | Title (config default `GenesisTools`) |
| `-s, --subtitle <subtitle>` | Subtitle |
| `--sound <sound>` | A macOS sound name (config default `Ping`) |
| `-g, --group <id>` | Group id (see below) |
| `--open <url>` | URL to open on a click (GenesisTools.app also takes a file path starting with `/` or `~`) |
| `--execute <cmd>` | Shell command to run on a click (through the app: `/bin/sh -c`, killed after 30 s) |
| `--app-icon <path>` | Image file (terminal-notifier also takes a URL) |
| `--ignore-dnd` | Ask to break through Do Not Disturb |
| `--no-ignore-dnd` | Cancel `ignoreDnD: true` from the config |
| `--payload <json>` | The whole notification as JSON; `-` reads stdin |
| `--wait` | With `--payload`: wait for the answer |
| `--timeout <seconds>` | With `--payload --wait`: how long (default 300) |

- Each channel gets what it can carry. Telegram gets the title and the message. The webhook gets the app, title,
  subtitle and message. Speech says the message. The phone gets the title, subtitle and message. Sound, group, icon
  and click actions apply to the banner only.
- `--sound` takes any sound name macOS knows; `default` is the system sound. The wizard offers Basso, Blow, Bottle,
  Frog, Funk, Glass, Hero, Morse, Ping, Pop, Purr, Sosumi, Submarine and Tink.
- `--group`: GenesisTools.app groups the banners of one group into one stack in Notification Center, and `remove --group` takes
  them all away. Through terminal-notifier, a new banner replaces the older one of its group. Without `-g` the group
  is `notify`. The group is also the `source` of the banner's ledger row.
- `--app-icon`: macOS lets no app change its own icon per banner, so GenesisTools.app shows the image as the
  banner's thumbnail. It needs a local file: a URL is dropped (the drop shows in `notify-clicks.log`). The same
  holds for `attachments`. terminal-notifier uses the image as the icon and also takes a URL.
- `--ignore-dnd` is accepted and ignored by GenesisTools.app (see Troubleshooting). terminal-notifier passes it on.

### `--payload`: every field

`--payload` reaches the fields the flags cannot: buttons, text fields, attachments and a stable id. It posts the
macOS banner only (no Telegram, webhook, speech or phone) and prints `{ "backend", "id", "confirmed" }`. It
exits 1 when `confirmed` is false.

```bash
tools notify --payload '{
  "message": "Tests failed on owner/repo#42",
  "title": "CI",
  "id": "ci-42",
  "actions": [
    { "id": "pr", "title": "Open PR", "open": "https://github.com/owner/repo/pull/42" },
    { "id": "rerun", "title": "Rerun", "execute": "gh run rerun 123" }
  ]
}'
echo '{"message":"Screenshot ready","attachments":["~/Projects/app/shot.png"]}' | tools notify --payload -
```

| Field | Meaning |
|---|---|
| `message` | Required, not empty |
| `title`, `subtitle`, `sound`, `group` | As the flags |
| `open`, `execute`, `appIcon`, `ignoreDnD` | As the flags |
| `id` | Stable id; no `/`, `\` or `..` |
| `actions[]` | Buttons (below) |
| `attachments[]` | Image, audio or video paths (`~` allowed) |
| `preferred` | `genesis-app`, `terminal-notifier` or `osascript` |

- An action is `{ id, title, open?, execute?, destructive?, input? }`. A button runs `execute` first, then `open`.
  `destructive` only paints it red. `input: { buttonTitle, placeholder }` turns it into a text field.
- Post again with the same `id` to replace a banner in place, or remove it later with `tools notify remove <id>`.
- The app copies each attachment before it attaches it, because macOS moves the file it is given.
- `id`, `actions` and `attachments` work only through GenesisTools.app. `preferred` picks the first backend to try;
  the chain still falls through when that one is not available.
- With `--wait` it waits for the answer and prints the reply, or `{ "answered": false }`.

### ask and reply

```bash
tools notify ask "Which branch?" --placeholder main              # prints what was typed
tools notify ask "Ship it?" --choice yes:Ship --choice no:Wait   # prints yes, no, or the typed text
tools notify ask "Name the release" --no-wait --id release-name  # prints the id at once
tools notify reply release-name --consume                        # later: the answer, deleted as it is read
```

| Flag | Meaning |
|---|---|
| `-t, --title <title>` | Title (default `GenesisTools asks`) |
| `-s, --subtitle <subtitle>` | Subtitle |
| `-g, --group <id>` | Group id; the app groups its banners into one stack |
| `--id <id>` | Stable id (generated when omitted) |
| `--placeholder <text>` | Hint in the empty text field |
| `--button <label>` | Label of the send button (default `Send`) |
| `--choice <id:label>` | A plain button; repeat it; a bare value is both |
| `--timeout <seconds>` | How long to wait (default 300) |
| `--no-wait` | Post, print the id, and exit |
| `--json` | Print the reply as JSON |

- The banner always has an **Answer** button with a text field. Each `--choice` adds a plain button.
- The output is the typed text, or the id of the button. A click on the banner body answers
  `com.apple.UNNotificationDefaultActionIdentifier`.
- No answer within the timeout exits 1. That is a normal outcome, so a script branches on the exit code.
- `ask` needs GenesisTools.app. No other backend can carry a reply. Without the app, or when the app has no grant,
  the question still shows as a plain banner with no Answer button. `--no-wait` then exits 1 and says so, and a
  waiting `ask` returns at once with "No answer within <timeout>s" and exit 1.
- The app writes each answer to `~/.genesis-tools/app/replies/<id>.json` from a process macOS starts, so the
  asking process can be long gone. `ask` deletes an old answer for a reused `--id` first, and takes the answer
  away when it reads it.
- `reply <id>` does not wait. It exits 1 while there is no answer. `--consume` deletes the answer, so two callers
  cannot act on it twice. `--json` prints `{ answered: true, id, actionId, text?, at }`, or
  `{ answered: false, id }`.

### status, authorize, settings

```bash
tools notify status          # AUTH, STYLE, TEMPORARY, SOUND, BUNDLE, and the next command to run
tools notify authorize       # the permission prompt (first time only); waits up to 120 s for your answer
tools notify settings        # System Settings > Notifications > GenesisTools
```

- `status` prints a **Next** line: `tools notify settings` when banners are temporary, `tools notify authorize`
  when the grant is `notDetermined` or `denied`. `--json` adds `alertSetting`, `badgeSetting`, `lockScreenSetting`,
  `notificationCenterSetting`, `criticalAlertSetting`, `timeSensitiveSetting` and `settingsUrl`.
- When the app is missing, `status` names the backend that carries the next banner (terminal-notifier at its path,
  not confirmed authorized, or osascript only) and exits 1. When the app is there but its call fails, it prints the
  error code. It only reads: it never caches the terminal-notifier path.
- `authorize` prints `granted` or `not granted`, and a note. macOS shows the prompt only on a Mac that was never
  asked. After a denial, `authorize` returns at once with `not granted` and the note "Already answered once, so
  macOS showed no prompt". Then use `tools notify settings` and switch the app on there. `status` still prints
  `Next tools notify authorize` for a denied grant, but that cannot fix a denial.
- Each of the three exits 1 when the app call fails, and names the fix: build the app, or `tools notify authorize`.

### list and remove

```bash
tools notify list                    # ID, TITLE, MESSAGE, GROUP of each banner still shown
tools notify remove ci-42            # one or more ids
tools notify remove --group deploys  # every banner of one group
tools notify remove --all            # every banner of the app
```

- Both see only banners GenesisTools.app posted. The other backends post under another app.
- A banner shows in `list` about one second after the post (measured 2026-09-16: absent at once, present after
  1 s). Do not use `list` to confirm a post.
- `remove` needs ids, `--group` or `--all`, and exits 1 without one. It prints `removed <ids>` or `removed all`.

### history

```bash
tools notify history                         # the last 24 hours
tools notify history --since 2d --source hub
tools notify history --clicks --since 6h     # only the clicks
tools notify history --json                  # { path, notifications: [...] }
```

- Columns: TIME (local), SOURCE, OUTCOME, TITLE, DETAIL.
- `--since` takes a number with s, m, h or d (`30m`, `6h`, `2d`; also `1h30m` or `2 hours`), default `24h`. A bare
  number is minutes. A value it cannot read exits 1.
- `--source` is the tool that sent it: `meetings`, `hub`, `claude-usage`, and so on. A banner from
  `tools notify` has its group as the source: `notify` without `-g`.
- OUTCOME is `posted`, `failed`, `suppressed` (a rule decided against it; DETAIL says which), `withdrawn` or
  `clicked` (DETAIL names the button and what it ran).

### phone

```bash
tools notify phone devices                   # ID, NAME, ROUTE, SEEN
tools notify phone apns \
    --team ABCDE12345 \
    --key-id XYZ9876543 \
    --key-path ~/Projects/app/AuthKey_XYZ9876543.p8
tools notify phone test --title Hello --message "From the Mac"
tools notify phone remove <id>
```

- A phone registers itself when the DevDashboard app connects to this Mac and you allow its notifications. It
  registers again on every start, so an old SEEN date means the app is gone.
- ROUTE is `apns <environment> <token start>` for a real phone, or `simulator <udid>`. A simulator gets pushes
  through `xcrun simctl push` and needs no Apple account.
- A real phone needs the APNs key: the `.p8` file App Store Connect gives once, its key id, and your Apple team id.
  All three options of `phone apns` are required, and it exits 1 when the file does not exist. It saves the path,
  not the key, so leave the file where it is.
- `phone test` ignores only the on/off switch. Desk mode and quiet hours still apply, so with the default
  `desk: away` a test typed at the Mac prints `sent: skipped, not sent later: the Mac is in use` and exits 0
  with no push. To test, lock the Mac and wait `idleMinutes`, or set `desk` to `always` first. It prints `sent` or
  `not sent` with each phone's
  result, and exits 1 when a push failed or no phone is registered. Defaults: title `GenesisTools`, message
  `Push to this phone works.`
- `phone remove` exits 1 for an id it does not know. `phone devices --json` leaves out each phone's public key.

## How it works

**One send.** `tools notify "<message>"` sends one event as the app `notify` to every channel at once. A channel
that is off counts as delivered; a system channel that is off still writes a `suppressed` ledger row. A channel
that is on but not set up (no token, no URL, no phone) sends nothing and writes a `suppressed` row too. The command
exits 1 when a channel failed, or when no backend could confirm the banner.

**The banner** tries three backends in order:

1. **GenesisTools.app** (`~/Applications/GenesisTools.app`) posts through macOS's notification center with the
   GenesisTools icon. It is the only backend with buttons, text replies, attachments, ids, `list` and `remove`.
   macOS starts the app to run a click action, so actions work after the sender has exited. Each call is one
   `--rpc` child process with a 10 s deadline (120 s for `authorize`).
2. **terminal-notifier** shows its own icon and costs about 240 ms per banner (5 s deadline). It is found in the
   rbenv gem folders, then `/opt/homebrew/bin` and `/usr/local/bin`, then `PATH` (an rbenv shim is skipped). The
   path found is cached as `terminalNotifierPath` in the config.
3. **osascript** `display notification`: no click actions and no grouping. It exits 0 whether or not macOS showed
   the banner, so it never counts as confirmed.

When the app has no grant, it refuses the banner and the send falls back to terminal-notifier. The warning names
`tools notify authorize` (never asked) or System Settings > Notifications (denied). A send never opens the permission
prompt itself, because the prompt outlives its deadline.

**The other channels:**

- **Telegram** posts the title and the message through the Bot API. A channel that is on but names no token or no
  chat sends through the shared bot (`tools telegram-bot configure`) to its notifications chat. The chat id must
  be numeric (`-1001234567890`), not `@name`: that fails with `Invalid Telegram chatId` and the send exits 1.
- **Webhook** POSTs JSON `{ app, title, message, subtitle, timestamp }`. A status that is not 2xx counts as failed.
  To reach Slack or Discord, point it at a relay that maps these fields.
- **Say** runs `tools say <message> --voice <voice>` (default voice `Samantha`), with `--provider` when one is set,
  and stops it after 120 s.
- **Phone** pushes over APNs (`api.push.apple.com`, or `api.sandbox.push.apple.com`; 10 s) or `xcrun simctl push`.
  A token from the other APNs environment is tried there once and remembered. A phone Apple reports as
  unregistered is dropped from the list.

**When the phone gets an alert.** With `desk: away` (the default) the phone gets an alert only while the Mac is
locked or idle for `idleMinutes` (default 5); `always` sends every time. During quiet hours (a local `HH:MM` span
that may wrap past midnight) nothing goes, except a time-sensitive event. A skipped alert is not queued: the Mac's
banner shows it, and the phone never gets it later. With lock screen text off, the phone shows `GenesisTools` and
`Open GenesisTools to read it.` in place of the title, subtitle and message. The buttons still work.

**Where data lives** (`GENESIS_TOOLS_HOME` replaces `~`, so every path becomes `$GENESIS_TOOLS_HOME/.genesis-tools/...`):

All paths are under `~/.genesis-tools/`.

| Path | What |
|---|---|
| `notify/config.json` | Channels, per-app overrides, terminal-notifier path |
| `notify/cache/phone-devices.json` | Registered phones and tokens (0600) |
| `notify/cache/phone-push-keys.json` | The Mac's key pair for sealed answers (0600) |
| `notifications/ledger.jsonl` | Every notification sent, held back or clicked |
| `app/replies/<id>.json` | Answers to `ask` |
| `app/notify-clicks.log` | Every click and action the app ran |

The ledger is shared: the Swift apps write the same file with the same fields, under a lock on
`ledger.jsonl.lock`. At 20 MB it moves to `ledger.jsonl.1` (replacing the older one), and `history` reads both.

**What it needs and what costs money.** macOS for banners (on another platform the system channel sends nothing).
GenesisTools.app for everything past a plain banner: build it with `tools macos permissions build`. terminal-notifier
is optional (`brew install terminal-notifier`). Telegram and macOS speech are free. A real phone needs an APNs key
from your Apple developer account; a simulator needs none. A `say` channel with a cloud provider bills each
synthesis; see [what costs money in tools say](../say/README.md#what-it-needs-and-what-costs-money).

## Configuration

`tools notify config` needs an interactive terminal. It loops over the channels until you pick **Back**:

- **System (macOS)**: on or off, default title, default sound (from the 14 above), bypass Do Not Disturb.
- **Telegram**: bot token and chat id, both required.
- **Webhook**: the URL.
- **TTS (say)**: the voice name.
- **Phone (push)**: on or off, lock screen text, away or always, idle minutes (1 to 1440), quiet hours (start and
  end). It reminds you of `phone apns` when no key is set.
- **Show current config**: each channel and its state. The Telegram token shows only as set or missing, and a
  webhook only as its host.

The file, with every key:

```json
{
  "channels": {
    "system": { "enabled": true, "title": "GenesisTools", "sound": "Ping", "ignoreDnD": false },
    "telegram": { "enabled": false, "botToken": "123456:ABC-DEF...", "chatId": "-1001234567890", "apiRoot": "..." },
    "webhook": { "enabled": false, "url": "https://hooks.example.com/notify" },
    "say": { "enabled": false, "voice": "Samantha", "provider": "macos" },
    "phone": {
      "enabled": false,
      "text": true,
      "when": { "desk": "away", "idleMinutes": 5, "quiet": { "from": "22:00", "to": "07:00" } },
      "apns": {
        "teamId": "ABCDE12345",
        "keyId": "XYZ9876543",
        "keyPath": "/path/to/AuthKey_XYZ9876543.p8",
        "topic": "..."
      }
    }
  },
  "apps": {
    "monitor": { "meta": {}, "channels": { "say": { "enabled": true, "voice": "Samantha" } } }
  },
  "terminalNotifierPath": "/opt/homebrew/bin/terminal-notifier"
}
```

- Defaults: the system channel is on, with title `GenesisTools`, sound `Ping` and `ignoreDnD` false. Telegram,
  webhook, say and phone are off. The phone sends text, with `desk: away` and 5 idle minutes.
- `say.provider` is any provider `tools say` knows (`macos`, `xai`, `openai`, ...); unset means the say default.
  `telegram.apiRoot` is another Bot API server. `apns.topic` defaults to the phone app's bundle id. The wizard does
  not ask for these three. Re-running its Telegram or TTS step removes `apiRoot` or `provider`, so set them again
  in the file afterwards. `apns.topic` survives.
- `phone apns` writes the absolute key path.
- **Per-app overrides**: `apps.<app>.channels.<channel>` is merged over the global channel for the notifications that
  app sends. `tools notify` sends as `notify`; other tools send as their own name (`monitor`, `question`, `hub`, ...).
  `tools monitor notify set` writes the `monitor` overrides.
- A channel the file does not name reads as its defaults (the phone channel was added on 2026-11-04 without a migration).
  An old flat file (`title`, `sound`, `ignoreDnD`, `say: true`) still loads, as `channels.system` and `channels.say`.

Environment variables:

- `GENESIS_TOOLS_NO_APP=1` switches GenesisTools.app routing off, so banners start at terminal-notifier and `ask`,
  `list`, `remove`, `status`, `authorize` and `settings` report the app as unavailable. The switch in
  `tools macos permissions ui` does the same and stays on. So do `tools macos permissions disable` (writes the
  marker `~/.genesis-tools/app/disabled`) and `enable` (removes it).
- `GENESIS_TOOLS_HOME` replaces `~` for the data, so paths become `$GENESIS_TOOLS_HOME/.genesis-tools/...`. The app
  stays in `~/Applications`.

## For agents

- `--json` on `ask`, `reply`, `status`, `authorize`, `settings`, `list`, `remove`, `history` and `phone devices`.
  `--payload` prints JSON on success.
- Exit codes: 0 on success, 1 on any failure: a channel failed or could not confirm the banner, no answer in time,
  no answer yet (`reply`), the app is unavailable, bad `--since`, bad `--payload`. One exception: `config`
  without a terminal prints an error and exits 0.
- A failed app call in `status`, `authorize` and `settings` JSON is `{ "ok": false, "error": { "code", "message" } }`.
  `list`, `remove`, `ask --no-wait` and a rejected `--payload` (bad JSON, missing message) print a plain error and
  exit 1, so branch on the exit code first. `status --json` adds
  `fallback: { kind: "genesis-app" | "terminal-notifier" | "osascript-only", path? }`. Codes: `unavailable`,
  `timeout`, `handshake`, `denied`, `not_determined`, `method_unknown`, `params_invalid`, `bad_request`, `internal`.
- To ask a person and continue later: `ask --no-wait --id <id>`, then `reply <id> --consume` until it exits 0.
- Feed a large payload through stdin: `... | tools notify --payload -`.
- Over SSH or from a background job, macOS shows no banner and no prompt. When such a send fails, its warning
  names the launchd session it ran in.

## Troubleshooting

- **Banners fade after about 5 s and take their buttons with them.** `status` shows STYLE `banner` and TEMPORARY
  `yes`. That is macOS's "Temporary" style, and no code can change it. Pick "Persistent" in the pane that
  `tools notify settings` opens.
- **`--ignore-dnd` has no effect.** `status --json` shows `timeSensitiveSetting: notSupported`. The time-sensitive
  entitlement needs a provisioning profile that a Developer ID signature cannot carry, so this does not change.
  terminal-notifier still passes `-ignoreDnD`:

  ```bash
  tools notify --payload '{"message":"Server is down","ignoreDnD":true,"preferred":"terminal-notifier"}'
  ```
- **The first banner on a new Mac comes from terminal-notifier or osascript.** The app has no grant yet. Run
  `tools notify authorize` once. `tools notify status` shows AUTH. After a denial, use `tools notify settings`.
- **"could not confirm delivery", exit 1.** Neither the app nor terminal-notifier was there, so osascript took the
  banner, or another channel (Telegram, webhook, say, phone) failed: check `tools notify history --since 10m` for
  a `failed` row. Run `tools notify status`, then `tools macos permissions build` or `brew install terminal-notifier`.
- **A click seemed to do nothing.** The click runs in a process with no terminal, so read
  `~/.genesis-tools/app/notify-clicks.log` and `tools notify history --clicks` before you guess.
- **`ask` prints "Only the genesis-app backend can carry a reply", or "No answer" at once.** GenesisTools.app is
  missing or routing is off. Run `tools notify status`.
- **The phone got nothing.** A skip shows in the DETAIL column of `history`: "the Mac is in use" is desk mode
  `away`, "quiet hours" is the quiet span, and both skip the alert for good. `phone test` obeys them too (see
  `phone`). "no phone registered" means the
  DevDashboard app has not connected yet. A failed push keeps its reason in the `detail` field of
  `history --json`: "the APNs team id, key id or key file is not set" needs `tools notify phone apns`.

## Related

- [tools say](../say/README.md): the `say` channel speaks through it.
- [tools telegram-bot](../telegram-bot/README.md): the shared bot a blank Telegram channel sends through.
- [tools macos](../macos/README.md): `tools macos permissions build` builds GenesisTools.app, which posts the banners.
- [tools monitor](../monitor/README.md): per-app overrides (`tools monitor notify set`) and its own targets.
- [tools hub](../hub/README.md): pull request notifications through the same channels (`tools hub notify`).
- [tools question](../question/README.md): decisions that reach you as notifications.
- [tools dev-dashboard](../dev-dashboard/README.md): the phone app that registers for push.
