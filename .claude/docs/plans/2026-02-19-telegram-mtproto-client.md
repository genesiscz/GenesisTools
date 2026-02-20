# Telegram MTProto Client Tool — Implementation Plan (v2)

> **Save this plan to:** `docs/plans/2026-02-19-telegram-mtproto-client.md` before starting implementation.
> **Worktree:** `.worktrees/feat-telegram` (branch `feat/telegram` from `feat/automate`)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create `tools telegram` — a full MTProto Telegram user-account client that listens for messages from configured contacts and performs configurable actions (read aloud via TTS with language detection, LLM auto-reply, macOS notifications).

**Architecture:** Class-based design — `TGClient` wraps GramJS, `TelegramMessage` wraps incoming messages with media detection and is serializable for future history storage, `TelegramContact` pairs entity with config, `TelegramToolConfig` manages persistence. TTS utility with automatic language detection goes in `src/utils/macos/tts.ts`. Actions are composable per contact. The design is prepared for Phase 2 (conversation history: download, search, date-range filtering via SQLite FTS5).

**Tech Stack:** GramJS (`telegram`), Commander, @clack/prompts, `runTool` for `tools ask`, macOS `say` with NLP language detection, `sendNotification()`

**Phase 2 (follow-up plan):** Conversation history — download full/partial history, store in SQLite with FTS5, search within conversations, date-range export. A dedicated plan will be written as the last task of this implementation.

---

## Context

The existing `telegram-bot` tool uses grammY (Bot API HTTP polling) for remote-controlling GenesisTools via a bot account. This new `telegram` tool is fundamentally different: it connects as a **real user account** via MTProto protocol, enabling interception of private messages from any contact — for use cases like reading messages aloud (with correct TTS voice), auto-replying with LLM-generated text, or showing macOS notifications.

---

## Code Style Rules

**Add these rules to the project CLAUDE.md before writing any code:**

```markdown
## Code Style: Conditionals & Spacing

- **No one-line `if` statements** — even for early returns. Always use block form with braces.
- **Empty line before `if`** — unless the preceding line is a variable declaration used by that `if`.
- **Empty line after closing `}`** — unless followed by `else`, `catch`, `finally`, or another `}`.
- Example:

  const value = getValue();
  if (!value) {
      return;
  }

  doSomething(value);

## Code Style: Type Safety

- **No `as any`** — use proper type narrowing, type guards, or explicit interfaces.
- When working with union types, use discriminant checks (e.g. `entity.className === "User"`).
- Prefer `error: err` over `error: err instanceof Error ? err.message : String(err)` when the error field accepts unknown.
```

---

## File Structure

```
src/telegram/
├── index.ts                         # Commander entry point
├── commands/
│   ├── configure.ts                 # Guided MTProto auth + contact selection wizard
│   │   ├── runAuthFlow()            # Auth sub-flow
│   │   ├── runContactSelection()    # Contact picker sub-flow
│   │   └── configureContactActions()# Per-contact action picker
│   ├── listen.ts                    # Start message listener (long-running)
│   └── contacts.ts                  # List/remove watched contacts
├── lib/
│   ├── types.ts                     # Type definitions + defaults
│   ├── TelegramToolConfig.ts        # Config class with Storage + overridable defaults
│   ├── TGClient.ts                  # Wrapper class around GramJS TelegramClient
│   ├── TelegramMessage.ts           # Wrapper class around Api.Message (media, preview, etc.)
│   ├── TelegramContact.ts           # Our contact = entity + config (delay, actions, prompt)
│   ├── handler.ts                   # NewMessage event handler + dispatch
│   └── actions/
│       ├── index.ts                 # Action registry + sequential executor
│       ├── say.ts                   # Uses src/utils/macos/tts.ts
│       ├── ask.ts                   # LLM auto-reply via tools ask
│       └── notify.ts               # macOS notification

src/utils/macos/
└── tts.ts                           # NEW: Text-to-speech with language detection + voice selection
```

## Critical Reference Files

- `src/telegram-bot/commands/configure.ts` — @clack/prompts wizard pattern
- `src/telegram-bot/lib/config.ts` — Storage + chmod 0o600 pattern
- `src/utils/cli/tools.ts:16-36` — `runTool(args, opts)` → `ExecResult { success, stdout, stderr, exitCode }`
- `src/utils/macos/notifications.ts:10-23` — `sendNotification({ title, message, subtitle?, sound? })` (sync)
- `src/utils/macos/nlp.ts:24-26` — `detectLanguage(text)` → `{ language: string, confidence: number }` (BCP-47)
- `src/utils/storage/storage.ts` — `Storage` class API
- `src/utils/readme.ts` — `handleReadmeFlag(import.meta.url)`

---

### Task 1: Code style rules + install GramJS

**Files:**
- Modify: `CLAUDE.md` — add code style rules from section above
- Modify: `package.json` — add `telegram` dependency

**Step 1:** Add the code style rules to the project CLAUDE.md (the section shown above)

**Step 2:** Install GramJS

```bash
bun add telegram
```

**Step 3:** Verify Bun compatibility

```bash
bun -e "import { TelegramClient } from 'telegram'; import { StringSession } from 'telegram/sessions'; import { Api } from 'telegram'; console.log('GramJS OK:', typeof TelegramClient, typeof StringSession, typeof Api)"
```

Expected: `GramJS OK: function function object`

If import paths fail under Bun's ESM resolution, try alternatives:
- `telegram/sessions/index.js`
- `telegram/tl/index.js`

*(No commit yet — will commit together with Task 2)*

---

### Task 2: Create TTS utility with language detection

**Files:**
- Create: `src/utils/macos/tts.ts`
- Modify: `src/utils/macos/index.ts` — re-export `tts.ts`

**Step 1: Implement TTS with voice auto-selection**

```typescript
// src/utils/macos/tts.ts
import { detectLanguage } from "./nlp";

/** BCP-47 language code → macOS say voice name */
const VOICE_MAP: Record<string, string> = {
    cs: "Zuzana",
    sk: "Laura",
    en: "Samantha",
    de: "Anna",
    fr: "Thomas",
    es: "Monica",
    it: "Alice",
    pl: "Zosia",
    pt: "Joana",
    ru: "Milena",
    uk: "Lesya",
    ja: "Kyoko",
    ko: "Yuna",
    zh: "Ting-Ting",
};

export interface SpeakOptions {
    /** Override voice (skips language detection) */
    voice?: string;
    /** Words per minute (default: macOS default ~175) */
    rate?: number;
}

/**
 * Speak text aloud using macOS `say` command.
 * Automatically detects language and selects appropriate voice.
 */
export async function speak(text: string, options?: SpeakOptions): Promise<void> {
    const args = ["say"];

    if (options?.voice) {
        args.push("-v", options.voice);
    } else {
        try {
            const result = await detectLanguage(text);
            const voice = VOICE_MAP[result.language];

            if (voice) {
                args.push("-v", voice);
            }
        } catch {
            // Fall through to default system voice
        }
    }

    if (options?.rate) {
        args.push("-r", String(options.rate));
    }

    args.push(text);

    const proc = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
}

/** List available voices on this system */
export async function listVoices(): Promise<string[]> {
    const proc = Bun.spawn(["say", "-v", "?"], { stdout: "pipe", stderr: "ignore" });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return output.split("\n").filter(Boolean);
}
```

**Step 2:** Re-export from macos/index.ts (add `export * from "./tts"`)

**Step 3:** Verify compile

```bash
bunx tsgo --noEmit 2>&1 | rg "src/utils/macos"
```

**Step 4:** Commit (Task 1 + 2 together)

```bash
git add CLAUDE.md package.json bun.lockb src/utils/macos/tts.ts src/utils/macos/index.ts
git commit -m "feat(telegram): add GramJS dependency + TTS utility with language detection"
```

---

### Task 3: Create core classes

**Files:**
- Create: `src/telegram/lib/types.ts`
- Create: `src/telegram/lib/TelegramToolConfig.ts`
- Create: `src/telegram/lib/TGClient.ts`
- Create: `src/telegram/lib/TelegramMessage.ts`
- Create: `src/telegram/lib/TelegramContact.ts`

#### Step 1: Type definitions + defaults

```typescript
// src/telegram/lib/types.ts
import type { Api } from "telegram";

export type ActionType = "say" | "ask" | "notify";

export interface ContactConfig {
    userId: string;
    displayName: string;
    username?: string;
    actions: ActionType[];
    askSystemPrompt?: string;
    replyDelayMin: number;
    replyDelayMax: number;
}

export interface TelegramConfigData {
    apiId: number;
    apiHash: string;
    session: string;
    me?: { firstName: string; username?: string; phone?: string };
    contacts: ContactConfig[];
    configuredAt: string;
}

export interface ActionResult {
    action: ActionType;
    success: boolean;
    reply?: string;
    duration: number;
    error?: unknown;
}

export type ActionHandler = (
    message: import("./TelegramMessage").TelegramMessage,
    contact: import("./TelegramContact").TelegramContact,
    client: import("./TGClient").TGClient,
) => Promise<ActionResult>;

export const DEFAULTS = {
    apiId: 39398121,
    apiHash: "d1857dc6fabd4d7034795dd3bd6ac0d1",
    replyDelayMin: 2000,
    replyDelayMax: 5000,
    askSystemPrompt:
        "You're chatting casually on Telegram. Reply naturally and briefly (1-2 sentences). Match the language of the incoming message.",
    connectionRetries: 5,
    maxProcessedMessages: 500,
    typingIntervalMs: 4000,
    askTimeoutMs: 60_000,
} as const;
```

#### Step 2: TelegramToolConfig class

```typescript
// src/telegram/lib/TelegramToolConfig.ts
import { chmodSync } from "node:fs";
import { Storage } from "@app/utils/storage/storage";
import type { TelegramConfigData, ContactConfig } from "./types";
import { DEFAULTS } from "./types";

export class TelegramToolConfig {
    private storage = new Storage("telegram");
    private data: TelegramConfigData | null = null;

    async load(): Promise<TelegramConfigData | null> {
        this.data = await this.storage.getConfig<TelegramConfigData>();
        return this.data;
    }

    async save(config: TelegramConfigData): Promise<void> {
        await this.storage.setConfig(config);
        this.data = config;
        this.protect();
    }

    async updateSession(session: string): Promise<void> {
        await this.storage.setConfigValue("session", session);

        if (this.data) {
            this.data.session = session;
        }

        this.protect();
    }

    getApiId(): number {
        return this.data?.apiId ?? DEFAULTS.apiId;
    }

    getApiHash(): string {
        return this.data?.apiHash ?? DEFAULTS.apiHash;
    }

    getSession(): string {
        return this.data?.session ?? "";
    }

    getContacts(): ContactConfig[] {
        return this.data?.contacts ?? [];
    }

    hasValidSession(): boolean {
        return !!this.data?.session;
    }

    private protect(): void {
        try {
            chmodSync(this.storage.getConfigPath(), 0o600);
        } catch {}
    }
}
```

#### Step 3: TGClient wrapper class

```typescript
// src/telegram/lib/TGClient.ts
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Api } from "telegram";
import { NewMessage, type NewMessageEvent } from "telegram/events";
import type { TelegramToolConfig } from "./TelegramToolConfig";
import { DEFAULTS } from "./types";

export interface AuthCallbacks {
    phoneNumber: () => Promise<string>;
    phoneCode: () => Promise<string>;
    password: () => Promise<string>;
}

export class TGClient {
    private client: TelegramClient;

    constructor(apiId: number, apiHash: string, session: string = "") {
        this.client = new TelegramClient(
            new StringSession(session),
            apiId,
            apiHash,
            { connectionRetries: DEFAULTS.connectionRetries },
        );
    }

    /** Factory from config */
    static fromConfig(config: TelegramToolConfig): TGClient {
        return new TGClient(config.getApiId(), config.getApiHash(), config.getSession());
    }

    /** Interactive auth (for configure wizard) */
    async startWithAuth(callbacks: AuthCallbacks): Promise<void> {
        await this.client.start({
            phoneNumber: callbacks.phoneNumber,
            phoneCode: callbacks.phoneCode,
            password: callbacks.password,
            onError: (err) => console.error("Auth error:", err),
        });
    }

    /** Connect using saved session. Returns true if authorized. */
    async connect(): Promise<boolean> {
        await this.client.connect();
        return this.client.checkAuthorization();
    }

    async disconnect(): Promise<void> {
        await this.client.disconnect();
    }

    getSessionString(): string {
        return (this.client.session as StringSession).save();
    }

    async getMe(): Promise<Api.User> {
        return this.client.getMe() as Promise<Api.User>;
    }

    async getDialogs(limit: number = 100): Promise<import("telegram").Dialog[]> {
        return this.client.getDialogs({ limit });
    }

    async sendMessage(userId: string, text: string): Promise<void> {
        await this.client.sendMessage(userId, { message: text });
    }

    async sendTyping(userId: string): Promise<void> {
        const peer = await this.client.getInputEntity(userId);

        await this.client.invoke(
            new Api.messages.SetTyping({
                peer,
                action: new Api.SendMessageTypingAction(),
            }),
        );
    }

    /** Start a typing indicator loop. Returns stop function. */
    startTypingLoop(userId: string): { stop: () => void } {
        let stopped = false;

        const tick = async () => {
            if (stopped) {
                return;
            }

            try {
                await this.sendTyping(userId);
            } catch {}
        };

        tick();
        const interval = setInterval(tick, DEFAULTS.typingIntervalMs);

        return {
            stop: () => {
                stopped = true;
                clearInterval(interval);
            },
        };
    }

    /** Register a handler for new incoming private messages */
    onNewMessage(handler: (event: NewMessageEvent) => Promise<void>): void {
        this.client.addEventHandler(handler, new NewMessage({}));
    }

    get raw(): TelegramClient {
        return this.client;
    }

    // ── History methods (Phase 2 preparation) ──────────────────────────
    // These provide the foundation for conversation history download/search.
    // Implementation is minimal now — Phase 2 plan will build on these.

    /**
     * Fetch message history from a specific user/chat.
     * GramJS iterMessages returns an async iterator over Api.Message objects.
     * @param userId - The user/chat to fetch history from
     * @param options - limit, offsetDate, minId, maxId for pagination/filtering
     */
    async *getMessages(
        userId: string,
        options: { limit?: number; offsetDate?: number; minId?: number; maxId?: number } = {},
    ): AsyncGenerator<Api.Message> {
        for await (const message of this.client.iterMessages(userId, {
            limit: options.limit,
            offsetDate: options.offsetDate,
            minId: options.minId,
            maxId: options.maxId,
        })) {
            yield message;
        }
    }

    /**
     * Get total message count for a conversation (for progress bars).
     * Uses search with empty query to get total count.
     */
    async getMessageCount(userId: string): Promise<number> {
        const result = await this.client.invoke(
            new Api.messages.Search({
                peer: await this.client.getInputEntity(userId),
                q: "",
                filter: new Api.InputMessagesFilterEmpty(),
                minDate: 0,
                maxDate: 0,
                offsetId: 0,
                addOffset: 0,
                limit: 0,
                maxId: 0,
                minId: 0,
                hash: BigInt(0),
            }),
        );

        if ("count" in result) {
            return result.count;
        }

        return 0;
    }
}
```

#### Step 4: TelegramMessage class

```typescript
// src/telegram/lib/TelegramMessage.ts
import { Api } from "telegram";

/**
 * Wrapper around GramJS Api.Message providing convenience accessors
 * and media type detection for TTS/LLM context.
 */
export class TelegramMessage {
    constructor(private message: Api.Message) {}

    get id(): number {
        return this.message.id;
    }

    get text(): string {
        return this.message.text ?? "";
    }

    get isPrivate(): boolean {
        return this.message.isPrivate ?? false;
    }

    get isOutgoing(): boolean {
        return this.message.out ?? false;
    }

    get senderId(): string | undefined {
        return this.message.senderId?.toString();
    }

    get date(): Date {
        return new Date(this.message.date * 1000);
    }

    get hasText(): boolean {
        return !!this.text;
    }

    get hasMedia(): boolean {
        return !!this.message.media;
    }

    get raw(): Api.Message {
        return this.message;
    }

    /** Short preview for logging (max 80 chars) */
    get preview(): string {
        if (this.text.length > 80) {
            return `${this.text.slice(0, 80)}...`;
        }

        return this.text || this.mediaDescription || "(empty)";
    }

    /** Human-readable description of the message content for TTS and LLM */
    get contentForLLM(): string {
        if (this.mediaDescription && this.text) {
            return `${this.mediaDescription}: ${this.text}`;
        }

        return this.text || this.mediaDescription || "";
    }

    /** Human-readable media description, or undefined if no media */
    get mediaDescription(): string | undefined {
        const media = this.message.media;

        if (!media) {
            return undefined;
        }

        const name = media.className;

        if (name === "MessageMediaPhoto") {
            return "a photo";
        }

        if (name === "MessageMediaGeo" || name === "MessageMediaGeoLive") {
            return "a location";
        }

        if (name === "MessageMediaContact") {
            return "a contact card";
        }

        if (name === "MessageMediaPoll") {
            return "a poll";
        }

        if (name === "MessageMediaDice") {
            return "a dice/emoji game";
        }

        if (name === "MessageMediaDocument") {
            return this.describeDocument(media as Api.MessageMediaDocument);
        }

        return undefined;
    }

    private describeDocument(media: Api.MessageMediaDocument): string {
        const doc = media.document;

        if (!doc || doc.className === "DocumentEmpty") {
            return "a document";
        }

        const attrs = (doc as Api.Document).attributes ?? [];

        for (const attr of attrs) {
            if (attr.className === "DocumentAttributeSticker") {
                return "a sticker";
            }

            if (attr.className === "DocumentAttributeAudio") {
                return (attr as Api.DocumentAttributeAudio).voice ? "a voice message" : "an audio file";
            }

            if (attr.className === "DocumentAttributeVideo") {
                return (attr as Api.DocumentAttributeVideo).roundMessage ? "a video message" : "a video";
            }

            if (attr.className === "DocumentAttributeAnimated") {
                return "a GIF";
            }
        }

        return "a file";
    }

    // ── Serialization (Phase 2 preparation) ────────────────────────────
    // Produces a plain object suitable for SQLite storage / JSON export.
    // Phase 2 will use this for conversation history persistence.

    /** Serializable representation for history storage */
    toJSON(): SerializedMessage {
        return {
            id: this.id,
            senderId: this.senderId,
            text: this.text,
            mediaDescription: this.mediaDescription,
            isOutgoing: this.isOutgoing,
            date: this.date.toISOString(),
            dateUnix: this.message.date,
        };
    }
}

/** Plain object for storage/export (Phase 2) */
export interface SerializedMessage {
    id: number;
    senderId: string | undefined;
    text: string;
    mediaDescription: string | undefined;
    isOutgoing: boolean;
    date: string;
    dateUnix: number;
}
```

**Note on `as` casts in TelegramMessage:** The `media as Api.MessageMediaDocument`, `doc as Api.Document`, and attribute casts are **safe narrowing after className checks** (discriminated unions in GramJS). These are NOT `as any` — they are narrow casts to specific known subtypes after the discriminant has been checked. If GramJS provides proper discriminated union types, prefer type guards instead.

#### Step 5: TelegramContact class

```typescript
// src/telegram/lib/TelegramContact.ts
import { Api } from "telegram";
import type { ContactConfig, ActionType } from "./types";
import { DEFAULTS } from "./types";

/**
 * Combines a Telegram user entity with our per-contact configuration.
 * Provides computed properties for actions, delays, and display.
 */
export class TelegramContact {
    constructor(
        public readonly userId: string,
        public readonly displayName: string,
        public readonly username: string | undefined,
        public readonly config: ContactConfig,
    ) {}

    get actions(): ActionType[] {
        return this.config.actions;
    }

    get hasAskAction(): boolean {
        return this.config.actions.includes("ask");
    }

    get askSystemPrompt(): string {
        return this.config.askSystemPrompt ?? DEFAULTS.askSystemPrompt;
    }

    get replyDelayMin(): number {
        return this.config.replyDelayMin ?? DEFAULTS.replyDelayMin;
    }

    get replyDelayMax(): number {
        return this.config.replyDelayMax ?? DEFAULTS.replyDelayMax;
    }

    /** Generate a random delay within the configured range */
    get randomDelay(): number {
        return this.replyDelayMin + Math.random() * (this.replyDelayMax - this.replyDelayMin);
    }

    /** Create from a GramJS user entity + our config */
    static fromUser(user: Api.User, config: ContactConfig): TelegramContact {
        const displayName = `${user.firstName || ""} ${user.lastName || ""}`.trim();

        return new TelegramContact(
            user.id.toString(),
            displayName || config.displayName,
            user.username ?? undefined,
            config,
        );
    }

    /** Create from stored config only (no live entity) */
    static fromConfig(config: ContactConfig): TelegramContact {
        return new TelegramContact(
            config.userId,
            config.displayName,
            config.username,
            config,
        );
    }
}
```

**Step 6:** Verify compile

```bash
bunx tsgo --noEmit 2>&1 | rg "src/telegram"
```

*(No commit yet — will commit with Task 4)*

---

### Task 4: Create action handlers

**Files:**
- Create: `src/telegram/lib/actions/say.ts`
- Create: `src/telegram/lib/actions/ask.ts`
- Create: `src/telegram/lib/actions/notify.ts`
- Create: `src/telegram/lib/actions/index.ts`

#### Step 1: Say action (uses new TTS utility)

```typescript
// src/telegram/lib/actions/say.ts
import { speak } from "@app/utils/macos/tts";
import type { ActionHandler } from "../types";

export const handleSay: ActionHandler = async (message, contact) => {
    const start = performance.now();

    const text = message.mediaDescription
        ? `${contact.displayName} sent ${message.mediaDescription}`
        : `${contact.displayName} says: ${message.text}`;

    try {
        await speak(text);

        return {
            action: "say",
            success: true,
            duration: performance.now() - start,
        };
    } catch (err) {
        return {
            action: "say",
            success: false,
            duration: performance.now() - start,
            error: err,
        };
    }
};
```

#### Step 2: Notify action

```typescript
// src/telegram/lib/actions/notify.ts
import { sendNotification } from "@app/utils/macos/notifications";
import type { ActionHandler } from "../types";

export const handleNotify: ActionHandler = async (message, contact) => {
    const start = performance.now();

    const body = message.mediaDescription
        ? `[${message.mediaDescription}] ${message.text}`.trim()
        : message.text;

    sendNotification({
        title: `Telegram: ${contact.displayName}`,
        message: body || "(empty message)",
    });

    return {
        action: "notify",
        success: true,
        duration: performance.now() - start,
    };
};
```

#### Step 3: Ask action (LLM auto-reply with typing)

```typescript
// src/telegram/lib/actions/ask.ts
import { runTool } from "@app/utils/cli/tools";
import type { ActionHandler } from "../types";
import { DEFAULTS } from "../types";

export const handleAsk: ActionHandler = async (message, contact, client) => {
    const start = performance.now();
    const typing = client.startTypingLoop(contact.userId);

    try {
        const systemPrompt = contact.askSystemPrompt;
        const promptText = message.contentForLLM;

        const result = await runTool(
            ["ask", "--system-prompt", systemPrompt, "--format", "text", "--", promptText],
            { timeout: DEFAULTS.askTimeoutMs },
        );

        typing.stop();

        if (!result.success || !result.stdout) {
            return {
                action: "ask",
                success: false,
                duration: performance.now() - start,
                error: result.stderr || "Empty LLM response",
            };
        }

        // Natural delay before sending
        await Bun.sleep(contact.randomDelay);

        await client.sendMessage(contact.userId, result.stdout);

        return {
            action: "ask",
            success: true,
            reply: result.stdout,
            duration: performance.now() - start,
        };
    } catch (err) {
        typing.stop();

        return {
            action: "ask",
            success: false,
            duration: performance.now() - start,
            error: err,
        };
    }
};
```

#### Step 4: Action registry

```typescript
// src/telegram/lib/actions/index.ts
import type { ActionHandler, ActionResult, ActionType } from "../types";
import type { TelegramMessage } from "../TelegramMessage";
import type { TelegramContact } from "../TelegramContact";
import type { TGClient } from "../TGClient";
import { handleSay } from "./say";
import { handleAsk } from "./ask";
import { handleNotify } from "./notify";

const ACTION_HANDLERS: Record<ActionType, ActionHandler> = {
    say: handleSay,
    ask: handleAsk,
    notify: handleNotify,
};

/** Execute all configured actions for a contact, sequentially (say before ask is intentional). */
export async function executeActions(
    contact: TelegramContact,
    message: TelegramMessage,
    client: TGClient,
): Promise<ActionResult[]> {
    const results: ActionResult[] = [];

    for (const action of contact.actions) {
        const handler = ACTION_HANDLERS[action];

        if (!handler) {
            continue;
        }

        const result = await handler(message, contact, client);
        results.push(result);
    }

    return results;
}
```

**Step 5:** Verify compile

```bash
bunx tsgo --noEmit 2>&1 | rg "src/telegram"
```

**Step 6:** Commit (Task 3 + 4 together — core library)

```bash
git add src/telegram/lib/
git commit -m "feat(telegram): add core classes (TGClient, TelegramMessage, TelegramContact, Config) and action handlers"
```

---

### Task 5: Create message handler + all commands + entry point

**Files:**
- Create: `src/telegram/lib/handler.ts`
- Create: `src/telegram/commands/configure.ts`
- Create: `src/telegram/commands/listen.ts`
- Create: `src/telegram/commands/contacts.ts`
- Create: `src/telegram/index.ts`

#### Step 1: Message handler

```typescript
// src/telegram/lib/handler.ts
import type { NewMessageEvent } from "telegram/events";
import pc from "picocolors";
import logger from "@app/logger";
import type { TGClient } from "./TGClient";
import { TelegramMessage } from "./TelegramMessage";
import { TelegramContact } from "./TelegramContact";
import type { ContactConfig } from "./types";
import { DEFAULTS } from "./types";
import { executeActions } from "./actions";

const processedIds = new Set<number>();
const processedOrder: number[] = [];

function trackMessage(id: number): boolean {
    if (processedIds.has(id)) {
        return false;
    }

    processedIds.add(id);
    processedOrder.push(id);

    while (processedOrder.length > DEFAULTS.maxProcessedMessages) {
        processedIds.delete(processedOrder.shift()!);
    }

    return true;
}

export function registerHandler(client: TGClient, contacts: ContactConfig[]): void {
    const contactMap = new Map<string, TelegramContact>();

    for (const config of contacts) {
        const contact = TelegramContact.fromConfig(config);
        contactMap.set(config.userId, contact);
    }

    client.onNewMessage(async (event: NewMessageEvent) => {
        try {
            const msg = new TelegramMessage(event.message);

            if (!msg.isPrivate || msg.isOutgoing) {
                return;
            }

            const senderId = msg.senderId;

            if (!senderId) {
                return;
            }

            const contact = contactMap.get(senderId);

            if (!contact) {
                return;
            }

            if (!trackMessage(msg.id)) {
                return;
            }

            if (!msg.hasText && !msg.hasMedia) {
                return;
            }

            logger.info(`${pc.bold(pc.cyan(contact.displayName))}: ${msg.preview}`);

            const results = await executeActions(contact, msg, client);

            for (const r of results) {
                if (r.success) {
                    const extra = r.reply
                        ? ` "${r.reply.slice(0, 60)}${r.reply.length > 60 ? "..." : ""}"`
                        : "";
                    logger.info(`  ${pc.green(`[${r.action}]`)} OK${pc.dim(extra)}`);
                } else {
                    logger.warn(`  ${pc.red(`[${r.action}]`)} FAILED: ${r.error}`);
                }
            }
        } catch (err) {
            logger.error(`Handler error: ${err}`);
        }
    });

    const names = contacts.map((c) => pc.cyan(c.displayName)).join(", ");
    logger.info(`Listening for messages from ${contacts.length} contact(s): ${names}`);
}
```

#### Step 2: Configure command (broken into helper functions)

The configure wizard is split into focused functions:

```typescript
// src/telegram/commands/configure.ts
import type { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { Api } from "telegram";
import { TelegramToolConfig } from "../lib/TelegramToolConfig";
import { TGClient } from "../lib/TGClient";
import type { TelegramConfigData, ContactConfig, ActionType } from "../lib/types";
import { DEFAULTS } from "../lib/types";

// --- Type guard for GramJS entities ---

function isUser(entity: Api.TypeEntity | undefined): entity is Api.User {
    return entity?.className === "User";
}

// --- Sub-flows ---

async function promptCredentials(existing: TelegramConfigData | null): Promise<{ apiId: number; apiHash: string } | null> {
    p.note(
        "Telegram API credentials are pre-filled.\nGet your own at https://my.telegram.org/apps",
        "API Credentials",
    );

    const apiId = await p.text({
        message: "API ID:",
        initialValue: String(existing?.apiId ?? DEFAULTS.apiId),
        validate: (v) => {
            if (!/^\d+$/.test(v)) {
                return "Must be a number";
            }
        },
    });

    if (p.isCancel(apiId)) {
        return null;
    }

    const apiHash = await p.text({
        message: "API Hash:",
        initialValue: existing?.apiHash ?? DEFAULTS.apiHash,
        validate: (v) => {
            if (!/^[a-f0-9]{32}$/.test(v)) {
                return "Must be 32 hex chars";
            }
        },
    });

    if (p.isCancel(apiHash)) {
        return null;
    }

    return { apiId: Number(apiId), apiHash: apiHash as string };
}

async function runAuthFlow(client: TGClient): Promise<boolean> {
    p.note(
        "You'll enter your phone number and a verification code.\nThis connects as YOUR user account (not a bot).",
        "Telegram Authentication",
    );

    try {
        await client.startWithAuth({
            phoneNumber: async () => {
                const phone = await p.text({
                    message: "Phone number (with country code):",
                    placeholder: "+420123456789",
                });

                if (p.isCancel(phone)) {
                    throw new Error("Cancelled");
                }

                return phone as string;
            },
            phoneCode: async () => {
                const code = await p.text({
                    message: "Verification code (check Telegram):",
                    placeholder: "12345",
                });

                if (p.isCancel(code)) {
                    throw new Error("Cancelled");
                }

                return code as string;
            },
            password: async () => {
                const pass = await p.text({
                    message: "2FA password (if enabled):",
                });

                if (p.isCancel(pass)) {
                    throw new Error("Cancelled");
                }

                return pass as string;
            },
        });

        p.log.success("Authenticated successfully!");
        return true;
    } catch (err) {
        p.log.error(`Authentication failed: ${err}`);
        return false;
    }
}

interface ContactOption {
    userId: string;
    label: string;
    hint: string;
    user: Api.User;
}

async function fetchContacts(client: TGClient): Promise<ContactOption[]> {
    const spinner = p.spinner();
    spinner.start("Fetching your recent chats...");

    const dialogs = await client.getDialogs(100);

    const userDialogs = dialogs.filter(
        (d) => d.isUser && isUser(d.entity) && !d.entity.bot && !d.entity.self,
    );

    spinner.stop(`Found ${userDialogs.length} contacts`);

    return userDialogs
        .filter((d): d is typeof d & { entity: Api.User } => isUser(d.entity))
        .map((d) => {
            const user = d.entity;
            const label = `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.id.toString();
            const hint = user.username ? `@${user.username}` : user.phone ? `+${user.phone}` : "";
            return { userId: user.id.toString(), label, hint, user };
        });
}

async function selectContacts(
    options: ContactOption[],
    existingContacts: ContactConfig[],
): Promise<string[] | null> {
    const existingIds = new Set(existingContacts.map((c) => c.userId));

    const selected = await p.multiselect({
        message: "Select contacts to watch:",
        options: options.map((o) => ({ value: o.userId, label: o.label, hint: o.hint })),
        initialValues: [...existingIds].filter((id) => options.some((o) => o.userId === id)),
        required: false,
    });

    if (p.isCancel(selected)) {
        return null;
    }

    return selected as string[];
}

async function configureContactActions(
    opt: ContactOption,
    existing?: ContactConfig,
): Promise<ContactConfig | null> {
    p.log.step(pc.bold(opt.label));

    const actions = await p.multiselect({
        message: `Actions for ${opt.label}:`,
        options: [
            { value: "say" as const, label: "Say aloud", hint: "macOS TTS with language detection" },
            { value: "ask" as const, label: "Auto-reply", hint: "LLM generates reply via tools ask" },
            { value: "notify" as const, label: "Notification", hint: "macOS notification" },
        ],
        initialValues: existing?.actions ?? ["notify"],
        required: true,
    });

    if (p.isCancel(actions)) {
        return null;
    }

    const typedActions = actions as ActionType[];
    let askSystemPrompt: string | undefined;

    if (typedActions.includes("ask")) {
        const prompt = await p.text({
            message: `System prompt for auto-replies to ${opt.label}:`,
            initialValue: existing?.askSystemPrompt || DEFAULTS.askSystemPrompt,
        });

        if (p.isCancel(prompt)) {
            return null;
        }

        askSystemPrompt = prompt as string;
    }

    return {
        userId: opt.userId,
        displayName: opt.label,
        username: opt.user.username ?? undefined,
        actions: typedActions,
        askSystemPrompt,
        replyDelayMin: existing?.replyDelayMin ?? DEFAULTS.replyDelayMin,
        replyDelayMax: existing?.replyDelayMax ?? DEFAULTS.replyDelayMax,
    };
}

// --- Main command registration ---

export function registerConfigureCommand(program: Command): void {
    program
        .command("configure")
        .description("Set up Telegram MTProto client with guided wizard")
        .action(async () => {
            p.intro(pc.bgMagenta(pc.white(" telegram configure ")));

            const toolConfig = new TelegramToolConfig();
            const existing = await toolConfig.load();
            let client: TGClient;

            // --- Try existing session ---
            if (existing?.session) {
                const spinner = p.spinner();
                spinner.start("Checking existing session...");

                client = TGClient.fromConfig(toolConfig);
                const authorized = await client.connect();

                if (authorized) {
                    spinner.stop("Session valid");
                    const me = await client.getMe();
                    p.log.success(
                        `Logged in as ${pc.bold(me.firstName || "")} ` +
                        `${me.username ? `(@${me.username})` : ""}`,
                    );
                } else {
                    spinner.stop("Session expired — re-authentication needed");
                    await client.disconnect();
                    client = null!;
                }
            } else {
                client = null!;
            }

            // --- Auth flow if needed ---
            if (!client) {
                const creds = await promptCredentials(existing);

                if (!creds) {
                    return;
                }

                client = new TGClient(creds.apiId, creds.apiHash);

                const ok = await runAuthFlow(client);

                if (!ok) {
                    p.outro("Please try again.");
                    return;
                }
            }

            // --- Save session immediately after auth ---
            const me = await client.getMe();
            const session = client.getSessionString();

            // --- Contact selection ---
            const contactOptions = await fetchContacts(client);

            if (contactOptions.length === 0) {
                p.log.warn("No contacts found in recent chats.");
                await toolConfig.save({
                    apiId: toolConfig.getApiId(),
                    apiHash: toolConfig.getApiHash(),
                    session,
                    me: { firstName: me.firstName || "", username: me.username ?? undefined, phone: me.phone ?? undefined },
                    contacts: [],
                    configuredAt: new Date().toISOString(),
                });
                await client.disconnect();
                p.outro("Configuration saved (no contacts to watch).");
                return;
            }

            const selectedIds = await selectContacts(contactOptions, existing?.contacts ?? []);

            if (!selectedIds) {
                await client.disconnect();
                return;
            }

            // --- Per-contact action config ---
            const contacts: ContactConfig[] = [];

            for (const userId of selectedIds) {
                const opt = contactOptions.find((o) => o.userId === userId)!;
                const existingContact = existing?.contacts.find((c) => c.userId === userId);

                const contact = await configureContactActions(opt, existingContact);

                if (!contact) {
                    await client.disconnect();
                    return;
                }

                contacts.push(contact);
            }

            // --- Save final config ---
            await toolConfig.save({
                apiId: toolConfig.getApiId(),
                apiHash: toolConfig.getApiHash(),
                session,
                me: { firstName: me.firstName || "", username: me.username ?? undefined, phone: me.phone ?? undefined },
                contacts,
                configuredAt: new Date().toISOString(),
            });

            await client.disconnect();

            p.log.success(`Saved ${contacts.length} contact(s)`);
            p.outro("Run: tools telegram listen");
        });
}
```

#### Step 3: Listen command

```typescript
// src/telegram/commands/listen.ts
import type { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import logger from "@app/logger";
import { TelegramToolConfig } from "../lib/TelegramToolConfig";
import { TGClient } from "../lib/TGClient";
import { registerHandler } from "../lib/handler";

export function registerListenCommand(program: Command): void {
    program
        .command("listen")
        .description("Start listening for messages from configured contacts")
        .action(async () => {
            const config = new TelegramToolConfig();
            const data = await config.load();

            if (!data?.session) {
                p.log.error("Not configured. Run: tools telegram configure");
                process.exit(1);
            }

            if (data.contacts.length === 0) {
                p.log.warn("No contacts configured. Run: tools telegram configure");
                process.exit(1);
            }

            const spinner = p.spinner();
            spinner.start("Connecting to Telegram...");

            const client = TGClient.fromConfig(config);
            const authorized = await client.connect();

            if (!authorized) {
                spinner.stop("Session expired");
                p.log.error("Session expired. Run: tools telegram configure");
                process.exit(1);
            }

            const me = await client.getMe();
            spinner.stop(`Connected as ${me.firstName || "user"}`);

            for (const c of data.contacts) {
                logger.info(
                    `Watching: ${pc.cyan(c.displayName)} → [${c.actions.map((a) => pc.yellow(a)).join(", ")}]`,
                );
            }

            registerHandler(client, data.contacts);
            logger.info(`Press ${pc.dim("Ctrl+C")} to stop.`);

            const shutdown = async () => {
                logger.info("Shutting down...");

                try {
                    await client.disconnect();
                } catch {}

                process.exit(0);
            };

            process.on("SIGINT", shutdown);
            process.on("SIGTERM", shutdown);

            await new Promise(() => {});
        });
}
```

#### Step 4: Contacts command

```typescript
// src/telegram/commands/contacts.ts
import type { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { TelegramToolConfig } from "../lib/TelegramToolConfig";

export function registerContactsCommand(program: Command): void {
    program
        .command("contacts")
        .description("List and manage watched contacts")
        .action(async () => {
            const config = new TelegramToolConfig();
            const data = await config.load();

            if (!data) {
                p.log.error("Not configured. Run: tools telegram configure");
                return;
            }

            if (data.contacts.length === 0) {
                p.log.info("No contacts configured. Run: tools telegram configure");
                return;
            }

            p.intro(pc.bgMagenta(pc.white(" telegram contacts ")));

            for (const c of data.contacts) {
                p.log.info(
                    `${pc.bold(c.displayName)} ${c.username ? pc.dim(`@${c.username}`) : ""}\n` +
                    `  Actions: [${c.actions.join(", ")}]` +
                    (c.askSystemPrompt ? `\n  Prompt: "${c.askSystemPrompt}"` : ""),
                );
            }

            const action = await p.select({
                message: "What would you like to do?",
                options: [
                    { value: "done", label: "Done" },
                    { value: "remove", label: "Remove a contact" },
                ],
            });

            if (p.isCancel(action) || action === "done") {
                p.outro("Done.");
                return;
            }

            if (action === "remove") {
                const toRemove = await p.select({
                    message: "Remove which contact?",
                    options: data.contacts.map((c) => ({
                        value: c.userId,
                        label: `${c.displayName} ${c.username ? `(@${c.username})` : ""}`,
                    })),
                });

                if (p.isCancel(toRemove)) {
                    return;
                }

                data.contacts = data.contacts.filter((c) => c.userId !== toRemove);
                await config.save(data);
                p.log.success("Contact removed.");
            }

            p.outro("Done.");
        });
}
```

#### Step 5: Entry point

```typescript
// src/telegram/index.ts
import { Command } from "commander";
import { handleReadmeFlag } from "@app/utils/readme";
import { registerConfigureCommand } from "./commands/configure";
import { registerListenCommand } from "./commands/listen";
import { registerContactsCommand } from "./commands/contacts";

handleReadmeFlag(import.meta.url);

const program = new Command();
program
    .name("telegram")
    .description("Telegram MTProto user client — listen for messages and auto-respond")
    .version("1.0.0")
    .showHelpAfterError(true);

registerConfigureCommand(program);
registerListenCommand(program);
registerContactsCommand(program);

program.parseAsync();
```

**Step 6:** Full compile verification

```bash
bunx tsgo --noEmit 2>&1 | rg "src/telegram"
```

**Step 7:** Tool discovery test

```bash
tools telegram --help
```

**Step 8:** Commit (commands + entry point)

```bash
git add src/telegram/
git commit -m "feat(telegram): add commands (configure, listen, contacts) and entry point"
```

---

### Task 6: End-to-end verification

**Step 1:** Full TypeScript check (zero errors expected)

```bash
bunx tsgo --noEmit 2>&1 | rg "src/telegram"
```

**Step 2:** Test all help commands

```bash
tools telegram --help
tools telegram configure --help
tools telegram listen --help
tools telegram contacts --help
```

**Step 3:** Test configure wizard (requires real Telegram auth)

```bash
tools telegram configure
```

Verify:
- API credentials are pre-filled (just press Enter)
- Phone auth flow works (phone → code → optional 2FA)
- Session auto-saved to `~/.genesis-tools/telegram/config.json`
- Recent contacts appear in multiselect picker
- Per-contact action selection works
- System prompt configurable when "ask" is selected
- Re-running `configure` skips auth (uses saved session)

**Step 4:** Test listen (requires configured contacts)

```bash
tools telegram listen
```

Verify:
- Connects without re-auth
- Shows watched contacts with their actions
- Receiving a message triggers configured actions
- "say" reads message aloud in the correct language voice
- "notify" shows macOS notification
- "ask" shows typing indicator, generates LLM reply, sends it back with delay
- Ctrl+C gracefully disconnects

---

### Task 7: Write Phase 2 plan + search options doc

After the core tool is working, write follow-up documentation.

**Step 1:** Write search options documentation at `docs/plans/2026-02-19-telegram-search-options.md`

This doc captures the full research findings from the Appendix below in a standalone reference file. Include:
- All 5 options evaluated with pros/cons/benchmarks
- The recommendation (FTS5 + sqlite-vec)
- macOS NLEmbedding language support limitation (7 languages, no Czech/Slovak)
- Schema design with hybrid search SQL patterns
- Installation instructions for sqlite-vec with better-sqlite3

**Step 2:** Use `superpowers:writing-plans` to create `docs/plans/2026-02-19-telegram-history.md`

The Phase 2 plan should cover:

**Commands to add:**
- `tools telegram history download <contact> [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--limit N]`
- `tools telegram history search <contact> <query> [--since] [--until] [--semantic]`
- `tools telegram history export <contact> --format json|csv|txt [--since] [--until]`
- `tools telegram history stats <contact>` (message counts, date ranges, activity patterns)

**Architecture (informed by semantic search research — see Appendix):**
- **SQLite storage** (`better-sqlite3` + `sqlite-vec`) at `~/.genesis-tools/telegram/history.db`
- **FTS5 table** for full-text keyword search
- **sqlite-vec `vec0` table** for 512-dim embedding vectors (from `embedText()`)
- **Hybrid search** via Reciprocal Rank Fusion (FTS5 + sqlite-vec CTE join)
- **Schema:** See "Updated Phase 2 Architecture" in Appendix
- **`TelegramHistoryStore` class** in `src/telegram/lib/TelegramHistoryStore.ts` — wraps SQLite with methods: `insertMessages()`, `search()`, `semanticSearch()`, `hybridSearch()`, `getByDateRange()`, `getStats()`, `getLastSyncedId()`
- **Embedding pipeline:** On message insert, call `embedText()` for supported languages, store vector in `messages_vec`. Skip embedding for unsupported languages (Czech/Slovak) — fall back to FTS5-only.
- Use `TGClient.getMessages()` (already stubbed in Phase 1) as the data source
- Use `TelegramMessage.toJSON()` (already implemented in Phase 1) for serialization
- **Incremental sync** — track `lastSyncedId` per chat, only download new messages on subsequent runs
- Progress bar via `@clack/prompts` spinner or custom progress for large downloads

**Key design decisions to explore:**
- Download batch size (100-500 messages per API call)
- Rate limiting (Telegram has FloodWait errors)
- Whether to store full media metadata or just descriptions
- Export formats: JSON (array of SerializedMessage), CSV, plain text transcript
- Embedding batch strategy (embed on download vs. lazy embed on first search)

**Step 3:** This plan should follow the same structure: bite-sized tasks, exact file paths, complete code, verification steps. It will be implemented in a separate session.

---

## Commit Summary (3 commits)

| # | Scope | Contents |
|---|-------|----------|
| 1 | Infra + utils | CLAUDE.md rules, GramJS dep, `src/utils/macos/tts.ts` |
| 2 | Core library | All classes (TGClient, TelegramMessage, TelegramContact, TelegramToolConfig, types) + action handlers |
| 3 | Commands | configure, listen, contacts, index.ts entry point, handler |

---

## Phase 2 Preparation Summary

The following hooks are already built into Phase 1 classes for future history support:

| Class | Phase 2 hook | Purpose |
|-------|-------------|---------|
| `TGClient` | `getMessages()` async generator | Iterate over chat history with date/ID filters |
| `TGClient` | `getMessageCount()` | Get total count for progress bars |
| `TelegramMessage` | `toJSON()` → `SerializedMessage` | Serializable format for SQLite/JSON storage |
| `TelegramMessage` | `dateUnix` field | Efficient date range queries in SQLite |
| `TelegramToolConfig` | `Storage` with cache dir | History DB can go in `~/.genesis-tools/telegram/history.db` |

---

## Known Risks

1. **GramJS + Bun**: GramJS uses `node:crypto` and `node:net` for MTProto. Bun supports both, but if edge cases arise, try adjusting import paths first (`telegram/sessions/index.js`). Fallback: run with `node --loader tsx`.

2. **Import paths**: GramJS subpackage imports (`telegram/sessions`, `telegram/events`) may need `.js` extensions under Bun's ESM resolution. Test early in Task 1.

3. **`tools ask` output**: May include ANSI codes. Use `stripAnsi()` from `@app/utils/string` if needed.

4. **Type narrowing in GramJS**: GramJS uses `.className` as discriminants. The `as Api.MessageMediaDocument` casts in `TelegramMessage.describeDocument()` are safe narrowing after className checks — NOT `as any`. If GramJS types allow proper discriminated unions, prefer removing the casts. **Under no circumstances use `as any`** — use proper type guards (`isUser()`) or narrow via className checks.

5. **DarwinKit dependency for TTS**: The `speak()` function uses `detectLanguage()` which requires the DarwinKit native bridge. If DarwinKit is unavailable, the `try/catch` falls through to macOS default voice. This is graceful degradation, not a failure.

---

## Appendix: Semantic Search Research Findings

> This research informs the Phase 2 plan (Task 7). Part of Phase 2 will be to write a docs file at `docs/plans/2026-02-19-telegram-search-options.md` documenting these findings in full.

### What We Already Have

- **`embedText(text, language?, type?)`** → 512-dimensional float vectors via DarwinKit NaturalLanguage bridge
- **`textDistance(text1, text2)`** → cosine distance (0=identical, 2=max different)
- **`scoreRelevance(query, text)`** → 0–1 similarity score
- **`rankBySimilarity(query, items)`** → ranked results (O(n²), practical up to ~200 items)
- **`better-sqlite3`** already in project deps

### Key Limitation: macOS NLEmbedding Language Support

NLEmbedding only supports **7 languages**: en, es, fr, de, it, pt, zh-Hans. **Czech and Slovak are NOT supported** for embeddings. `detectLanguage()` works for 60+ languages (including Czech), but embedding/semantic similarity is limited to the 7 above. This means semantic search will work well for English messages but will fall back to keyword search for Czech/Slovak content.

### Options Evaluated

#### 1. SQLite FTS5 (full-text keyword search)

- **Built-in** to SQLite on macOS — zero installation, zero deps
- BM25 ranking, stemming, prefix search, phrase/boolean queries, `highlight()` and `snippet()`
- Trigram tokenizer for substring matching (not edit-distance fuzzy)
- At < 100K messages, queries are sub-millisecond
- **Verdict:** Excellent for the keyword-search half. Use this as the baseline.

#### 2. sqlite-vec (vector similarity search) — **RECOMMENDED**

- Successor to deprecated `sqlite-vss`. Single C file, no FAISS dependency.
- `vec0` virtual tables with `float[512]` columns, KNN via `WHERE embedding MATCH ? AND k = 20`
- Cosine distance, L2, binary quantization (32× storage reduction, ~10× speedup)
- **Performance at our scale:** 100K vectors × 512 dims → brute-force KNN **under 75ms** on Apple Silicon
- **Hybrid search with FTS5:** Proven pattern — FTS5 + sqlite-vec CTEs joined via Reciprocal Rank Fusion (RRF)
- **Installation:** `bun add sqlite-vec` + `sqliteVec.load(db)` on `better-sqlite3` connection. Pre-compiled macOS arm64/x64 binaries ship in npm package.
- **macOS caveat:** `bun:sqlite` uses system SQLite which blocks extensions. Using `better-sqlite3` (already in deps) sidesteps this entirely.
- **Verdict:** Perfect complement to FTS5. Single `.db` file, in-process, instant cold start.

#### 3. ManticoreSearch — **NOT RECOMMENDED**

- External server daemon (`searchd`) via Homebrew, requires `manticore-columnar-lib` for KNN
- ~40 MB RAM at idle, client-server architecture via HTTP
- Replication unavailable on macOS
- **Verdict:** Wrong model for a local CLI tool. Designed for production web services at scale.

#### 4. Orama (pure TypeScript, in-memory) — **MODERATE**

- Full-text + vector + hybrid search, pure TypeScript, zero native deps
- **Excellent typo tolerance** (Levenshtein fuzzy matching) — this is its killer feature over FTS5
- **Problem:** Entire index lives in JS heap. At 100K messages with 512-dim embeddings: **~400–700 MB heap**
- **Problem:** Cold-start deserialization on every CLI invocation
- **Problem:** ~512 MB persistence file size ceiling
- **Verdict:** Good for long-running servers, poor for CLI tools with cold starts.

#### 5. Brute-force cosine in TypeScript (DIY)

- Store embeddings as BLOBs in SQLite, compute cosine in TypeScript
- 100K × 512 dims in plain TypeScript: ~30–75 ms per query (no SIMD)
- **Best pattern:** FTS5 pre-filter to ~1K candidates → cosine rerank in TypeScript (~5 ms)
- **Verdict:** Legitimate minimal starting point before adding sqlite-vec. Zero new deps.

### Recommendation for Phase 2

**FTS5 + sqlite-vec in the same SQLite database.**

1. **Single `.db` file**, opened by `better-sqlite3`, in-process, instant cold start
2. **True hybrid search:** FTS5 keyword results + sqlite-vec vector results joined via RRF in SQL
3. **Our `embedText()` fits exactly:** 512-dim floats → `vec0(embedding float[512])`
4. **Zero friction:** `better-sqlite3` already in deps, `bun add sqlite-vec` + one `load()` call
5. **Performance:** BM25 queries sub-ms, KNN queries < 75ms at 100K scale

**Fallback for unsupported languages (Czech/Slovak):** When embedding is unavailable for a language, fall back to FTS5-only keyword search. The hybrid pipeline should gracefully handle missing embeddings.

### Updated Phase 2 Architecture

The Phase 2 plan (Task 7) should use this schema:

```sql
-- Main messages table
CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    chat_id TEXT NOT NULL,
    sender_id TEXT,
    text TEXT,
    media_desc TEXT,
    is_outgoing INTEGER NOT NULL,
    date_unix INTEGER NOT NULL,
    date_iso TEXT NOT NULL
);

-- FTS5 full-text index (external content, references messages table)
CREATE VIRTUAL TABLE messages_fts USING fts5(
    text,
    content=messages,
    content_rowid=id,
    tokenize='unicode61'
);

-- Vector embeddings (sqlite-vec)
CREATE VIRTUAL TABLE messages_vec USING vec0(
    message_id INTEGER PRIMARY KEY,
    embedding float[512]
);

-- Sync tracking
CREATE TABLE sync_state (
    chat_id TEXT PRIMARY KEY,
    last_synced_id INTEGER NOT NULL,
    last_synced_at TEXT NOT NULL
);
```

**Hybrid search query pattern (Reciprocal Rank Fusion):**

```sql
WITH fts_results AS (
    SELECT rowid, rank FROM messages_fts WHERE text MATCH ? ORDER BY rank LIMIT 100
),
vec_results AS (
    SELECT message_id, distance FROM messages_vec WHERE embedding MATCH ? AND k = 100
),
combined AS (
    SELECT COALESCE(f.rowid, v.message_id) AS id,
           COALESCE(1.0 / (60 + f.rrf_rank), 0) + COALESCE(1.0 / (60 + v.rrf_rank), 0) AS score
    FROM (SELECT rowid, ROW_NUMBER() OVER () AS rrf_rank FROM fts_results) f
    FULL OUTER JOIN (SELECT message_id, ROW_NUMBER() OVER () AS rrf_rank FROM vec_results) v
    ON f.rowid = v.message_id
)
SELECT m.* FROM combined c JOIN messages m ON m.id = c.id ORDER BY c.score DESC LIMIT 20;
```

### New Dependencies for Phase 2

```bash
bun add sqlite-vec
# sqlite-vec ships pre-compiled for macOS arm64/x64 — no compilation needed
```
