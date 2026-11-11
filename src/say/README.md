# tools say

Text-to-speech for scripts and coding agents on macOS. It speaks a message through macOS `say`, xAI or OpenAI,
loads the voice, volume, provider and the rest from a named profile (`--app <name>`) so a caller passes no flags, and
logs every call, so a notification you half-heard can be read back together with who sent it.

## Quick start

```bash
# Speak once. The command returns at once; playback runs in a background process.
tools say "Build finished"

# Save a voice and a provider under the "claude" profile (save only, nothing is spoken)
tools say --app claude --voice Samantha --provider macos --save

# Later calls only name the profile
tools say "Tests done" --app claude

# Override one field for this run only (does not persist)
tools say "Tests done" --app claude --voice Daniel

# Write the audio to a file instead of playing it (blocks until the file is written)
tools say "Deploy done" --output ~/Projects/app/done.aiff --provider macos

# Read back the last calls: who called, from where, and what happened
tools say logs -n 20
```

## Commands

### Speak (the root command)

```bash
tools say [options] [message...]
```

The message words are joined with spaces. With no message, no `--file` and no `--save`, a terminal opens the profile
manager (the same as `tools say config`). Outside a terminal it exits 1 with `[say] no message provided.`

| Flag | What it does |
|------|--------------|
| `--volume <n>` | `0.0` to `1.0`, or a percent: `50` and `50%` both mean `0.5`. `--volume 2` is 2%, not loud |
| `--voice [name]` | Voice id of the provider. With no value it lists the voices |
| `--rate <n>` | Speed, `0..2` or `0..200` (percent). `1` is the default cadence. `--rate 3` is 3%, the slowest |
| `--provider <name>` | `macos`, `xai`, `openai` or `elevenlabs`. Default: the profile, else `macos`. `--help` and the config pick lists show only the first three |
| `--account <id\|name>` | The AI account whose key speaks. Picks the provider when `--provider` is not given |
| `--model <id>` | OpenAI only. Accepted, stored, part of the cache key and logged, but synthesis ignores it today: OpenAI always speaks with `tts-1` |
| `--language <bcp47>` | xAI only. Default `auto` |
| `--format <codec>` | `mp3` or `wav`, for a cloud provider |
| `--app <name>` | The profile to load, and the target of `--save` |
| `--save` | Persist the flags typed on this run to the `--app` profile |
| `--unset <fields>` | Comma list: ignore these profile fields this run, or clear them with `--save` |
| `--mute`, `--unmute` | Mute or unmute the profile. Both need `--save` |
| `--file <path>` | Read the text from a file instead of the arguments |
| `--output <path>` | Write the audio to a file, do not play it. Blocks. Ignores mute |
| `--wait` | Block until playback ends, in this process |
| `--stream`, `--no-stream` | Force the streaming path, or the REST path. `--output` always buffers |
| `--no-fallback` | Fail instead of falling back to macOS when a cloud provider fails |
| `--logs`, `--stats` | The same as `tools say logs` (last 100 calls) and `tools say stats` |
| `-v, --verbose` | Verbose logging |
| `--readme` | Print this README |

```bash
# Speak the text of a file, and wait until playback ends
tools say --file ~/Projects/app/notes.txt --wait

# Write an mp3 through xAI
tools say "Hello" --output ~/Projects/app/hello.mp3 --provider xai --format mp3

# List the voices of one provider
tools say --provider openai --voice
```

`--output` creates missing parent folders. A path with no extension gets the one that matches the audio (`.aiff` for
macOS, `.mp3` or `.wav` for a cloud provider). The audio is never converted: an extension that does not match the
audio is kept, with a warning that names the right one.

`--rate` follows the macOS native range: `0` plays at about 0.81x, `1` at 1x and `2` at about 1.86x. Cloud speech is
matched to that range so the same `--rate` sounds the same on every provider. Read "`--rate` has no effect" under
Troubleshooting for the paths that ignore it.

### Subcommands

| Command | What it does |
|---------|--------------|
| `tools say voices` | Voices grouped by provider. `tools say --provider xai voices` shows one provider |
| `tools say models [--task tts\|transcribe]` | Downloadable TTS or speech-to-text models per provider (default `tts`) |
| `tools say logs` | The last calls as a table. Flags in "Call log" below |
| `tools say stats [--since <when>] [--json]` | Call statistics |
| `tools say config` | The interactive profile manager. Needs a terminal |

`tools say models` lists what the AI layer can download, with `tools ai models download <id>` as the next step.
`tools say` itself speaks only through the providers above.

### Call log (`logs`, `stats`)

```bash
# The last 100 calls, oldest first, newest at the bottom (same as `tools say --logs`)
tools say logs

# Only the calls with the attention marker, a text search, or a time window
tools say logs --attention
tools say logs --grep "deploy" --since 7d
tools say logs -n 20 --since 2026-09-15

# One detail block per call: argv, cwd, process chain, pids, the day-log search, the jump command
tools say logs -n 3 --full

# Outcomes, agents, app profiles, providers, days, hours, top sessions and phrases (same as `tools say --stats`)
tools say stats
tools say stats --since 24h --json
```

| `logs` flag | What it does |
|-------------|--------------|
| `-n, --limit <count>` | How many calls to show. Default `100` |
| `--attention` | Only calls whose text contains the word `attention` (any case) |
| `--grep <text>` | Only calls whose text contains this (case-insensitive) |
| `--since <when>` | A duration (`7d`, `24h`, `90m`, `1h30m`) or a date (`2026-09-15`) |
| `--full` | A detail block per call instead of the table |
| `--json` | Print the records as JSON |

The table columns are `WHEN`, `AGENT`, `SESSION`, `WHERE`, `APP`, `PROVIDER`, `STATUS` and `TEXT`. `WHERE` shows the
cmux workspace title when cmux runs (read at view time, so a renamed workspace shows its current name), else the short
workspace id, the tmux pane or the terminal program. An attention call is shown in yellow with a `❗` mark.
`tools claude cmux focus <session>` jumps to the pane of a listed session.

## How it works

### One call, step by step

1. The foreground process reads the text, checks the flags and checks mute. A muted call prints `[say] muted` on
   stderr, is logged as `muted`, and exits 0.
2. Without `--wait`, `--save` or `--output`, it starts a detached copy of itself with `--wait` added, writes the call
   to the call log, and returns at once. Speech is a notification, so a hook that awaits `tools say` does not wait for
   the synthesis or the audio. `--save` and `--output` run in the foreground, so the confirmation and the file are
   ready before the command exits.
3. The speaker (the detached copy, or the foreground with `--wait`) resolves the profile, the account, the text
   overrides and the key, then speaks. A cloud provider goes through the audio cache.
4. When a cloud provider fails, the speaker retries with macOS (without the cloud voice and model), unless
   `--no-fallback` is set. An unknown cloud voice (an HTTP 404 or "voice not found") is not retried: it fails and prints
   the provider's voice list. An unknown macOS voice is silent, is logged as `spoken` and exits 0 (see Troubleshooting).
5. The speaker writes the outcome onto the call's row.

The detached speaker has no stdout or stderr. Its errors go to the day log, `~/.genesis-tools/logs/<day>.log`.

### Profiles and inheritance

A profile holds `voice`, `volume`, `provider`, `rate`, `model`, `format`, `language`, `account` and `mute`. Every
profile inherits an unset field from the `default` profile. For one run, the most specific value wins:

1. The flag typed on this invocation
2. The `--app <name>` profile's field
3. The `default` profile's field
4. The provider's own default

`null` or a missing field means "inherit", not "use null". A call with no `--app` uses the `default` profile.
`tools say --app default --voice Samantha --save` sets a base value for every profile.

Mute is the logical OR of `global.mute` and the profile's own `mute`. Mute does not inherit from `default` to other
profiles: use `global.mute` for one switch that silences everything.

Some fields matter only to some providers. Storing them on a profile that does not use them is harmless:

- `model`: OpenAI only. xAI and macOS ignore it, and synthesis ignores it today (OpenAI uses `tts-1`).
- `language`: xAI only (a BCP-47 hint, default `auto`).
- `format`: a cloud provider only. macOS always writes AIFF.

### Providers, keys and fallback

- **macOS** speaks with the built-in `say` command. It is local and free. With no voice, live speech uses the system
  voice. A file written with `--output` and no voice gets the first system voice for the text's detected language.
- **xAI** and **OpenAI** need a key. It comes from the provider's AI accounts first
  (`tools ai config account add --provider xai`), then from `XAI_API_KEY` (or `X_AI_API_KEY`) and `OPENAI_API_KEY`.
  This lets a GUI app or a launchd job with no shell exports still speak. The default voices are `eve` (xAI) and
  `alloy` (OpenAI).
- **ElevenLabs** works with `--provider elevenlabs`. Its key comes from an `elevenlabs` AI account, then
  `ELEVENLABS_API_KEY`. `tools say voices` lists its voices when a key exists.
- **`--account <id|name>`** picks one account from `tools ai config account list`. Its provider becomes the provider
  unless `--provider` is typed, and a typed `--provider` that does not match the account fails. The account may be an
  xAI, OpenAI or ElevenLabs account. A disabled account, an unknown account or an account of a provider that cannot
  speak fails with `[say] --account: ...` and exit 1. A usable account whose key is missing prints
  `[say] account <name> has no usable key, falling back to macos.`. When the account moves the call to another
  provider than the profile's, the
  profile's voice and model are dropped unless they are typed on the command line.
- **A gate-only account** gets its key through `tools ai gate`: GenesisTools.app asks for approval with Touch ID (or
  uses a remembered grant). The speaker waits up to 210 s (the 180 s approval window plus 30 s), After a refusal or no answer it
  falls back to macOS, or fails with `--no-fallback`.
- **No usable key**: the speaker prints `[say] <provider> has no usable key, falling back to macos.` and speaks with
  macOS. With `--no-fallback` it prints `[say] <provider> has no usable key.` and exits 1.

### Text overrides

A text override sends a phrase to another provider whatever the profile says. A typical use routes a phrase that
repeats all day, such as "Permission needed", to free macOS instead of a paid cloud voice. The `match` is a substring,
compared case-insensitively, and the first match wins. When an override changes the provider, the profile's voice and
model are dropped unless they are typed on the command line. A phrase routed to macOS never reads the account key,
so it never raises a gate prompt. Manage overrides in `tools say config` under "Manage text overrides".

### Audio cache

A cloud provider's audio is cached for phrases that repeat. The cache key is the text, provider, voice, model, rate,
language, format and account id, so two accounts never share audio. The first calls of a phrase only count. The 5th
call writes its audio to disk, and the 6th call and every later one play from disk with no API call. The cache is
skipped for macOS (already free) and for `--stream` without `--output` (the cache needs the whole buffer). A cache read error counts as
a miss, and a cache write error only skips the caching: the audio still plays. The defaults and their keys are under
"Configuration".

### Call log

Every call that has text is a row in `~/.genesis-tools/say/calls.db` (SQLite). Rows are never pruned. Each row records:

- **The request:** the text, the raw argv, the `--app` profile, and whether the text carries the attention marker.
- **The caller:** the agent (`claude`, `codex`, `grok`, `copilot`) and its session id from the environment
  (`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`, `GROK_SESSION_ID`), the account its own harness was launched as, the
  cmux workspace, surface and tab ids (or the tmux pane), the terminal program, the cwd, and the process chain above
  `tools say` (read from the kernel in the foreground, before it exits). All of it comes from the agent identity
  module (`src/utils/agent/identity/`). A blank value is recorded as no value. The chain names a caller that set none
  of those variables.
- **The outcome:** `spoken`, `written` (`--output`), `muted` or `failed` with the error, plus the provider and voice
  that spoke, whether the audio came from the cache, which provider it fell back from, and when it finished.

Two processes write one row. The foreground `tools say` writes the request and the caller, then returns. The detached
speaker (told the row id through `GENESIS_SAY_CALL_ID`) writes the outcome when playback ends. Both writes are
upserts, so either order works. A row with no outcome shows as `playing` for two minutes, then as `no outcome`: the
speaker crashed or was killed. Its log lines are in the day log under the pid that `--full` prints. A failed call-log
write is logged and the speech goes on.

### Where data lives

| Path | What it holds |
|------|---------------|
| `~/.genesis-tools/say/config.json` | Profiles, global mute, text overrides, cache settings |
| `~/.genesis-tools/say/config.v1.bak.json` | The original v1 config, written once by the migration |
| `~/.genesis-tools/say/calls.db` | The call log |
| `~/.genesis-tools/say/cache/` | The audio cache (`index.json` plus one audio file per phrase) |
| `~/.genesis-tools/say/cache/voice-map.json` | The macOS voice list, refreshed after 7 days |
| `~/.genesis-tools/logs/<day>.log` | The detached speaker's log lines |

### What it needs and what costs money

- macOS with the built-in `say` and `afplay` commands.
- `ffplay` (from ffmpeg) is optional. When it is on `PATH`, cloud audio plays through it, and
  a rate change keeps the pitch. A peak limiter guards the xAI loudness boost on the `--stream` path only. Without it,
  cloud audio plays through `afplay`, which ignores the rate.
- xAI, OpenAI and ElevenLabs bill each synthesis to the key's account. The audio cache and text overrides cut that
  cost. With `--account`, each paid synthesis adds a usage row for the app `say` with its character count; a cache hit
  adds none.
- Fire-and-forget playback, macOS speech, the call log and the cache are local and free.

## Configuration

### `config.json`

Every saved profile carries the full field list, with `null` for a field that inherits from `default`:

```json
{
    "version": 2,
    "global": {
        "mute": false,
        "textOverrides": [{ "match": "Permission needed", "provider": "macos" }]
    },
    "apps": [
        {
            "name": "default",
            "voice": "Samantha",
            "volume": 0.5,
            "provider": null,
            "rate": null,
            "model": null,
            "format": null,
            "language": null,
            "account": null,
            "mute": null
        },
        {
            "name": "build",
            "voice": "alloy",
            "volume": null,
            "provider": "openai",
            "rate": null,
            "model": "tts-1",
            "format": null,
            "language": null,
            "account": null,
            "mute": null
        }
    ]
}
```

The cache settings live in `global` and have no flag. Add them to the file by hand:

| Key | Default | What it does |
|-----|---------|--------------|
| `cacheThreshold` | `5` | The call count at which a phrase's audio is written to disk |
| `cacheMaxBytes` | `50000000` (50 MB) | The disk budget. The least recently used audio goes first |
| `cacheTtlMs` | `86400000` (24 h) | Idle time after which a counted phrase with no audio is dropped. `0` turns it off |
| `cacheAudioTtlMs` | `0` (off) | Idle time after which cached audio is dropped. Off: the disk budget alone evicts |

### Saving (`--save`)

`--save` persists only the flags typed on this invocation to the `--app` profile. Other fields stay as they are.

```bash
# Save voice and provider for the "claude" profile
tools say --app claude --voice Samantha --provider macos --save

# Save only the volume; voice and provider stay
tools say --app claude --volume 0.5 --save

# Speak through one AI account from now on
tools say --app claude --account work --save

# Save and speak: speaks first, persists only after the speech succeeded
tools say "deploy done" --app claude --voice Samantha --save
```

- `--save` needs `--app <name>`. Outside a terminal it is an error with the suggested form. In a terminal it asks you
  to pick a profile or create one (the name `default` is reserved for a new profile).
- With no message (no words, no `--file`), `--save` only writes the config. Nothing is spoken.
- `--save` alone with no other flag creates an empty profile when it does not exist.
- The volume is stored normalized: `--volume 50%` and `--volume 0.5` both store `0.5`.

### Unsetting (`--unset`)

`--unset <fields>` takes a comma-separated list of profile fields. Valid names: `voice`, `volume`, `provider`, `rate`,
`model`, `format`, `language`, `account`, `mute`. An unknown name exits 1 and prints the valid list.

```bash
# For this run only: ignore the saved voice
tools say "test" --app claude --unset voice

# Persisted: clear the voice in the saved profile
tools say --app claude --unset voice --save

# Several fields at once
tools say --app claude --unset voice,volume,provider --save
```

With `--save`, the fields are set to `null`, not deleted, so the profile still shows the full field list while the
value falls through to `default`.

### Mute and unmute

`--mute` and `--unmute` need `--save`. They no longer write the config on their own.

```bash
# Mute the "claude" profile
tools say --app claude --mute --save

# Unmute it
tools say --app claude --unmute --save

# Toggle the global mute: tools say config, then "Toggle global mute"
tools say config
```

Without `--save` the command exits 1:

```text
$ tools say --app claude --mute
[say] --mute / --unmute now require --save to persist.
```

`--mute` together with `--unmute` also exits 1. With a message, `--unmute --save` (or `--unset mute --save`) on a
muted profile speaks and then saves; the mute does not stop it.

### The interactive manager (`tools say config`)

`tools say config`, or `tools say` with no arguments in a terminal, opens a menu:

- **Speak text (test)**: pick a profile, type text, hear it through the local macOS voice (see Troubleshooting).
- **Edit an app profile**: pick a profile or `+ new app`. It walks every field once. In a text field, Enter keeps the
  value, `-` inherits (clears it), and any other value sets it. `provider`, `format` and `mute` are pick lists with
  Keep and Inherit. It shows a summary and asks before it saves; a cancel at any prompt saves nothing (a `+ new app`
  profile is created before the walk, so a cancel leaves it
  empty).
- **List apps with resolved settings**: each profile after inheritance.
- **Delete an app profile**: the `default` profile cannot be deleted.
- **List available voices**.
- **Manage text overrides**: add or remove a `match` and its provider.
- **Toggle global mute**.

Outside a terminal both entry points fail fast. Pass a message, or `--app <name> --save`, instead.

### Migration from v1

The first run against a v1 config (the old `defaultVoice`, `defaultVolume`, `globalMute`, `appMute` and `appVolume`
shape) migrates it:

- `defaultVoice` and `defaultVolume` become the `default` profile's `voice` and `volume`.
- `globalMute` becomes `global.mute`.
- Each name in `appMute` or `appVolume` becomes its own profile, with its v1 mute and volume.

Before the first write, the original file is copied to `~/.genesis-tools/say/config.v1.bak.json`, only when no backup
exists yet. To roll back, copy that file over `config.json`.

## For agents

- The end-of-task notification needs only a saved profile: `tools say "<task> done" --app claude`.
- By default the command exits 0 as soon as the background speaker starts. A missing account, a failed synthesis or
  an unknown voice then shows only in the call log and the day log. Add `--wait` when the exit code must reflect the
  speech.
- Exit 1 means: a bad flag combination (`--mute` with `--unmute`, `--mute` or `--unmute` without `--save`, an unknown
  `--unset` field), a missing `--file`, no message outside a terminal, `--save` without `--app` outside a terminal,
  `config` outside a terminal, or an unreadable `--since`. With `--wait`, `--save` or `--output` it also means an
  account error, no usable key with `--no-fallback`, or a failed synthesis that no fallback saved.
- `tools say logs --json` prints the call records: `id`, `ts`, `text`, `argv`, `app`, `attention`, `caller`, `pid`,
  `speakerPid`, `status`, `provider`, `voice`, `cacheHit`, `fallbackFrom`, `error`, `finishedAt`. `tools say stats
  --json` prints the aggregates, including the call to outcome
  latency.
- To get the whole pipeline (profiles, cloud providers, cache, call log) from code, run the tool with
  `execTool(["say", text, "--app", "build"], { timeout })` from `@genesiscz/utils/cli`. The notification `say`
  channel does this with a 2 minute deadline.
- To read or change profiles from code:

```ts
import { SayConfigManager } from "@genesiscz/utils/macos/SayConfigManager";

const mgr = new SayConfigManager();
await mgr.patchApp("claude", { voice: "Samantha", provider: "macos" });
await mgr.unsetAppFields("claude", ["volume"]);
const effective = await mgr.resolveApp("claude"); // merged with the default profile
```

- Inside this repository, `speakWithProfile({ text, app, wait })` from `@app/say/lib/speak` checks mute and speaks
  with a profile's voice, rate and volume through the local speech provider (macOS). It does not use the profile's
  cloud provider, the cache or the call log. `speak()` from `@genesiscz/utils/macos/tts` is a plain macOS call
  (`voice`, `rate`, `volume`, `wait`) with no profile at all.

## Troubleshooting

**Nothing is heard, but the command exited 0.** The profile or `global.mute` is muted (stderr shows `[say] muted`),
or the background speaker failed. Run `tools say logs -n 5 --full` to see the status and the error, and repeat the
call with `--wait` to see the error on the terminal.

**`[say] xai has no usable key, falling back to macos.`** No xAI account and no `XAI_API_KEY`. Add one with
`tools ai config account add --provider xai`. The same holds for `openai` and `OPENAI_API_KEY`.

**`[say] TTS failed: ...` followed by a voice list.** The voice does not exist for that provider (an HTTP 404 or
"voice not found"). This error does not fall back to macOS. Pick a voice from `tools say --provider <name> voices`.

**`--model gpt-4o-mini-tts` sounds the same.** The model is dropped before synthesis (the same function drops
`--rate`), so OpenAI always uses `tts-1`. The call still gets its own cache entry and a usage row with the wrong model.

**Nothing is heard with a macOS `--voice`.** The name is not in `say -v '?'`. `tools say` cannot detect it: the log
shows `spoken` and the exit code is 0. With `--output` it fails with ``macOS `say` failed to produce output file``.

**`--rate` has no effect.** The rate takes effect on live macOS speech and on a cloud provider with `--stream` (the
cloud tempo change also needs `ffplay`). It is ignored with `--output` on every provider, and on a cloud provider's
default path, which synthesizes over REST and plays through the audio cache. A caller that writes files with a rate,
such as the recorder's voiceovers, gets the default speed.

**xAI sounds quieter than with `--stream`.** xAI audio gets a 7 dB loudness boost on the streaming path only. The
default path (REST plus the audio cache) plays it without the boost.

**A long text on OpenAI falls back to macOS.** OpenAI takes at most 4,096 characters on every path, `--stream`
included. Split the text.

**A long text on xAI falls back to macOS.** The xAI REST path takes at most 15,000 characters. Use `--stream`.

**`tools say logs` shows `no outcome`.** The speaker crashed or was killed before it wrote the outcome. `--full`
prints the pid and the `rg` command that finds its lines in the day log.

**`tools say voices` lists one macOS voice per language.** The list keeps the first voice per language from
`say -v '?'`, cached for 7 days. Any voice that `say -v '?'` prints works with `--voice`. A cloud provider with no
usable key is left out of the list.

**"Speak text (test)" in `tools say config` does not sound like a cloud profile.** The test speaks through the local
macOS voice, not the profile's cloud provider. A cloud voice name such as `alloy` is not a macOS voice, so the test can
stay silent. Test a cloud profile with `tools say "test" --app <name> --wait`.

**`[say] config requires a TTY.`, `[say] no message provided.` or `[say] --save requires --app <name> in
non-interactive mode.`** The command ran outside a terminal. Pass the message, or `--app <name>` with `--save`.

## Related

- [`tools ai`](../ai/README.md): AI accounts (`tools ai config account`), the approval gate (`tools ai gate`), model
  downloads (`tools ai models download`) and usage.
- [`tools notify`](../notify/README.md): its `say` channel speaks notifications through `tools say`.
- [`tools claude`](../claude/README.md): `tools claude cmux focus <session>` jumps to the pane of a call in the log.
- [`tools recorder`](../recorder/README.md): voiceovers are written with `tools say --output`.
- [`tools telegram`](../telegram/README.md): its say action speaks through `speakWithProfile`.
