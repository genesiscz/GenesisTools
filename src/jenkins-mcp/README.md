# Jenkins MCP

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)
![Type](https://img.shields.io/badge/Type-MCP%20Server%20%2B%20CLI-purple?style=flat-square)

> **Model Context Protocol server + CLI for Jenkins — daily ops without the token blowup.**

Inspect Jenkins from an AI assistant (MCP) *or* from your shell (CLI). Same backing library either way. Token-efficient: logs spill to `/tmp/jenkins-mcp/`, the MCP response is just a path + summary.

---

## Quick Start

```bash
# Required env vars (set once)
export JENKINS_URL=https://jenkins.example.com
export JENKINS_USER=myuser
export JENKINS_TOKEN=xxxxxxxxxxxx

# CLI: paste any Jenkins URL — buildNumber and selected-node are auto-extracted
tools jenkins-mcp stages "https://jenkins.example.com/job/X/job/Y/123/pipeline-overview/?selected-node=41"
tools jenkins-mcp log    "https://jenkins.example.com/job/X/job/Y/123/" --node 41
tools jenkins-mcp info   "https://jenkins.example.com/job/X/job/Y/123/"

# Background a live monitor — JSONL stream + click-to-Brave notifications
tools jenkins-mcp monitor "https://.../job/X/123/" --timeout 30m | tee /tmp/build.jsonl
```

Without args (no CLI subcommand), the binary launches as a stdio MCP server — that's what your assistant config uses.

---

## CLI Subcommands

`tools jenkins-mcp <subcommand>` — the first positional arg is a job path OR a full Jenkins URL. URLs auto-parse `buildNumber` and `selected-node`. Explicit flags win over URL contents.

| Subcommand | Flags | Behavior |
|---|---|---|
| `stages <input>` | `--build`, `--expand` | Stage tree (`wfapi/describe`). `--expand` drills into parallel branches. |
| `log <input>` | `--build`, `--node`, `--tail`, `--head`, `--grep` | Save full log to `/tmp/jenkins-mcp/<slug>-<build>[-node<id>].log` after stripping HTML timestamp wrappers. Print path + preview. |
| `info <input>` | `--build` | Build params, causes (who/what triggered), agent, executor, estimated duration. |
| `changes <input>` | `--build` | SCM changeSet (commits/authors) + trigger causes. |
| `jobs` | `--folder`, `--limit` | List jobs in a folder. |
| `monitor <input>` | `--build` (req), `--timeout`, `--poll`, `--no-notify`, `--quiet` | Live JSONL stage events to stdout + DarwinKit notifications. Click any notification to open the build URL (or the stage's deep-link) in Brave. |

### `monitor` JSONL schema

One JSON object per line. Schema shorthand below (`?` = optional, `// ...` = comment) — actual stream is valid JSON:

```text
{event: "start",    jobPath, build, url}
{event: "snapshot", stages: [{id, name, status, durationMillis}]}        // historical state on first poll (no notifications fired)
{event: "stage",    id, name, status, durationMillis?, url}              // each transition
{event: "branch",   stage, stageId, id, name, status, durationMillis?, url}
{event: "error",    stage, stageId, line, matched, window: [...]}        // ±5 / ±3 line windows around errors after a FAILED stage
{event: "end",      result, durationMillis}                              // SUCCESS / FAILED / UNSTABLE / ABORTED / NOT_EXECUTED
```

Process exits with the result mapped to a code:

| Result | Exit |
|---|---|
| SUCCESS | 0 |
| FAILED | 1 |
| UNSTABLE | 2 |
| ABORTED | 3 |
| NOT_EXECUTED | 4 |
| timeout (`--timeout` exceeded) | 124 |

### `monitor` notifications

- Backed by `@app/utils/macos/notifications.sendNotification` → DarwinKit (native `UNUserNotificationCenter`), ~92ms per call. Falls back to `terminal-notifier` then `osascript` if DarwinKit is unavailable.
- One notification per stage transition (not for historical snapshot). Subtitle = stage name. Body = `✓ SUCCESS  27s` style with duration.
- `thread_identifier` is `jenkins-<jobPath>-<build>` so stage notifications for one build collapse instead of stacking.
- Click handler routes through `Browser.open(url, { browser: "brave" })` — opens the stage's deep-linked URL in Brave (or your preferred browser via `Browser.setPreferred()`).

---

## MCP Tools

| Tool | Behavior |
|---|---|
| `get_build_status` | `building` / `result` / `timestamp` / `duration` / `url` |
| `trigger_build` | POST `/build` or `/buildWithParameters` |
| `get_build_log` | **Saves to `/tmp/jenkins-mcp/`**, returns `{path, sizeBytes, lineCount, nodeStatus?, truncated, preview: {first, last, grepMatches?}}`. Pass `nodeId` for a single-node log. |
| `list_jobs` | Folder listing. Supports `limit`. |
| `get_build_history` | Last N builds (`limit`, default 10). |
| `stop_build` | POST `/<build>/stop` |
| `get_queue` | Current queue (supports `limit`). |
| `get_job_config` | Selected fields from the job's `api/json`. |
| `get_pipeline_stages` | `wfapi/describe`, optional `expand` for parallel branches. |
| `get_failing_node` | Finds first FAILED stage + innermost failing node, fetches its log, runs regex error extraction. One-shot "what failed and why". |
| `get_build_info` | params / causes / `builtOn` (agent) / executor / estimated duration. |
| `get_build_changes` | SCM `changeSet[items[*]]` + causes. |
| `wait_for_build` | Snapshots current state + emits a `tools jenkins-mcp monitor ...` command via `suggestCommand`. Does NOT poll; routes the LLM to the CLI for backgrounded waiting. |

Every tool that takes a `jobPath` also accepts a full Jenkins URL — the build number and `selected-node` are auto-extracted (explicit args win over URL).

---

## Environment Variables

| Var | Description |
|---|---|
| `JENKINS_URL` | Base URL of your Jenkins instance |
| `JENKINS_USER` | Jenkins username |
| `JENKINS_TOKEN` | Jenkins API token (Manage Jenkins → Users → API Token) |

All required at startup. MCP server exits non-zero with a clear error if any are missing.

---

## Configuration (Claude Desktop / Cursor)

```json
{
  "mcpServers": {
    "jenkins": {
      "command": "tools",
      "args": ["jenkins-mcp"],
      "env": {
        "JENKINS_URL": "https://jenkins.example.com",
        "JENKINS_USER": "myuser",
        "JENKINS_TOKEN": "xxxxxxxxxxxx"
      }
    }
  }
}
```

---

## URL Parsing

`parseJenkinsInput()` accepts any of:

```text
job/Org/job/Project/job/Team/job/my-build                                   → { jobPath }
/job/Org/.../my-build/123/                                                  → { jobPath, buildNumber: "123" }
https://j.example/job/.../123/pipeline-overview/?selected-node=41           → { jobPath, buildNumber, nodeId: "41" }
https://j.example/job/X/job/Y/view/change-requests/job/PR-42/6/             → { jobPath: "job/X/job/Y/job/PR-42", buildNumber: "6" }
```

Strips trailing `pipeline-overview`, `console`, `consoleText`, `wfapi`, etc. Strips `view/<name>/` filters from multibranch URLs.

---

## Architecture

```text
src/jenkins-mcp/
├── index.ts          # router: any argv → cli.ts, else → mcp.ts
├── mcp.ts            # MCP server (13 tools)
├── cli.ts            # commander CLI (6 subcommands)
└── lib/
    ├── url.ts        # parseJenkinsInput / buildUrl
    ├── client.ts     # axios with retry (3 attempts, exp backoff on 5xx/net)
    ├── pipeline.ts   # wfapi/describe + findFailingLeaf
    ├── log.ts        # progressiveText + wfapi/log + HTML strip + /tmp save
    ├── format.ts     # slug / status icons / stage line / notify body
    ├── errors.ts     # regex-windowed error extraction (±5 / ±3 lines)
    ├── notify.ts     # MonitorNotifier — sendNotification + click-to-default-browser
    └── monitor.ts    # diff engine + JSONL emitter + exitCodeFor
```

Pure-function modules are unit-tested under `bun:test`. I/O wrappers are smoke-tested against real Jenkins.

---

## Notes

- Logs cap at 50MB raw before HTML strip (a 13MB stripped log is normal — timestamp spans are ~4× the content size).
- If a build has been pruned by Jenkins retention, the MCP returns a clear "build may have been pruned" error.
- Multibranch sub-build recursion is out of scope — `monitor` shows the parent stage status; drill into sub-jobs with their own `monitor` invocation if needed.
- Notification clicks open in Brave by default. Configure via `Browser.setPreferred("safari")` (or chrome/firefox/edge/arc) in `~/.genesis-tools/genesis-tools/config.json`.
