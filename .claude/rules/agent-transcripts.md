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
  - "plugins/**/hooks/**"
---

# Reading a coding agent's transcript (Claude, Codex, Grok)

Loaded by Claude Code when you read, write or edit a file in a folder that reads agent sessions. Martin's rule
(2026-10-25): every fact read from a session transcript is a member of the provider interface, implemented by every
provider, so a new provider is a list of members to fill in and no feature parses a transcript format itself.

- **The interface is `NativeSessionReader`** (`src/utils/agent-sessions/types.ts`), reached through one door:
  `resolveHistoryProvider(kind)` over `ProviderPlugin.codingAgent` (`src/utils/agent-sessions/provider.ts`;
  `nativeReaderFor(kind)` in `native-adapter.ts` when the caller needs the kind narrowed). Claude, Codex and Grok
  implement it in `src/utils/agent-sessions/readers/<provider>.ts`. The driver has no history part and there is no
  reader list (both went on 2026-10-31). Never add another provider registry or a `switch (harness)` over
  transcript formats in a tool.
- **One owner per harness for its session files: `src/utils/agent-sessions/readers/<harness>-*.ts`.** The reader,
  its discovery, its title parser, its turn-state dialect (`<harness>-turn-state.ts`), its locator
  (`<harness>-locate.ts`: default roots, path and id lookup, title search), its turn parser (`<harness>-parse.ts`)
  and its current-model probe (`<harness>-model.ts`) all live there, and a fact is parsed in one function both sides
  call (Codex's `session_index.jsonl`: `codexIndexRows` in `codex-title.ts`). The harness driver
  (`src/utils/ai/providers/plugins/<plugin>/harness.ts`) only points at them: `locate` through `deferredLocator`
  (`src/utils/harness/deferred.ts`, so a hook loads no locator), `parse` through a dynamic import, `turnState`
  directly, and `transcript` holds static facts only. Callers reach a part as `harnessDriver(id).parts.<part>`
  (`src/utils/ai/providers/harness-index.ts`); the one-line accessors went on 2026-10-31.
- **Roots are a per-harness table.** `TranscriptRoots` (`src/utils/ai/transcripts/resolve.ts`) is keyed by harness,
  each entry `{ native, worker }`; a field a caller leaves out takes the locator's `defaultRoots()`. Codex has one
  home policy, `codexHomesWithLegacy()` (`src/utils/providers/session-paths.ts`): history discovery, lookup and
  title search read the same homes, legacy profile homes (`~/.codex-work`) included.
- **A new transcript capability is a REQUIRED member**, implemented by all three readers in the same change. The
  compiler then names every provider (and test fake) that lacks it. When a provider cannot answer, its member says
  so in code and in a comment (Grok's chat history carries no timestamps, so its `readBackward` is bounded by
  content and bytes, never by time). An optional member lets the next provider forget it; do not add one for a
  capability features rely on.
- **The members are listed in `NativeSessionReader`** (`src/utils/agent-sessions/types.ts`); read them there.
  Rules that come with them: a hook reaches `readBackward` through `readSessionBackward` and a continued session
  through `followSessionContinuations` (`session-backward.ts`). An `analysis` or `workflows` fact the harness's
  files lack answers `{ supported: false, reason }`, never an empty list (test fakes: `noAnalysis`, `noWorkflows`).
  The session-analyzer skill in GenesisClaude calls `tools ai sessions workflows` (2026-11-11): never add a second
  reader of the Workflow files; each run's agent carries its journal lines and `supersededBy`, so a caller cites a
  line and never opens the journal itself. A session's sub-agent transcripts, its workflow runs' included, are enumerated in ONE
  place: `claudeSubagentTranscripts` in `readers/claude-paths.ts` (the folder walk a hook can load is
  `claudeSubagentFolders` in `claude-subagent-path.ts`).
- **What a feature gets is normalized**: `NativeHistoryEntry` (role, text, timestamp, tool, paths). Logic over it
  (decision answers in `src/question/lib/decisions/chat-answers.ts`, a reply's decision blocks) is provider-neutral
  and never names a JSONL field such as `"type":"assistant"`, `response_item`, `continued-in` or `chat_history`.
- **The format parsers live beside the readers** (`src/utils/agent-sessions/readers/`: `codex-turns.ts`,
  `codex-changes.ts`, `codex-import.ts`, `codex-usage.ts`, `grok-usage.ts`, `claude-tail-usage.ts`,
  `claude-native-scan.ts`, moved there 2026-10-30). The Claude change parser joined them on 2026-11-10:
  `claude-changes-parse.ts` reads the lines and `claude-changes.ts` folds them for `readChanges`, while
  `src/utils/session-changes/` only computes over a `SessionTranscript`. `claude-locate.ts` is the one module that
  maps a Claude id or an 8-character prefix to a file (`canonicalClaudeTranscript` and its sync form); a prefix of
  several sessions throws `AmbiguousSessionIdError`. `src/utils/ai/transcripts/` keeps provider-neutral logic and
  tables keyed by provider. The turn-state dialects moved there too on 2026-10-30
  (`readers/<harness>-turn-state.ts`); the one door from a transcript path to a `TurnSnapshot` is `readTurnState`
  (`src/utils/ai/transcripts/turn-state.ts`), and its shapes are in `turn-state-types.ts`. Do not add a new parser
  outside the readers.
- **Lint enforces it**: `no-transcript-format-outside-readers` in `scripts/ci/lint-rules.ts` fails a transcript record
  type or field literal (`"continued-in"`, `"turn_context"`, `'"type":"user"'`, …) outside the readers. Its list in
  `scripts/ci/transcript-format-ratchet.ts` was emptied on 2026-10-30, so a new offender fails the lint at once.
- **Four more lints guard the same seam**: `no-hand-built-claude-home`, `no-hand-built-codex-grok-home`,
  `no-harness-name-branch`, `no-hook-payload-read` and `no-agent-name-in-command-match`. Their lists are empty, so
  a new offender fails at once; what each one wants instead is in `.claude/rules/ci.md`.
- **A reader that caps or skips records says so in the log.** A byte cap, a timeout or a skipped row that hides
  newer records logs the path, the cap and what was missed, so a frozen age or a missing prompt is found from
  `~/.genesis-tools/logs/` and not by a user.
