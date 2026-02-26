# AIChat Library Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Read `.claude/plans/giggly-whistling-puppy.md` for the full API design spec — it is the source of truth for all interfaces, types, and behavior. This plan provides the step-by-step implementation tasks.

**Goal:** Extract the ask tool's core into `AIChat` — a programmatic, provider-agnostic LLM chat class with session persistence, typed streaming events, and internal log capture. Fixes telegram stdout leakage by eliminating the subprocess approach.

**Architecture:** `AIChat` is a facade over existing components (ChatEngine, ProviderManager, ModelSelector, DynamicPricing). It owns a `ChatSession` (JSONL-backed conversation state) and a `ChatLog` (in-memory log capture). `send()` returns a `ChatTurn` that is both `PromiseLike<ChatResponse>` and `AsyncIterable<ChatEvent>`. The existing `tools ask` CLI and telegram handler become thin wrappers around `AIChat`.

**Tech Stack:** TypeScript, Bun, Vercel AI SDK (`ai` package), pino (captured), JSONL storage

---

## Task 1: Types

**Files:**
- Create: `src/ask/lib/types.ts`

**Step 1: Write the types file**

All interfaces from the design spec. Reference: `.claude/plans/giggly-whistling-puppy.md` → "Types" section.

```typescript
import type { LanguageModelUsage } from "ai";

// Re-export relevant existing types
export type { ProviderChoice, DetectedProvider, ModelInfo } from "@ask/types";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug" | "trace";

export interface AIChatOptions {
    provider: string;
    model: string;
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
    tools?: Record<string, AIChatTool>;
    logLevel?: LogLevel;
    session?: {
        dir?: string;
        id?: string;
        autoSave?: boolean;
    };
    resume?: string;
}

export interface AIChatTool {
    description: string;
    parameters: unknown; // ZodSchema or JSON schema object
    execute: (params: Record<string, unknown>) => Promise<unknown>;
}

export interface SendOptions {
    onChunk?: (text: string) => void;
    override?: Partial<Omit<AIChatOptions, "session" | "resume">>;
    addToHistory?: boolean;
    saveThinking?: boolean;
}

export interface ChatResponse {
    content: string;
    thinking?: string;
    usage?: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        cachedInputTokens?: number;
    };
    cost?: number;
    duration: number;
    toolCalls?: ToolCallResult[];
}

export interface ToolCallResult {
    name: string;
    input: unknown;
    output: unknown;
    duration: number;
}

export type SessionEntry =
    | SessionConfigEntry
    | SessionUserEntry
    | SessionAssistantEntry
    | SessionSystemEntry
    | SessionContextEntry;

export interface SessionConfigEntry {
    type: "config";
    timestamp: string;
    provider: string;
    model: string;
    systemPrompt?: string;
}

export interface SessionUserEntry {
    type: "user";
    content: string;
    timestamp: string;
    metadata?: Record<string, unknown>;
}

export interface SessionAssistantEntry {
    type: "assistant";
    content: string;
    thinking?: string;
    timestamp: string;
    usage?: LanguageModelUsage;
    cost?: number;
    toolCalls?: ToolCallResult[];
}

export interface SessionSystemEntry {
    type: "system";
    content: string;
    timestamp: string;
}

export interface SessionContextEntry {
    type: "context";
    content: string;
    timestamp: string;
    label?: string;
    metadata?: Record<string, unknown>;
}

export interface AIChatSelection {
    provider: string;
    model: string;
}

export interface LogEntry {
    level: LogLevel;
    message: string;
    timestamp: Date;
    source?: string;
}

export interface SessionStats {
    messageCount: number;
    tokenCount: number;
    cost: number;
    duration: number;
    startedAt: string;
    byRole: Record<string, number>;
}
```

**Step 2: Verify types compile**

Run: `bunx tsgo --noEmit 2>&1 | rg "src/ask/lib/types"`
Expected: No errors

**Step 3: Commit**

```bash
git add src/ask/lib/types.ts
git commit -m "feat(ask): add AIChat type definitions"
```

---

## Task 2: ChatEvent

**Files:**
- Create: `src/ask/lib/ChatEvent.ts`
- Create: `src/ask/lib/__tests__/ChatEvent.test.ts`

**Step 1: Write the test**

```typescript
import { describe, expect, it } from "bun:test";
import { ChatEvent } from "../ChatEvent";

describe("ChatEvent", () => {
    it("creates text event with factory", () => {
        const event = ChatEvent.text("hello");
        expect(event.type).toBe("text");
        expect(event.isText()).toBe(true);
        expect(event.text).toBe("hello");
        expect(event.isDone()).toBe(false);
    });

    it("creates done event with response", () => {
        const response = { content: "hi", duration: 100 };
        const event = ChatEvent.done(response as any);
        expect(event.isDone()).toBe(true);
        expect(event.response).toBe(response);
        expect(event.isText()).toBe(false);
    });

    it("creates thinking event", () => {
        const event = ChatEvent.thinking("reasoning...");
        expect(event.isThinking()).toBe(true);
        expect(event.text).toBe("reasoning...");
    });

    it("creates tool_call event", () => {
        const event = ChatEvent.toolCall("searchWeb", { query: "test" });
        expect(event.isToolCall()).toBe(true);
        expect(event.name).toBe("searchWeb");
        expect(event.input).toEqual({ query: "test" });
    });

    it("creates tool_result event", () => {
        const event = ChatEvent.toolResult("searchWeb", { results: [] }, 150);
        expect(event.isToolResult()).toBe(true);
        expect(event.name).toBe("searchWeb");
        expect(event.duration).toBe(150);
    });

    it("type guards narrow correctly", () => {
        const event = ChatEvent.text("hi");
        if (event.isText()) {
            // TypeScript should see event.text as string (not undefined)
            const _text: string = event.text;
            expect(_text).toBe("hi");
        }
    });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/ask/lib/__tests__/ChatEvent.test.ts`
Expected: FAIL — module not found

**Step 3: Implement ChatEvent**

```typescript
import type { ChatResponse } from "./types";

type ChatEventType = "text" | "thinking" | "tool_call" | "tool_result" | "done";

export class ChatEvent {
    readonly type: ChatEventType;
    readonly text?: string;
    readonly name?: string;
    readonly input?: unknown;
    readonly output?: unknown;
    readonly duration?: number;
    readonly response?: ChatResponse;

    private constructor(type: ChatEventType, data: Partial<Omit<ChatEvent, "type">>) {
        this.type = type;
        Object.assign(this, data);
    }

    // === Factory methods ===
    static text(text: string): ChatEvent { return new ChatEvent("text", { text }); }
    static thinking(text: string): ChatEvent { return new ChatEvent("thinking", { text }); }
    static toolCall(name: string, input: unknown): ChatEvent { return new ChatEvent("tool_call", { name, input }); }
    static toolResult(name: string, output: unknown, duration: number): ChatEvent { return new ChatEvent("tool_result", { name, output, duration }); }
    static done(response: ChatResponse): ChatEvent { return new ChatEvent("done", { response }); }

    // === Type guards ===
    isText(): this is ChatEvent & { text: string } { return this.type === "text"; }
    isThinking(): this is ChatEvent & { text: string } { return this.type === "thinking"; }
    isToolCall(): this is ChatEvent & { name: string; input: unknown } { return this.type === "tool_call"; }
    isToolResult(): this is ChatEvent & { name: string; output: unknown; duration: number } { return this.type === "tool_result"; }
    isDone(): this is ChatEvent & { response: ChatResponse } { return this.type === "done"; }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/ask/lib/__tests__/ChatEvent.test.ts`
Expected: All pass

**Step 5: Commit**

```bash
git add src/ask/lib/ChatEvent.ts src/ask/lib/__tests__/ChatEvent.test.ts
git commit -m "feat(ask): add ChatEvent class with type guards and factories"
```

---

## Task 3: ChatLog

**Files:**
- Create: `src/ask/lib/ChatLog.ts`
- Create: `src/ask/lib/__tests__/ChatLog.test.ts`

**Step 1: Write the test**

```typescript
import { describe, expect, it } from "bun:test";
import { ChatLog } from "../ChatLog";

describe("ChatLog", () => {
    it("captures logs at or above configured level", () => {
        const log = new ChatLog("warn");
        log.capture("info", "should be ignored", "Source");
        log.capture("warn", "visible warning", "DynamicPricing");
        log.capture("error", "visible error", "ProviderManager");

        const all = log.getAll();
        expect(all).toHaveLength(2);
        expect(all[0].message).toBe("visible warning");
        expect(all[0].source).toBe("DynamicPricing");
    });

    it("getUnseen returns entries since last call", () => {
        const log = new ChatLog("info");
        log.capture("info", "first");
        log.capture("info", "second");

        const batch1 = log.getUnseen();
        expect(batch1).toHaveLength(2);

        log.capture("info", "third");
        const batch2 = log.getUnseen();
        expect(batch2).toHaveLength(1);
        expect(batch2[0].message).toBe("third");
    });

    it("getUnseen with level filter", () => {
        const log = new ChatLog("info");
        log.capture("info", "info msg");
        log.capture("warn", "warn msg");
        log.capture("error", "error msg");

        const warnings = log.getUnseen({ level: "warn" });
        expect(warnings).toHaveLength(2); // warn + error
    });

    it("silent level captures nothing", () => {
        const log = new ChatLog("silent");
        log.capture("error", "should not appear");
        expect(log.getAll()).toHaveLength(0);
    });

    it("clear resets everything", () => {
        const log = new ChatLog("info");
        log.capture("info", "test");
        log.clear();
        expect(log.getAll()).toHaveLength(0);
        expect(log.getUnseen()).toHaveLength(0);
    });

    it("createLogger produces a pino-compatible interface", () => {
        const log = new ChatLog("info");
        const logger = log.createLogger("TestSource");
        logger.info("hello from logger");
        logger.warn("warning from logger");
        logger.debug("should be ignored at info level");

        const entries = log.getAll();
        expect(entries).toHaveLength(2);
        expect(entries[0].source).toBe("TestSource");
    });
});
```

**Step 2: Run test — verify failure**

Run: `bun test src/ask/lib/__tests__/ChatLog.test.ts`

**Step 3: Implement ChatLog**

Create `src/ask/lib/ChatLog.ts`. Key points:
- `LOG_LEVELS` map for numeric comparison (reuse pattern from `src/logger.ts` lines 18-25)
- `capture(level, message, source?)` — checks level threshold, pushes to array
- `getUnseen()` — tracks cursor index, returns slice from cursor
- `createLogger(source)` — returns `{ info, warn, error, debug, trace }` object that calls `capture()`
- Never writes to `process.stdout` or `process.stderr`

**Step 4: Run test — verify pass**

Run: `bun test src/ask/lib/__tests__/ChatLog.test.ts`

**Step 5: Commit**

```bash
git add src/ask/lib/ChatLog.ts src/ask/lib/__tests__/ChatLog.test.ts
git commit -m "feat(ask): add ChatLog — in-memory log capture with cursor-based getUnseen"
```

---

## Task 4: ChatSession

**Files:**
- Create: `src/ask/lib/ChatSession.ts`
- Create: `src/ask/lib/__tests__/ChatSession.test.ts`

**Step 1: Write the test**

Tests for: `add()`, `getHistory()`, `toMessages()`, `filterByRole()`, `filterByDateRange()`, `filterByContent()`, `clear()`, `getStats()`, `export()`.

Key test cases:
- `add({ role: "context" })` creates a context entry with timestamp
- `getHistory({ last: 2 })` returns last 2 entries
- `getHistory({ roles: ["user", "assistant"] })` filters by role
- `toMessages()` maps context→system, skips config entries
- `filterByRole("user")` returns new ChatSession with only user entries
- `clear()` resets entries but keeps id
- `getStats()` computes counts, cost, duration
- `export("jsonl")` produces valid JSONL
- `export("markdown")` produces readable markdown

**Step 2: Run test — verify failure**

**Step 3: Implement ChatSession**

Create `src/ask/lib/ChatSession.ts`. Key points:
- Constructor takes `id: string`, optional `entries: SessionEntry[]`
- `add()` appends with auto-generated timestamp
- `getHistory()` with `last`, `roles`, `since` filtering
- `toMessages()` maps entries to `{ role, content }[]` — context entries become system role, config entries are skipped
- Filter methods return `new ChatSession(this.id, filteredEntries)`
- `getStats()` iterates entries once, caches result (invalidated on add/clear)
- `export("jsonl")` → entries.map(JSON.stringify).join("\n")

**Step 4: Run test — verify pass**

**Step 5: Commit**

```bash
git add src/ask/lib/ChatSession.ts src/ask/lib/__tests__/ChatSession.test.ts
git commit -m "feat(ask): add ChatSession — in-memory session with filtering and export"
```

---

## Task 5: ChatSessionManager (JSONL persistence)

**Files:**
- Create: `src/ask/lib/ChatSessionManager.ts`
- Create: `src/ask/lib/__tests__/ChatSessionManager.test.ts`

**Step 1: Write the test**

Tests for: `create()`, `save()`, `load()`, `list()`, `delete()`. Use a temp dir for file I/O.

Key test cases:
- `create()` returns ChatSession with generated UUID
- `create("custom-id")` uses the provided ID
- `save()` writes JSONL file, `load()` reads it back with identical entries
- `list()` returns all sessions sorted by date
- `delete()` removes the file
- Loading a non-existent session throws/returns null

**Step 2: Run test — verify failure**

**Step 3: Implement ChatSessionManager**

Create `src/ask/lib/ChatSessionManager.ts`. Key points:
- Constructor takes `{ dir: string }`, auto-creates directory
- `save(session)`: write `session.entries` as JSONL to `<dir>/<id>.jsonl`
- `load(sessionId)`: read JSONL file, parse lines, return new `ChatSession(id, entries)`
- `list()`: read directory, parse first line of each file for metadata
- File path: `resolve(dir, `${sessionId}.jsonl`)`
- Use `Bun.write()` for writes, `Bun.file().text()` for reads

**Step 4: Run test — verify pass**

**Step 5: Commit**

```bash
git add src/ask/lib/ChatSessionManager.ts src/ask/lib/__tests__/ChatSessionManager.test.ts
git commit -m "feat(ask): add ChatSessionManager — JSONL session persistence"
```

---

## Task 6: ChatTurn

**Files:**
- Create: `src/ask/lib/ChatTurn.ts`
- Create: `src/ask/lib/__tests__/ChatTurn.test.ts`

**Step 1: Write the test**

Tests for: `await` resolves to ChatResponse, `for await` yields ChatEvent instances, `.response` promise, `onChunk` callback.

Key test cases:
- Construct ChatTurn with a mock async generator of ChatEvents
- `await turn` resolves with the ChatResponse from the done event
- `for await (const event of turn)` yields all events in order
- `turn.response` resolves with same ChatResponse
- With `onChunk`: callback fires for each text event

**Step 2: Run test — verify failure**

**Step 3: Implement ChatTurn**

Create `src/ask/lib/ChatTurn.ts`. Key points:
- Constructor takes `source: AsyncGenerator<ChatEvent>` and optional `onChunk`
- Implements `[Symbol.asyncIterator]()` — yields from source, calls `onChunk` for text events
- Implements `then()` (PromiseLike) — iterates internally, buffers text, resolves with ChatResponse
- `.response` is a deferred Promise that resolves when the done event is emitted
- Only one consumer (await or iterate) — second access replays from buffer if possible

**Step 4: Run test — verify pass**

**Step 5: Commit**

```bash
git add src/ask/lib/ChatTurn.ts src/ask/lib/__tests__/ChatTurn.test.ts
git commit -m "feat(ask): add ChatTurn — dual PromiseLike + AsyncIterable response handle"
```

---

## Task 7: Modify ChatEngine — Add onChunk callback

**Files:**
- Modify: `src/ask/chat/ChatEngine.ts`

**Step 1: Read the current ChatEngine**

Read `src/ask/chat/ChatEngine.ts` fully. Locate `sendStreamingMessage()` — find the `process.stdout.write(chunk)` calls (around lines 120-129). Also check `sendNonStreamingMessage()`.

**Step 2: Add callback parameters**

Add to `sendMessage()` signature:
```typescript
async sendMessage(
    message: string,
    tools?: Record<string, unknown>,
    callbacks?: {
        onChunk?: (chunk: string) => void;
        onThinking?: (text: string) => void;
    }
): Promise<ChatResponse>
```

**Step 3: Modify streaming path**

In `sendStreamingMessage()`, replace:
```typescript
process.stdout.write(chunk);
```
with:
```typescript
if (callbacks?.onChunk) {
    callbacks.onChunk(chunk);
} else {
    process.stdout.write(chunk);
}
```

Do the same for the trailing newline write. Also wire `onThinking` if the AI SDK provides thinking blocks.

**Step 4: Verify existing CLI still works**

Run: `tools ask -p openai -m gpt-4o-mini "say hello in one word"`
Expected: Still streams output to terminal (default behavior preserved)

**Step 5: Commit**

```bash
git add src/ask/chat/ChatEngine.ts
git commit -m "feat(ask): add onChunk/onThinking callbacks to ChatEngine.sendMessage"
```

---

## Task 8: AIChat — Core class

**Files:**
- Create: `src/ask/AIChat.ts`
- Create: `src/ask/__tests__/AIChat.test.ts`

This is the main task. Break into sub-steps:

**Step 1: Write integration test (constructor + send)**

Test that AIChat can be constructed and `send()` returns a ChatResponse. Use a real provider if API key is available, or mock ChatEngine. At minimum test:
- Constructor resolves provider/model
- `await chat.send("hello")` returns `{ content, duration }`
- `chat.session.getHistory()` has user + assistant entries after send
- `chat.log.getAll()` has no entries at logLevel "silent"

**Step 2: Implement constructor**

In `src/ask/AIChat.ts`:
- Accept `AIChatOptions`
- Create `ChatLog` with configured `logLevel`
- Create `ChatSession` (or load via `ChatSessionManager` if `resume` is set)
- Resolve provider/model: call `providerManager.detectProviders()` then `modelSelector.selectModelByName(provider, model)` — but pass the captured logger so no stdout
- Create `ChatEngine` with the resolved `ChatConfig`
- Wire `ChatSessionManager` if session config provided
- Expose `.session`, `.log`, `.getConfig()`, `.updateConfig()`

**Step 3: Implement `send()`**

- Create `ChatTurn` wrapping an async generator:
  1. Add user entry to session (if `addToHistory !== false`)
  2. Build messages from `session.toMessages()`
  3. Handle `override` — temporarily create new ChatEngine config if provider/model differ
  4. Call `chatEngine.sendMessage(message, tools, { onChunk, onThinking })` where onChunk/onThinking yield ChatEvents
  5. After completion: create `ChatResponse` from the engine response
  6. Add assistant entry to session (if `addToHistory`)
  7. If `autoSave`: call `session.save()`
  8. Yield `ChatEvent.done(response)`
- Return the `ChatTurn`

**Step 4: Implement `stream()`**

- Store the latest `ChatTurn` as `this._activeTurn`
- `stream()` returns `this._activeTurn[Symbol.asyncIterator]()`

**Step 5: Implement static methods**

```typescript
static async getProviders(filter?): Promise<ProviderInfo[]> {
    await providerManager.detectProviders();
    const providers = providerManager.getAvailableProviders();
    // apply capability filter if provided
    return providers;
}

static async getModels(options): Promise<ModelInfo[]> {
    await providerManager.detectProviders();
    return providerManager.getModelsForProvider(options.provider);
}

static async selectProviderInteractively(): Promise<ProviderInfo> {
    return modelSelector.selectProvider();
}

static async selectModelInteractively(options?): Promise<AIChatSelection> {
    const choice = await modelSelector.selectModel();
    return { provider: choice.provider.name, model: choice.model.id };
}
```

**Step 6: Implement `dispose()`**

- If autoSave: `await this.session.save()`
- Clean up ChatEngine if needed

**Step 7: Run tests**

Run: `bun test src/ask/__tests__/AIChat.test.ts`

**Step 8: Commit**

```bash
git add src/ask/AIChat.ts src/ask/__tests__/AIChat.test.ts
git commit -m "feat(ask): add AIChat class — programmatic LLM chat with session and log capture"
```

---

## Task 9: Barrel export

**Files:**
- Create: `src/ask/index.lib.ts`

**Step 1: Create barrel export**

```typescript
export { AIChat } from "./AIChat";
export { ChatEvent } from "./lib/ChatEvent";
export { ChatSession } from "./lib/ChatSession";
export { ChatSessionManager } from "./lib/ChatSessionManager";
export { ChatLog } from "./lib/ChatLog";
export { ChatTurn } from "./lib/ChatTurn";
export type {
    AIChatOptions,
    AIChatTool,
    AIChatSelection,
    SendOptions,
    ChatResponse,
    ToolCallResult,
    SessionEntry,
    LogEntry,
    LogLevel,
    SessionStats,
} from "./lib/types";
```

**Step 2: Verify it compiles**

Run: `bunx tsgo --noEmit 2>&1 | rg "src/ask/"`

**Step 3: Commit**

```bash
git add src/ask/index.lib.ts
git commit -m "feat(ask): add barrel export for AIChat library"
```

---

## Task 10: Migrate telegram handler

**Files:**
- Modify: `src/telegram/lib/actions/ask.ts`
- Modify: `src/telegram/lib/handler.ts` (or wherever contact chat state belongs)

**Step 1: Read current telegram handler files**

Read `src/telegram/lib/actions/ask.ts` and `src/telegram/lib/handler.ts` to understand current flow.

**Step 2: Add contact chat map**

In the appropriate file (handler.ts or a new module), add:
```typescript
import { AIChat } from "@ask/AIChat";
const contactChats = new Map<string, AIChat>();
```

**Step 3: Replace subprocess call in ask.ts**

Replace the `runTool()` call with:
```typescript
let chat = contactChats.get(contact.userId);

if (!chat) {
    chat = new AIChat({
        provider: contact.askProvider,
        model: contact.askModel,
        systemPrompt: contact.askSystemPrompt,
        logLevel: "silent",
        session: {
            id: `telegram-${contact.userId}`,
            dir: resolve(homedir(), ".genesis-tools/telegram/ai-sessions"),
            autoSave: true,
        },
    });
    contactChats.set(contact.userId, chat);
}

chat.session.add({ role: "context", content: message.contentForLLM, label: "telegram-incoming" });

const response = await chat.send(message.contentForLLM);
await client.sendMessage(contact.userId, response.content);
```

**Step 4: Remove runTool import if no longer needed**

**Step 5: Test manually**

Run: `tools telegram listen`
Send a test message to a configured contact.
Expected: Response contains ONLY the AI response — no "Created conversations directory" or "WARN: Failed to fetch" leakage.

**Step 6: Commit**

```bash
git add src/telegram/lib/actions/ask.ts src/telegram/lib/handler.ts
git commit -m "fix(telegram): use in-process AIChat — eliminates stdout leakage in responses"
```

---

## Task 11: Migrate CLI `tools ask`

**Files:**
- Modify: `src/ask/index.ts`

This is a larger refactor. The existing `ASKTool` class in `index.ts` should be rewritten to use `AIChat` for both single-message and interactive modes.

**Step 1: Read current index.ts**

Read `src/ask/index.ts` fully. Understand both `handleSingleMessage()` and `startInteractiveChat()`.

**Step 2: Refactor single-message mode**

Replace `handleSingleMessage()` with:
```typescript
private async handleSingleMessage(argv: Args): Promise<void> {
    const chat = new AIChat({
        provider: argv.provider,
        model: argv.model,
        systemPrompt: createSystemPrompt(argv.systemPrompt),
        temperature: parseTemperature(argv.temperature),
        maxTokens: parseMaxTokens(argv.maxTokens),
        logLevel: argv.raw ? "silent" : "info",
        tools: /* existing tools setup */,
    });

    const message = argv._.join(" ");

    if (argv.raw) {
        const response = await chat.send(message);
        process.stdout.write(response.content.endsWith("\n") ? response.content : `${response.content}\n`);
        return;
    }

    // Streaming with UI output
    p.log.info(`Using ${colorizeProvider(chat.getConfig().provider)}/${chat.getConfig().model}`);
    p.log.step(pc.yellow("Thinking..."));

    for await (const event of chat.send(message)) {
        if (event.isText()) process.stdout.write(event.text);
        if (event.isDone() && event.response.cost) {
            console.log(await outputManager.formatCostBreakdown([/* ... */]));
        }
    }
}
```

**Step 3: Refactor interactive mode**

Replace `startInteractiveChat()` with:
```typescript
private async startInteractiveChat(argv: Args): Promise<void> {
    const selection = await AIChat.selectModelInteractively();
    const chat = new AIChat({
        ...selection,
        systemPrompt: createSystemPrompt(argv.systemPrompt),
        temperature: parseTemperature(argv.temperature),
        maxTokens: parseMaxTokens(argv.maxTokens),
        session: { dir: "./conversations", autoSave: true },
    });

    // ... main loop uses chat.send() with onChunk or for-await
}
```

**Step 4: Test single-message mode**

Run: `tools ask -p openai -m gpt-4o-mini --raw "say hello"`
Expected: Only the response text on stdout.

Run: `tools ask -p openai -m gpt-4o-mini "say hello"`
Expected: Streaming output with cost breakdown.

**Step 5: Test interactive mode**

Run: `tools ask`
Expected: Model selection, then conversation loop works.

**Step 6: Commit**

```bash
git add src/ask/index.ts
git commit -m "refactor(ask): CLI uses AIChat internally — cleaner, no stdout leakage in raw mode"
```

---

## Task 12: Final verification

**Step 1: Run all tests**

```bash
bun test src/ask/
```

**Step 2: Type check**

```bash
bunx tsgo --noEmit 2>&1 | rg "src/ask/"
```

**Step 3: Manual integration tests**

1. `tools ask -p openai -m gpt-4o-mini --raw "hello"` — only response text
2. `tools ask -p openai -m gpt-4o-mini "hello"` — streaming + cost
3. `tools telegram listen` — send message, verify no log leakage
4. Check JSONL session file exists after telegram conversation

**Step 4: Final commit if any cleanup needed**
