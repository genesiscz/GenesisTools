# TypeScript SDKs for macOS Native App Automation

> Last updated: 2026-02-16

## Overview

This document catalogs TypeScript/JavaScript libraries for interacting with macOS native applications (Mail, Notes, Calendar, Contacts, etc.) via AppleScript/JXA (JavaScript for Automation).

## SDK Comparison Matrix

| Package | Stars | Last Active | TS Types | Approach | Best For |
|---------|-------|------------|----------|----------|----------|
| [`@jxa/global-type`](https://github.com/JXA-userland/JXA) + `@jxa/run` + `@jxa/sdef-to-dts` | 480 | 2026-01 | Full native | Type declarations + sdef→d.ts generator + run bridge | Full typed JXA development with per-app types |
| [`run-jxa`](https://github.com/sindresorhus/run-jxa) | 152 | 2025-09 | Full (generics) | Serialize function to osascript | Simple typed JXA execution from Node.js |
| [`run-applescript`](https://github.com/sindresorhus/run-applescript) | 172 | 2025-09 | Full | String to osascript | Simple typed AppleScript execution |
| [`@dhravya/apple-mcp`](https://github.com/supermemoryai/apple-mcp) | 2,999 | 2025-08 | Written in TS | MCP tools wrapping run-applescript | Pre-built MCP tools for 8 Apple apps |
| [`@steipete/macos-automator-mcp`](https://github.com/steipete/macos-automator-mcp) | 648 | 2026-02 | Written in TS | MCP + 200+ script knowledge base | AI-driven macOS automation via MCP |
| [`joshrutkowski/applescript-mcp`](https://github.com/joshrutkowski/applescript-mcp) | 358 | 2025-04 | Written in TS | MCP + modular categories | Structured AppleScript MCP server |

## Tier Classification

### Tier 1: Type-Safe JXA Development (Recommended Foundation)

**JXA-userland** (`@jxa/*` packages) — The most comprehensive TypeScript-for-JXA ecosystem.

- `@jxa/global-type` — Global type declarations (`Application()`, `ObjC`, `$`, etc.)
- `@jxa/run` — Execute JXA from Node.js, get typed results back
- `@jxa/sdef-to-dts` — **Unique**: Generate `.d.ts` from any app's scripting dictionary (`.sdef`)
- `@jxa/types` — Core TypeScript definition files
- `@jxa/repl` — Interactive JXA REPL

**Key advantage**: `@jxa/sdef-to-dts` can generate typed interfaces for ANY scriptable macOS app:
```bash
bunx @jxa/sdef-to-dts /Applications/Mail.app --output ./types/mail.d.ts
bunx @jxa/sdef-to-dts /Applications/Notes.app --output ./types/notes.d.ts
bunx @jxa/sdef-to-dts /Applications/Calendar.app --output ./types/calendar.d.ts
```

See: [jxa-userland.md](./jxa-userland.md) for deep exploration.

### Tier 2: Simple Execution Wrappers

**`run-jxa`** (sindresorhus) — Highest quality single-package solution.

```ts
import { runJxa } from 'run-jxa';
const result = await runJxa<string[]>(() => {
    const mail = Application("Mail");
    return mail.inbox.messages.whose({ subject: { _contains: "invoice" } })()
        .map(m => m.subject());
});
```

Features: async/sync APIs, generics, AbortSignal cancellation, console.log forwarding.

**`run-applescript`** (sindresorhus) — Same author, for AppleScript strings.

```ts
import { runAppleScript } from 'run-applescript';
const count = await runAppleScript('tell application "Mail" to count messages of inbox');
```

### Tier 3: Pre-Built MCP Servers (Reference Implementations)

**`@dhravya/apple-mcp`** — Pre-built MCP tools for 8 Apple apps. Uses `run-applescript` internally.
See: [apple-mcp.md](./apple-mcp.md) for deep exploration.

**`@steipete/macos-automator-mcp`** — 200+ pre-built AppleScript/JXA scripts with AI-driven selection.
See: [macos-automator-mcp.md](./macos-automator-mcp.md) for deep exploration.

### Tier 4: Legacy (Avoid for New Projects)

| Package | Stars | Last Updated | Notes |
|---------|-------|-------------|-------|
| `node-applescript` | 388 | 2020 | Callback-based, no TypeScript |
| `node-jxa` | 81 | 2020 | Browserify-based, unmaintained |
| `osa2` | 72 | 2018 | Direct OSA bridge, unmaintained |
| `node-osascript` | 60 | 2015 | Streaming interface, abandoned |

## Related: Native Swift Approach

**OpenClaw** (200k+ stars) — Uses a native Swift companion app (`apps/macos/`) communicating over WebSocket to a Node.js gateway. Does not use JXA TypeScript bindings; instead shells out to `osascript` through an allowlist-based exec approval system. Represents the "heavy-duty" approach when you need full macOS permissions (Accessibility, Screen Recording, etc.).

## Recommended Stack for GenesisTools

For building `src/macos-mail/` and future macOS automation tools:

1. **Foundation**: `@jxa/global-type` + `@jxa/sdef-to-dts` for typed JXA
2. **Execution**: Direct `Bun.spawn(["osascript", "-l", "JavaScript", ...])` (no extra dep needed)
3. **Performance**: SQLite direct queries for bulk metadata searches (25x faster than JXA)
4. **Reference**: Study `@dhravya/apple-mcp` and `@steipete/macos-automator-mcp` for patterns

## macOS Mail.app Specifics

### SQLite Database
- Path: `~/Library/Mail/V10/MailData/Envelope Index`
- Tables: `messages`, `subjects`, `addresses`, `attachments`, `mailboxes`, `recipients`
- Always copy before querying to avoid locking: `cp ... /tmp/MailEnvelopeIndex.sqlite`
- Dates are Unix epoch integers (seconds since 1970)
- 25x faster than JXA for metadata searches

### JXA Scripting Dictionary Properties
- Message: `id`, `subject`, `sender`, `content`, `source`, `dateReceived`, `dateSent`, `readStatus`, `flaggedStatus`, `messageId`, `messageSize`
- Attachment: `name`, `mimeType` (unreliable), `fileSize`, `downloaded`
- Hierarchy: `Application("Mail").accounts[].mailboxes[].messages[]`
- Unified inbox: `Application("Mail").inbox`

### Performance Notes
- JXA `whose` filter on 37k messages: ~67s
- SQLite query on same data: ~2.7s
- Hybrid approach recommended: SQLite for search, JXA for content/attachment retrieval
