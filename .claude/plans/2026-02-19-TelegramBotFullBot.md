# Telegram Bot Full Platform — Future Vision

> This is a **future plan** documenting the full bot platform vision.
> Build on top of the interactive bot from `.claude/plans/2026-02-19-Automate-ScheduleTasksWithTelegram.md`.

**Goal:** Evolve telegram-bot from interactive commands into a full bot platform with rich UI, extensibility, and advanced features.

---

## Feature Areas

### 1. Rich Message UI

- **Inline keyboards**: Confirm/cancel buttons for `/run`, enable/disable toggles for schedules
- **Reply keyboards**: Quick-access preset buttons, status shortcuts
- **Message editing**: Update progress inline instead of sending new messages
- **Callback queries**: Handle button press events

### 2. Webhook Mode

- `tools telegram-bot webhook --port 8443` using `Bun.serve()`
- SSL termination via reverse proxy or self-signed cert
- Faster response times vs long-polling
- Auto-switch between polling and webhook based on environment

### 3. Multi-User / Multi-Chat

- Extend `TelegramBotConfig` to `chatIds: number[]`
- Per-user permission levels (admin, viewer)
- Group chat support with `@botname` command prefix
- Broadcast notifications to multiple chats

### 4. Media Messages

- `sendPhoto` — send charts, screenshots
- `sendDocument` — send log files, reports
- `sendAnimation` — GIFs for fun status updates
- File upload support for preset inputs

### 5. Conversation State Machine

Multi-step Telegram interactions:
- `/run` → shows preset list as inline keyboard → user selects → shows variables → user fills → execute
- `/schedule create` → guided flow through Telegram messages
- Context tracking per chat with timeout cleanup

### 6. Plugin System for Commands

Allow tools to register their own Telegram commands:
```typescript
// In any tool's index.ts
export const telegramCommands = [
  { command: "usage", description: "Show Claude usage stats", handler: async () => {...} }
];
```
Bot discovers commands by scanning tool directories, similar to how the `tools` entry point discovers tools.

### 7. Notification Routing

Presets can specify notification channels:
- `notify.telegram` — Telegram only
- `notify.desktop` — macOS only
- `notify.all` — broadcast to all configured channels
- Per-schedule notification preferences in SQLite

### 8. Telegram Triggers

New trigger type: `trigger.type: "telegram"`
- Presets can be triggered by specific Telegram messages matching patterns
- Example: send "deploy staging" → triggers deployment preset
- Pattern matching with regex or keyword lists

### 9. Scheduled Digests

- Daily/weekly digest messages combining multiple data sources
- Example: "Morning digest" at 9am with: GitHub PRs, unread emails, today's schedule
- Configurable digest templates with Markdown formatting

### 10. Bot Menu / BotFather Integration

- Auto-register commands with BotFather via `setMyCommands` API
- Dynamic command list based on installed tools
- Command descriptions synced automatically

---

## Implementation Priority

1. Inline keyboards (highest value, low effort)
2. Webhook mode (performance)
3. Conversation state (UX improvement)
4. Plugin system (extensibility)
5. Multi-user (if sharing is needed)
6. Media messages (nice to have)
7. Telegram triggers (advanced)
8. Scheduled digests (integration)
