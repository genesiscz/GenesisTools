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
  Timestamp-free Grok prompts use their absolute byte offset as the turn key.
- **What a feature gets is normalized**: `NativeHistoryEntry` (role, text, timestamp, tool, paths). Logic over it
  (decision answers in `src/question/lib/decisions/chat-answers.ts`, a reply's decision blocks) is provider-neutral
  and never names a JSONL field such as `"type":"assistant"`, `response_item`, `continued-in` or `chat_history`.
- **Legacy parsers still exist** (about 20 folders read transcript rows directly:
  `src/claude/lib/usage/session-rows.ts` for `continued-in`, `src/utils/ai/transcripts/`). Do not copy them. When a
  change touches one, move the fact it reads into a reader member first.
- **Lint enforces it**: `no-transcript-format-outside-readers` in `scripts/ci/lint-rules.ts` fails a transcript record
  type or field literal (`"continued-in"`, `"turn_context"`, `'"type":"user"'`, …) outside the readers. The files that
  still do it are listed in `scripts/ci/transcript-format-ratchet.ts`; a file only ever leaves that list.
- **Four more lints guard the same seam** (2026-10-25), each with a list in `scripts/ci/` that only shrinks:
  - `no-hand-built-claude-home`, `no-hand-built-codex-grok-home` (`native-home-ratchet.ts`): a path into
    `~/.claude`, `~/.codex`, `~/.grok` or their env overrides goes through `nativeHome(kind)` or
    `nativeSessionRoots(kind)` in `src/utils/providers/session-paths.ts`.
  - `no-harness-name-branch` (`harness-ratchet.ts`): `x.harness === "codex"` or a `case "grok":` in a tool is a
    provider member instead.
  - `no-hook-payload-read`: a hook payload field (`transcript_path`, `tool_input`, …) is read in
    `src/agents/lib/hooks/payload.ts` only; add a typed `HookPayload` field there.
  - `no-agent-name-in-command-match`: finding a running agent by its command line goes through
    `src/utils/process/classify.ts`.
- **A reader that caps or skips records says so in the log.** A byte cap, a timeout or a skipped row that hides
  newer records logs the path, the cap and what was missed, so a frozen age or a missing prompt is found from
  `~/.genesis-tools/logs/` and not by a user.
