# Jenkins MCP

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)
![Type](https://img.shields.io/badge/Type-MCP%20Server-purple?style=flat-square)

> **Model Context Protocol server exposing Jenkins build info, logs, and triggers.**

An MCP server that lets an AI assistant inspect Jenkins: list jobs, trigger builds, read build logs, watch the queue, and stop runaway builds. Talks to Jenkins via its HTTP API with a user + token.

---

## Quick Start

This is an MCP server — you normally wire it into your assistant's config rather than invoking it directly. See "Configuration" below for a Claude Desktop / Cursor snippet.

```bash
# Run standalone (stdin/stdout MCP transport) — for debugging
JENKINS_URL=https://jenkins.example.com \
JENKINS_USER=myuser \
JENKINS_TOKEN=xxxxxxxxxxxx \
tools jenkins-mcp
```

---

## Environment Variables

All three are required at startup — the server refuses to run without them.

| Var | Description |
|-----|-------------|
| `JENKINS_URL` | Base URL of your Jenkins instance |
| `JENKINS_USER` | Jenkins username |
| `JENKINS_TOKEN` | Jenkins API token (Manage Jenkins -> Users -> API Token) |

---

## Tools (exposed over MCP)

| Tool | Args | What it does |
|------|------|--------------|
| `get_build_status` | `jobPath`, `buildNumber?` | Current status of a build (building/result/timestamp/duration) |
| `trigger_build` | `jobPath`, `parameters?` | Trigger a build, optionally with parameters |
| `get_build_log` | `jobPath`, `buildNumber` | Fetch raw build log text |
| `list_jobs` | `folderPath?` | List jobs at root or inside a folder |
| `get_build_history` | `jobPath`, `limit?` | Last N builds for a job |
| `stop_build` | `jobPath`, `buildNumber` | Abort a running build |
| `get_queue` | — | List queued items with stuck flags |

---

## Configuration

Claude Desktop / Cursor MCP config snippet:

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

## Notes

- Uses `axios` with basic auth (`JENKINS_USER:JENKINS_TOKEN`).
- Job paths are Jenkins job URLs with `/` separators for folder nesting (e.g. `folder/subfolder/my-job`).
- The server logs missing-env errors to stderr and exits non-zero — check the calling assistant's MCP logs if it never starts.
