# Optional MCPs for `gt:research`

This skill dispatches research subagents with explicit MCP preferences. None of these are required — the skill degrades gracefully and reports the gap. Use this reference when the skill offers to help the user install one.

## Detection

Check whether an MCP is available in the current session by looking at the system reminder listing `mcp__<server>__<tool>` tools, or by attempting a no-op call. Do NOT ask the user "is X installed?" — verify yourself.

## Install offer protocol

When the skill decides an MCP would materially improve a research run and it's missing, it MUST:

1. Tell the user **what the MCP adds** to this run, in one sentence ("brave-search would let me cross-check facts against a second search index").
2. Offer install via `AskUserQuestion` with three choices:
   - **Install now** (recommended) — show the install command and config snippet, then continue once they confirm install.
   - **Skip** — proceed without it, note the gap in `Confidence & Gaps`.
   - **Don't ask again this run** — proceed and don't re-prompt for any other missing MCP this run.
3. If the user picks Install now, output the **install command** AND the **config snippet** the user pastes into their Claude Code MCP config (the user runs the install themselves; the skill does not auto-run install commands).

Default to **Skip** if the run is small, low-stakes, or the user typed "quick"/"just tell me"/"temporary".

## Install commands and config snippets

Each entry below has the install command and the **mcpServers** snippet for `~/.claude.json` (or run `tools mcp-manager show <name>` in this repo to see how it's configured locally). The user pastes the snippet under `mcpServers` in their Claude config, or uses `claude mcp add` per the [Claude Code MCP docs](https://docs.claude.com/en/docs/claude-code/mcp).

### jina (web search + URL read)

Tools used by this skill: `mcp__jina__search_web`, `mcp__jina__read_url`, `mcp__jina__parallel_read_url`.

Jina is a hosted HTTP MCP — no local install. The user needs a Jina API key from <https://jina.ai>.

```json
{
  "mcpServers": {
    "jina": {
      "type": "http",
      "url": "https://mcp.jina.ai/v1",
      "headers": {
        "Authorization": "Bearer <YOUR_JINA_API_KEY>"
      }
    }
  }
}
```

CLI install: `claude mcp add --transport http jina https://mcp.jina.ai/v1 --header "Authorization: Bearer <YOUR_JINA_API_KEY>"`

### brave-search

Tools used by this skill: `mcp__brave-search__brave_web_search`, `mcp__brave-search__brave_local_search`.

Local stdio server. User needs a Brave Search API key from <https://brave.com/search/api/>.

Install:
```bash
bun add --global @modelcontextprotocol/server-brave-search
```

Config snippet:
```json
{
  "mcpServers": {
    "brave-search": {
      "type": "stdio",
      "command": "mcp-server-brave-search",
      "env": {
        "BRAVE_API_KEY": "<YOUR_BRAVE_API_KEY>"
      }
    }
  }
}
```

### reddit-mcp-server

Tools used by this skill: `mcp__reddit-mcp-server__search_reddit`, `get_post_comments`, `get_top_posts`.

Local stdio server. Read-only mode works without credentials; for write actions the user adds `REDDIT_USERNAME` / `REDDIT_PASSWORD` env vars (this skill never writes).

Install:
```bash
bun add --global reddit-mcp-server
```

Config snippet:
```json
{
  "mcpServers": {
    "reddit-mcp-server": {
      "type": "stdio",
      "command": "reddit-mcp-server",
      "args": []
    }
  }
}
```

### gh_grep (GitHub code search)

Tools used by this skill: `mcp__gh_grep__searchGitHub`.

Hosted HTTP MCP — no local install, no API key.

```json
{
  "mcpServers": {
    "gh_grep": {
      "type": "http",
      "url": "https://mcp.grep.app"
    }
  }
}
```

CLI install: `claude mcp add --transport http gh_grep https://mcp.grep.app`

### context7-mcp (library docs)

Tools used by this skill (only when a named library is being researched): `mcp__context7-mcp__resolve-library-id`, `mcp__context7-mcp__get-library-docs`.

Local stdio server. User needs a Context7 API key from <https://context7.com>.

Install:
```bash
bun add --global @upstash/context7-mcp
```

Config snippet:
```json
{
  "mcpServers": {
    "context7-mcp": {
      "type": "stdio",
      "command": "context7-mcp",
      "env": {
        "CONTEXT7_API_KEY": "<YOUR_CONTEXT7_API_KEY>"
      }
    }
  }
}
```

## After install

Once the user finishes adding the MCP and restarts Claude Code, the new tools appear under `mcp__<server>__*`. The skill should re-check availability before relying on the new server in the same run — if the user installed mid-run without a restart, the tools are still unavailable; treat as Skip and note in Gaps.

## Sister skills (optional, ship in same plugin)

These are not MCPs but are referenced by the skill for richer behavior. They live in the same `genesis-tools` plugin, so they are present whenever this skill is.

- `gt:github` — GitHub issue/PR/discussion fetcher used by `comparison` and `sentiment` categories.
- `gt:explore` — code/web exploration used by `news` and `deep_technical` categories.

If the plugin install was partial and these are missing, fall back to `general-purpose` agent with the same MCP preferences and note in Gaps.
