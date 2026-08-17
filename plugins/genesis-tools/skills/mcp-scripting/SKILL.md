---
name: mcp-scripting
description: Call MCP tools from a plain TypeScript script via `tools scripts`, with typed bindings generated from each server's live tools/list. Use this WHENEVER a task means calling the same MCP tool many times, chaining several tools in a fixed order, looping or diffing over tool results, or when the tool you need belongs to a server this session did not load. Triggers on "script this MCP call", "call <server> tools in a loop", "without burning context on tool definitions", "scratch script for <server>", "one-shot MCP call", "what MCP servers do I have", "list the tools on <server>", "generate types from an MCP server", "tools scripts", "mcp-scripts", "mcporter". Also use PROACTIVELY when about to issue the same MCP tool call more than about three times in a row, since the script version costs one tool call instead of N.
---

# MCP scripting (`tools scripts`)

Every MCP server already configured on this machine is reachable from a normal Bun script.
No agent loop, no tool definitions in context, no waiting for a model turn between calls.

```bash
tools scripts servers                       # what exists, and how it connects
tools scripts tools 'genesis-tools.*'       # live tools/list, cached after first probe
tools scripts describe 'genesis-tools.handoff_post'   # params before you write a call
tools scripts call genesis-tools.handoff_list '{"limit":5}'
```

Full reference: `tools scripts --readme` (selector grammar, persisted-script layout, result
helpers, recipes, credentials, token-efficiency patterns).

## When this beats calling the MCP tool directly

Direct tool calls are correct for one or two calls. Switch to a script when any of these is
true:

- The same tool runs more than about three times. Each direct call is a full model turn;
  the script is one.
- Results need looping, diffing, filtering or asserting before a human sees them. A tool
  call cannot express control flow.
- The server is not loaded in this session. The script does not care what the session
  loaded at startup.
- The output is large and only a slice matters. Filter inside the script; the model never
  sees the rest.
- The sequence needs to be repeatable later. Persisted scripts survive the session.

## Selectors

`[provider:]<server>.<tool>`, either half may contain `*`: `chrome-devtools-mcp.*`,
`*.take_screenshot`, `genesis-tools.handoff_*`. A bare selector means `mcp:` (the only v1
provider; the prefix is reserved for future surfaces like `openapi:`/`composio:`). `*.*`
probes every server and is slow the first time.

## Persisted scripts

```bash
tools scripts create colTriage \
  --import 'chrome-devtools-mcp.*' 'genesis-tools.handoff_*' \
  --description 'Reproduce the bug, then file a handoff' --tag triage
tools scripts run colTriage
tools scripts list            # gated scripts from other projects hidden; --all reveals
tools scripts regen colTriage # after a server changes its schema
tools scripts doctor          # verify store health, read-only
```

Scripts live in `~/.genesis-tools/scripts/persisted/<name>/`. `<name>.ts` is yours;
`<name>.tools.ts` is generated (never hand-edit). Sidecars (presets, state, `out/`) belong
in the same folder. `create --gated` scopes the script's visibility to the current project;
`run` works from anywhere regardless. The store is a LOCAL git repo: mutating verbs
auto-commit, so `tools scripts git -- log --oneline` is the history of every script.
Off-machine history is opt-in and remembered: `tools scripts remote <url>` (sets origin,
pushes, persists the decision; `--auto-push on` pushes on every commit; `--none` declines
and silences the offer).

Script body shape — bindings are camelCase, server-prefixed when the import spans servers:

```typescript
import { data, must, text, withKit } from "@gt/scripts/kit";
import * as T from "./colTriage.tools.ts";

await withKit(async (kit) => {
    const pages = must(await T.chromeDevtoolsMcp_listPages(kit), "list_pages");
    console.log(text(pages));

    // Independent calls run concurrently over the open session (MCP has no batching).
    const [snap, logs] = await kit.all([
        () => T.chromeDevtoolsMcp_takeSnapshot(kit),
        () => T.chromeDevtoolsMcp_listConsoleMessages(kit),
    ]);

    // Anything not bound at create time is still reachable.
    const raw = await kit.callRef("genesis-tools.handoff_list", { limit: 3 });
    console.log(data<{ handoffs: unknown[] }>(raw)?.handoffs.length);
}, { servers: ["chrome-devtools-mcp", "genesis-tools"] });
```

Result helpers from `@gt/scripts/kit`: `text` (concatenated text blocks), `data<T>`
(structuredContent, else text-as-JSON), `images`, `isError`, `must` (throw on tool error),
`result` (mcporter's full CallResult). `withKit` always closes the runtime; use it over
`createKit` so stdio servers do not leak processes.

## Worth knowing

- **Remote servers authenticate with Claude Code's own OAuth tokens** (read from its
  credential store; scripts are headless). Expired/missing tokens are reported up front —
  the raw failure otherwise reads as `SSE error: Non-200 status code (405)`, which says
  nothing about credentials. Re-authorise with `/mcp`. Tokens are never refreshed here:
  refresh tokens rotate and spending Claude Code's copy would break the server in-app.
- **No wire batching in MCP** (removed 2025-06-18). `kit.all()` fires concurrent requests
  over one open session — the only lever.
- **First probe of a stdio server is slow** (spawn + handshake); cached after, `--refresh`
  busts. Failed servers are cached as errors and reported, not re-probed every run.
- **Large results:** print a value in full exactly once (`@gt/scripts/refs`), or print its
  shape instead of its data (`@gt/scripts/schema` — `formatSchema`, `describeCollection`;
  12,632 chars of JSON vs 57 of skeleton on a real 900-element array).
