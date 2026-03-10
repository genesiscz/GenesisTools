# Telegram Conversation Memory + Assistant V2 Implementation Plan

## Summary
Build a V2 Telegram subsystem that supports full + incremental sync for users/groups/channels, range-aware query with auto-fetch caching, attachment indexing with lazy download, and an assistant workflow (auto-reply, chat assistant, suggestion drafting with pick/edit/send).
This plan keeps existing `tools telegram listen` behavior compatible while adding new runtime modes (`daemon`, `light`, `ink`) and richer per-contact Ask/model/style configuration.

## Git Start (Execute After Plan Mode)
1. Fast-forward local `master` and branch:
```bash
git checkout master
git pull --ff-only origin master
git checkout -b feat/telegram-agent
```
2. Save this plan to `.claude/plans/2026-03-01-TelegramAssistantV2.md` before implementation.

## Public APIs / Interfaces / Types
- Extend Telegram config schema in `src/telegram/lib/types.ts` and migration logic in `src/telegram/lib/TelegramToolConfig.ts`.
- Keep backward compatibility with old `askProvider/askModel/askSystemPrompt` by mapping into V2 `modes.autoReply`.
- Add per-contact per-mode Ask config (`autoReply`, `assistant`, `suggestions`) with global defaults.
- Add style rule array config (rich source rules, regex/time windows, cross-chat sources).
- Add query parser interface for flags + NL helper.
- Add attachment locator interface: `chatId + messageId + attachmentIndex`.
- Expose Ask model-selection helpers for Telegram configure flow via `src/ask/index.lib.ts` and reuse `src/ask/providers/ModelSelector.ts`.

### Proposed V2 Contact Shape (decision-complete)
```ts
type TelegramRuntimeMode = "daemon" | "light" | "ink";

interface AskModeConfig {
  enabled: boolean;
  provider?: string;
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}

interface SuggestionModeConfig extends AskModeConfig {
  count: number;
  trigger: "manual" | "auto" | "hybrid";
  autoDelayMs: number;
  allowAutoSend: boolean;
}

interface StyleSourceRule {
  id: string;
  sourceChatId: string;
  direction: "outgoing" | "incoming";
  limit?: number;
  since?: string;
  until?: string;
  regex?: string;
}

interface StyleProfileConfig {
  enabled: boolean;
  refresh: "incremental";
  rules: StyleSourceRule[];
  previewInWatch: boolean;
}

interface TelegramContactV2 {
  userId: string;
  displayName: string;
  username?: string;
  actions: ("say" | "ask" | "notify")[];
  watch: { enabled: boolean; contextLength: number; runtimeMode?: TelegramRuntimeMode };
  modes: {
    autoReply: AskModeConfig;
    assistant: AskModeConfig;
    suggestions: SuggestionModeConfig;
  };
  styleProfile: StyleProfileConfig;
}
```

## Data Model and Migration
- Upgrade SQLite schema in `src/telegram/lib/TelegramHistoryStore.ts` using `PRAGMA user_version` migrations.
- Add `chats` table for dialog metadata/type.
- Extend `messages` with mutation tracking fields (`edited_date_unix`, `is_deleted`, `deleted_at_iso`, `reply_to_msg_id`).
- Add `message_revisions` table to preserve create/edit/delete history.
- Add `attachments` table with metadata + download status/path/hash + unique `(chat_id, message_id, attachment_index)`.
- Add `sync_segments` table to track covered date intervals for auto-fetch gap detection.
- Keep `sync_state` for high-watermark incremental latest sync.
- Keep FTS + embeddings intact.

## Command Surface (V2)
- Update `src/telegram/index.ts` command registration.
- Keep existing commands; add/extend:
1. `tools telegram configure`
2. `tools telegram history sync [contact] [--all] [--since] [--until] [--limit]`
3. `tools telegram history query --from <contact> [--since] [--until] [--sender me|them|any] [--text <regex>] [--local-only] [--nl "<query>"]`
4. `tools telegram history attachments list --from <contact> [--since] [--until] [--message-id]`
5. `tools telegram history attachments fetch --from <contact> --message-id <id> --attachment-index <n> [--output <path>]`
6. `tools telegram watch [contact|--all] [--runtime daemon|light|ink] [--context-length <n>]`
7. `tools telegram listen`

## Implementation Tasks
- Implement tasks 1-12 from agreed plan.

## Assumptions and Defaults
- Default query behavior is auto-fetch-and-cache when local range is incomplete.
- Default suggestion behavior is manual; optional delayed auto-suggest is configurable.
- Default send behavior requires explicit user pick/edit confirmation; no auto-send by default.
- Default style refresh is incremental background update.
- Attachment binaries are lazy-downloaded; metadata is always indexed.
- Deleted messages remain queryable as tombstones (`is_deleted=1`) unless explicitly filtered out.
- TUI is split into `light` first and `ink` runtime second, but both are delivered in this feature branch.
