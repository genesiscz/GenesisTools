# tools youtube

Fetch, store and query YouTube videos on your Mac: captions or AI transcripts, summaries, questions with
cited answers, saved channels, a job queue, a web UI, an MCP server, and the API server the companion browser
extension talks to. Use it to read a video without watching it, or to ask questions across a whole channel.

## Quick start

```bash
# Print the transcript of one video (captions first, AI transcription only when there are none)
tools youtube transcribe "https://www.youtube.com/watch?v=abcDEF12345"

# Summarise a video (asks before it calls the LLM; -y skips the prompt)
tools youtube analyze abcDEF12345 --summary

# Ask a question with cited timestamps (the video needs a transcript, as above)
tools youtube ask "what did they say about pricing?" abcDEF12345

# Start the background API server (it also runs queued jobs)
tools youtube server

# Save a channel, fetch the captions of its uploads, then ask across them
tools youtube channels add @example-channel
tools youtube queue add @example-channel --stages discover,metadata,captions --watch
tools youtube ask "what shipped this month?" --channel @example-channel
```

Quote a URL that holds `?`: zsh reads an unquoted `?` as a glob, prints `no matches found` and runs nothing.
`channels sync` stores the video listings only, with no transcripts, so a channel ask right after it fails
with "none of the N video(s) in scope have transcript data yet".

A target is an 11-character video id, a YouTube URL, or a channel `@handle`, unless a command says otherwise.

## Commands

Run `tools youtube <command> --help` for the full option list of any command.

### Global flags

These go before the subcommand and work on every command. Many subcommands also accept `--json` after their name.

| Flag          | Effect                                        |
|---------------|-----------------------------------------------|
| `--json`      | Structured JSON instead of human output       |
| `--clipboard` | Copy the output to the clipboard              |
| `--silent`    | Suppress non-essential logs                   |
| `--verbose`   | Verbose logs                                  |
| `--readme`    | Print this README                             |
| `-V`          | Print the version                             |

```bash
tools youtube --json cache stats
```

### One video: transcribe, download, analyze

```bash
tools youtube transcribe [url]       # captions, else AI transcription; prompts when no url is given
tools youtube download <target>      # download audio and/or video into the cache
tools youtube analyze <targets...>   # short summary (default), timestamped summary, or a question
```

- `transcribe`: `--format text|json|srt|vtt` (default `text`), `--lang <code>` (an ISO code such as `en`),
  `-o, --output <path>` writes the file, `--provider <provider>` overrides the transcription provider.
  Without a url in a non-interactive shell it exits with an error.
- `transcribe` looks for a stored transcript first, then captions, then runs AI transcription.
  `--no-cache` ignores the stored transcript and runs AI transcription; it does not fetch captions again.
  `--force-transcribe` skips the caption check and runs AI transcription, but a stored transcript still
  wins: to transcribe a stored video again, pass `--force-transcribe --no-cache` (or `--no-cache` alone).
- When AI transcription runs, `--provider` also saves that provider as the default transcription provider of
  the shared AI config, so other tools use it too.
- `download`: `--audio` (archived opus audio, the default), `--video` (a video file too),
  `--quality 720p|1080p|best` (default `720p`), `--keep` pins the file so `cache prune` skips it.
- `analyze`: `--summary` (default), `--timestamped` with `--target-bins <n>` (approximate entry count),
  `--ask <question>` with `--top-k <n>` (default 8) and `--stream`. `--provider <name>` and `--model <id>`
  override the model. `-y, --yes` skips the confirmation.

`analyze` prints what it is about to send (one LLM call per video for a summary, the full transcript text)
and asks before it calls the model. In a non-interactive shell it refuses without `-y` and exits 1.

`analyze --ask --stream` always streams the answer to stdout. With the global `--json` it then prints the
JSON after the streamed text, so the output is not one JSON document. Do not combine the two in a script.

### Ask across many videos

```bash
tools youtube ask "what did they say about pricing?" abcDEF12345 xyzXYZ98765   # explicit video ids
tools youtube ask "what shipped this month?" --channel @example-channel
tools youtube ask "summarise the objections" --dir ./exported-transcripts
```

The three corpus selectors (video ids, `--channel <handle>`, `--dir <path>`) are mutually exclusive.
`--dir` imports the transcript directory first, then asks over it.

- `--limit <n>` caps the channel members, newest first. `--top-k <n>` sets the chunks to retrieve.
- `--session <name>` keeps conversational memory under that name, so a follow-up question sees the earlier
  turns. `--history --session <name>` prints those turns and exits; it needs no question.
- `--stream` streams the answer. `ask` ignores it with `--json` or `--clipboard` and prints a note to
  stderr, so the result stays parseable.
- `--provider <name>` and `--model <id>` override the model.

Every `ask` indexes at most 5 not-yet-indexed videos per call (`MAX_LAZY_INDEX_PER_ASK` in `lib/qa.ts`), with
explicit ids, `--channel`, `--dir` and `--session` alike, and reports the rest as "left unindexed by the
index budget". A first question against a large channel answers promptly instead of embedding the whole
channel. To index every named target, pass explicit ids to `analyze --ask`: explicit ids there have no
budget, while a `@handle` target keeps it.

A video counts for an ask only when it has a stored transcript. When no video in scope has one, `ask` stops
with "none of the N video(s) in scope have transcript data yet".

### Channels and the video library

```bash
tools youtube channels add [handles...]   # save channels; --from-file <path> reads one handle per line
tools youtube channels list               # saved channels and their last sync
tools youtube channels remove <handle>    # remove a channel and all of its cached data; --yes skips the prompt
tools youtube channels sync [handle]      # refresh video listings for one channel, or --all
tools youtube videos list                 # cached videos
tools youtube videos show <id>            # full metadata and transcript availability
tools youtube videos search <query>       # keyword search in the database
tools youtube videos sync-dates           # backfill a missing upload_date (one yt-dlp call per row)
```

- `channels sync`: `--all`, `--limit <n>` (videos per channel, default 30), `--include-shorts`, `--since <date>`.
  By default it only enqueues a `discover,metadata` job per channel and prints the job ids; the job runs when a
  worker runs (see "How it works"). `--sync` runs it now and prints a results table. In a non-interactive
  shell it needs a handle or `--all`.
- `videos list`: `--channel <handle>`, `--since <YYYY-MM-DD>`, `--limit <n>` (default 30), `--include-shorts`.
- `videos search`: `--in transcript,title,description,tags` (default `transcript`), `--channel <handle>`,
  `--limit <n>` (default 50).
- `videos sync-dates`: `--channel <handle>`, `--limit <n>` (rows per run, default 200), `--concurrency <n>`
  (default 4).

### Transcripts in files

```bash
tools youtube transcripts export abcDEF12345 --dir ./out          # one <videoId>.<format> file per video
tools youtube transcripts import --dir ./out                      # read .json and .md files back
tools youtube transcripts show abcDEF12345 --format md            # print one stored transcript
```

- `--format md|json|txt|srt|vtt`. `export` defaults to `json`, `show` defaults to `txt`.
- `export --overwrite` rewrites files that exist; without it they are skipped.
- `json` is the lossless format and the one `import` round-trips. Markdown keeps `[mm:ss] text` lines, so an
  import recovers the start times only and infers the ends. `import` reads only `.json` and `.md` files.

### Pipeline and queue

```bash
tools youtube pipeline <targets...>         # enqueue, run the jobs in this process, print the result
tools youtube queue add <targets...>        # enqueue one job per target and return
tools youtube queue list                    # jobs, newest first
tools youtube queue show <id>               # one job; --activity adds its activity rows
tools youtube queue watch [ids...]          # stream job events; no ids watches everything active
tools youtube queue cancel <id>             # cancel a pending or running job
tools youtube queue stats                   # queue depth per stage
```

Stages for `--stages` (comma-separated): `metadata`, `comments`, `captions`, `audio`, `video`, `transcribe`,
`summarize`. The default for `pipeline` and `queue add` is `metadata,captions,transcribe,summarize`. The queue
also knows `discover`, `qaIndex`, `qa` and `reportSynthesize`, which channel sync and the server use; an
unknown name is refused.

The `transcribe` stage always runs AI transcription, even for a video that has captions, and it is in the
default list. `--stages metadata,captions,summarize` is the path that costs no transcription.

- `pipeline`: `--concurrency <n>` overrides every per-stage cap, `--watch` streams progress to stderr.
- With `--stages metadata,captions` (or `metadata,comments`), a video that already has a transcript (or
  comments) is skipped with a note. No other stage list, the default included, is skipped for a cached
  artifact.
- For a channel `@handle` with `discover`, `pipeline` returns when discovery ends. The discover stage
  enqueues one child job per stored video, and `pipeline` does not wait for them; they run when a worker
  runs. Start the server and use `queue add @handle --stages discover,... --watch` instead, because the
  watch follows child jobs.
- `queue add`: `--priority <n>` (higher runs first), `--force` (enqueue even when an identical job is
  active), `--watch` (follow the jobs and the child jobs they spawn; progress goes to stderr so `--json`
  stays parseable).
- `queue list`: `--status pending|running|completed|failed|cancelled`, `--target <target>`, `--limit <n>`
  (default 20).
- `queue watch`: `--jsonl` (one JSON object per line), `--timeout <sec>`, `--no-children` (do not follow the
  jobs that the watched jobs spawn). Its event stream goes to stdout, because that is the result.

```bash
tools youtube queue add abcDEF12345 --stages metadata,captions --watch
tools youtube queue watch 41 42 --timeout 300
tools youtube queue watch --jsonl | jq .
```

#### Comments

The `comments` stage fetches a video's comments through `yt-dlp` (100 by default) and stores them in the
database. It is opt-in:

```bash
tools youtube pipeline abcDEF12345 --stages metadata,comments
```

The server serves them at `GET /api/v1/videos/:id/comments`. The web UI shows them in the video's Comments tab,
which has search and renders 50 threads at first, with a "Show all" button for more.

### Server, web UI and MCP

```bash
tools youtube server                 # start the API server in the background (same as `server up`)
tools youtube server status          # pid, port, uptime, dependencies, launchd state
tools youtube server down            # stop (alias: stop)
tools youtube ui                     # start the web UI and open it in the browser
tools youtube mcp                    # serve the curated MCP tool set over stdio
```

`server` and `ui` have the same verbs:

| Verb        | What it does                                                    |
|-------------|-----------------------------------------------------------------|
| `up`        | Start in the background; `-f` blocks in the foreground          |
| `down`      | Stop; `--no-force` never escalates to SIGKILL                   |
| `restart`   | Stop and start again                                            |
| `status`    | Pid, port, uptime, dependencies, launchd state                  |
| `attach`    | Tail the background log (`-n`, default 50); Ctrl+C detaches     |
| `logs`      | Print the last lines of the log (`-n`, default 200)             |
| `open`      | Make sure it is up, print the URL and a QR code, open it        |
| `install`   | Register a launchd agent, so it survives reboots and crashes    |
| `uninstall` | Remove that launchd agent                                       |

- `up` and `restart` take `-p, --port <n>`, `--force` (kill a process that holds the port) and `--no-open`.
  `open` takes `-p`, `--no-qr`, `--no-open` and `-q, --query key=value` (repeatable). `install` takes
  `--force` and `-p`.
- `-p` on `up` and `restart` does not move either process. It only sets the port that the launcher checks
  for a conflict and waits on. The process starts on its own port anyway, and after the readiness timeout
  (30 seconds for the server, 90 for the web UI) `up` prints "Readiness check failed".
- `-i, --interactive` shows the menu even when the action is clear.
- `ui`, `ui up` and `ui restart` also take `--api-url <url>`, which writes `apiBaseUrl` into `server.json`.
- `ui up` asks to start the API server when it is not running.

The API server listens on port 9886, the `youtube-server` entry in `src/utils/ui/dashboards.ts`. It was 9876
until 2026-10-04, which Blender MCP also uses; a saved `apiPort` of 9876 (or a base URL on it) is read as 9886,
and any other saved port stays. It covers channel tracking, videos, transcripts, summaries and questions, the
job pipeline, cache management, users and config. The full endpoint list is an OpenAPI 3.1 document at
`GET /api/v1/openapi.json`.

The API server process binds `apiPort` from `server.json`. To move it, set the key and pass the same number to
`-p`, so the launcher waits on the right port. Change `apiBaseUrl` too, so the UI and the extension follow:

```bash
tools youtube config set apiPort 9900
tools youtube config set apiBaseUrl http://localhost:9900
tools youtube server restart -p 9900
```

The web UI runs on port 3074. The launcher always starts Vite with `--port 3074 --strictPort`, so the UI
port does not move.

#### MCP server

`tools youtube mcp` exposes a curated subset over stdio: `list_videos`, `get_video`, `search_transcripts`,
`transcript_window`, `ask`, `queue_add` and `queue_status`. Admin, billing, cache and config writes are absent
on purpose, and the server treats its client as untrusted:

- It reads the queue as its own console service account, never as the operator, so it cannot see or cancel
  another user's jobs.
- Paging limits and retrieval depth are clamped in the handler, not only advertised: 200 rows, a
  `transcript_window` half-width of 600 seconds (default 45, so one window spans up to 1200 seconds),
  50 chunks for `ask`.
- `queue_add` defaults to the stages that cost no credits (`metadata`, `captions`, `summarize`). Pass
  `transcribe` explicitly to allow paid AI transcription; that stage transcribes even a video that has
  captions.

Register it in an MCP client with the command `tools` and the arguments `youtube mcp`.

### Browser extension

```bash
tools youtube extension build                  # build into dist/extension/ and reload it in the browser
tools youtube extension reload                 # reload it over DevTools, no click (--port, default 9222)
tools youtube extension dev                    # watch, rebuild and reload on every change
tools youtube extension devtools launch        # build, then start Chrome or Brave with it loaded and CDP open
tools youtube extension devtools get-frame-grid ./shot.png   # screenshot with a labelled coordinate grid
```

- `build --no-reload` skips the reload.
- `devtools launch -p <port>` sets the debugging port (default 9333). Drive that browser with
  `tools chrome-devtools <verb> --port 9333`. The old `devtools list-tools` and `devtools call` verbs are
  removed and print that pointer instead.
- `get-frame-grid <outPath>`: `--region x,y,w,h` crops first, `--step <n>` sets the grid spacing (default 40),
  `--cdp-url <url>` picks the browser (default `$CDP_URL`, else `http://127.0.0.1:9333`).
- `dev` sends reloads over a WebSocket on port 9877 (`youtube-extension` in the port registry).

### Cache and config

```bash
tools youtube cache stats              # row counts and the size of the audio, video and thumbnail caches
tools youtube cache prune --dry-run    # list the binaries past their TTL; drop --dry-run to delete them
tools youtube cache clear --audio      # delete cached binaries: --audio, --video, --thumbs or --all; --yes skips the prompt
tools youtube config get [key]         # print the whole config, or one key
tools youtube config set <key> <value> # set one key; a JSON value is parsed, anything else is a string
```

## How it works

Every command opens the same local SQLite database directly; the CLI does not need the server. Work that runs
long goes through a job queue in that database:

- `pipeline` and `download` enqueue their jobs and run the workers in their own process until the jobs finish.
  For a channel `@handle` with `discover`, `pipeline` waits for the discovery job only, not for the child job
  of each video (see "Pipeline and queue").
- `queue add`, `channels sync` (without `--sync`) and the MCP `queue_add` only enqueue. The jobs run when a
  worker runs: the API server starts one, and so does any `pipeline` or `download` command.
- CLI and MCP work is recorded under a console service account, so jobs and AI usage have an owner.

Captions come from the `youtube-transcript` package. Listings, metadata, audio, video and comments come from
`yt-dlp`, which must be on `PATH`; its metadata also names the caption languages a video has. Audio
downloads use `yt-dlp -x` (opus, or 16 kHz mono WAV), which needs `ffmpeg`.

### Where data lives

The root is `~/.genesis-tools`; `GENESIS_TOOLS_HOME` moves it.

| Path                                          | Holds                                    |
|-----------------------------------------------|------------------------------------------|
| `youtube/server.json`                         | The config                               |
| `youtube/youtube.db`                          | Channels, videos, transcripts, jobs, users |
| `youtube/cache/channels/<handle>/videos/<id>/` | `audio/`, `video/`, `thumbs/` binaries   |
| `youtube-server/port`                         | The port the running server took         |
| `logs/youtube-server.bg.log`                  | The background server log                |
| `logs/youtube.bg.log`                         | The background web UI log                |

The extension build goes to `dist/extension/` in the GenesisTools checkout. `server install` writes
`~/Library/LaunchAgents/com.genesis-tools.youtube-server.plist`.

### What costs money

- Captions are free. AI transcription runs in three cases: a video has no captions; the `transcribe` stage
  is in a `pipeline` or `queue add` stage list (it is in the default list, and it transcribes even a video
  that has captions); or `transcribe --no-cache` (or `--force-transcribe` on a video with no stored
  transcript). Use `--stages metadata,captions,summarize` for the free path.
- Summaries, insights and questions call an LLM. The default config sends them to the `grok` provider (the
  SuperGrok subscription account), not the metered xAI API key. Embedding and transcription keep the local,
  free defaults of the shared AI layer unless you map them in `ai`.
- `--provider` on `ask`, `analyze` and `transcribe`, and `--model` on `ask` and `analyze`, can point at a
  paid API.

## Configuration

`tools youtube config get` prints the effective config: the defaults merged with `server.json`. The file is
written atomically under a lock. A `server.json` that is not a JSON object, or that holds malformed values, is
never replaced: a write refuses with an error.

- A running server keeps the config in memory and does not watch the file. It sees a `config set` change
  only after `tools youtube server restart`, and `config set` prints a note to say so.
- `config set` refuses an unknown key, and a value whose JSON type differs from the current value's type
  (an array for an object key, `null` for a number). Both exit 1. It checks the type only: a wrong string
  such as `config set defaultQuality garbage` still passes.

| Key               | Default                                    | Meaning                                     |
|-------------------|--------------------------------------------|---------------------------------------------|
| `apiPort`         | `9886`                                     | API server port                             |
| `apiBaseUrl`      | `http://localhost:9886`                    | Where the UI and extension reach the API    |
| `ai`              | grok for `summary`, `insights`, `qa`       | Task to provider and model mapping          |
| `provider`        | `{}`                                       | Legacy per-task provider names (fallback)   |
| `preferredLangs`  | `["en"]`                                   | Caption languages to prefer                 |
| `defaultQuality`  | `"720p"`                                   | `720p`, `1080p` or `best`                   |
| `concurrency`     | download 4, localTranscribe 2, cloudTranscribe 8, summarize 4 | Per-stage caps          |
| `workers`         | max 8, `burst`, idle 30000 ms, poll 2000 ms | Worker pool                                |
| `ttls`            | audio 7 days, video 3 days, thumb 30 days, channelListing 24 hours | Cache lifetimes    |
| `keepVideo`       | `false`                                    | Keep video files                            |
| `powerUsers`      | `[]`                                       | `{ email, type }` grants: `admin`, `dev`, `user` |
| `freeTier`        | `{ actionsPerMonth: null }`                | Monthly free actions; `null` turns metering off |
| `referrals`       | `{ enabled: false, offers: [] }`           | Referral offers                             |

An `ai` entry is `{ provider, model?, for: [...] }`, where `for` lists tasks from `insights`, `summary`, `qa`,
`transcribe`, `embed`, or `"all"` as the fallback. The default deliberately does not use `"all"`: grok has no
embedding endpoint, and an `"all"` entry would break every indexing run.

```bash
tools youtube config set preferredLangs '["en","cs"]'
tools youtube config set ai '[{"provider":"grok","for":["summary","insights","qa"]}]'
```

### Environment variables

- `YOUTUBE_SERVICE_KEY`: a comma-separated list of keys, one per user. See "Hosted deployment".
- `YOUTUBE_HOST`: the server's bind host, default `127.0.0.1` (loopback). Set `0.0.0.0` only for direct LAN
  access, and keep a firewall in front.
- `YOUTUBE_ALLOW_DEV_TOPUP`: `1` enables `POST /api/v1/users/topup`, the extension's dev-only "Fill diamonds"
  button. Unset or `0` keeps the endpoint a 404, because a free credit mint has no place on a real deployment.
  Set it locally, or the dev button only gets a 404.
- `YOUTUBE_UI_PORT`: read by `ui/vite.config.ts`, so it moves the web UI only when you run Vite on that config
  directly. `tools youtube ui` passes `--port 3074`, which wins over the config, so there the variable has no
  effect.
- `CDP_URL`: the default browser for `extension devtools get-frame-grid`.

### Hosted deployment and service keys

The server is open on localhost by default. To expose it (for example on a shared VPS), set
`YOUTUBE_SERVICE_KEY`:

- Every route then requires a key, except `/api/v1/healthz`, `/api/v1/version`, `/api/v1/openapi.json`,
  `/api/v1/webhooks/*` (a payment webhook proves itself with its own signature) and the public share pages
  at `GET /share/:slug`, which need no key of any kind.
- A valid per-user `ytu_` token passes the gate as well as a service key; user routes then check that
  user's identity.
- A request presents the key as `Authorization: Bearer <key>`, or as `?access_token=<key>` or `?key=<key>`
  on any route. The query forms exist because a browser cannot set headers on a WebSocket handshake or an
  `<audio src>`.
- Unset or empty keeps the server open for local development. A value that parses to zero keys (such as
  `,,,`) fails closed at startup instead of opening silently.

A complete VPS template (an nginx TLS front plus systemd units for the youtube, ai-proxy and eve services) is in
[`deploy/vps/`](../../deploy/vps/README.md); its README has the bring-up steps.

## For agents

- Put `--json` before the subcommand for structured output: `tools youtube --json videos list --limit 5`.
- `queue watch --jsonl` streams one JSON event per line on stdout. `pipeline --watch` and `queue add --watch`
  write progress to stderr, so stdout stays one JSON document. `analyze --ask --stream` is the exception: it
  streams text to stdout before the JSON, so do not combine it with `--json`.
- A failed command prints the error to stderr and exits 1.
- Pass `-y` to `analyze` in scripts; without it a non-interactive run refuses the LLM call.
- `tools youtube mcp` is the MCP door (see above). The HTTP API is described by `/api/v1/openapi.json`.

## Troubleshooting

- **Jobs stay `pending`.** `queue add` and `channels sync` only enqueue. Start a worker with
  `tools youtube server`, or use `pipeline` (or `channels sync --sync`), which runs the work in its own process.
- **Jobs under launchd fail with `Could not resolve provider="xai"`.** A launchd agent gets a bare environment.
  `server install` copies the provider API keys that are set when it writes the plist. Export the key, then run
  `tools youtube server install` again.
- **`analyze` prints "Refusing to call the LLM in non-interactive mode".** Add `-y`.
- **An ask reports videos "left unindexed by the index budget".** Every `ask` indexes at most 5 not-yet-indexed
  videos per call. Ask again, or name the ids with `analyze --ask`.
- **An ask says "none of the N video(s) in scope have transcript data yet".** The videos have
  listings only, for example after `channels sync`. Fetch captions first, with the server running:
  `tools youtube queue add <id> --stages metadata,captions` for a video, or
  `tools youtube queue add @handle --stages discover,metadata,captions --watch` for a channel.
- **`ask --stream` printed nothing extra with `--json`.** That is on purpose; `--json` wins, and a note goes to
  stderr. `analyze --ask --stream` has no such guard: with `--json` it prints the streamed text before the
  JSON, so scripts must not combine them.
- **`server up -p` or `ui up -p` waits, then says "Readiness check failed".** `-p` does not move the process.
  Set `apiPort` for the API server and pass the same `-p`; the web UI always runs on 3074.
- **The server will not start with a service key set.** The value parsed to zero keys; check for stray commas.
- **The server port is taken.** Check `tools youtube server status`; `server up --force` kills the process
  that holds the port.
- **`config set` says it is "refusing to replace" `server.json`.** Fix the file by hand; the tool does not
  overwrite a file it cannot read.
- **`channels sync --since` has no effect.** The flag is accepted, but neither sync path reads it yet
  (`commands/channels.ts`). Filter afterwards with `videos list --since <date>`.

## Related

- [tools chrome-devtools](../chrome-devtools/README.md): drives the extension test browser.
- [tools transcribe](../transcribe/README.md): local audio transcription outside YouTube.
- [tools ai-proxy](../ai-proxy/README.md): runs beside this server in the VPS template.
