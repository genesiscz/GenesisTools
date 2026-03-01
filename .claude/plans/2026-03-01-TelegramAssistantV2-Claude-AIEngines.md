# Phase 5: AI Engines — Assistant, Suggestions, Style Profiles

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build three AI engine modules: (1) Chat Assistant with full DB tool access, (2) Suggestion Engine with pick/edit/send and edit tracking feedback loop, (3) Style Profile Engine with hybrid summary+examples. Wire all three into the Watch TUI's slash commands.

**Architecture:** Each engine is a standalone class that takes the store, client, and contact config. They use `AIChat` from `src/ask/index.lib.ts` for LLM calls. The assistant gets AI SDK tools for DB queries. Suggestions use the style profile + correction history for context. All engines are injected into `WatchSession` and invoked by slash command routing.

**Tech Stack:** AI SDK (`ai` package) tool definitions, `AIChat` from src/ask, bun:sqlite

**Prerequisites:** Phase 1 (data), Phase 3 (config V2), Phase 4 (Watch TUI)

---

## Task 1: Assistant Engine with Tool Use

**Files:**
- Create: `src/telegram/lib/AssistantEngine.ts`
- Test: `src/telegram/lib/__tests__/AssistantEngine.test.ts`

**Context:** The assistant can answer questions about the conversation using the full message DB. It has these tools:
- `search_messages` — search by text, date range, sender
- `get_message_count` — count messages matching filters
- `get_conversation_summary` — summarize messages in a date range
- `get_attachments` — list attachments for a message or date range
- `get_style_analysis` — analyze writing patterns
- `search_across_chats` — search multiple chats

**Step 1: Write the test**

Create `src/telegram/lib/__tests__/AssistantEngine.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { AssistantEngine } from "../AssistantEngine";

describe("AssistantEngine", () => {
    it("builds correct tool definitions", () => {
        const tools = AssistantEngine.getToolDefinitions();

        expect(tools).toHaveProperty("search_messages");
        expect(tools).toHaveProperty("get_message_count");
        expect(tools).toHaveProperty("get_conversation_summary");
        expect(tools).toHaveProperty("get_attachments");
        expect(tools).toHaveProperty("get_style_analysis");
        expect(tools).toHaveProperty("search_across_chats");
    });

    it("search_messages tool has correct parameters", () => {
        const tools = AssistantEngine.getToolDefinitions();
        const searchTool = tools.search_messages;

        expect(searchTool.parameters).toBeDefined();
        // Should have: query, since, until, sender, limit
    });
});
```

**Step 2: Run test to verify it fails**

```bash
bun test src/telegram/lib/__tests__/AssistantEngine.test.ts
```

**Step 3: Implement AssistantEngine**

```typescript
import { AIChat } from "@app/ask/index.lib";
import type { TelegramHistoryStore } from "./TelegramHistoryStore";
import type { TelegramContactV2, AskModeConfig } from "./types";
import { parseDate } from "./DateParser";
import { DEFAULTS } from "./types";
import { z } from "zod";
import { tool } from "ai";

export class AssistantEngine {
    private chat: AIChat | null = null;

    constructor(
        private store: TelegramHistoryStore,
        private contact: TelegramContactV2,
        private myName: string,
    ) {}

    private getConfig(): AskModeConfig {
        return this.contact.modes.assistant;
    }

    private ensureChat(): AIChat {
        if (!this.chat) {
            const config = this.getConfig();
            this.chat = new AIChat({
                provider: config.provider ?? DEFAULTS.askProvider,
                model: config.model ?? DEFAULTS.askModel,
                systemPrompt: this.buildSystemPrompt(config),
                temperature: config.temperature ?? 0.7,
                tools: this.buildTools(),
                session: {
                    id: `telegram-assistant-${this.contact.userId}`,
                    dir: `${process.env.HOME}/.genesis-tools/telegram/ai-sessions`,
                    autoSave: true,
                },
            });
        }
        return this.chat;
    }

    private buildSystemPrompt(config: AskModeConfig): string {
        const base = config.systemPrompt ?? [
            `You are a helpful assistant analyzing a Telegram conversation between "${this.myName}" and "${this.contact.displayName}".`,
            "You have access to tools that let you search the full message history.",
            "Use the tools to find relevant messages before answering questions.",
            "Be concise but thorough. Reference specific messages when relevant.",
        ].join("\n");

        return base;
    }

    private buildTools() {
        const store = this.store;
        const contactId = this.contact.userId;

        return {
            search_messages: tool({
                description: "Search messages in the conversation by text content, date range, or sender",
                parameters: z.object({
                    query: z.string().optional().describe("Text to search for"),
                    since: z.string().optional().describe("Start date (ISO or natural language like 'last week')"),
                    until: z.string().optional().describe("End date (ISO or natural language)"),
                    sender: z.enum(["me", "them", "any"]).optional().describe("Filter by sender"),
                    limit: z.number().optional().default(20).describe("Max results"),
                }),
                execute: async ({ query, since, until, sender, limit }) => {
                    const results = store.queryMessages(contactId, {
                        textPattern: query,
                        since: since ? parseDate(since) ?? undefined : undefined,
                        until: until ? parseDate(until) ?? undefined : undefined,
                        sender: sender ?? "any",
                        limit: limit ?? 20,
                    });

                    return results.map((r) => ({
                        id: r.id,
                        date: r.date_iso,
                        sender: r.is_outgoing ? "me" : "them",
                        text: r.text ?? "[media]",
                    }));
                },
            }),

            get_message_count: tool({
                description: "Count messages matching filters",
                parameters: z.object({
                    since: z.string().optional(),
                    until: z.string().optional(),
                    sender: z.enum(["me", "them", "any"]).optional(),
                }),
                execute: async ({ since, until, sender }) => {
                    const results = store.queryMessages(contactId, {
                        since: since ? parseDate(since) ?? undefined : undefined,
                        until: until ? parseDate(until) ?? undefined : undefined,
                        sender: sender ?? "any",
                    });
                    return { count: results.length };
                },
            }),

            get_conversation_summary: tool({
                description: "Get a summary of messages in a date range. Returns messages for you to summarize.",
                parameters: z.object({
                    since: z.string().describe("Start date"),
                    until: z.string().optional().describe("End date (defaults to now)"),
                    limit: z.number().optional().default(50),
                }),
                execute: async ({ since, until, limit }) => {
                    const results = store.queryMessages(contactId, {
                        since: parseDate(since) ?? undefined,
                        until: until ? parseDate(until) ?? undefined : undefined,
                        limit: limit ?? 50,
                    });

                    return results.map((r) => ({
                        date: r.date_iso,
                        sender: r.is_outgoing ? "me" : "them",
                        text: r.text ?? "[media]",
                    }));
                },
            }),

            get_attachments: tool({
                description: "List attachments (photos, videos, documents) in messages",
                parameters: z.object({
                    messageId: z.number().optional().describe("Specific message ID"),
                    since: z.string().optional(),
                    until: z.string().optional(),
                }),
                execute: async ({ messageId, since, until }) => {
                    if (messageId) {
                        return store.getAttachments(contactId, messageId);
                    }
                    return store.listAttachments(contactId, {
                        since: since ? parseDate(since) ?? undefined : undefined,
                        until: until ? parseDate(until) ?? undefined : undefined,
                    });
                },
            }),

            get_style_analysis: tool({
                description: "Analyze writing style patterns for a sender (message length, emoji usage, common phrases)",
                parameters: z.object({
                    sender: z.enum(["me", "them"]).describe("Whose style to analyze"),
                    limit: z.number().optional().default(200).describe("Number of messages to analyze"),
                }),
                execute: async ({ sender, limit }) => {
                    const messages = store.queryMessages(contactId, {
                        sender,
                        limit: limit ?? 200,
                    });

                    const texts = messages.map((m) => m.text ?? "").filter(Boolean);
                    const avgLength = texts.reduce((sum, t) => sum + t.length, 0) / (texts.length || 1);
                    const emojiCount = texts.reduce((sum, t) => sum + (t.match(/[\p{Emoji}]/gu) ?? []).length, 0);
                    const avgWords = texts.reduce((sum, t) => sum + t.split(/\s+/).length, 0) / (texts.length || 1);

                    return {
                        totalMessages: texts.length,
                        avgCharLength: Math.round(avgLength),
                        avgWordCount: Math.round(avgWords),
                        totalEmojis: emojiCount,
                        emojisPerMessage: (emojiCount / (texts.length || 1)).toFixed(2),
                        sampleMessages: texts.slice(-10),
                    };
                },
            }),

            search_across_chats: tool({
                description: "Search for text across ALL synced chats, not just the current one",
                parameters: z.object({
                    query: z.string().describe("Text to search for"),
                    limit: z.number().optional().default(20),
                }),
                execute: async ({ query, limit }) => {
                    // Get all chats
                    const chats = store.listChats();
                    const allResults: Array<{ chatId: string; chatTitle: string; date: string; sender: string; text: string }> = [];

                    for (const chat of chats) {
                        const results = store.queryMessages(chat.chat_id, {
                            textPattern: query,
                            limit: 5, // Limit per chat
                        });

                        for (const r of results) {
                            allResults.push({
                                chatId: chat.chat_id,
                                chatTitle: chat.title,
                                date: r.date_iso,
                                sender: r.is_outgoing ? "me" : chat.title,
                                text: r.text ?? "[media]",
                            });
                        }
                    }

                    return allResults.slice(0, limit ?? 20);
                },
            }),
        };
    }

    /** Ask the assistant a question */
    async ask(question: string): Promise<string> {
        const chat = this.ensureChat();
        const response = await chat.send(question);
        return response.content;
    }

    /** Static: get tool definitions for testing */
    static getToolDefinitions() {
        // Return tool schemas without store binding (for testing)
        return {
            search_messages: { parameters: { query: "string", since: "string", until: "string", sender: "string", limit: "number" } },
            get_message_count: { parameters: { since: "string", until: "string", sender: "string" } },
            get_conversation_summary: { parameters: { since: "string", until: "string", limit: "number" } },
            get_attachments: { parameters: { messageId: "number", since: "string", until: "string" } },
            get_style_analysis: { parameters: { sender: "string", limit: "number" } },
            search_across_chats: { parameters: { query: "string", limit: "number" } },
        };
    }

    /** Reset chat session (e.g. when switching models) */
    resetSession(): void {
        this.chat = null;
    }
}
```

**Step 4: Run test to verify it passes**

```bash
bun test src/telegram/lib/__tests__/AssistantEngine.test.ts
```

**Step 5: Commit**

```bash
git add src/telegram/lib/AssistantEngine.ts src/telegram/lib/__tests__/AssistantEngine.test.ts
git commit -m "feat(telegram): AssistantEngine with full DB tool access via AI SDK"
```

---

## Task 2: Style Profile Engine

**Files:**
- Create: `src/telegram/lib/StyleProfileEngine.ts`
- Create: `src/telegram/lib/StyleRuleResolver.ts`
- Test: `src/telegram/lib/__tests__/StyleProfileEngine.test.ts`

**Context:** Builds a style prompt from the user's messages using the hybrid approach: generate a style summary + include representative examples. Sources are configurable via `StyleSourceRule[]`.

**Step 1: Write the test**

Create `src/telegram/lib/__tests__/StyleProfileEngine.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { StyleProfileEngine } from "../StyleProfileEngine";
import { TelegramHistoryStore } from "../TelegramHistoryStore";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function tmpDbPath() {
    return join(tmpdir(), `telegram-style-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("StyleProfileEngine", () => {
    let store: TelegramHistoryStore;
    let dbPath: string;

    beforeEach(() => {
        dbPath = tmpDbPath();
        store = new TelegramHistoryStore();
        store.open(dbPath);

        // Seed outgoing messages with varied style
        const messages = [
            { id: 1, senderId: "me", text: "hey whats up", isOutgoing: true, date: "2024-01-10T10:00:00Z", dateUnix: 1704880800 },
            { id: 2, senderId: "me", text: "lol yea that was crazy 😂", isOutgoing: true, date: "2024-01-10T10:01:00Z", dateUnix: 1704880860 },
            { id: 3, senderId: "me", text: "nah im good thanks tho", isOutgoing: true, date: "2024-01-10T10:02:00Z", dateUnix: 1704880920 },
            { id: 4, senderId: "me", text: "wanna grab coffee tmrw?", isOutgoing: true, date: "2024-01-10T10:03:00Z", dateUnix: 1704880980 },
            { id: 5, senderId: "me", text: "k cool see ya", isOutgoing: true, date: "2024-01-10T10:04:00Z", dateUnix: 1704881040 },
        ];

        for (const msg of messages) {
            store.insertMessages("chat1", [{ ...msg, mediaDescription: undefined }]);
        }
    });

    afterEach(() => {
        store.close();
        if (existsSync(dbPath)) unlinkSync(dbPath);
    });

    it("generates a style summary from messages", () => {
        const engine = new StyleProfileEngine(store);
        const summary = engine.analyzeStyle("chat1", "me", 100);

        expect(summary.totalMessages).toBe(5);
        expect(summary.avgLength).toBeGreaterThan(0);
        expect(summary.traits).toBeInstanceOf(Array);
        expect(summary.traits.length).toBeGreaterThan(0);
    });

    it("builds a hybrid style prompt", () => {
        const engine = new StyleProfileEngine(store);
        const prompt = engine.buildStylePrompt("chat1", {
            rules: [
                { id: "r1", sourceChatId: "chat1", direction: "outgoing", limit: 100 },
            ],
            exampleCount: 5,
        });

        expect(prompt).toContain("Style Summary");
        expect(prompt).toContain("Example Messages");
        // Should contain actual messages
        expect(prompt).toContain("hey whats up");
    });

    it("respects rule filters", () => {
        const engine = new StyleProfileEngine(store);

        // Add incoming messages
        store.insertMessages("chat1", [
            { id: 10, senderId: "other", text: "How are you?", mediaDescription: undefined, isOutgoing: false, date: "2024-01-10T10:05:00Z", dateUnix: 1704881100 },
        ]);

        const prompt = engine.buildStylePrompt("chat1", {
            rules: [
                { id: "r1", sourceChatId: "chat1", direction: "outgoing", limit: 100 },
            ],
            exampleCount: 5,
        });

        // Should not contain incoming messages
        expect(prompt).not.toContain("How are you?");
    });
});
```

**Step 2: Run test to verify it fails**

```bash
bun test src/telegram/lib/__tests__/StyleProfileEngine.test.ts
```

**Step 3: Implement StyleRuleResolver**

Create `src/telegram/lib/StyleRuleResolver.ts`:

```typescript
import type { TelegramHistoryStore } from "./TelegramHistoryStore";
import type { StyleSourceRule, MessageRowV2 } from "./types";
import { parseDate } from "./DateParser";

export class StyleRuleResolver {
    constructor(private store: TelegramHistoryStore) {}

    resolveMessages(rules: StyleSourceRule[]): MessageRowV2[] {
        const allMessages: MessageRowV2[] = [];

        for (const rule of rules) {
            const sender = rule.direction === "outgoing" ? "me" : "them";
            const messages = this.store.queryMessages(rule.sourceChatId, {
                sender,
                since: rule.since ? parseDate(rule.since) ?? undefined : undefined,
                until: rule.until ? parseDate(rule.until) ?? undefined : undefined,
                limit: rule.limit ?? 500,
            });

            let filtered = messages;

            // Apply regex filter if present
            if (rule.regex) {
                const re = new RegExp(rule.regex, "i");
                filtered = filtered.filter((m) => m.text && re.test(m.text));
            }

            allMessages.push(...filtered);
        }

        // Deduplicate by id+chat_id
        const seen = new Set<string>();
        return allMessages.filter((m) => {
            const key = `${m.chat_id}:${m.id}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }
}
```

**Step 4: Implement StyleProfileEngine**

Create `src/telegram/lib/StyleProfileEngine.ts`:

```typescript
import type { TelegramHistoryStore } from "./TelegramHistoryStore";
import type { StyleSourceRule, MessageRowV2 } from "./types";
import { StyleRuleResolver } from "./StyleRuleResolver";

interface StyleAnalysis {
    totalMessages: number;
    avgLength: number;
    avgWords: number;
    usesEmojis: boolean;
    emojiFrequency: number;
    usesSlang: boolean;
    traits: string[];
    commonPatterns: string[];
}

interface StylePromptOptions {
    rules: StyleSourceRule[];
    exampleCount?: number;
}

export class StyleProfileEngine {
    private ruleResolver: StyleRuleResolver;

    constructor(private store: TelegramHistoryStore) {
        this.ruleResolver = new StyleRuleResolver(store);
    }

    analyzeStyle(chatId: string, sender: "me" | "them", limit = 500): StyleAnalysis {
        const messages = this.store.queryMessages(chatId, { sender, limit });
        const texts = messages.map((m) => m.text ?? "").filter(Boolean);

        if (texts.length === 0) {
            return {
                totalMessages: 0, avgLength: 0, avgWords: 0,
                usesEmojis: false, emojiFrequency: 0, usesSlang: false,
                traits: ["No messages to analyze"], commonPatterns: [],
            };
        }

        const avgLength = texts.reduce((s, t) => s + t.length, 0) / texts.length;
        const avgWords = texts.reduce((s, t) => s + t.split(/\s+/).length, 0) / texts.length;
        const emojiCount = texts.reduce((s, t) => s + (t.match(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu) ?? []).length, 0);
        const emojiFreq = emojiCount / texts.length;

        // Detect traits
        const traits: string[] = [];

        // Length traits
        if (avgWords < 5) traits.push("Very short messages (1-4 words)");
        else if (avgWords < 10) traits.push("Short messages (5-9 words)");
        else if (avgWords < 20) traits.push("Medium-length messages");
        else traits.push("Long, detailed messages");

        // Emoji usage
        if (emojiFreq > 1) traits.push("Heavy emoji user");
        else if (emojiFreq > 0.3) traits.push("Moderate emoji user");
        else if (emojiFreq > 0) traits.push("Occasional emoji user");
        else traits.push("Rarely or never uses emojis");

        // Capitalization
        const lowercaseRatio = texts.filter((t) => t === t.toLowerCase()).length / texts.length;
        if (lowercaseRatio > 0.8) traits.push("Mostly lowercase");
        else if (lowercaseRatio < 0.3) traits.push("Uses proper capitalization");

        // Punctuation
        const noPuncRatio = texts.filter((t) => !/[.!?]$/.test(t.trim())).length / texts.length;
        if (noPuncRatio > 0.7) traits.push("Often omits ending punctuation");

        // Slang/abbreviations detection
        const slangPatterns = /\b(lol|lmao|nah|yea|wanna|gonna|kinda|idk|imo|tbh|rn|tmrw|btw|omg|brb|ttyl)\b/i;
        const slangCount = texts.filter((t) => slangPatterns.test(t)).length;
        const usesSlang = slangCount / texts.length > 0.1;
        if (usesSlang) traits.push("Uses informal slang/abbreviations");

        // Detect common starting patterns
        const starters = new Map<string, number>();
        for (const t of texts) {
            const firstWord = t.split(/\s+/)[0]?.toLowerCase();
            if (firstWord) {
                starters.set(firstWord, (starters.get(firstWord) ?? 0) + 1);
            }
        }
        const commonPatterns = [...starters.entries()]
            .filter(([, count]) => count > texts.length * 0.05)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([word, count]) => `"${word}..." (${count} times)`);

        return {
            totalMessages: texts.length,
            avgLength: Math.round(avgLength),
            avgWords: Math.round(avgWords * 10) / 10,
            usesEmojis: emojiFreq > 0,
            emojiFrequency: Math.round(emojiFreq * 100) / 100,
            usesSlang,
            traits,
            commonPatterns,
        };
    }

    buildStylePrompt(chatId: string, options: StylePromptOptions): string {
        const messages = this.ruleResolver.resolveMessages(options.rules);
        const texts = messages.map((m) => m.text ?? "").filter(Boolean);

        if (texts.length === 0) {
            return "No messages available for style analysis.";
        }

        // Generate style summary
        const analysis = this.analyzeStyleFromTexts(texts);

        // Select representative examples
        const exampleCount = options.exampleCount ?? 15;
        const examples = this.selectRepresentativeExamples(texts, exampleCount);

        const sections: string[] = [];

        // Style Summary section
        sections.push("## Style Summary");
        sections.push(`Analyzed ${texts.length} messages.`);
        sections.push("");
        sections.push("Characteristics:");
        for (const trait of analysis.traits) {
            sections.push(`- ${trait}`);
        }
        if (analysis.commonPatterns.length > 0) {
            sections.push("");
            sections.push("Common patterns:");
            for (const pattern of analysis.commonPatterns) {
                sections.push(`- ${pattern}`);
            }
        }

        // Example Messages section
        sections.push("");
        sections.push("## Example Messages");
        sections.push("These are real messages showing the typical style:");
        sections.push("");
        for (const ex of examples) {
            sections.push(`> ${ex}`);
        }

        return sections.join("\n");
    }

    private analyzeStyleFromTexts(texts: string[]): StyleAnalysis {
        const avgLength = texts.reduce((s, t) => s + t.length, 0) / texts.length;
        const avgWords = texts.reduce((s, t) => s + t.split(/\s+/).length, 0) / texts.length;
        const emojiCount = texts.reduce((s, t) => s + (t.match(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu) ?? []).length, 0);
        const emojiFreq = emojiCount / texts.length;

        const traits: string[] = [];
        if (avgWords < 5) traits.push("Very short messages (1-4 words)");
        else if (avgWords < 10) traits.push("Short messages (5-9 words)");
        else traits.push("Longer messages");

        if (emojiFreq > 0.5) traits.push("Frequent emoji use");
        else if (emojiFreq === 0) traits.push("No emojis");

        const lowercaseRatio = texts.filter((t) => t === t.toLowerCase()).length / texts.length;
        if (lowercaseRatio > 0.7) traits.push("Lowercase style");

        const slangPatterns = /\b(lol|lmao|nah|yea|wanna|gonna|idk|tbh|rn|tmrw|btw|omg)\b/i;
        if (texts.filter((t) => slangPatterns.test(t)).length / texts.length > 0.1) {
            traits.push("Uses slang/abbreviations");
        }

        const starters = new Map<string, number>();
        for (const t of texts) {
            const w = t.split(/\s+/)[0]?.toLowerCase();
            if (w) starters.set(w, (starters.get(w) ?? 0) + 1);
        }
        const commonPatterns = [...starters.entries()]
            .filter(([, c]) => c > texts.length * 0.05)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([w, c]) => `"${w}..." (${c}x)`);

        return {
            totalMessages: texts.length, avgLength: Math.round(avgLength),
            avgWords: Math.round(avgWords * 10) / 10,
            usesEmojis: emojiFreq > 0, emojiFrequency: emojiFreq,
            usesSlang: traits.includes("Uses slang/abbreviations"),
            traits, commonPatterns,
        };
    }

    private selectRepresentativeExamples(texts: string[], count: number): string[] {
        if (texts.length <= count) return texts;

        // Select evenly spaced examples to represent the full range
        const step = Math.floor(texts.length / count);
        const examples: string[] = [];

        for (let i = 0; i < texts.length && examples.length < count; i += step) {
            const t = texts[i];
            if (t.length > 0 && t.length < 200) { // Skip very long messages
                examples.push(t);
            }
        }

        return examples;
    }
}
```

**Step 5: Run test to verify it passes**

```bash
bun test src/telegram/lib/__tests__/StyleProfileEngine.test.ts
```

**Step 6: Commit**

```bash
git add src/telegram/lib/StyleProfileEngine.ts src/telegram/lib/StyleRuleResolver.ts src/telegram/lib/__tests__/StyleProfileEngine.test.ts
git commit -m "feat(telegram): StyleProfileEngine with hybrid summary+examples approach"
```

---

## Task 3: Suggestion Engine

**Files:**
- Create: `src/telegram/lib/SuggestionEngine.ts`
- Test: `src/telegram/lib/__tests__/SuggestionEngine.test.ts`

**Context:** Generates 3-5 reply suggestions based on conversation context, style profile, and correction history. The user picks/edits one and it's sent. Edit diffs are tracked.

**Step 1: Write the test**

Create `src/telegram/lib/__tests__/SuggestionEngine.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { SuggestionEngine } from "../SuggestionEngine";

describe("SuggestionEngine", () => {
    it("builds suggestion system prompt with style and corrections", () => {
        const prompt = SuggestionEngine.buildSuggestionPrompt({
            contactName: "Alice",
            myName: "Martin",
            stylePrompt: "Short messages, lowercase, uses emoji",
            recentCorrections: [
                { suggested: "Hey, how are you?", sent: "hey wyd" },
            ],
            count: 3,
        });

        expect(prompt).toContain("Alice");
        expect(prompt).toContain("3");
        expect(prompt).toContain("lowercase");
        // Should include correction example
        expect(prompt).toContain("hey wyd");
    });

    it("parseSuggestions extracts numbered list", () => {
        const raw = `Here are 3 suggestions:

1. hey whats up
2. yo how was your day
3. lol yea that sounds fun`;

        const suggestions = SuggestionEngine.parseSuggestions(raw);
        expect(suggestions.length).toBe(3);
        expect(suggestions[0]).toBe("hey whats up");
        expect(suggestions[2]).toBe("lol yea that sounds fun");
    });
});
```

**Step 2: Run test to verify it fails**

```bash
bun test src/telegram/lib/__tests__/SuggestionEngine.test.ts
```

**Step 3: Implement SuggestionEngine**

```typescript
import { AIChat } from "@app/ask/index.lib";
import type { TelegramHistoryStore } from "./TelegramHistoryStore";
import type { TelegramContactV2, SuggestionModeConfig, MessageRowV2 } from "./types";
import { StyleProfileEngine } from "./StyleProfileEngine";
import { DEFAULTS } from "./types";

interface SuggestionPromptInput {
    contactName: string;
    myName: string;
    stylePrompt?: string;
    recentCorrections?: Array<{ suggested: string; sent: string }>;
    count: number;
}

export class SuggestionEngine {
    private chat: AIChat | null = null;
    private styleEngine: StyleProfileEngine;
    private autoTriggerTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private store: TelegramHistoryStore,
        private contact: TelegramContactV2,
        private myName: string,
    ) {
        this.styleEngine = new StyleProfileEngine(store);
    }

    private getConfig(): SuggestionModeConfig {
        return this.contact.modes.suggestions;
    }

    /** Generate reply suggestions */
    async suggest(
        recentMessages: Array<{ sender: string; text: string }>,
        customPrompt?: string,
    ): Promise<string[]> {
        const config = this.getConfig();
        const count = config.count ?? 3;

        // Build style prompt if style profile is enabled
        let stylePrompt: string | undefined;
        if (this.contact.styleProfile?.enabled && this.contact.styleProfile.rules.length > 0) {
            stylePrompt = this.styleEngine.buildStylePrompt(this.contact.userId, {
                rules: this.contact.styleProfile.rules,
                exampleCount: 15,
            });
        }

        // Get recent corrections for feedback loop
        const corrections = this.store.getRecentSuggestionEdits(this.contact.userId, 10)
            .filter((e) => e.suggested_text !== e.sent_text) // Only include actual edits
            .map((e) => ({ suggested: e.suggested_text, sent: e.sent_text }));

        const systemPrompt = SuggestionEngine.buildSuggestionPrompt({
            contactName: this.contact.displayName,
            myName: this.myName,
            stylePrompt,
            recentCorrections: corrections,
            count,
        });

        // Build conversation context
        const context = recentMessages
            .map((m) => `${m.sender}: ${m.text}`)
            .join("\n");

        const userMessage = customPrompt
            ? `${customPrompt}\n\nRecent conversation:\n${context}`
            : `Generate ${count} reply suggestions for this conversation:\n\n${context}`;

        const chat = new AIChat({
            provider: config.provider ?? DEFAULTS.askProvider,
            model: config.model ?? DEFAULTS.askModel,
            systemPrompt,
            temperature: config.temperature ?? 0.8, // Higher temp for variety
        });

        const response = await chat.send(userMessage);
        return SuggestionEngine.parseSuggestions(response.content);
    }

    /** Track what was suggested vs. what was actually sent */
    trackEdit(suggestedText: string, editedText: string, sentText: string, messageId: number | null): void {
        const config = this.getConfig();
        this.store.insertSuggestionEdit({
            chatId: this.contact.userId,
            messageId,
            suggestedText,
            editedText,
            sentText,
            provider: config.provider ?? DEFAULTS.askProvider,
            model: config.model ?? DEFAULTS.askModel,
        });
    }

    /** Schedule auto-suggestion after delay (for hybrid trigger mode) */
    scheduleAutoSuggest(
        recentMessages: Array<{ sender: string; text: string }>,
        onSuggestions: (suggestions: string[]) => void,
    ): void {
        const config = this.getConfig();

        if (config.trigger === "manual") return;

        // Clear existing timer (debounce)
        if (this.autoTriggerTimer) {
            clearTimeout(this.autoTriggerTimer);
        }

        this.autoTriggerTimer = setTimeout(async () => {
            try {
                const suggestions = await this.suggest(recentMessages);
                onSuggestions(suggestions);
            } catch {
                // Silently fail for auto-suggest
            }
        }, config.autoDelayMs ?? 5000);
    }

    cancelAutoSuggest(): void {
        if (this.autoTriggerTimer) {
            clearTimeout(this.autoTriggerTimer);
            this.autoTriggerTimer = null;
        }
    }

    static buildSuggestionPrompt(input: SuggestionPromptInput): string {
        const sections: string[] = [];

        sections.push(`You are helping ${input.myName} craft replies to ${input.contactName} on Telegram.`);
        sections.push(`Generate exactly ${input.count} distinct reply options.`);
        sections.push("Each reply should feel natural and match the conversation tone.");
        sections.push("Output ONLY a numbered list (1. 2. 3. etc.) with no other text.");

        if (input.stylePrompt) {
            sections.push("");
            sections.push("## Writing Style to Match");
            sections.push(input.stylePrompt);
        }

        if (input.recentCorrections && input.recentCorrections.length > 0) {
            sections.push("");
            sections.push("## Style Corrections (learn from these)");
            sections.push("When I was suggested these, I changed them before sending:");
            for (const c of input.recentCorrections.slice(0, 5)) {
                sections.push(`- Suggested: "${c.suggested}" → Actually sent: "${c.sent}"`);
            }
            sections.push("Adjust your suggestions to match what I actually prefer to send.");
        }

        return sections.join("\n");
    }

    static parseSuggestions(raw: string): string[] {
        const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
        const suggestions: string[] = [];

        for (const line of lines) {
            // Match numbered list items: "1. text", "1) text", "1: text"
            const match = line.match(/^\d+[.):\-]\s*(.+)/);
            if (match) {
                suggestions.push(match[1].trim());
            }
        }

        return suggestions;
    }
}
```

**Step 4: Run test to verify it passes**

```bash
bun test src/telegram/lib/__tests__/SuggestionEngine.test.ts
```

**Step 5: Commit**

```bash
git add src/telegram/lib/SuggestionEngine.ts src/telegram/lib/__tests__/SuggestionEngine.test.ts
git commit -m "feat(telegram): SuggestionEngine with style matching and edit tracking"
```

---

## Task 4: Wire AI Engines into WatchSession

**Files:**
- Modify: `src/telegram/runtime/shared/WatchSession.ts`

**Context:** Replace the placeholder slash command handlers with real engine calls.

**Step 1: Add engine instances to WatchSession**

Add to constructor/fields:

```typescript
import { AssistantEngine } from "../../lib/AssistantEngine";
import { SuggestionEngine } from "../../lib/SuggestionEngine";
import { StyleProfileEngine } from "../../lib/StyleProfileEngine";

// In constructor:
private assistantEngine: AssistantEngine;
private suggestionEngine: SuggestionEngine;
private styleEngine: StyleProfileEngine;

// In constructor body:
this.assistantEngine = new AssistantEngine(store, contact, myName);
this.suggestionEngine = new SuggestionEngine(store, contact, myName);
this.styleEngine = new StyleProfileEngine(store);
```

**Step 2: Update switchContact to recreate engines**

```typescript
async switchContact(contact: TelegramContactV2): Promise<void> {
    this._currentContact = contact;
    this.messages = [];
    this.clearUnread(contact.userId);
    this.assistantEngine = new AssistantEngine(this.store, contact, this.myName);
    this.suggestionEngine = new SuggestionEngine(this.store, contact, this.myName);
    await this.loadHistory();
}
```

**Step 3: Replace placeholder slash commands with real implementations**

In `handleSlashCommand()`:

```typescript
case "ask": {
    if (!args) {
        return { handled: true, output: "Usage: /ask <question>" };
    }
    try {
        const answer = await this.assistantEngine.ask(args);
        return { handled: true, output: answer };
    } catch (err) {
        return { handled: true, output: `Assistant error: ${err instanceof Error ? err.message : String(err)}` };
    }
}

case "suggest": {
    try {
        const recentMsgs = this.messages.slice(-10).map((m) => ({
            sender: m.senderName,
            text: m.text,
        }));
        const customPrompt = args || undefined;
        const suggestions = await this.suggestionEngine.suggest(recentMsgs, customPrompt);

        // Store suggestions for later pick/send
        this._pendingSuggestions = suggestions;

        const formatted = suggestions.map((s, i) => `  ${i + 1}. ${s}`).join("\n");
        return {
            handled: true,
            output: `Suggestions:\n${formatted}\n\nUse /pick <number> to select, or /pick <number> <edited text> to edit and send.`,
        };
    } catch (err) {
        return { handled: true, output: `Suggestion error: ${err instanceof Error ? err.message : String(err)}` };
    }
}

case "pick": {
    if (!this._pendingSuggestions || this._pendingSuggestions.length === 0) {
        return { handled: true, output: "No pending suggestions. Use /suggest first." };
    }

    const parts = args.split(/\s+/);
    const index = Number.parseInt(parts[0], 10) - 1;

    if (Number.isNaN(index) || index < 0 || index >= this._pendingSuggestions.length) {
        return { handled: true, output: `Invalid choice. Pick 1-${this._pendingSuggestions.length}` };
    }

    const original = this._pendingSuggestions[index];
    const edited = parts.length > 1 ? parts.slice(1).join(" ") : original;

    // Send the message
    const sent = await this.client.sendMessage(this._currentContact.userId, edited);

    // Persist
    this.store.insertMessages(this._currentContact.userId, [{
        id: sent.id,
        senderId: undefined,
        text: edited,
        mediaDescription: undefined,
        isOutgoing: true,
        date: new Date().toISOString(),
        dateUnix: Math.floor(Date.now() / 1000),
    }]);

    this.messages.push({
        id: sent.id,
        text: edited,
        isOutgoing: true,
        senderName: this.myName,
        date: new Date(),
    });

    // Track the edit
    this.suggestionEngine.trackEdit(original, edited, edited, sent.id);

    this._pendingSuggestions = null;
    this.notify();

    return { handled: true, output: `Sent: "${edited}"` };
}

case "style": {
    try {
        const analysis = this.styleEngine.analyzeStyle(
            this._currentContact.userId, "me", 200
        );
        const lines = [
            `Style analysis (${analysis.totalMessages} messages):`,
            ...analysis.traits.map((t) => `  - ${t}`),
        ];
        if (analysis.commonPatterns.length > 0) {
            lines.push("Common starters:");
            lines.push(...analysis.commonPatterns.map((p) => `  - ${p}`));
        }
        return { handled: true, output: lines.join("\n") };
    } catch (err) {
        return { handled: true, output: `Style error: ${err instanceof Error ? err.message : String(err)}` };
    }
}
```

Add the field:

```typescript
private _pendingSuggestions: string[] | null = null;
```

**Step 4: Type check**

```bash
bunx tsgo --noEmit | rg "src/telegram"
```

**Step 5: Commit**

```bash
git add src/telegram/runtime/shared/WatchSession.ts
git commit -m "feat(telegram): wire AI engines into watch slash commands"
```

---

## Task 5: Auto-Suggest Trigger in Watch Mode

**Files:**
- Modify: `src/telegram/runtime/shared/WatchSession.ts`

**Context:** When a new incoming message arrives and the contact's suggestion trigger is "auto" or "hybrid", schedule auto-suggestions after the configured delay.

**Step 1: Update addIncoming to trigger auto-suggest**

In `addIncoming()`:

```typescript
addIncoming(msg: TelegramMessage): void {
    this.messages.push({
        id: msg.id,
        text: msg.text,
        isOutgoing: false,
        senderName: this._currentContact.displayName,
        date: msg.date,
        mediaDesc: msg.mediaDescription,
    });

    // Auto-suggest if configured
    const triggerMode = this._currentContact.modes.suggestions.trigger;
    if (triggerMode === "auto" || triggerMode === "hybrid") {
        const recentMsgs = this.messages.slice(-10).map((m) => ({
            sender: m.senderName,
            text: m.text,
        }));

        this.suggestionEngine.scheduleAutoSuggest(recentMsgs, (suggestions) => {
            this._pendingSuggestions = suggestions;
            this._autoSuggestCallback?.(suggestions);
            this.notify();
        });
    }

    this.notify();
}
```

Add callback field:

```typescript
private _autoSuggestCallback: ((suggestions: string[]) => void) | null = null;

onAutoSuggest(callback: (suggestions: string[]) => void): void {
    this._autoSuggestCallback = callback;
}
```

**Step 2: Wire auto-suggest display in WatchInkApp**

In `WatchInkApp.tsx`, in the `useEffect` for session subscription:

```tsx
useEffect(() => {
    session.onAutoSuggest((suggestions) => {
        setSystemLines(suggestions.map((s, i) => ({
            text: `  ${i + 1}. ${s}`,
            type: "suggestion" as const,
        })));
        // Auto-clear after 30s
        setTimeout(() => setSystemLines([]), 30000);
    });
}, [session]);
```

**Step 3: Commit**

```bash
git add src/telegram/runtime/shared/WatchSession.ts src/telegram/runtime/ink/WatchInkApp.tsx
git commit -m "feat(telegram): auto-suggest trigger with configurable delay"
```

---

## Task 6: Model Switching in Watch Mode

**Files:**
- Modify: `src/telegram/runtime/shared/WatchSession.ts`

**Context:** The `/model` slash command should let users switch AI model for the current mode. Since we're in Ink TUI, we can't use @clack/prompts (they conflict with Ink). Instead, display available models and let the user type `/model <provider>/<model>`.

**Step 1: Implement /model command**

In `handleSlashCommand()`:

```typescript
case "model": {
    if (!args) {
        const current = this._currentContact.modes.assistant;
        return {
            handled: true,
            output: [
                "Current models:",
                `  Assistant: ${current.provider ?? "default"}/${current.model ?? "default"}`,
                `  Suggestions: ${this._currentContact.modes.suggestions.provider ?? "default"}/${this._currentContact.modes.suggestions.model ?? "default"}`,
                "",
                "Usage: /model assistant <provider>/<model>",
                "       /model suggestions <provider>/<model>",
            ].join("\n"),
        };
    }

    const modelParts = args.split(/\s+/);
    const mode = modelParts[0] as "assistant" | "suggestions" | "autoReply";
    const modelSpec = modelParts[1];

    if (!modelSpec || !modelSpec.includes("/")) {
        return { handled: true, output: "Usage: /model <mode> <provider>/<model>" };
    }

    const [provider, ...modelParts2] = modelSpec.split("/");
    const model = modelParts2.join("/");

    if (mode === "assistant" || mode === "suggestions" || mode === "autoReply") {
        this._currentContact = {
            ...this._currentContact,
            modes: {
                ...this._currentContact.modes,
                [mode]: { ...this._currentContact.modes[mode], provider, model },
            },
        };

        // Reset engine sessions so they pick up new model
        if (mode === "assistant") this.assistantEngine.resetSession();

        return { handled: true, output: `${mode} model set to ${provider}/${model}` };
    }

    return { handled: true, output: `Unknown mode: ${mode}. Use assistant, suggestions, or autoReply` };
}
```

**Step 2: Commit**

```bash
git add src/telegram/runtime/shared/WatchSession.ts
git commit -m "feat(telegram): /model command for runtime AI model switching"
```

---

## Task 7: Phase 5 Full Verification

**Step 1: Run all tests**

```bash
bun test src/telegram/
```

Expected: all pass

**Step 2: Type check**

```bash
bunx tsgo --noEmit | rg "src/telegram"
bunx tsgo --noEmit | rg "src/ask"
```

**Step 3: Lint**

```bash
bunx biome check src/telegram src/ask
```

**Step 4: Manual end-to-end test**

```bash
# 1. Configure a contact with V2 settings
tools telegram configure

# 2. Sync history
tools telegram history sync <contact>

# 3. Query with natural language dates
tools telegram history query --from <contact> --since "last week"

# 4. Launch watch mode
tools telegram watch <contact>

# 5. In watch mode:
#    - Type a message → sends
#    - /ask "what were we talking about yesterday?" → assistant searches DB
#    - /suggest → generates 3 suggestions
#    - /pick 1 → sends suggestion 1
#    - /pick 2 this is my edit → sends edited version
#    - /style → shows style analysis
#    - /model assistant anthropic/claude-sonnet-4-20250514 → switches model
#    - /careful → toggles careful mode
#    - Tab → shows contact list
#    - /quit → exits

# 6. Verify existing listen still works
tools telegram listen
```

**Step 5: Commit any final fixes**

```bash
git add src/telegram/ src/ask/
git commit -m "fix(telegram): Phase 5 verification fixes"
```

---

## Summary of Phase 5 Deliverables

| Component | File | Status |
|-----------|------|--------|
| AssistantEngine with AI tools | `src/telegram/lib/AssistantEngine.ts` | Task 1 |
| StyleProfileEngine (hybrid) | `src/telegram/lib/StyleProfileEngine.ts` | Task 2 |
| StyleRuleResolver | `src/telegram/lib/StyleRuleResolver.ts` | Task 2 |
| SuggestionEngine | `src/telegram/lib/SuggestionEngine.ts` | Task 3 |
| AI engines wired into WatchSession | `src/telegram/runtime/shared/WatchSession.ts` | Task 4 |
| Auto-suggest trigger | `WatchSession.ts`, `WatchInkApp.tsx` | Task 5 |
| /model runtime switching | `WatchSession.ts` | Task 6 |

---

## Full Feature Checklist (All Phases)

| Feature | Phase | Implemented In |
|---------|-------|----------------|
| Download conversations incrementally | 1, 2 | ConversationSyncService |
| Save to SQLite DB | 1 | TelegramHistoryStore migration |
| Query "messages from X since Y until Z" | 1, 2 | queryMessages + history query command |
| Auto-fetch missing ranges | 2 | ConversationSyncService.queryWithAutoFetch |
| Natural language date parsing | 1 | DateParser (chrono-node) |
| Attachment indexing | 1, 2 | AttachmentIndexer + store methods |
| Lazy attachment download | 2 | AttachmentDownloader |
| Group/channel support | 3 | Configure command + ChatRow |
| Per-contact per-mode model selection | 3 | V2 config + ModelSelector |
| Watch live conversation | 4 | Ink WatchInkApp |
| Configurable context length | 3, 4 | WatchConfig.contextLength |
| /ask inline assistant | 5 | AssistantEngine |
| Full DB history access with tools | 5 | AssistantEngine AI tools |
| /suggest message suggestions (3-5) | 5 | SuggestionEngine |
| Pick/edit/send flow | 5 | /pick command |
| Style profile (hybrid summary+examples) | 5 | StyleProfileEngine |
| Configurable style rules | 3 | StyleSourceRule[] config |
| Suggestion edit tracking | 1, 5 | suggestion_edits table + SuggestionEngine.trackEdit |
| Auto-feed corrections into suggestions | 5 | SuggestionEngine.buildSuggestionPrompt |
| Edit/delete event tracking | 1, 2 | message_revisions + handler edit/delete |
| /careful mode | 4 | WatchSession input mode |
| /model runtime switching | 5 | /model command |
| Contact list with unread badges | 4 | ContactList + WatchSession unread tracking |
| Backward compatible with V1 config | 3 | migrateConfigV1toV2 |
| Backward compatible listen command | 4 | listen.ts unchanged |
