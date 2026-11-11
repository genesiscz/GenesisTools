# tools voice

`tools voice` turns speech into text while you talk. It streams the microphone, a raw PCM file or stdin to a
live speech-to-text provider (Deepgram, OpenAI, xAI or ElevenLabs) and prints the words. It also records a
private local clip without any provider, and rewrites text through one of your AI accounts. The GenesisTools
widget uses it for dictation and text transforms, and a script or an agent can call it the same way. It has
no Eve or computer-control dependency.

## Quick start

```sh
# Dictate through xAI, Czech first, then English. Press Ctrl-C once to stop and print the text.
tools voice listen --provider xai --language cs,en

# The same session as typed JSONL events, for a script or an app
tools voice listen --provider xai --language cs,en --json

# Transcribe a raw PCM file (s16le, 16 kHz, mono) through Deepgram
tools voice listen --provider deepgram --input recording.s16le

# See which live providers, default models and accounts are set up (reads no credentials)
tools voice configuration

# Replay fixture events with no audio and no network, for tests
tools voice listen --provider fixture --input none --events-file events.json --json
```

## Commands

```text
tools voice listen                     live transcription from mic, file, stdin, ffmpeg or a fixture
tools voice configuration              live providers, default models and enabled accounts
tools voice record                     a private local PCM clip, no provider involved
tools voice transforms configuration   chat providers, accounts and models for text transforms
tools voice transforms run             rewrite one text with one account and model
```

Add `-v` (`--verbose`) for more log detail on stderr.

### listen

Opens one live session, feeds it audio, and prints the finalized text when the session ends.

- `--provider <id>`: `deepgram`, `openai`, `xai`, `elevenlabs` or `fixture`. Without it, the tool prints the
  valid ids and exits 1. Older spellings still work: `grok-live` and `grok` mean `xai`, `gpt-realtime` and
  `gpt` mean `openai`, `scribe` means `elevenlabs`, and `mock` means `fixture`. `grok-live` means xAI speech
  transcription, not a duplex assistant.
- `--account <name or id>`: an AI account of that provider. Default: the provider's first enabled account.
- `--model <id>`: the provider model. Defaults are in the table below.
- `--language <codes>`: comma-separated ISO 639 codes in priority order, such as `cs,en` or `en-US`. The tool
  lower-cases them and drops duplicates. Without it, the provider detects the language.
- `--input <source>` (default `mic`): where the audio comes from. See "Audio input" below.
- `--events-file <file>`: the events a `fixture` session replays.
- `--max-seconds <seconds>` (default `300`): the longest session, from 0.1 to 3600 seconds.
- `--capsule`: also shows the GenesisTools.app capsule, a small overlay with the level and the live text. When
  the app is not installed, the session runs without it.
- `--save-audio <file>`: also writes the captured audio to this file (raw s16le, 16 kHz, mono). The file gets
  mode 0600 before any audio goes in. An existing file is overwritten and also set to 0600.
- `--stop-on-stdin`: stops the session when stdin closes. A native owner uses this to end the session by
  closing its pipe. It cannot be combined with `--input -`.
- `--json`: prints one JSON event per line, then a `complete` line.

Default models:

| Provider     | Default model               |
|--------------|-----------------------------|
| `deepgram`   | `nova-3`                    |
| `openai`     | `gpt-live-transcribe`       |
| `xai`        | `grok-voice-transcribe-2.0` |
| `elevenlabs` | `scribe_v2_realtime`        |

How each provider uses `--language`:

- Deepgram takes one language. Several codes turn on code switching (`multi`) only when every code is one
  that nova-3 can switch between: `en`, `es`, `fr`, `de`, `hi`, `ru`, `pt`, `ja`, `it`, `nl`. Otherwise the
  first code is pinned and a warning is logged, so `cs,en` transcribes Czech only. A region suffix is dropped.
- xAI formats text for the first code and detects the others.
- ElevenLabs uses the first code as the primary language and the rest as secondary languages.
- OpenAI gets the whole list.

#### Audio input

Audio is signed 16-bit little-endian mono PCM at 16 kHz. For an encoded file (MP3, M4A, WAV), use
`tools transcribe`, or convert it first:

```sh
ffmpeg -i memo.m4a -ac 1 -ar 16000 -f s16le memo.s16le
```

`--input` takes one of these:

- `mic`: the microphone, through GenesisTools.app. The signed app owns the microphone permission, so the
  macOS prompt names GenesisTools and not your terminal.
- `-`: raw PCM on stdin.
- a file path: a raw PCM file. It is sent at real-time pace, in 100 ms frames, so a 60-second file takes
  about 60 seconds.
- `ffmpeg` or `ffmpeg:<device>`: capture through ffmpeg's avfoundation input. `ffmpeg` alone uses the default
  device; `ffmpeg:1` passes `:1`. It needs `ffmpeg` on PATH.
- `none`: no audio at all. Only the `fixture` provider accepts it.

#### Stopping

A session ends when the input runs out, at `--max-seconds`, on the first Ctrl-C or SIGTERM, or when stdin
closes under `--stop-on-stdin`. Stop keeps finalized text. Capture stops at once, the provider hears that no
more audio follows, and it gets up to 3 seconds to send its last final text. Then the connection closes.

The printed text is every `final` segment joined with a space. A `session_final` event replaces all of them.
After a Ctrl-C the text still prints, but the exit code is 130. A second Ctrl-C more than half a second after
the first ends the process at once and loses the text that was still on its way.

#### Output

Without `--json`, stdout gets only the final text. With `--json`, stdout gets one event per line:

```text
{"kind":"state","state":"listening","provider":"xai","accountId":"acc_work"}
{"kind":"level","rms":0.031}
{"kind":"partial","text":"hello","isFinal":false,"startedAtMs":420}
{"kind":"final","text":"Hello there.","isFinal":true,"startedAtMs":420,"endedAtMs":1310}
{"kind":"state","state":"stopping","provider":"xai","accountId":"acc_work"}
{"kind":"state","state":"stopped","provider":"xai","accountId":"acc_work"}
{"kind":"complete","text":"Hello there.","provider":"xai","accountId":"acc_work"}
```

- `state`: `listening`, `stopping` or `stopped`, with the provider and the account id.
- `level`: the RMS of each captured frame, from 0 to 1.
- `partial`, `final`, `session_final`, `speech_start`, `speech_end`: transcript events with `text`, `isFinal`,
  `startedAtMs`, and sometimes `endedAtMs` and `confidence`.
- `error`: the provider failed. The detail is in `error`, and the run exits 1.
- `complete`: the last line, with the whole text.

#### Fixture replay

`--events-file` is a JSON array of transcript events:

```json
[
  { "kind": "partial", "text": "hello", "isFinal": false, "startedAtMs": 200 },
  { "kind": "final", "text": "Hello there.", "isFinal": true, "startedAtMs": 200, "endedAtMs": 900 }
]
```

With `--input none`, the events replay at once. With real audio, each event waits until its `startedAtMs`, and
the replay ends when the audio ends, as a live provider would. The fixture needs no account and no network.

### configuration

```sh
tools voice configuration
```

Prints one JSON object: `{"providers": [...]}`, with one entry for each live provider (`deepgram`, `openai`,
`xai`, `elevenlabs`). Each entry has `id`, `title`, `defaultModel`, `models`, and `accounts`: the enabled
accounts of that provider, as `id` and `name` (the account label when it has one). It reads no credentials and
makes no network call. The output is JSON with or without `--json`. The widget's dictation settings fill their
provider, account and model pickers from it.

### record

Records a clip on this Mac only. It never opens a provider, never reads a credential and never transcribes.

```sh
tools voice record \
    --output ~/Projects/app/clip.s16le \
    --mic-launcher ~/Applications/GenesisTools.app/Contents/MacOS/GenesisTools \
    --wait-for-start \
    --stop-on-stdin \
    --json
# Type "start" and Enter to begin. Close stdin (Ctrl-D) to stop and keep the clip.
```

- `--output <file>` (required): a new file. The tool refuses a file that already exists. It creates missing
  folders with mode 0700 and the file with mode 0600, and deletes the file again when the recording fails or
  is cancelled.
- `--input <source>` (default `mic`): `mic`, `-` (stdin), or a raw s16le mono PCM file of at most 30 seconds.
- `--mic-launcher <path>`: the absolute path of the signed GenesisTools.app launcher. It is required for
  `mic`, and there is no fallback to the installed app, so a preview build never records through the
  production app.
- `--max-seconds <seconds>` (default `30`): from 0.1 to 30 seconds.
- `--wait-for-start`: prints `{"kind":"ready","pid":<pid>}`, then waits for a line `start` on stdin. A missed
  10 second deadline, the end of stdin before `start`, or a first line other than `start` fails the command with
  code `capture_failed` and exit 1. Stderr says `Recording cancelled before start`, `Recording owner closed before
  start` or `Recording needs an explicit start message`.
- `--stop-on-stdin`: the end of stdin stops capture and keeps the audio recorded so far. With
  `--wait-for-start`, the end of stdin does the same, but only after `start`.
- `--json`: prints `{"kind":"recording","sampleRateHz":16000}` when capture starts, then
  `{"kind":"level","rms":…,"durationMs":…}` for each frame. A failure prints `{"kind":"error","code":…}`.

`-` cannot be combined with `--wait-for-start` or `--stop-on-stdin`, because both read stdin.

On success, the last line is the result. It is one line; here it is wrapped:

```json
{"kind":"recorded","clip":{"path":"/Users/alice/Projects/app/clip.s16le","bytes":320000,
"sampleRateHz":16000,"channels":1,"encoding":"s16le","durationMs":10000,"peakRms":0.21,
"endedBy":"stop"}}
```

`endedBy` is `eof` (the input ran out), `stop` (stdin closed) or `limit` (`--max-seconds`). The error codes
are `no_audio`, `microphone_permission`, `capture_interrupted`, `capture_failed` and `cancelled`. Ctrl-C or
SIGTERM cancels and deletes the clip (`cancelled` comes only from these two). To keep a clip, close stdin (with
`--stop-on-stdin` or `--wait-for-start`, the only cases where stdin is read), let the input end, or let it reach
`--max-seconds`.

### transforms configuration

```sh
tools voice transforms configuration
```

Prints `{"providers": [...]}`: every chat provider that has at least one enabled account, sorted by id. Each
entry has `id`, `title`, `accounts` (`id`, `name`) and `models` (`id`, `title`) from the model catalog. It
resolves no credentials, refreshes no token and sends no request. The output is JSON with or without `--json`.

### transforms run

Rewrites one text with one chat model, for example to fix punctuation in a dictated note.

The input holds your text, so keep it in a private file and remove it afterwards. `mktemp` creates the file readable
by you only, and the last line runs whether the transform succeeded or not.

```sh
input=$(mktemp)
cat > "$input" <<'EOF'
{ "systemPrompt": "Fix punctuation. Keep the wording.", "text": "hello there how are you" }
EOF
tools voice transforms run \
    --input "$input" \
    --model-ref "@account/acc_work:<model id>"
rm -f "$input"
```

- `--input <file>` (required): JSON with `systemPrompt` and `text`. The file may be at most 300,000 bytes, the
  instruction at most 32,000 characters and not empty, and the text at most 256,000 characters and 1,000 words
  (the character cap is checked first).
- `--model-ref <ref>` (required): `@account/<account id>:<model id>`. The account id starts with `acc_`. Take
  both ids from `tools voice transforms configuration`.
- `--timeout-ms <milliseconds>` (default `30000`): from 1 to 120,000.
- `--json`: accepted. The output is `{"text":"…"}` either way.

It sends one chat request at temperature 0.2, with `systemPrompt` as the instruction and `text` as the user
message. An empty `text` returns `{"text":""}` without a request. An empty answer fails with "The model
returned nothing." The text comes from a file and not from an argument, so it never shows in the process
list. The app writes that file with mode 0600 in a private temporary folder.

## How it works

- **No state of its own.** The tool has no config file and keeps no data. It writes only the files you name
  with `--save-audio` and `--output`.
- **Accounts** come from the shared AI config, `~/.genesis-tools/ai/config.json`, managed with
  `tools ai config account …`. Keys stay in the encrypted vault (`~/.genesis-tools/security/vault.json`) or
  come from an environment variable the account may fall back to.
- **Network.** `listen` opens one WebSocket to the provider: `api.deepgram.com`, `api.openai.com`, `api.x.ai` or
  `api.elevenlabs.io`. `transforms run` sends one request to the account's chat provider. `record`, `fixture`
  and both `configuration` commands make no network call.
- **GenesisTools.app** captures the microphone (`--input mic`) and draws the capsule. The tool looks for it at
  `~/Applications/GenesisTools.app`. `bun run app` (which runs `tools macos permissions build`) builds and
  installs it from the GenesisTools checkout. The app is skipped when `GENESIS_TOOLS_NO_APP=1` is set or after
  `tools macos permissions disable`; then `mic` and `--capsule` are not available.
- **Cost.** `listen` with a cloud provider bills that provider's account for the streamed audio.
  `transforms run` bills one chat request to the chosen account, and the shared AI call path records its usage
  like any other GenesisTools AI call. `record`, `fixture` and both `configuration` commands are free.
- **Logs** go to `~/.genesis-tools/logs/<date>.log`. They name the provider, the account id and where the key
  came from, never the key itself.

The GenesisTools widget calls this tool:

- Reply box dictation runs `tools voice listen --input mic --json --stop-on-stdin` with the provider, language,
  account and model from the widget settings. A voice note adds `--save-audio` with a path from
  `tools hub widget voice-notes incoming-path`.
- The widget's dictation settings run `tools voice configuration --json`.
- Text transforms run `tools voice transforms configuration --json` and `tools voice transforms run`.

## Configuration

- **Accounts.** Add one with `tools ai config account add --provider <id> --name <name>`, and list them with
  `tools ai config account list --provider <id>`. `--api-key-stdin` reads the key from stdin, and
  `--use-env <var>` lets the account fall back to an environment variable.
- **Environment variables** an account may fall back to: `DEEPGRAM_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`
  (or `X_AI_API_KEY`) and `ELEVENLABS_API_KEY`.
- **Account choice.** `--account` must name an enabled account of the chosen provider. Without it, the tool
  takes the provider's first enabled account and logs the others at debug level. The `transcribe` task default
  is not consulted: it steers `tools transcribe` (batch) and may point at a local Whisper model.

## For agents

- **Exit codes.** 0 means success. 1 means an error: a bad flag, no account, a provider error, a capture
  failure or a cancelled `record`. An error a command throws goes to stderr as `ERROR: <message>`. A flag-parse
  error (a missing required option, an unknown flag) prints Commander's `error: ...` and the help. A missing
  `--provider` and an out-of-range `listen --max-seconds` print a plain error line. All exit 1. 130 means `listen`
  stopped on Ctrl-C; it still prints its text first. SIGTERM stops `listen` the same way, but exits 0 with the text.
- **stdout** carries only results and `--json` events. Logs and errors go to stderr.
- **Stable shapes.** On success, `listen --json` and `record --json` print JSONL that ends in a `complete` or
  a `recorded` line. `configuration`, `transforms configuration` and `transforms run` print one JSON object.
- **Owner protocol.** A process that owns the session (a native app) starts `listen` or `record` with
  `--stop-on-stdin` and closes the pipe to stop. `record --wait-for-start` adds a handshake: read the `ready`
  line, then write `start` and a newline within 10 seconds.
- **Tests** use `--provider fixture`, which needs no account, no audio (`--input none`) and no network.

## Troubleshooting

- **"GenesisTools.app is not installed, so there is no microphone face."** Build the app with `bun run app`, or
  capture with `--input ffmpeg:<device>` or `--input -`. The message names `--pcm-in`, which is not a flag of
  this tool: use `--input`. The same holds for the `ffmpeg is not on PATH` message.
- **"Microphone access is unavailable to the recorder."** (code `microphone_permission`). GenesisTools has no
  microphone grant. Run `tools macos permissions request microphone`, or allow GenesisTools in System Settings,
  Privacy & Security, Microphone.
- **"Live STT provider 'xai' has no enabled account."** Add an account; the message prints the exact
  `tools ai config account add` command.
- **"Account 'work' is a openai account, not xai."** `--account` must belong to the provider you chose.
- **"Input none is reserved for fixture replay".** Use `--provider fixture`, or give a real `--input`.
- **The transcript is noise.** The input is not raw s16le 16 kHz mono PCM. Convert it with the ffmpeg command
  above, or use `tools transcribe` for encoded files.
- **Deepgram ignores the second language.** `cs,en` pins Czech, because Czech is not in nova-3's code-switching
  set. For mixed Czech and English, use `xai`, `openai` or `elevenlabs`, which take several codes.
- **"Local recording requires the current app's explicit --mic-launcher".** `record --input mic` needs
  `--mic-launcher` with the absolute path of an executable launcher. A relative path fails with "The microphone
  launcher must be an absolute executable path". A missing or non-executable path fails with "The explicit
  microphone launcher is unavailable; no production fallback was started".
- **"PCM input '<path>' is not a file. Use '-' for stdin, 'mic' ..."**. A mistyped `--input` path. Fix the path.
- **"No AI account '<name>'. List them with: tools ai config account list"**. An unknown `--account`. List the
  accounts, then use a name or id from the list.
- **"The selected dictation account is disabled or unavailable for ordinary use."** Enable the account, or pick
  another one.
- **`record` fails with `EEXIST`.** `--output` already exists, and `record` never overwrites. Choose a new path.
- **"PCM input exceeds the 30-second local clip limit".** `record` takes at most 30 seconds (960,000 bytes at
  16 kHz). Use `listen` for longer audio.
- **"Choose an enabled AI account and a model in Dictation → Text transforms."** `--model-ref` does not match
  `@account/acc_<id>:<model id>`.
- **"That is too long to transform in one pass (1,000 words maximum)."** Split the text.

## Related

- [tools transcribe](../transcribe/README.md): batch transcription of encoded audio files.
- [tools ai](../ai/README.md): the accounts and keys this tool uses.
- [tools hub](../hub/README.md): the widget, its dictation and its voice notes.
- [tools macos](../macos/README.md): GenesisTools.app, its build and its privacy grants.
- [tools say](../say/README.md): the other direction, text to speech.
