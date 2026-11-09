# tools transcribe

Turn speech into text. Give it an audio or video file on this Mac, a YouTube video, an X (Twitter) post with a
video, or a direct link to a media file, and it prints the transcript as plain text, JSON, or SRT or VTT subtitles.
It runs on a cloud speech provider (OpenAI, Groq, Deepgram and others) or on this Mac with a local Whisper model,
and `--price-only` shows what each provider would charge before you spend anything.

## Quick start

```bash
tools transcribe meeting.m4a --local                          # on this Mac, free; plain text to the terminal
tools transcribe interview.mp4 --provider deepgram --format srt -o interview.srt   # SRT subtitles to a file
tools transcribe https://youtu.be/dQw4w9WgXcQ                 # YouTube: captions first, the audio only without them
tools transcribe https://x.com/user/status/123 --provider deepgram   # the video of an X post
tools transcribe call.wav --provider openai --diarize --speakers 3   # label who speaks
tools transcribe https://cdn.example.com/talk.mp4 --price-only       # the price per provider; downloads nothing
```

You need one provider. `--local` needs no key. A cloud provider needs its API key in the environment
(`export DEEPGRAM_API_KEY=...`) or in an AI account (`tools ai config account add`); `elevenlabs` works only through
an account. By the source, `--local` also resolves through an enabled `local-hf` account (see
[Providers and keys](#providers-and-keys)). GenesisTools itself installs from the repository root with
`bun install && ./install.sh`, then `source ~/.zshrc` (or `~/.bashrc`).

## Commands

`tools transcribe` has no subcommands. It takes one input and the flags below.

```text
tools transcribe [options] [file]
```

- With no `file`, when stdin is a terminal, it opens a form: the input, the provider, speaker labels, the format, and
  where the result goes (terminal, clipboard, or a file named after the input with the format's extension). The form
  offers `local-hf`, `cloud`, and OpenAI, Groq, OpenRouter or xAI when that key is set in the environment. For any
  other provider, pass `--provider`. Cancelling the form exits 0.
- `tools transcribe --help` lists the flags. `tools transcribe --readme` prints this page.

### Inputs

`file` is one of four kinds. The tool picks the driver from the text you pass:

- **A local file**, such as `meeting.m4a`. Allowed extensions: `.mp3 .wav .m4a .aac .ogg .flac .wma .aiff .webm
  .opus .qta .mov .mp4`. Any other extension stops with `Unsupported audio format` before any transcription starts. A local file is then
  probed with ffprobe through the shared `AudioProcessor` (as `ask` does), and a file ffprobe cannot read stops with
  `Invalid audio file: <reason>`.
- **A YouTube video**: a `watch?v=`, `youtu.be/`, `shorts/`, `embed/`, `live/` or `youtube-nocookie.com` link, or a
  bare 11-character video id (`dQw4w9WgXcQ`). It uses the same pipeline as `tools youtube transcribe`.
- **An X post**: `https://x.com/<user>/status/<id>` (also `twitter.com` and `/statuses/`). It reads the post through
  Twitter's public syndication JSON, takes the lowest-bitrate MP4 of the post's first video, and extracts the audio.
  No X account or key is needed.
- **A direct media URL**: a link that is already the media, known by its extension (the local list plus `.m4v .mkv
  .m3u8`) or by its `Content-Type` (`audio/*`, `video/*`, `application/mp4`, an HLS playlist type).

How the text is read:

- An `http://` or `https://` input is always a URL. Any other input that exists on disk is a local file.
- A missing name of exactly 11 characters from `A-Z a-z 0-9 _ -` is taken as a YouTube video id. Any other missing
  name fails with `File not found`.
- A YouTube link without a video id (a channel page) and an X link that is not a post (a profile) are refused.
- An ordinary HTML page is refused by the direct driver. There is no general page scraper.
- A local `.mkv` or `.m4v` is refused, though the same file works as a URL. Convert it first (see
  [Troubleshooting](#troubleshooting)).

### Flags

| Flag | Default | What it does |
|---|---|---|
| `--provider <provider>` | asked, or saved | The speech provider ([table](#providers-and-keys)) |
| `--local` | off | Shorthand for `--provider local-hf` |
| `--model <model>` | provider's | A model id of that provider |
| `--lang <language>` | auto-detect | The audio language: `en`, `cs`, `de`, ... |
| `--format <format>` | `text` | `text`, `json`, `srt` or `vtt` |
| `-o, --output <path>` | stdout | Write the result to a file |
| `-c, --clipboard` | off | Copy the result to the clipboard |
| `--diarize` | off | Label the speakers (`SPEAKER_00`, `SPEAKER_01`, ...) |
| `--speakers <n>` | see below | The expected number of speakers |
| `--no-clean`, `--raw` | cleanup on | Keep repetition loops in the transcript |
| `--force-transcribe` | off | YouTube only: skip captions and transcribe the audio |
| `--price-only` | off | Price every provider; no download, no transcription |
| `-v, --verbose` | off | Verbose logging |

- `--local` wins over `--provider` when you pass both.
- `-o` and `-c` together do both. With either of them, nothing goes to stdout.
- `--lang` matters for non-English audio. Without it, Whisper detects the language as it goes and can fall into
  repetition loops on, for example, Czech.
- Cleanup (on unless `--no-clean` or `--raw`) collapses the loops Whisper sometimes produces: one word or a short
  phrase repeated many times.
- `--speakers` takes a positive whole number. `0`, a negative number or text counts as not given. The help says
  "0/omit = auto-detect", but local diarization then assumes **two** speakers, because auto-detect split long
  two-person recordings into five. Pass `--speakers N` for a call with more people. Deepgram counts the speakers
  itself.
- A YouTube input refuses `--model`, `--raw`/`--no-clean`, `--diarize` and `--speakers`, because its pipeline would
  drop them silently. It accepts `--provider`, `--local`, `--lang`, `--force-transcribe` and the output flags. To use
  the refused flags, download the audio and pass the file.
- `--force-transcribe` also skips a transcript that the youtube tool already stored for that video.
- `tools transcribe` has no `--no-cache`. That flag is on `tools youtube transcribe`.

### Output formats

- `text`: the transcript. With speakers, each turn is one line: `SPEAKER_00: ...`.
- `json`: the whole result: `text`, `segments` (`start` and `end` in seconds, `text`, and `speaker` when known),
  `language` and `duration`.
- `srt` and `vtt`: subtitles. Segments are merged into cues. A cue ends at a sentence end (`.` `!` `?` `…`), at 84
  characters, or, without speakers, when it would last more than 6 s. With speakers, a change of speaker always
  starts a new cue. SRT puts `SPEAKER_00: ` in
  front of the text, VTT uses `<v SPEAKER_00>`.
- A model that returns no timestamps (`gpt-4o-transcribe`, `gpt-4o-mini-transcribe`) gives subtitles with no cues:
  SRT is the plain text, VTT is a `WEBVTT` header and the plain text.

The SRT, VTT and text renderers are shared helpers in `src/utils/ai/transcription-format.ts`.

### Price check (`--price-only`)

```bash
tools transcribe https://youtu.be/dQw4w9WgXcQ --price-only
tools transcribe meeting.m4a --price-only --provider deepgram --model nova-2-finance   # mark the row a run would use
tools transcribe https://x.com/user/status/123 --price-only --format json
```

- It reads only the duration: from the file header (ffprobe) for a local file or a direct URL, from the post's JSON
  for X, and from YouTube metadata (yt-dlp) for YouTube. It downloads no media and writes nothing. The YouTube lookup
  does not store the video in the youtube database.
- A YouTube or direct-URL lookup gives up after 20 s and an X lookup after 30 s, so a dead host fails instead of
  hanging.
- It needs no provider and no key.
- The table columns are `PROVIDER`, `MODEL`, `MODE` (`batch` or `stream`), `$/HOUR`, `THIS AUDIO`, `HERE` and `RUN`.
  `HERE` is `yes` when the provider can run on this Mac now: an enabled AI account, a key, or a local model.
  `RUN` is `default` on each provider's default model; with `--provider` (and `--model`) it is `yes` on the row that
  run would use.
- Rows that can run here come first, then the cheapest. A price the catalog does not know shows as a dash and sorts
  last. Notes per row and failed availability checks go to stderr.
- The rates are list prices (Deepgram's are before prepaid credit) and live in `src/utils/ai/catalog/speech.ts`.
  Deepgram domain models that the catalog does not list (`nova-2-finance`, `base-phonecall`) inherit the parent's
  rate: `--model nova-2-finance` costs what `nova-2` costs.
- For YouTube, the table is the audio price. Captions, when the video has them, cost nothing.

## How it works

### Providers and keys

| Provider | Key (environment variable) | Default model |
|---|---|---|
| `local-hf` | none, runs on this Mac | `onnx-community/whisper-large-v3-turbo` |
| `openai` | `OPENAI_API_KEY` | `whisper-1` |
| `groq` | `GROQ_API_KEY` | `whisper-large-v3` |
| `deepgram` | `DEEPGRAM_API_KEY` | `nova-3` |
| `assemblyai` | `ASSEMBLYAI_API_KEY` | `best` |
| `gladia` | `GLADIA_API_KEY` | `default` |
| `elevenlabs` | an AI account only (see below) | `scribe_v1` |
| `openrouter` | `OPENROUTER_API_KEY` | `openai/whisper-1` |
| `xai` | `XAI_API_KEY` or `X_AI_API_KEY` | `xai-stt` (Grok voice) |
| `cloud` | does not run | none ([Troubleshooting](#troubleshooting)) |

- `--help` names only `local-hf, cloud, openai, groq, openrouter, xai`. The other rows work too; the default models
  come from `src/utils/ai/tasks/task-models.ts`.
- A key comes from an AI account first (`tools ai config account add`, kept in the encrypted vault), then from the
  provider's environment variable. The environment-only fallback covers `openai`, `groq`, `openrouter`, `xai`,
  `deepgram`, `assemblyai` and `gladia`. `elevenlabs` needs an account, with the key stored there or its variable
  opted in on the account; without one, `--provider elevenlabs` fails with `No enabled account for provider
  "elevenlabs"` and `--price-only` shows `no` in `HERE` for it.
- `cloud` is listed by `--help` and by the form, but it never runs: it has no default model, and no provider plugin
  has that name. Name a provider instead.
- `local-hf` runs Whisper through transformers.js on this Mac. The first run installs `@huggingface/transformers`
  into the package store `~/.genesis-tools/packages/store` (it asks first in a terminal; `bun install` does not bring
  it), then downloads the model. By the source (not run here), `local-hf` is not in the environment fallback, so
  `--local` resolves through an enabled `local-hf` account; add one with
  `tools ai config account add --provider local-hf` if a run fails with `No enabled account for provider "local-hf"`.
- `xai` is xAI's speech API. It has nothing to do with the X driver, which needs no key.
- `assemblyai` and `gladia` need an optional package that `bun install` does not bring. Add it once in the
  GenesisTools checkout: `bun add @ai-sdk/assemblyai` or `bun add @ai-sdk/gladia`.
- `whisper-1` still loops on some audio even with `--lang`. That is the model, not a bug. `gpt-4o-transcribe`, or
  Deepgram `nova-3` (robust, and about five times faster), are the alternatives.

### Which provider runs

1. `--local`, else `--provider` (with `--model` if you pass it).
2. No flag, when stdin is a terminal: it lists the providers that are ready on this Mac and asks you to pick one.
3. No flag, stdin not a terminal (a script or an agent): the saved `transcribe` default. Without a default it exits 1
   and prints the command with `--provider` added.

**A run with `--provider` or `--local`, or a provider picked at the prompt, saves that provider (and `--model`) as the
`transcribe` default** in `~/.genesis-tools/ai/config.json` (`defaults.task.transcribe`). Later runs without a
terminal and `tools ask --sst` then use it too. The default is saved before the provider is checked, so a run that
then fails (no account, a bad key, a failed upload) changes it as well. A provider name with no default model throws
before the save. Change it with `tools ai config default set transcribe <ref>`.

A YouTube input never asks. Captions need no provider. When it falls back to the audio, it uses `--provider`, else the
`transcribe` entry of the youtube tool's `ai` config, else the shared default, and it saves `--provider` the same way.

### What happens to each input

- **Local file**: the tool checks the extension, reads the format, duration and size (printed to stderr), and hands
  the file to the shared `Transcriber` in `src/utils/ai/tasks/Transcriber.ts`.
- **X and direct URLs**: the media goes to a temp folder (`$TMPDIR/transcribe-url-*`). An audio file (`.mp3 .wav
  .m4a .aac .ogg .flac .opus .aiff`) is used as it is; a video is converted to 16 kHz mono MP3 with ffmpeg. An HLS
  playlist (by `.m3u8` or by `Content-Type`) goes straight to ffmpeg, which reads it from the network. The result is
  kept for one hour in the cache, so a second run on the same post or URL skips the download. The temp folder is
  removed, also when the run fails.
- **YouTube**: the youtube tool stores the video's metadata, then returns a transcript it already has, or the
  captions (it prefers `--lang`, then the youtube tool's `preferredLangs`). Only without captions, or with
  `--force-transcribe`, does it download the audio (16 kHz WAV) and transcribe it. The transcript is stored in the
  youtube database. With Deepgram, the YouTube audio path labels speakers on its own.

Limits on a remote download: 512 MiB (a 38-minute 256 kbps MP4 is about 70 MB), 5 minutes per download, and
15 minutes for an HLS conversion. A live stream never ends, so it fails at that limit.

### Long files, cleanup and speakers

- A file over 24 MiB for a cloud provider is split by size, each part is transcribed in turn, and the timestamps are
  joined. OpenAI and Groq reject uploads over 25 MB. Deepgram with `--diarize` is the exception: it gets the whole
  file in one request, so one set of speaker labels covers it.
- Cleanup runs after the transcript is joined.
- `--diarize` uses the provider's own speaker labels when it returns them (Deepgram). For every other provider it runs
  local diarization with sherpa-onnx on the whole file, never one part, so `SPEAKER_00` is the same person from start
  to end. The speaker models (about 31 MB) download on first use. When the native addon or the models are not
  available, you get the transcript without speakers and a warning in the log.

### Data on disk

The root is `~/.genesis-tools`; `GENESIS_TOOLS_HOME` moves it.

| Path | Holds |
|---|---|
| `transcribe/cache/` | Converted audio of X and direct URLs, one hour each |
| `packages/store/` | `@huggingface/transformers`, installed by the first `--local` run |
| `transcribe/models/diarization/` | The local speaker models (about 31 MB) |
| `ai/config.json` | The saved `transcribe` default (`defaults.task.transcribe`) |
| `youtube/youtube.db` | YouTube videos and their stored transcripts |
| `youtube/cache/` | YouTube audio downloaded for transcription |
| `logs/<date>.log` | Log lines, scopes `transcribe` and `transcribe-quote` |

- A cache entry is a `<hash>.json` record and the audio file beside it. An expired entry is deleted at the next X or
  direct-URL lookup, not by a timer. Local files are never cached.
- Large cloud uploads are split in `$TMPDIR/transcribe-chunks-*`, which is removed after the run.

### What it needs on the Mac

- `ffmpeg` and `ffprobe` (`brew install ffmpeg`): durations, video to audio, HLS, and splitting long files.
- `yt-dlp` on `PATH` for YouTube.
- Local `--diarize` uses the `sherpa-onnx-node` native addon, which `bun install` brings. Where the addon cannot
  load, `--diarize` gives no speaker labels.
- No macOS permissions.

### What costs money

- `local-hf` and YouTube captions cost nothing.
- Every cloud provider bills by the length of the audio. `--price-only` shows the list price for your file before
  you run.

## Configuration

`tools transcribe` has no config file of its own.

- The `transcribe` default lives in the AI config:

  ```bash
  tools ai config default set transcribe deepgram/nova-3   # the provider and model to use without --provider
  tools ai config default list                             # what is set now
  ```

- Keys: the environment variables in [Providers and keys](#providers-and-keys), or an AI account
  (`tools ai config account add`).
- `GENESIS_TOOLS_HOME` moves `~/.genesis-tools`.
- YouTube caption languages and the YouTube audio provider: `tools youtube config set preferredLangs '["en","cs"]'`
  and the `ai` entry with `"for": ["transcribe"]` (see [youtube](../youtube/README.md)).

## For agents

- The transcript goes to stdout and every status line goes to stderr. When stdout is not a terminal, or with
  `--format json`, there is no spinner: only milestone lines reach stderr. YouTube progress is then silent.
- Always pass `file`. Without it, the tool opens the interactive form.
- Without a terminal, pass `--provider` (or `--local`), or set the `transcribe` default once. Otherwise it exits 1.
- Remember that `--provider` saves the default ([Which provider runs](#which-provider-runs)).
- `--format json` returns `{ text, segments?, language?, duration? }`. Each segment is
  `{ text, start, end, speaker? }`.
- `--price-only --format json` returns `{ durationSec, via, quotes }`. Each quote has `provider`, `model`, `mode`,
  `usdPerHour`, `usd` (`null` when unknown), `note`, `transcribeDefault`, `available` and `run`.
- Exit codes: `0` on success, `1` on every failure (a missing file, an unsupported input, no provider, a failed
  download or transcription). Cancelling the interactive form exits 0.
- Prompts test stdin (a terminal on stdin means the provider prompt and the form can open, even with `> out.txt`).
  The spinner and quiet output test stdout.
- Failed runs are also in `tools genesis-tools logs failures`.

## Troubleshooting

- **`No --provider specified, no default transcribe model, and not in an interactive terminal.`** Pass `--provider`,
  or set the default: `tools ai config default set transcribe <provider or model ref>`.
- **`No default transcribe model is defined for provider "cloud".`** `--provider cloud`, and the form's
  "Cloud (auto-select)" choice, have no default model. Name a provider (`--provider deepgram`), or leave `--provider`
  out and let the saved default answer.
- **`@ai-sdk/assemblyai is not installed, so this provider cannot transcribe.`** (or `@ai-sdk/gladia`). Run the
  `bun add` command the message prints, in the GenesisTools checkout.
- **`No enabled account for provider "<id>"`.** The provider has no AI account and is not in the environment
  fallback (`elevenlabs`, and `local-hf` by the source). Run `tools ai config account add --provider <id>`.
- **`Invalid audio file: <reason>`.** ffprobe could not read the file. Convert it first.
- **`No transcription providers are available.`** No key and no account was found. Export a key from the
  [table](#providers-and-keys), add an account, or use `--local`.
- **A provider you did not ask for runs.** An earlier `--provider` saved the default, even if that run failed. Check it with
  `tools ai config default list` and change it with `tools ai config default set transcribe <ref>`.
- **`Unsupported audio format: .mkv`.** Convert the file, then transcribe the result:

  ```bash
  ffmpeg -i video.mkv -vn -ac 1 -ar 16000 audio.mp3
  tools transcribe audio.mp3
  ```

- **`YouTube sources do not support --diarize.`** (or `--model`, `--speakers`, `--raw/--no-clean`). Download the
  audio, then pass the file with those flags.
- **`That URL is not a video or audio file (text/html)`.** The direct driver needs the media file's own URL, not the
  page that shows it.
- **`Remote file is N bytes, over the 536870912 byte cap.`** Download the file yourself and pass the local path.
- **`The HLS stream from <host> did not convert within 15 minutes or failed. Live streams are not supported.`** The
  stream is live or too long. Record or download it first.
- **`X post <id> has no video.`** or **`could not be read (syndication HTTP <status>)`**. The post has no video, or
  the syndication endpoint did not return it.
- **The same phrase repeats over and over.** Pass `--lang`, keep cleanup on, or switch the model (`whisper-1` loops on
  some audio; try `gpt-4o-transcribe` or `--provider deepgram`).
- **`--diarize` gives no speaker labels with `gpt-4o-transcribe`.** That model returns no segments, so there is
  nothing to label. Use `whisper-1`, Groq, `--local` or `--provider deepgram`.
- **SRT or VTT has no cues.** The model returns no timestamps (`gpt-4o-transcribe`). Use `whisper-1`, Groq, Deepgram
  or `--local` for subtitles.
- **`--diarize` gives no speaker labels.** Local diarization could not load (the sherpa-onnx addon or the model
  download failed). Look for `Local diarization unavailable` in `~/.genesis-tools/logs/<date>.log`, or use
  `--provider deepgram`, which labels speakers itself.
- **Too many or too few speakers.** Pass `--speakers N`. Local diarization assumes two without it.

## Related

- [youtube](../youtube/README.md): the YouTube pipeline this tool calls, with captions, stored transcripts and
  `--no-cache`.
- [ask](../ask/README.md): `tools ask --sst <file>` transcribes with the same `Transcriber` and the same `transcribe`
  default, but prints text only.
- [ai](../ai/README.md): accounts, keys and `tools ai config default set transcribe`.
