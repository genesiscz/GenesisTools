# tools jenkins-mcp

`tools jenkins-mcp` is the older name of `tools jenkins mcp`: with no arguments it serves the Jenkins MCP server over
stdio, and with a subcommand it is a small Jenkins CLI. The name stays so that MCP configs that launch it keep
working. The code and the full manual live in [`src/jenkins`](../jenkins/README.md).

## Quick start

```bash
tools jenkins-mcp login                                                 # store an API token once
tools jenkins-mcp stages "https://ci.example.com/job/app/job/main/42/"  # status and duration per stage
tools jenkins-mcp log job/app/job/main --build 42 --grep 'ERROR|FAILED' # save the log, print L<n> matches
tools jenkins-mcp monitor job/app/job/main --build 42                   # a line and a notification per stage
tools jenkins-mcp status                                                # which login is in use, and who it is
tools jenkins-mcp                                                       # the MCP server on stdio (for MCP configs)
```

Every subcommand also runs as `tools jenkins mcp <subcommand>`; the two help texts are the same, and both print the
name `tools jenkins mcp`. For smart URL mode, rebuilds, pipeline tracking and queue diagnosis, use
[`tools jenkins`](../jenkins/README.md).

## Commands

### Targets: a job path or a URL

The `<input>` argument is a job path (`job/app/job/main`) or a full Jenkins URL.

- From a URL the tool takes the job path, the build number and `?selected-node=<id>`. It drops a trailing page
  (`console`, `consoleText`, `consoleFull`, `pipeline-overview`, `changes`, `testReport`, `wfapi`, `api`,
  `execution`) and a `view/<name>/` filter between two jobs.
- `--build <n>` and `--node <id>` win over the values in the URL.
- Only the path of the URL is used. The host is not checked: requests go to the Jenkins you logged in to.
- `stages`, `log` and `monitor` need a build, from `--build` or the URL. `info` and `changes` default to
  `lastBuild`.
- `log` resolves a permalink such as `--build lastBuild` to its number before it saves the file. `monitor` polls the
  value you give, so give it a number.

### The MCP server

```bash
tools jenkins-mcp                              # serve MCP on stdin and stdout
tools jenkins-mcp --tls-accept-unauthorized    # the same, without certificate checks
```

With no subcommand the process waits for JSON-RPC on stdin, so in a terminal it seems to hang. An MCP client starts
it. The flag `--tls-accept-unauthorized` is taken off the command line first, so it alone still starts the server.
The tools the server offers are in [For agents](#for-agents).

### Builds, stages and jobs

- `stages <input>`: the stage tree from `wfapi/describe`. One line per stage with its status and duration, or how
  long it has run so far. `--build <n>`. `--expand` adds the parallel branches inside each stage.
- `info <input>`: build JSON: number, result, building, duration, timestamp, agent (`builtOn`), executor, estimated
  duration, parameters and causes (who or what started the build). `--build <n>` (default `lastBuild`).
- `changes <input>`: the SCM change set (commit id, author, message, time) and the causes, as JSON. `--build <n>`
  (default `lastBuild`).
- `jobs`: one line per job, with the name, the color and the URL separated by tabs. `--folder <path>`
  (`job/Foo/job/Bar`, default the root). `--limit <n>`.

### Logs

`log <input>` saves the whole build log, or one pipeline node's log, to `$TMPDIR/jenkins-mcp/`. Then it prints the
parts you ask for.

- `--build <n>`: the build, if the URL has none.
- `--node <id>`: one node only (the `selected-node` id of a pipeline URL).
- `--head <n>`: the first N lines.
- `--grep <pattern>`: the lines that match a regex, as `L<n>: <line>`, at most 200.
- `--tail <n>`: the last N lines. The default is 20. When `--grep` or `--head` is set, there is no tail unless you
  set `--tail`.

The first line is always the saved path (the real line shows the absolute path):

```text
saved: $TMPDIR/jenkins-mcp/app-main-42.log (183402B, 2411 lines)
--- tail (20) ---
...
```

The `saved:` line adds `status=<status>` for a node log fetched now (a log reused from the cache has none) and `TRUNCATED` for a log cut at 50 MB. The sections come in
the order head, grep, tail.

### Monitor a build

`monitor <input>` polls the build until it ends. It prints one line per stage result, error and the end, posts a
notification for each change, and exits with a code that tells the result.

```bash
tools jenkins-mcp monitor "https://ci.example.com/job/app/job/main/42/"
tools jenkins-mcp monitor job/app/job/main \
    --build 42 \
    --timeout 2h \
    --detail \
    --no-notify
```

| Flag | Default | Meaning |
|---|---|---|
| `--build <n>` | the URL | Build number |
| `--timeout <duration>` | `30m` | Maximum wait (`30s`, `10m`, `2h`, `1h30m`) |
| `--poll <duration>` | `5s` | Poll interval |
| `--no-notify` | notify | No notifications |
| `--quiet` | off | No output, exit code only |
| `--detail` | off | Every event as JSONL |

The default output leaves out in-progress stages and inner steps, which are most of the lines of a build:

```text
[start] job/app/job/main #42 https://ci.example.com/job/app/job/main/42/
[snapshot] 3 stage(s) finished before monitoring started
[stage] web-app · Lint: SUCCESS (72s)
[stage] web-app · Tests: FAILED (40s)
[error] web-app · Tests (log line 412): FAILED: 3 of 100 tests
[end] FAILED after 5m 58s
```

`--detail` prints every event as one JSON line, in-progress stages and inner steps included: about 300 lines for a
6 minute build. Exit codes: 0 success, 1 failed, 2 unstable, 3 aborted, 4 not executed, 124 timeout. On a timeout
the end record and the `[end]` line say `ABORTED` and have no `via` field, so use the exit code (124) to tell a
timeout from a real abort.

`wfapi` can report a run as in progress for minutes after its last stage ended. After 3 polls with no change, the
monitor asks `/api/json` for the real state.

### Log in

- `login [url]`: asks for the Jenkins URL, opens `<jenkins>/me/security/` so you can create an API token, asks for
  the username and the token, checks them, and stores them. Any page of the Jenkins works as the URL, and a URL
  without a scheme gets `https://`.
  - `--url <url>`, `--user <name>` and `--token <token>` skip their prompts. With all three, nothing is asked and no
    browser opens.
  - `--no-open` prints the token page URL instead of opening a browser.
- `logout`: removes the stored login of the default host. `--url <url>` names another host. It prints
  `Nothing stored.` when there is nothing to remove.
- `status`: prints the URL, the user (full name and id) and the source (environment variables or the GenesisTools
  vault). It exits 1 when no login works.

## How it works

### What it calls

It talks only to Jenkins, with the username and API token as basic auth. Nothing costs money.

- The JSON API (`api/json`, with a `tree` filter where only some fields are needed) for builds, jobs and the queue.
- `wfapi/describe` (the Pipeline REST API plugin) for stages. `stages`, `monitor`, `get_pipeline_stages`,
  `get_failing_node` and `wait_for_build` need a Pipeline job.
- The Blue Ocean REST API, when the server has it, for the parent of a parallel stage. A stage then reads
  `web-app · Tests` instead of `Tests`. Without Blue Ocean the plain stage names are used.
- `consoleText` for a whole-build log, and `execution/node/<id>/log/?consoleFull` for one node's log.

Each request waits up to 30 s. A GET, HEAD or OPTIONS request is retried up to 3 times on a 5xx answer or a network
error (after 250 ms, 500 ms and 1 s). A POST is never retried, so a trigger is never sent twice. A certificate
failure is not retried.

`monitor` posts its notifications through GenesisTools.app, then `terminal-notifier`, then `osascript`, whichever
answers first. With the first two, a click opens the build or the stage, also after the monitor has exited. A
failed stage plays Basso; the end plays Glass on success and Basso otherwise.

### Where data lives

- Login (URL, user and token per host): the GenesisTools vault entry `jenkins/credentials`, in
  `~/.genesis-tools/security/vault.json` (AES-256-GCM). One entry holds every host. Like every other stored
  credential, it moves with `tools ai config secret export|import` and is re-encrypted by `rotate`.
- Saved logs: `$TMPDIR/jenkins-mcp/<slug>-<build>.log`, or `<slug>-<build>-node<id>.log` for one node.
- "Log is complete" markers: `~/.genesis-tools/jenkins-mcp/cache/<log name>.complete`.
- Tool logs: `~/.genesis-tools/logs/<date>.log`.
- Failed runs: `~/.genesis-tools/logs/<date>-failures.jsonl`, under the tool name `jenkins-mcp`
  (`tools genesis-tools logs failures`).

The slug is the job path without its `job/` segments: `job/Org/job/app/job/main` becomes `Org-app-main`.

### The log cache

- A saved log is reused only when the build had already finished before the fetch that saved it. Only such a fetch
  writes the `.complete` marker, so a log saved while the build ran is fetched again once the build ends.
- A permalink such as `lastBuild` is resolved to its number first, so the cache never answers with an older build.
- A missing log file (after the temp folder was cleared) is fetched again. A marker without its log does no harm.
- A log is cut at 50 MB of text. It is reported as truncated (`TRUNCATED`, MCP `truncated: true`) and gets no marker.
- Before it saves a log, the tool strips the Jenkins timestamp spans, simple HTML tags (it keeps their text, so URLs
  survive) and the hidden `ESC[8mha:...` pipeline markers. A node log is also URL-decoded, and its HTML entities
  (`&lt;`, `&amp;`, ...) are decoded to characters.
- `--grep` and the MCP `grep` take a JavaScript regex and are case-sensitive. A pattern that is not a valid regex is
  searched as plain text.

The endpoint choices and their measurements are in the [`tools jenkins`](../jenkins/README.md) manual.

## Configuration

### Credentials

The environment wins. When `JENKINS_URL`, `JENKINS_USER` and `JENKINS_TOKEN` are all set, they are used. Otherwise
the stored login is used: the host in `JENKINS_URL` when that is set, else the default host.

- `JENKINS_URL` alone only selects a stored host. When the vault has no login for that host, the error names the
  hosts it holds. It never falls back to another host.
- `JENKINS_USER` or `JENKINS_TOKEN` without the other is ignored when the vault holds a login for the host. Without a
  stored login it is an error that names the missing variable. `status` shows which source is in use.
- The newest `login` becomes the default host. `logout` without `--url` removes the default host, and another stored
  host becomes the default.
- `login` and `status` check `/me/api/json` and refuse a token that resolves to `anonymous`.
- When no master key can open the vault (a headless machine), `login` checks the token, saves nothing, prints the
  three `export` lines to use instead, and exits 1.
- `login` refuses to save when it cannot read the existing entry, so a read error never drops the other hosts.

| Variable | Meaning |
|---|---|
| `JENKINS_URL` | Base URL; alone it selects a stored host |
| `JENKINS_USER` | Jenkins username (the login name, not the full name) |
| `JENKINS_TOKEN` | API token from `<jenkins>/me/security/` |
| `JENKINS_TLS_ACCEPT_UNAUTHORIZED` | `1`, `true` or `yes` skips certificate checks |

### A Jenkins behind a private certificate authority

Bun does not fetch a missing intermediate certificate the way a browser or curl does. A server that sends only its
own certificate fails with `unable to verify the first certificate`. Put the intermediate and the root as `.pem`
files in `src/jenkins/lib/mcp/` of the GenesisTools checkout: every `*.pem` file there is trusted on top of the
public roots. The files are public certificates, but `*.pem` is not git-ignored there, so keep them out of your
commits.

As a last resort, `--tls-accept-unauthorized` (anywhere on the command line) or `JENKINS_TLS_ACCEPT_UNAUTHORIZED=1`
turns certificate verification off. The tool logs a warning on every run when it is off.

### Deployment seam

`src/jenkins/lib/mcp/defaults.ts` holds two values that a deployment can replace with its own copy of the file:

- `DEFAULT_JENKINS_URL`: the URL the login prompt shows first. It is empty here, because a wrong default is worse
  than an empty prompt.
- `TOKEN_NAME`: the token name `login` suggests, `genesis-tools`.

## For agents

### MCP config

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

`"args": ["jenkins", "mcp"]` starts the same server. With a stored login no `env` block is needed. On a machine
without one, add `"env": { "JENKINS_URL": "https://ci.example.com", "JENKINS_USER": "alice", "JENKINS_TOKEN": "..." }`.

The server starts without credentials and resolves them on the first tool call. `tools/list` works without a login.
A `tools/call` without one answers JSON-RPC `-32600` (InvalidRequest) with the login instructions, because a server
that exited at startup would show only "failed to connect". After such a failed call, a `login` in another terminal
takes effect on the next call, without a restart. Once a call has found a login, the server keeps it until it
restarts.

### MCP tools

Every `jobPath` also takes a full Jenkins URL. The build number and `selected-node` come from it, and explicit
arguments win. `buildNumber` is a string (`"42"` or `"lastBuild"`).

`get_pipeline_stages`, `get_failing_node` and `wait_for_build` need a build number (argument or URL).
`get_build_status`, `get_build_log`, `get_build_info` and `get_build_changes` use `lastBuild` by default.

- `get_build_status`: `building`, `result`, `timestamp`, `duration` and `url`. `buildNumber` (default `lastBuild`).
- `get_build_info`: parameters, causes, `builtOn` (agent), executor and estimated duration.
- `get_build_changes`: the SCM change set (commits, authors, affected paths) and the causes.
- `get_build_history`: the last `limit` builds (default 10). `expand` (default true) adds the display name, causes,
  parameters, branch, SCM revision and estimated duration.
- `get_build_log`: `{path, sizeBytes, lineCount, nodeStatus, truncated}`. `nodeId` fetches one node. `grep` adds
  `matches` (`L<n>: <text>`, at most 200). The log text itself never enters the response: read the saved file, or
  pass `grep`.
- `get_pipeline_stages`: the `wfapi/describe` stage tree. `expand` adds the parallel branches. It answers "what is
  `?selected-node=N`?".
- `get_failing_node`: the failed stage, its innermost failed node, the log path and the error windows found in that
  log. This is the one call for "what failed and why".
- `wait_for_build`: a stage snapshot. For a running build it adds a command to run in the background,
  `tools jenkins mcp monitor "<job>" --build <n> --timeout 30m`, and the events that command prints. It does not
  poll.
- `list_jobs`: the jobs of `folderPath` (default the root). `limit`.
- `get_queue`: the build queue, with the reason each item waits. `limit`.
- `get_job_config`: selected fields of the job's `api/json` (SCM, triggers, upstream and downstream jobs, the last
  builds). It does not read `config.xml`.
- `trigger_build`: POSTs `build`, or `buildWithParameters` when `parameters` (an object) is given.
- `stop_build`: POSTs `<build>/stop`. `buildNumber` is required.

`trigger_build` and `stop_build` do not check the answer of Jenkins: any status below 500 reports success. When you
need proof that a build was queued, use `tools jenkins triggers` or `tools jenkins rebuild`, which wait for the build
number.

### Waiting for a build

Run `tools jenkins-mcp monitor <url>` in the background, or give it to a Monitor tool: every stdout line is one
event. For one notification at the end only, add `--detail` and filter the end record:

```bash
tools jenkins-mcp monitor job/app/job/main --build 42 --detail | grep -E --line-buffered '"event":"end"'
```

The exit code tells the result without any parsing (see [Monitor a build](#monitor-a-build)).

### Output and exit codes

There is no `--json` flag. `info` and `changes` print JSON, `monitor --detail` prints JSONL, `jobs` prints
tab-separated lines, and the other commands print text. Missing credentials exit 1 with the setup message, and any
other thrown error exits 1 too. `login` and `status` exit 1 on failure. `logout` exits 0, also when nothing was
stored.

## Troubleshooting

- **`tools jenkins-mcp` with no argument seems to hang**: it is the MCP server, waiting for JSON-RPC on stdin. Add a
  subcommand for the CLI.
- **"Jenkins credentials are not set up (...)"**: run `tools jenkins-mcp login`, or export all three `JENKINS_*`
  variables. The text in parentheses names what is missing and which hosts the vault holds.
  `tools ai config secret ls jenkins` shows whether the vault entry exists.
- **"That token authenticated as anonymous"** or **"Jenkins rejected that username and token (HTTP 401)"**: the
  username and the token do not belong together. Use the Jenkins login name, not the full name, and a token created
  while signed in as that user.
- **`unable to verify the first certificate`**: the server sends no intermediate certificate. Add the `.pem` files
  (see [A Jenkins behind a private certificate authority](#a-jenkins-behind-a-private-certificate-authority)).
- **"Need --build or URL with build number"**: `stages`, `log` and `monitor` need a build. Pass `--build <n>` or a
  URL that ends in `/<build>/`.
- **"Build N pipeline data not found (queued, never started, or pruned?)"**: `wfapi/describe` answered 404. The build
  is still queued, Jenkins deleted it, or the job is not a Pipeline job.
- **A URL fails on a Jenkins under a context path** (`https://ci.example.com/jenkins/`): the tool reads only the path
  of a URL, so it sends the context path twice. Pass the job path (`job/app/job/main`) and `--build` instead.
- **`monitor` shows nothing for minutes**: the default output skips in-progress stages. Add `--detail` to see every
  event.
- **`monitor` prints only `[start]` and ends after the timeout with exit 124**: it cannot read the stage data (a wrong
  job path or build number, a build that is still queued, or a rejected login) and keeps polling without an error
  message. Run `tools jenkins-mcp stages <same input>` to see the error.
- **A notification click does nothing**: the `osascript` fallback has no click action. Install GenesisTools.app or
  `terminal-notifier`.
- **`tools jenkins-mcp --readme` does not print this page**: this entry has its own small CLI, and its `--help`
  lists no `--readme` flag. Run `tools jenkins --readme` for the full manual.

## Related

- [`tools jenkins`](../jenkins/README.md): the full manual, the REST commands (smart URL mode, `compare`, `rebuild`,
  `triggers`, `track`, `executors`) and the source layout of this server.
- [`tools ai`](../ai/README.md): `tools ai config secret` manages the vault that holds the login.
- [`tools notify`](../notify/README.md): the notification front end over the same macOS backends the monitor uses.
- [`tools genesis-tools`](../genesis-tools/README.md): `logs failures` reads the failed runs of this tool.
