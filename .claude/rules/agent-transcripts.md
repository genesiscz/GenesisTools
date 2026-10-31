---
paths:
  - "src/agents/**"
  - "src/question/**"
  - "src/hub/**"
  - "src/claude/**"
  - "src/codex/**"
  - "src/grok/**"
  - "src/ai-spend/**"
  - "src/genesis-tools-mcp/**"
  - "src/utils/agent-sessions/**"
  - "src/utils/ai/transcripts/**"
  - "src/utils/session-transcript/**"
  - "src/utils/cmux/**"
  - "src/utils/claude/**"
  - "plugins/**"
---

# Reading a coding agent's transcript (Claude, Codex, Grok)

Loaded by Claude Code when you read, write or edit a file in a folder that reads agent sessions. Martin's rule
(2026-10-25): every fact read from a session transcript is a member of the provider interface, implemented by every
provider, so a new provider is a list of members to fill in and no feature parses a transcript format itself.

- **The interface is `NativeSessionReader`** (`src/utils/agent-sessions/types.ts`), reached through
  `ProviderPlugin.codingAgent` and `resolveHistoryProvider(kind)` (`src/utils/agent-sessions/provider.ts`).
  Claude, Codex and Grok implement it in `src/utils/agent-sessions/readers/<provider>.ts`. Never add another
  provider registry or a `switch (harness)` over transcript formats in a tool.
- **A new transcript capability is a REQUIRED member**, implemented by all three readers in the same change. The
  compiler then names every provider (and test fake) that lacks it. When a provider cannot answer, its member says
  so in code and in a comment (Grok's chat history carries no timestamps, so its `readBackward` is bounded by
  content and bytes, never by time). An optional member lets the next provider forget it; do not add one for a
  capability features rely on.
- **Members today:** `discover`, `read`, `readMetadata`, `scan`, `readRecords`, `readStatistics`, and
  `readBackward` (the newest entries, from the end back to the entry a caller's `until` accepts; added 2026-10-25
  for the decision Stop hook's chat answers). A hook or tool reaches it with `readSessionBackward({ kind,
  transcriptPath, until })` (`src/utils/agent-sessions/session-backward.ts`). `readTurnBoundary` returns the latest
  real prompt's stable key and optional timestamp; `readSessionTurnBoundary` reaches it from a transcript path.
  Timestamp-free Grok prompts use their absolute byte offset as the turn key. Added 2026-10-30 (the ratchet
  migration): `continuedIn` (the successor session id a transcript ends on; Codex and Grok keep none),
  `currentModel` (the model a session runs now, from a bounded tail, or Grok's `summary.json`; it replaced the per-row
  `modelOfRow` on 2026-10-31, and the same function is each harness's `HookFacts.currentModel`, so a hook loads no
  reader), `indexesFile` (whether a path under a
  session root is this provider's transcript), and `rowAnchors` (the ids a row carries: uuid, message id, tool call
  ids, the open Codex turn). `followSessionContinuations` (`session-backward.ts`) walks `continuedIn` to the live
  id, so `tools claude cmux focus`, `send` and decision delivery reach a continued session.
- **What a feature gets is normalized**: `NativeHistoryEntry` (role, text, timestamp, tool, paths). Logic over it
  (decision answers in `src/question/lib/decisions/chat-answers.ts`, a reply's decision blocks) is provider-neutral
  and never names a JSONL field such as `"type":"assistant"`, `response_item`, `continued-in` or `chat_history`.
- **The format parsers live beside the readers** (`src/utils/agent-sessions/readers/`: `codex-turns.ts`,
  `codex-changes.ts`, `codex-import.ts`, `codex-usage.ts`, `grok-usage.ts`, `claude-tail-usage.ts`,
  `claude-native-scan.ts`, moved there 2026-10-30). `src/utils/ai/transcripts/` keeps provider-neutral logic and
  tables keyed by provider. The turn-state readers moved there too on 2026-10-30
  (`readers/<harness>-turn-state.ts`), reached through each harness driver's `turnState` part
  (`harnessTurnState(id)` in `src/utils/ai/providers/harness-index.ts`). Do not add a new parser outside the readers.
- **Lint enforces it**: `no-transcript-format-outside-readers` in `scripts/ci/lint-rules.ts` fails a transcript record
  type or field literal (`"continued-in"`, `"turn_context"`, `'"type":"user"'`, …) outside the readers. Its list in
  `scripts/ci/transcript-format-ratchet.ts` was emptied on 2026-10-30, so a new offender fails the lint at once.
- **Four more lints guard the same seam** (2026-10-25). Their lists in `scripts/ci/` were emptied on 2026-10-30, so
  a new offender fails the lint at once:
  - `no-hand-built-claude-home`, `no-hand-built-codex-grok-home` (`native-home-ratchet.ts`): a path into
    `~/.claude`, `~/.codex`, `~/.grok` or their env overrides goes through `nativeHome(kind)`, `nativeHomePath(kind,
    ...segments)`, `claudeJsonPath()`, `nativeSessionRoots(kind)` or `primaryCodexHome()` in
    `src/utils/providers/session-paths.ts`. `CODEX_HOME` is a comma list; `CLAUDE_CONFIG_DIR` moves `.claude.json` too.
  - `no-harness-name-branch` (`harness-ratchet.ts`): `x.harness === "codex"` or a `case "grok":` in a tool is a
    provider member, or an exhaustive table keyed by the harness type (`satisfies Record<HarnessName, …>`), never a
    comparison at the call site. Hook facts per harness are `HARNESS_HOOK_FACTS` in `src/agents/lib/hooks/payload.ts`;
    worker facts are `WorkerCapabilities` in `src/utils/worker/capabilities.ts`.
  - `no-hook-payload-read`: a hook payload field (`transcript_path`, `tool_input`, …) is read in
    `src/agents/lib/hooks/payload.ts` only; add a typed `HookPayload` field there. Claude's statusline input is a
    different shape with its own owner, `StatuslineInput` in `src/utils/agents/hooks/statusline-input.ts`.
  - `no-agent-name-in-command-match`: finding a running agent by its command line goes through
    `classifyCommand`, `isAgentProcess` or `runsAgent` in `src/utils/process/classify.ts`.
- **A reader that caps or skips records says so in the log.** A byte cap, a timeout or a skipped row that hides
  newer records logs the path, the cap and what was missed, so a frozen age or a missing prompt is found from
  `~/.genesis-tools/logs/` and not by a user.
