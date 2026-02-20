# Automate Schedule Tasks with Telegram — Full Vertical Slice

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> **Prerequisite:** Complete `.claude/plans/2026-02-19-Automate-ScheduleTasks.md` first (Tasks 1-12).

**Goal:** Add a new `telegram-bot` tool for Telegram Bot API integration, connect it to automate as a notification channel (`notify.telegram`), and build an interactive bot that can control automate from Telegram.

**Architecture:** New `src/telegram-bot/` tool with raw fetch-based Telegram API client. Config stored via Storage class. Bot uses long-polling for receiving commands. Automate's notify handler dynamically imports telegram-bot lib. Bot and daemon are separate processes sharing SQLite.

**Tech Stack:** Bun, Telegram Bot API (raw fetch), Commander.js, @clack/prompts

**Branch:** `feat/automate`

---

### Task 13: Telegram Bot API Client

**Files:**
- Create: `src/telegram-bot/lib/types.ts`
- Create: `src/telegram-bot/lib/api.ts`
- Create: `src/telegram-bot/lib/config.ts`

**Step 1: Create types**

```typescript
// src/telegram-bot/lib/types.ts

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  first_name?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export type ParseMode = "MarkdownV2" | "HTML";

export interface SendMessageParams {
  chat_id: number | string;
  text: string;
  parse_mode?: ParseMode;
  disable_web_page_preview?: boolean;
}

export interface TelegramBotConfig {
  botToken: string;
  chatId: number;
  botUsername?: string;
  configuredAt: string;
}

export interface BotCommand {
  command: string;
  args: string;
  chatId: number;
  messageId: number;
  fromUser?: TelegramUser;
}

export type CommandHandler = (cmd: BotCommand) => Promise<{ text: string; parse_mode?: ParseMode }>;
```

**Step 2: Create API client**

```typescript
// src/telegram-bot/lib/api.ts

import type { TelegramApiResponse, TelegramUser, TelegramMessage, TelegramUpdate, SendMessageParams } from "./types";

const BASE_URL = "https://api.telegram.org";

export function createTelegramApi(botToken: string) {
  const baseUrl = `${BASE_URL}/bot${botToken}`;

  async function callApi<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${baseUrl}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: params ? JSON.stringify(params) : undefined,
    });
    const data = await response.json() as TelegramApiResponse<T>;
    if (!data.ok) throw new Error(`Telegram API: ${data.description} (${data.error_code})`);
    return data.result!;
  }

  return {
    getMe: () => callApi<TelegramUser>("getMe"),
    sendMessage: (params: SendMessageParams) => callApi<TelegramMessage>("sendMessage", params),
    getUpdates: (offset?: number, timeout = 30) =>
      callApi<TelegramUpdate[]>("getUpdates", { offset, timeout, allowed_updates: ["message"] }),
    deleteWebhook: () => callApi<boolean>("deleteWebhook", { drop_pending_updates: false }),
  };
}

export type TelegramApi = ReturnType<typeof createTelegramApi>;
```

**Step 3: Create config loader**

```typescript
// src/telegram-bot/lib/config.ts

import { chmodSync } from "node:fs";
import { Storage } from "@app/utils/storage/storage";
import type { TelegramBotConfig } from "./types";

const storage = new Storage("telegram-bot");

export async function loadTelegramConfig(): Promise<TelegramBotConfig | null> {
  return storage.getConfig<TelegramBotConfig>();
}

export async function saveTelegramConfig(config: TelegramBotConfig): Promise<void> {
  await storage.setConfig(config);
  try { chmodSync(storage.getConfigPath(), 0o600); } catch {}
}

export function getStorage() { return storage; }
```

**Step 4: Commit**
```bash
git add src/telegram-bot/lib/types.ts src/telegram-bot/lib/api.ts src/telegram-bot/lib/config.ts
git commit -m "feat(telegram-bot): add Telegram API client, types, and config loader"
```

---

### Task 14: Telegram Bot Configure Command

**Files:**
- Create: `src/telegram-bot/commands/configure.ts`

**Step 1: Create the interactive setup wizard**

```typescript
// src/telegram-bot/commands/configure.ts

import { Command } from "commander";
import * as p from "@clack/prompts";
import { createTelegramApi } from "@app/telegram-bot/lib/api";
import { saveTelegramConfig } from "@app/telegram-bot/lib/config";

export function registerConfigureCommand(program: Command): void {
  program.command("configure").description("Set up Telegram Bot for notifications").action(async () => {
    p.intro("telegram-bot configure");

    p.note(
      "1. Open Telegram and search for @BotFather\n" +
      "2. Send /newbot and follow the prompts\n" +
      "3. Copy the API token BotFather gives you",
      "Setup Instructions"
    );

    const token = await p.text({
      message: "Paste your bot token:",
      placeholder: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
      validate: (val) => {
        if (!/^\d+:[A-Za-z0-9_-]+$/.test(val)) return "Invalid token format (expected: 123456:ABC...)";
      },
    });
    if (p.isCancel(token)) return;

    const api = createTelegramApi(token as string);
    let botUsername: string;
    try {
      const me = await api.getMe();
      botUsername = me.username ?? me.first_name;
      p.log.success(`Connected to bot: @${botUsername}`);
    } catch (err) {
      p.log.error(`Invalid token: ${(err as Error).message}`);
      return;
    }

    p.log.step("Now send any message to your bot in Telegram...");
    const spinner = p.spinner();
    spinner.start("Waiting for your message...");

    let chatId: number | null = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const updates = await api.getUpdates(undefined, 30);
        if (updates.length > 0) {
          chatId = updates[updates.length - 1].message?.chat.id ?? null;
          break;
        }
      } catch { /* retry */ }
    }

    if (!chatId) {
      spinner.stop("Timed out waiting for message");
      p.log.error("Could not detect your chat ID. Please try again.");
      return;
    }

    spinner.stop(`Chat ID detected: ${chatId}`);

    await saveTelegramConfig({
      botToken: token as string,
      chatId,
      botUsername,
      configuredAt: new Date().toISOString(),
    });

    try {
      await api.sendMessage({ chat_id: chatId, text: "GenesisTools telegram-bot configured successfully!" });
      p.log.success("Test message sent");
    } catch (err) {
      p.log.warn(`Could not send test message: ${(err as Error).message}`);
    }

    p.outro("Configuration complete!");
  });
}
```

**Step 2: Commit**
```bash
git add src/telegram-bot/commands/configure.ts
git commit -m "feat(telegram-bot): add interactive configure wizard with chat ID auto-detection"
```

---

### Task 15: Telegram Bot CLI Entry Point and Send Command

**Files:**
- Create: `src/telegram-bot/index.ts`
- Create: `src/telegram-bot/commands/send.ts`

**Step 1: Create entry point**

```typescript
#!/usr/bin/env bun
// src/telegram-bot/index.ts

import { Command } from "commander";
import { handleReadmeFlag } from "@app/utils/readme";
import { registerConfigureCommand } from "./commands/configure";
import { registerSendCommand } from "./commands/send";

handleReadmeFlag(import.meta.url);

const program = new Command();
program
  .name("telegram-bot")
  .description("Telegram Bot for GenesisTools notifications and remote control")
  .version("1.0.0")
  .showHelpAfterError(true);

registerConfigureCommand(program);
registerSendCommand(program);

program.parse();
```

**Step 2: Create send command**

```typescript
// src/telegram-bot/commands/send.ts

import { Command } from "commander";
import * as p from "@clack/prompts";
import { createTelegramApi } from "@app/telegram-bot/lib/api";
import { loadTelegramConfig } from "@app/telegram-bot/lib/config";
import type { ParseMode } from "@app/telegram-bot/lib/types";

export function registerSendCommand(program: Command): void {
  program
    .command("send <message>")
    .description("Send a message via Telegram")
    .option("--parse-mode <mode>", "Parse mode: MarkdownV2 or HTML")
    .option("--stdin", "Read message from stdin")
    .action(async (message: string, opts) => {
      const config = await loadTelegramConfig();
      if (!config) { p.log.error("Telegram not configured. Run: tools telegram-bot configure"); process.exit(1); }

      let text = message;
      if (opts.stdin) text = await new Response(Bun.stdin.stream()).text();

      const api = createTelegramApi(config.botToken);
      try {
        await api.sendMessage({ chat_id: config.chatId, text, parse_mode: opts.parseMode as ParseMode | undefined });
        p.log.success("Message sent");
      } catch (err) {
        p.log.error(`Failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
```

**Step 3: Commit**
```bash
git add src/telegram-bot/index.ts src/telegram-bot/commands/send.ts
git commit -m "feat(telegram-bot): add CLI entry point and send command"
```

---

### Task 16: Add notify.telegram Step Handler

**Files:**
- Modify: `src/automate/lib/steps/notify.ts:49-51` (add case before default)

**Step 1: Add telegram case to notify handler**

In `src/automate/lib/steps/notify.ts`, add before `default:`:

```typescript
      case "telegram": {
        const { loadTelegramConfig } = await import("@app/telegram-bot/lib/config");
        const { createTelegramApi } = await import("@app/telegram-bot/lib/api");

        const config = await loadTelegramConfig();
        if (!config) {
          ctx.log("warn", "Telegram not configured. Run: tools telegram-bot configure");
          return makeResult("skipped", { reason: "not_configured" }, start);
        }

        const api = createTelegramApi(config.botToken);
        const message = ctx.interpolate(params.message ?? "");
        const parseMode = params.parse_mode;

        const sent = await api.sendMessage({
          chat_id: config.chatId,
          text: message,
          parse_mode: parseMode as "MarkdownV2" | "HTML" | undefined,
        });

        return makeResult("success", { messageId: sent.message_id, chatId: config.chatId }, start);
      }
```

**Step 2: Commit**
```bash
git add src/automate/lib/steps/notify.ts
git commit -m "feat(automate): add notify.telegram step handler"
```

---

### Task 17: Interactive Bot (Polling + Command Handlers)

**Files:**
- Create: `src/telegram-bot/lib/security.ts` — Rate limiter (sliding window 20/min, per-command cooldowns)
- Create: `src/telegram-bot/lib/formatting.ts` — ANSI strip, truncate 4096 chars, MarkdownV2 escape
- Create: `src/telegram-bot/lib/dispatcher.ts` — Routes `/command args` to handlers, chatId restriction
- Create: `src/telegram-bot/lib/poller.ts` — Long-polling loop via `getUpdates(offset, timeout=30)`
- Create: `src/telegram-bot/lib/handlers/index.ts` — Re-export registration
- Create: `src/telegram-bot/lib/handlers/status.ts` — `/status`: daemon status, active schedules
- Create: `src/telegram-bot/lib/handlers/tasks.ts` — `/tasks`: recent run history
- Create: `src/telegram-bot/lib/handlers/run.ts` — `/run <preset>`: trigger preset
- Create: `src/telegram-bot/lib/handlers/tools.ts` — `/tools <cmd>`: run any tools command
- Create: `src/telegram-bot/lib/handlers/help.ts` — `/help`: list commands
- Create: `src/telegram-bot/commands/start.ts` — `telegram-bot start` foreground polling

**Key design points:**

- **Dispatcher**: Only responds to configured chatId. Silently ignores other users.
- **Rate limiter**: 20 cmds/min global, `/tools` 5s cooldown, `/run` 10s cooldown.
- **Formatting**: `sanitizeForTelegram(text)` strips ANSI and truncates to 4096 chars.
- **Poller**: `deleteWebhook()` on start, then loops `getUpdates` with 30s timeout. Backoff 5s on errors.
- **Handlers**: Each registers via `registerCommand(name, handler)` pattern (mirrors automate's `registerStepHandler`).
- **/tools handler**: Spawns `bun run tools <args>` with 30s timeout, `NO_COLOR=1`, pipes output.
- **/run handler**: Spawns `bun run tools automate run <preset>` with 120s timeout.

**Commit:**
```bash
git add src/telegram-bot/lib/ src/telegram-bot/commands/start.ts
git commit -m "feat(telegram-bot): add interactive bot with polling and command handlers"
```

---

### Task 18: Register Start Command

**Files:**
- Modify: `src/telegram-bot/index.ts`

Add import and registration for the start command:
```typescript
import { registerStartCommand } from "./commands/start";
registerStartCommand(program);
```

**Commit:**
```bash
git add src/telegram-bot/index.ts
git commit -m "feat(telegram-bot): register start command in CLI entry point"
```

---

### Task 19: Scheduled Preset with Telegram Notifications

**Files:**
- Create: `src/automate/presets/scheduled-health-check.json`

```json
{
  "$schema": "genesis-tools-preset-v1",
  "name": "Scheduled Health Check",
  "description": "Check API endpoints every 5 minutes, notify via Telegram on failure",
  "trigger": { "type": "schedule", "interval": "every 5 minutes" },
  "vars": {
    "endpoints": { "type": "string", "description": "Comma-separated URLs", "default": "https://httpstat.us/200,https://httpstat.us/500" }
  },
  "steps": [
    { "id": "split", "name": "Split endpoints", "action": "text.split", "params": { "input": "{{ vars.endpoints }}", "separator": "," }, "output": "urls" },
    { "id": "check-all", "name": "Check endpoints", "action": "forEach", "params": { "items": "{{ steps.split.output }}", "concurrency": 5, "step": { "id": "check", "name": "Check {{ item }}", "action": "http.get", "params": { "url": "{{ item }}", "timeout": 10000 }, "onError": "continue" } }, "output": "results" },
    { "id": "notify", "name": "Send Telegram notification", "action": "notify.telegram", "params": { "message": "Health check: {{ steps.check-all.output.count }} endpoints checked, {{ steps.check-all.output.failures }} failures" } }
  ]
}
```

**Commit:**
```bash
git add src/automate/presets/scheduled-health-check.json
git commit -m "feat(automate): add scheduled health check example preset with Telegram"
```

---

## Verification

1. `tools telegram-bot configure` — set up bot token + auto-detect chat ID
2. `tools telegram-bot send "Hello from GenesisTools"` — verify message arrives
3. `tools automate run <preset-with-notify.telegram>` — verify notification
4. `tools telegram-bot start` — send `/help` from Telegram, verify response
5. `/status`, `/tasks`, `/tools claude usage`, `/run <preset>` from Telegram
6. Full integration: schedule + daemon + telegram notification end-to-end
