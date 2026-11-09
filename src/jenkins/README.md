# tools jenkins

Jenkins from your shell and from an AI assistant: stage timings, saved and searchable logs, a build monitor that
prints one line per stage result and posts a notification per change, same-parameter rebuilds, pipeline tracking and
queue diagnosis. It also ships an MCP server whose log tools save the log to a file and return only a path and a
summary, so the log itself never enters the model's context.

## Quick start

```bash
tools jenkins login                                          # store an API token once (opens <jenkins>/me/security/)
tools jenkins "https://ci.example.com/job/app/job/main/42/"  # smart mode: what this build is and what to run next
tools jenkins monitor job/app/job/main 42                    # one line per stage result, a notification per change
tools jenkins search-logs job/app/job/main 42                # ERROR|FAILURE|Exception matches as L<n>: <line>
tools jenkins rebuild "https://ci.example.com/job/app/job/main/42/"  # rerun with the same parameters
tools jenkins executors --urls                               # why the queue is backed up, and who holds the executors
```

`tools jenkins` with no argument prints its help. `tools jenkins --readme` prints this page.

## Two layers

- **REST commands**, `tools jenkins <command>`: everything in [Commands](#commands) except the `mcp` group.
- **The MCP server and its CLI**, `tools jenkins mcp [subcommand]`. `tools jenkins-mcp` is the same entry, kept so
  older MCP configs keep working. With no subcommand it serves MCP over stdio. With a subcommand it is a small CLI
  (`stages`, `log`, `info`, `changes`, `jobs`, `monitor`, `login`, `logout`, `status`).

Both layers use one login, one HTTP client, one URL parser and one log cache. `stages`, `monitor`, `logs` and
`search-logs` are thin doors onto the `mcp` CLI, so their output is the same.

## Commands

### Targets: job paths, URLs and build numbers

The first argument of most commands is a job path or any Jenkins URL that you copy from the browser.

- A job path is `job/<folder>/job/<job>`. A leading slash is fine, so an empty `$JENKINS_URL` in front of `/job/...`
  still works. A job path is taken as it is: give the build as its own argument (`stages job/app/job/main 42`). Only
  `logs` and `search-logs` split a trailing `/<number>` off a job path.
- A URL gives its build number and its `selected-node` (a pipeline node) by itself. A trailing page is dropped
  (`pipeline-overview`, `console`, `consoleText`, `consoleFull`, `wfapi`, `api`, `changes`, `testReport`,
  `execution`), and so is a `view/<name>/` filter of a multibranch URL.
- An explicit build argument or flag wins over the number in the URL. `rebuild` is the exception: with a URL target
  it ignores its `[build-number]` argument and reruns the build in the URL. To rerun another build, pass the job
  path and the number.

```text
job/Org/job/app/job/main                                        jobPath
/job/Org/job/app/job/main/                                      jobPath job/Org/job/app/job/main
https://ci.example.com/job/app/job/main/123/                    jobPath, build 123
https://ci.example.com/job/app/job/main/123/pipeline-overview/?selected-node=41
                                                                jobPath, build 123, node 41
https://ci.example.com/job/app/view/change-requests/job/PR-42/6/
                                                                jobPath job/app/job/PR-42, build 6
```

Which build words each command takes:

- `stages`, `monitor`, `logs`, `search-logs` and the `mcp` subcommands: a number, or a Jenkins permalink such as
  `lastBuild` or `lastSuccessfulBuild`. The REST commands default to the build in the URL, else `lastBuild`; `stages`
  and `monitor` resolve a permalink to its number first, so they keep following the same build. `mcp stages`,
  `mcp log` and `mcp monitor` need a build (from `--build` or the URL); `mcp info` and `mcp changes` default to
  `lastBuild`.
- `rebuild` and `track`: a number, or `latest`.
- `compare` and `stop-range`: numbers. `stop-range` refuses `12oops`, `12.9` and an inverted range before it sends
  any stop.

`stages`, `monitor`, `compare`, `triggers`, `stop-range`, `rebuild` and `track` refuse a URL that is not on the
configured Jenkins (scheme, host, port and context path), so the credentials for one instance never act on a job of
the same name on another. They also drop a context path such as `/jenkins` from the URL. `logs`, `search-logs`, the
`mcp` subcommands and the MCP tools read only the path of a URL and do not check its host.

### Log in

- `login [url]` (alias `setup`): asks for the Jenkins URL (any page of it works), opens `<jenkins>/me/security/`,
  asks for the username and the API token, checks them against `/me/api/json`, and saves them in the GenesisTools
  vault. `--url <url>`, `--user <name>` and `--token <token>` skip their prompts; with all three it runs with no
  prompt and no browser. `--no-open` prints the token page instead of opening it.
- `logout`: forgets the stored login of the default host, or of `--url <url>`.
- `status`: prints the URL, the user Jenkins resolves the credentials to, and their source (environment or vault).

`/me/` is Jenkins' alias for whoever is signed in, so the token page works before the tool knows your username. On a
Jenkins under a context path, the page that `login` opens and prints drops the prefix (see
[Troubleshooting](#troubleshooting)).

### Builds and stages

- `<url>` (no command): smart mode. Parses the URL, fetches the build when it has a build number and a login exists,
  and prints the next commands in priority order (`monitor` for a running build, `rebuild`, `search-logs` and `logs`
  for a failed one, `track` for a master job). Without a login it prints a warning and still suggests commands.
- `stages <job-or-url> [build]`: stage tree with status and duration. `--expand` shows the parallel branches inside
  each stage.
- `compare <job-or-url> <b1> <b2>`: the stage durations of two builds side by side, with the difference and a total.
- `monitor <job-or-url> [build]`: follows the build until it ends. One line per stage result, error and the end, a
  notification per change, and an exit code by result (see [The monitor](#the-monitor)).

  | Flag | Default | Meaning |
  |---|---|---|
  | `--timeout <duration>` | `30m` | Max wait (`30s`, `10m`, `2h`, `1h30m`) |
  | `--poll <duration>` | `5s` | Poll interval |
  | `--no-notify` | | No notifications |
  | `--quiet` | | No output, exit code only |
  | `--detail` | | Every event as JSONL |

  A duration without a unit is minutes: `--poll 5` polls every 5 minutes, and `--timeout 30` waits 30 minutes.
  Write `5s` for seconds. `mcp monitor` reads its durations the same way.

### Logs

- `logs <job-or-url> [build]`: saves the whole log and prints its last 100 lines. `--tail <n>` changes the count,
  `--head <n>` prints the first N lines instead, `--node <id>` fetches one pipeline node's log. A `selected-node` URL
  fetches that node.
- `search-logs <job-or-url> [build]`: saves the log and prints the lines that match `-p, --pattern <regex>` (default
  `ERROR|FAILURE|Exception`) as `L<n>: <line>`. `--node <id>` searches one node.

Both print the saved path first: `saved: $TMPDIR/jenkins-mcp/<slug>-<build>.log (<bytes>B, <lines> lines)`.

### Start and stop builds

- `triggers <job-or-url> [-n, --count <n>]`: POSTs `<job>/build` (no parameters) N times, default 1. Jenkins merges
  identical queue items, so each trigger waits up to 120 s for its queue item to become a build before the next one.
  A refused trigger, a cancelled item or a missing build stops the run with exit code 1, because a further POST would
  merge into it and the count would be wrong. Only the last trigger may end as `queued`. A 302 to a login page counts
  as a refusal: a trigger counts only when Jenkins answers 201 or points at a queue item.
- `rebuild <target> [build-number]`: reruns a build with its own parameters (`buildWithParameters`, or `build` when it
  had none) and waits up to 30 s for the new build number. A URL target must point at a build, and its number is
  the one rerun: `rebuild <url of #42> 40` reruns #42, because the `[build-number]` argument is ignored. A job path
  needs a number or `latest` (`rebuild job/app/job/main 40`). `--dry-run` prints the parameters and triggers
  nothing. `--no-wait` returns once the build is queued. A parameter whose value is null is left out, so Jenkins
  applies its default.
- `stop-range <job-or-url> <from> <to>`: POSTs `stop` to every build from `<from>` to `<to>` and prints the HTTP
  status of each (`(not running?)` for anything but 200 or 302).
- `track <job-or-url> [build-number]`: follows the build to its end, then the downstream builds it triggers, and posts
  one notification with the summary. It exits 1 unless the build and every configured downstream build succeeded. A
  downstream build that is never found counts as a failure. Which jobs are masters, and what they trigger, comes from
  `lib/rest/catalog.ts` (see [Deployment seams](#deployment-seams)); with the empty catalog of this repo, `track`
  follows a single build.

`track` finds a downstream build from `Triggering <job> #<n>` lines in the master's log. Without such a line it takes
a build of the downstream job that started within 5 minutes of the master and names the master as its upstream
cause, from that job's last six builds. It looks up to 10 times (5 s, 10 s, then 20 s apart) and polls each build
with a backoff from 5 s to 60 s, for at most 30 minutes. A build that still runs after 30 minutes counts as not
passed, so `track` exits 1. It stops at once on a certificate failure.

### Capacity and health

- `pods`: agents grouped by template (a Kubernetes agent is named `<template>-<5 chars>`), with online, busy and
  offline counts, then the queue grouped by wait reason with the oldest wait and the task names.
- `executors`: diagnoses a queue backlog. It names the starved label from the queue reasons, lists what holds a
  matching heavyweight executor (longest first, `<-- OVER EST` past the estimate), and flags zombie builds.

  | Flag | Default | Meaning |
  |---|---|---|
  | `--label <label>` | from the queue | Agent label of interest |
  | `--zombie-mins <n>` | `120` | Flag builds running longer than this |
  | `--urls` | | Print the URL of each holder (zombies always get one) |
  | `--no-queue` | | Skip the queue read |

  Jenkins has two kinds of executors. Flyweight executors run a pipeline's Groovy and are effectively unlimited, so
  hundreds of builds can read as "running" while they wait at a `node()` step. Only heavyweight executors (the agents
  that `busy` and `total` count) are scarce, and the waiting requests are the queue. An offline agent adds no idle
  capacity, even though Jenkins still lists its executors as idle.
- `ping`: one GET of `api/json?tree=mode`. Prints `UP <ISO time>` or `DOWN <ISO time> (<reason>)` and always exits
  0, also when no login exists.

### The MCP CLI: `tools jenkins mcp <subcommand>`

The first argument is a job path or a full Jenkins URL. `--build <n>` wins over the number in the URL.

- `stages <input>`: the stage tree from `wfapi/describe`. Needs a build. `--build <n>`, `--expand`.
- `log <input>`: saves the log to `$TMPDIR/jenkins-mcp/` and prints the path, then the parts you ask for:
  `--head <n>`, `--grep <regex>`, `--tail <n>`. The default is the last 20 lines; with `--grep` or `--head` there is
  no tail unless `--tail` is set. `--node <id>` fetches one node. Needs a build: `--build <n>` or the URL.
- `info <input>`: build JSON with parameters, causes (who or what started it), agent, executor and estimated
  duration. `--build <n>` (default `lastBuild`).
- `changes <input>`: the SCM change set (commits and authors) and the causes, as JSON. `--build <n>`.
- `jobs`: one line per job, tab-separated name, color and URL. `--folder <path>` (default the root), `--limit <n>`.
- `monitor <input>`: the same stream as `tools jenkins monitor`, with the same flags. It needs a build number, from
  `--build` or the URL.
- `login [url]`, `logout`, `status`: the same as the top-level commands.

## How it works

### What it calls

Over the network it talks only to Jenkins, with the API token as basic auth. Nothing costs money. On the Mac it
needs a browser for `login`, and it posts notifications through GenesisTools.app or `terminal-notifier` when one is
there, else through `osascript`.

- The JSON API (`api/json` with a `tree` filter) for builds, jobs, the queue and the agents.
- `wfapi/describe` (the Pipeline REST API plugin) for stages. `stages`, `compare`, `monitor`, `get_pipeline_stages`,
  `get_failing_node` and `wait_for_build` need a Pipeline job.
- The Blue Ocean REST API, when the server has it, for the parent of a parallel stage: a stage then reads
  `web-app · Tests` instead of `Tests`. Without Blue Ocean the plain stage names are used.
- `consoleText` for a whole-build log and `execution/node/<id>/log/?consoleFull` for one node's log.

The HTTP client waits 30 s per request. It retries a GET, HEAD or OPTIONS request up to 3 times on a 5xx answer or a
network error (after 250 ms, 500 ms and 1 s). It never retries a POST: a trigger that Jenkins accepted before its
answer was lost would otherwise start the same build twice. A certificate failure is not retried.

The REST backend sends the credentials only to the configured Jenkins: it refuses an absolute URL outside it (a
queue `Location` header, for one). The `mcp` code (the MCP server, `stages`, `monitor`, `logs` and `search-logs`)
builds every request as a path under the configured Jenkins, so it has no such check.

### Where data lives

| What | Where |
|---|---|
| Login (URL, user, token per host) | GenesisTools vault entry `jenkins/credentials` |
| Saved logs | `$TMPDIR/jenkins-mcp/<slug>-<build>[-node<id>].log` |
| "Log is complete" markers | `~/.genesis-tools/jenkins-mcp/cache/<log name>.complete` |
| Request audit log | `$TMPDIR/<local date>-jenkins.log` |
| Tool logs | `~/.genesis-tools/logs/<date>.log` |

The slug is the job path without its `job/` segments: `job/Org/job/app/job/main` becomes `Org-app-main`.

The vault is `~/.genesis-tools/security/vault.json`, encrypted with AES-256-GCM. It holds one entry with every host
in it, so a stored login is self-contained and nothing else needs `JENKINS_URL`. The entry is in
`tools ai config secret export|import` and in the master-key rotation like every other stored credential.

The audit log gets one line per request (UTC time, method, status, latency, URL) for the requests that go through
the REST backend: smart mode's build lookup, `compare`, `triggers`, `stop-range`, `rebuild`, `track`, `pods`,
`executors` and `ping`. `stages`, `monitor`, `logs`, `search-logs`, the `mcp` subcommands and the MCP server use the
client directly, and their requests are not in it. The help of `tools jenkins` prints today's path.

### Logs and the cache

Two endpoints, each chosen because the alternative is broken on stock Jenkins:

- **One node** (`--node`, MCP `nodeId`): `/execution/node/<id>/log/?consoleFull`, one GET. The `wfapi/log` paginator
  returns 10 KB chunks but ignores the `start` parameter on the Jenkins versions tested, so a loop until
  `hasMore=false` appends the same content forever.
- **The whole build**: `/consoleText`, one GET. `progressiveText` is not usable as a cursor: on a running build it
  returned 986 KB of text while `X-Text-Size` reported 3.41 MB (measured 2026-09-23 on a large pipeline build), so
  continuing from `X-Text-Size` silently skipped most of the log.

Before it saves a log, the tool strips the Jenkins timestamp `<span>` wrappers, simple HTML tags (keeping their text,
so URLs survive) and the hidden `ESC[8mha:...` pipeline markers. One node's log (`consoleFull`) also gets its `%XX`
sequences and HTML entities decoded. The whole-build log (`consoleText`) gets no entity step, so a literal `&amp;`
in it stays.

A cached log is reused only when it is complete. `fetchLog` first asks `/api/json?tree=building,result`. It returns
the cached file only when the build is final and the `.complete` marker exists, and a fetch writes that marker only
when the build had already finished before the fetch started. A log saved while the build ran is fetched again once
the build ends. A permalink such as `lastBuild` is resolved to its number first, so the cache never serves an older
build under the alias. A `/tmp` wipe is harmless: a missing log file is fetched again. Measured on a 600 KB node log:
about 300 ms cold, about 50 ms from the cache.

A log is cut at 50 MB of text. The cut log is reported as `truncated` (the `log` line says `TRUNCATED`) instead of
failing, and it gets no `.complete` marker. A `consoleFull` page may take four times that in HTML, because the
timestamp spans are about four times the size of the text; a 13 MB log after stripping is normal.

`--grep`, `search-logs --pattern` and the MCP `grep` take a JavaScript regex and are case-sensitive. A pattern that
is not a valid regex is searched as plain text. They return at most 200 matches.

### The monitor

The default output is one text line per event that carries news, for a reader that treats every line as a message
(the Monitor tool of an agent, a chat):

```text
[start] job/app/job/main #42 https://ci.example.com/job/app/job/main/42/
[snapshot] 3 stage(s) finished before monitoring started
[stage] web-app · Lint: SUCCESS (72s)
[stage] web-app · Tests: FAILED (40s)
[error] web-app · Tests (log line 412): FAILED: 3 of 100 tests
[end] FAILED after 5m 58s
```

In-progress stages and the inner steps are left out; they are most of the lines of a build. `--detail` prints every
event as JSONL instead, about 300 lines for a 6 minute build. Each record has an ISO `ts`. `durationMillis` is
missing on an in-progress transition. `stage` records and the stages of a `snapshot` always carry `label` (the Blue
Ocean label, else the stage name), and a `branch` record carries its stage's label as `stageLabel`. In an `error`
record, `stage` is that label too. Only `path` and `context` depend on Blue Ocean. Each record is one line; the long
records below are wrapped here only. A link is the stage's deep link
(`<build URL>pipeline-overview/?selected-node=<id>`):

```text
{"event":"start","ts":"2026-05-13T10:00:00.000Z","jobPath":"job/app","build":"42",
 "url":"https://ci.example.com/job/app/42/"}
{"event":"snapshot","ts":"2026-05-13T10:00:00.000Z","stages":[{"id":"7","name":"Checkout","status":"SUCCESS",
 "durationMillis":1234,"label":"Checkout"}]}
{"event":"stage","ts":"2026-05-13T10:00:05.000Z","id":"12","name":"Build","status":"IN_PROGRESS","label":"Build",
 "url":"<stage link>"}
{"event":"branch","ts":"2026-05-13T10:00:06.000Z","stage":"Build","stageId":"12","stageLabel":"Build","id":"15",
 "name":"Building libfoo","status":"SUCCESS","durationMillis":7000,"url":"<branch link>"}
{"event":"error","ts":"2026-05-13T10:01:00.000Z","stage":"Tests","stageId":"30","line":412,
 "matched":"FAILED: 3 of 100 tests","window":["...","...","..."]}
{"event":"run","ts":"2026-05-13T10:01:30.000Z","status":"FAILED"}
{"event":"end","ts":"2026-05-13T10:02:00.000Z","result":"FAILED","durationMillis":120000,"via":"wfapi"}
```

- `snapshot` comes once, at the first poll, with the stages that finished before monitoring started. It posts no
  notification.
- `error` comes when a stage fails. The monitor fetches the log of the failing node and extracts up to 5 error
  windows, 5 lines around each match (3 when the log has more than 100 lines). The pattern looks for tool-neutral
  markers such as `FAILED`, `ERROR`, `Exception`, `fatal`, `error TS1234`, `exit code 1`, `npm ERR`, `Caused by` and
  `BUILD FAILED`, case-insensitive.
- `run` comes each time the run status changes.
- `end.result` is `SUCCESS`, `FAILED`, `UNSTABLE`, `ABORTED` or `NOT_EXECUTED`. `via` says which source ended it.
  The `wfapi` run status can stay `IN_PROGRESS` for minutes after every stage finished (common with multibranch
  dispatcher pipelines), so after 3 polls with no change the monitor asks `/api/json`, and ends with
  `"via": "api-json"` when Jenkins says the build is over.
- A failed poll is skipped and tried again at the next interval.

The process exits with the result:

| Result | Exit |
|---|---|
| SUCCESS | 0 |
| FAILED | 1 |
| UNSTABLE | 2 |
| ABORTED | 3 |
| NOT_EXECUTED | 4 |
| `--timeout` exceeded (`end` says `ABORTED`) | 124 |

Notifications:

- They go through the GenesisTools notification chain: GenesisTools.app first, then `terminal-notifier`, then
  `osascript`.
- One notification per stage transition after the first poll, with the stage label and a body such as
  `✓ SUCCESS  27s`. A parallel branch whose name starts with `Building ` (a child build of a multibranch dispatcher)
  gets its own, and the dispatcher stage is marked `orchestration`, because its own duration is only the dispatch.
- The build end gets one more. A failed stage or build plays `Basso`, a successful build plays `Glass`.
- All notifications of one build share the group `jenkins-<jobPath with / as _>-<build>`, so they collapse instead of
  stacking.
- A click opens the stage's deep link (or the build URL) in your default browser. The app and `terminal-notifier`
  store the URL in the notification, so the click still works after the monitor has exited. The `osascript` fallback
  has no click action.

Multibranch sub-build recursion is out of scope: `monitor` shows the parent stage status. Run another `monitor` on a
sub-job to follow it.

### Source layout

```text
src/jenkins/
├── index.ts               # `tools jenkins`: REST commands, smart URL mode, login / logout / status and `mcp`
├── commands/              # one thin file per command; auth.ts (login, setup, logout, status), helpers.ts (job +
│                          #   build resolution), analyze.ts (smart mode), mcp.ts (hands argv to lib/mcp/entry),
│                          #   extra.ts (seam: registerExtraCommands)
├── lib/rest/
│   ├── client.ts          # JenkinsBackend over the shared client, the audit log, refOnInstance (host check)
│   ├── types.ts           # build, pipeline, catalog and smart-mode types of the REST commands
│   ├── catalog.ts         # seam: JOB_CATALOG, SUB_JOB_BY_DISPLAY, PIPELINE_RULES
│   ├── jobs.ts            # job name, type, master and downstream lookups over the catalog
│   ├── wfapi.ts           # wfapi/describe reader, durations, flow-node search and column summaries (no
│   │                      #   command here calls the last two; the tests do)
│   ├── rebuild.ts         # same-parameter rebuild, trigger acceptance, queue resolution
│   ├── track-pipeline.ts  # master + downstream tracking
│   ├── capacity.ts        # pods and executors diagnosis
│   ├── url-analyzer.ts    # smart mode: context + suggested commands
│   └── buildLog.ts        # logs / search-logs onto `mcp log`
└── lib/mcp/
    ├── entry.ts           # any argv goes to cli.ts, none to mcp.ts
    ├── mcp.ts             # MCP server (13 tools)
    ├── cli.ts             # commander CLI (9 subcommands)
    ├── url.ts             # parseJenkinsInput / buildUrl
    ├── client.ts          # axios with TLS (PEM folder, accept flag) and retry of idempotent requests
    ├── credentials.ts     # resolution order, vault object, host keys
    ├── credentialStore.ts # the one vault entry (seam for another secret store)
    ├── login.ts           # login / logout / status and the /me/api/json check
    ├── defaults.ts        # seam: DEFAULT_JENKINS_URL, TOKEN_NAME
    ├── pipeline.ts        # wfapi/describe + findFailingLeaf
    ├── blue-ocean.ts      # parallel-stage parent labels from Blue Ocean
    ├── log.ts             # fetchLog (consoleFull per node, consoleText per build), HTML strip, cache, grep
    ├── storage.ts         # log files in $TMPDIR/jenkins-mcp/, markers in ~/.genesis-tools/jenkins-mcp/cache/
    ├── format.ts          # slug, status icons, stage line, notification body
    ├── errors.ts          # regex-windowed error extraction
    ├── notify.ts          # MonitorNotifier over sendNotification
    └── monitor.ts         # diff engine, summary / JSONL output, exitCodeFor
```

Pure-function modules are unit-tested under `bun:test`. I/O wrappers are smoke-tested against a real Jenkins.

## Configuration

### Credentials

The environment wins: when `JENKINS_URL`, `JENKINS_USER` and `JENKINS_TOKEN` are all set, they are used, which keeps
scripted runs and CI predictable. Otherwise the stored login is used.

- `JENKINS_URL` on its own is config, not a credential. It selects which stored host to use, and it never counts as
  "partly logged in", because a repo `.env` often sets it alone. When it names a host the vault does not hold, the
  tool says so and names the stored hosts instead of using another one.
- `JENKINS_USER` or `JENKINS_TOKEN` without the other is reported as a missing variable (usually a typo), but only
  when the vault holds no login for the selected host. When it holds one, the stored login (with its own user) is
  used and the half-set variable is ignored without a message. `tools jenkins status` shows which source is in use.
- `login` keeps one login per host. The newest login becomes the default host. `logout` without `--url` removes the
  default host, and another stored host becomes the default.
- A token alone is not a login. Jenkins accepts `Authorization: Bearer <token>` with HTTP 200 and resolves it to
  `anonymous`, and the same token with a wrong username answers 401. So `login` and `status` check `/me/api/json` and
  reject a resolved id of `anonymous` instead of trusting the status code.
- When no master key can open the vault (a headless machine), `login` checks the token, saves nothing, and prints the
  three `export` lines to use instead.
- `login` refuses to save when the existing entry cannot be read, so a read error never replaces the other hosts.

| Variable | Meaning |
|---|---|
| `JENKINS_URL` | Base URL; on its own it selects the stored host |
| `JENKINS_USER` | Jenkins username (the login, not the full name) |
| `JENKINS_TOKEN` | API token (`<jenkins>/me/security/`, Add new token) |
| `JENKINS_TLS_ACCEPT_UNAUTHORIZED` | `1`, `true` or `yes` skips certificate checks |

### A Jenkins behind a private certificate authority

A server that sends only its own certificate, without the intermediate, fails verification with
`unable to verify the first certificate`, because bun does not fetch a missing intermediate the way a browser or curl
does. Put the intermediate and root as `.pem` files in `src/jenkins/lib/mcp/` of the GenesisTools checkout: every
`*.pem` there is trusted on top of the public roots, for the REST commands and the MCP server alike. No `.pem` file
means the default behavior. The files are public certificates, but `*.pem` is not git-ignored there, so keep them
out of your commits.

As a last resort, `--tls-accept-unauthorized` (anywhere on the `tools jenkins` line, `mcp` included) or
`JENKINS_TLS_ACCEPT_UNAUTHORIZED=1` skips certificate verification. A warning says so on every run.

### Deployment seams

Three files exist so a deployment can ship its own copy without touching the rest. All are empty or neutral here.

- `lib/rest/catalog.ts`: `JOB_CATALOG` (known jobs with a type, `automatic` and `byTag`), `PIPELINE_RULES`
  (`masters`, `downstream`, `typeHints`) and `SUB_JOB_BY_DISPLAY` (orchestrator display name to job name). Smart mode
  and `track` read the first two; no code reads `SUB_JOB_BY_DISPLAY` yet.
- `commands/extra.ts`: `registerExtraCommands(jenkins)`, called last by `index.ts`, for commands that only make sense
  on one Jenkins. A no-op here.
- `lib/mcp/defaults.ts`: `DEFAULT_JENKINS_URL` (the login prompt's pre-filled URL, none here, because a wrong default
  is worse than an empty prompt) and `TOKEN_NAME` (the token name `login` suggests, `genesis-tools`).

## For agents

### MCP server

```json
{
  "mcpServers": {
    "jenkins": {
      "command": "tools",
      "args": ["jenkins-mcp"]
    }
  }
}
```

`tools jenkins mcp` with no arguments starts the same server. With a stored login no `env` block is needed. For a
machine without one, add
`"env": { "JENKINS_URL": "https://ci.example.com", "JENKINS_USER": "alice", "JENKINS_TOKEN": "..." }`.

The server starts without credentials and resolves them on the first tool call. `tools/list` works, and a
`tools/call` without a login answers JSON-RPC `-32600` (InvalidRequest) with the login instructions. Exiting at
startup instead would show the assistant only "server failed to connect".

Every `jobPath` also accepts a full Jenkins URL; the build number and `selected-node` come from it, and explicit
arguments win. `buildNumber` is a string (`"42"` or `"lastBuild"`). `get_build_status`, `get_build_log`,
`get_build_info` and `get_build_changes` default to `lastBuild`. `get_pipeline_stages`, `get_failing_node`,
`wait_for_build` and `stop_build` need a build, from `buildNumber` or the URL.

The 13 tools:

- `get_build_status`: `building`, `result`, `timestamp`, `duration`, `url`.
- `trigger_build`: POSTs `build`, or `buildWithParameters` when `parameters` (an object) is given.
- `get_build_log`: `{path, sizeBytes, lineCount, nodeStatus?, truncated}`. `grep` adds `matches` (`L<n>: <text>`, at
  most 200). `nodeId` fetches one node.
- `list_jobs`: the jobs of `folderPath` (default the root). `limit`.
- `get_build_history`: the last `limit` builds (default 10). `expand` (default true) adds the display name, causes,
  parameters, branch, SCM revision and estimated duration.
- `stop_build`: POSTs `<build>/stop`. `buildNumber` is required.
- `get_queue`: the queue. `limit`.
- `get_job_config`: selected fields of the job's `api/json`.
- `get_pipeline_stages`: `wfapi/describe`. `expand` adds the parallel branches.
- `get_failing_node`: the first failed stage, its innermost failed node, the log path and the error windows.
- `get_build_info`: parameters, causes, `builtOn` (agent), executor and estimated duration.
- `get_build_changes`: the SCM change set and the causes.
- `wait_for_build`: `status` and `stageSummary` (a stage snapshot). For a running build only, it adds
  `suggestCommand` (a `tools jenkins mcp monitor ...` command to run in the background), `runOptions`, `emitsEvents`
  and `monitorFilterExamples`. A finished build gets no command. It does not poll.

The log bytes never enter a response; read the saved file, or pass `grep`. `get_failing_node` is the one-call
"what failed and why".

`trigger_build` and `stop_build` do not check Jenkins' answer: they report success for any status below 500. When you
need proof that a build was queued, use `tools jenkins triggers` or `tools jenkins rebuild`, which wait for the build
number.

### Waiting for a build

Run `tools jenkins monitor <url>` in the background, or hand it to a Monitor tool: every stdout line is one event.
For a single notification at the end, add `--detail` and filter the end record:

```bash
tools jenkins monitor job/app/job/main 42 --detail | grep -E --line-buffered '"event":"end"'
```

The exit code tells the result without parsing anything (0 success, 1 failed, 2 unstable, 3 aborted, 4 not
executed, 124 timeout).

### Output and exit codes

There is no `--json` flag. `mcp info` and `mcp changes` print JSON, `monitor --detail` prints JSONL, and the other
commands print text. Any thrown error exits 1. `track` exits 1 unless the whole pipeline passed, also when a build
still runs after its 30 minutes. `triggers` exits 1 when it stops early, `login` and `status` exit 1 on failure,
and `ping` always exits 0. `compare` prints `#<n>: not found` and exits 0 when Jenkins has no `wfapi/describe` for
a build (HTTP 404).

## Troubleshooting

- **A command fails and the message says little**: add `-v` (`tools jenkins -v <command> ...`). It prints
  the debug logs, such as each retry of a request and the stack of a thrown error.
- **"Jenkins credentials are not set up (...)"**: run `tools jenkins login`, or export all three `JENKINS_*`
  variables. The text in parentheses names what was missing and which hosts the vault holds.
  `tools ai config secret ls jenkins` shows whether the vault entry exists.
- **`unable to verify the first certificate`**: the server sends no intermediate certificate. Add the `.pem` files
  (see [A Jenkins behind a private certificate authority](#a-jenkins-behind-a-private-certificate-authority)).
- **"That token authenticated as anonymous"** or **HTTP 401 at login**: the username is wrong or empty. Use the
  Jenkins login name, not the full name.
- **"<url> is not on the configured Jenkins"**: the URL belongs to another host than the one in use. Set
  `JENKINS_URL` to the stored host you want, or log in to that host.
- **`Could not resolve build latest of <job> (HTTP 404)`**: `latest` is a word of `rebuild` and `track` only. Smart
  mode prints `latest` in every suggestion when the URL has no build number; for `monitor`, `stages`, `logs` and
  `search-logs`, replace it with `lastBuild`.
- **`monitor` shows nothing for minutes**: the default output skips in-progress stages. Add `--detail` to see every
  event. A run that `wfapi` never marks finished ends through the `/api/json` check after 3 quiet polls.
- **`triggers` stops with "stopping so the next request is not merged into it"**: the queue item did not become a
  build within 120 s (often a full queue; see `tools jenkins executors`), was cancelled, or Jenkins gave no queue
  location.
- **"build may have been pruned by retention"**: Jenkins deleted that build's log.
- **A URL fails on a Jenkins under a context path** (`https://ci.example.com/jenkins/`) in `logs`, `search-logs`,
  smart mode, the `mcp` subcommands or the MCP tools: these read only the URL path, so the context path is sent
  twice. Pass the job path (`job/app/job/main`) and the build number instead. The other REST commands drop the
  context path themselves.
- **`login` opens a page that Jenkins does not have**, on a Jenkins under a context path: the token page is built
  from the server's origin, so for `https://ci.example.com/jenkins` it opens and prints
  `https://ci.example.com/me/security/`. Open `https://ci.example.com/jenkins/me/security/` by hand (add
  `--no-open` to skip the browser), then paste the username and the token as usual.
- **`tools jenkins mcp` with no argument seems to hang**: it is the MCP server, waiting for JSON-RPC on stdin. Add a
  subcommand for the CLI.
- **A notification click does nothing**: the `osascript` fallback has no click action. Install GenesisTools.app or
  `terminal-notifier`.

## Related

- [`tools jenkins-mcp`](../jenkins-mcp/README.md): the older entry of the same MCP server and CLI.
- [`tools ai`](../ai/README.md): `tools ai config secret` manages the vault that holds the login.
- [`tools notify`](../notify/README.md): the notification front end over the same macOS backends the monitor uses.
