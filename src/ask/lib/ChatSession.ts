import type {
    SessionAssistantEntry,
    SessionConfigEntry,
    SessionContextEntry,
    SessionEntry,
    SessionStats,
    SessionSystemEntry,
    SessionUserEntry,
    ToolCallResult,
} from "./types";

export class ChatSession {
    readonly id: string;
    private entries: SessionEntry[] = [];
    private _statsCache: SessionStats | null = null;
    private _manager: ChatSessionManagerRef | null = null;

    constructor(id: string, entries?: SessionEntry[]) {
        this.id = id;

        if (entries) {
            this.entries = [...entries];
        }
    }

    /** Set the manager reference (called by ChatSessionManager) */
    setManager(manager: ChatSessionManagerRef): void {
        this._manager = manager;
    }

    /** Add an entry to the session */
    add(entry: {
        role: "user" | "assistant" | "system" | "context";
        content: string;
        label?: string;
        metadata?: Record<string, unknown>;
        thinking?: string;
        usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedInputTokens?: number };
        cost?: number;
        toolCalls?: ToolCallResult[];
    }): void {
        this._statsCache = null;
        const timestamp = new Date().toISOString();

        switch (entry.role) {
            case "user":
                this.entries.push({
                    type: "user",
                    content: entry.content,
                    timestamp,
                    metadata: entry.metadata,
                } satisfies SessionUserEntry);
                break;
            case "assistant":
                this.entries.push({
                    type: "assistant",
                    content: entry.content,
                    thinking: entry.thinking,
                    timestamp,
                    usage: entry.usage as SessionAssistantEntry["usage"],
                    cost: entry.cost,
                    toolCalls: entry.toolCalls,
                } satisfies SessionAssistantEntry);
                break;
            case "system":
                this.entries.push({
                    type: "system",
                    content: entry.content,
                    timestamp,
                } satisfies SessionSystemEntry);
                break;
            case "context":
                this.entries.push({
                    type: "context",
                    content: entry.content,
                    timestamp,
                    label: entry.label,
                    metadata: entry.metadata,
                } satisfies SessionContextEntry);
                break;
        }
    }

    /** Add a config entry */
    addConfig(provider: string, model: string, systemPrompt?: string): void {
        this._statsCache = null;
        this.entries.push({
            type: "config",
            timestamp: new Date().toISOString(),
            provider,
            model,
            systemPrompt,
        } satisfies SessionConfigEntry);
    }

    /** Add a raw session entry directly */
    addRaw(entry: SessionEntry): void {
        this._statsCache = null;
        this.entries.push(entry);
    }

    /** Get conversation history with optional filtering */
    getHistory(options?: { last?: number; roles?: string[]; since?: Date }): SessionEntry[] {
        let result = [...this.entries];

        if (options?.roles) {
            const roles = new Set(options.roles);
            result = result.filter((e) => roles.has(e.type));
        }

        if (options?.since) {
            const since = options.since;
            result = result.filter((e) => new Date(e.timestamp) >= since);
        }

        if (options?.last) {
            result = result.slice(-options.last);
        }

        return result;
    }

    /** Get all entries (raw access) */
    getAllEntries(): SessionEntry[] {
        return [...this.entries];
    }

    /** Convert to ChatEngine-compatible messages */
    toMessages(): Array<{ role: "user" | "assistant" | "system"; content: string }> {
        const messages: Array<{ role: "user" | "assistant" | "system"; content: string }> = [];

        for (const entry of this.entries) {
            switch (entry.type) {
                case "user":
                    messages.push({ role: "user", content: entry.content });
                    break;
                case "assistant":
                    messages.push({ role: "assistant", content: entry.content });
                    break;
                case "system":
                    messages.push({ role: "system", content: entry.content });
                    break;
                case "context":
                    messages.push({ role: "system", content: entry.content });
                    break;
                case "config":
                    // Skip config entries in messages
                    break;
            }
        }

        return messages;
    }

    /** Filter by role — returns new ChatSession */
    filterByRole(...roles: string[]): ChatSession {
        const roleSet = new Set(roles);
        const filtered = this.entries.filter((e) => roleSet.has(e.type));
        return new ChatSession(this.id, filtered);
    }

    /** Filter by date range — returns new ChatSession */
    filterByDateRange(since?: Date, until?: Date): ChatSession {
        const filtered = this.entries.filter((e) => {
            const ts = new Date(e.timestamp);

            if (since && ts < since) {
                return false;
            }

            if (until && ts > until) {
                return false;
            }

            return true;
        });
        return new ChatSession(this.id, filtered);
    }

    /** Filter by content substring — returns new ChatSession */
    filterByContent(query: string): ChatSession {
        const lowerQuery = query.toLowerCase();
        const filtered = this.entries.filter((e) => {
            if ("content" in e) {
                return e.content.toLowerCase().includes(lowerQuery);
            }
            return false;
        });
        return new ChatSession(this.id, filtered);
    }

    /** Clear conversation history */
    clear(): void {
        this.entries = [];
        this._statsCache = null;
    }

    /** Save session (delegates to manager) */
    async save(): Promise<string> {
        if (!this._manager) {
            throw new Error("No session manager configured — pass session options to AIChat constructor");
        }

        await this._manager.save(this);
        return this.id;
    }

    /** Load session (delegates to manager) */
    async load(sessionId: string): Promise<void> {
        if (!this._manager) {
            throw new Error("No session manager configured");
        }

        const loaded = await this._manager.load(sessionId);
        this.entries = loaded.getAllEntries();
        this._statsCache = null;
    }

    /** Export in various formats */
    async export(format: "jsonl" | "json" | "markdown" | "text"): Promise<string> {
        switch (format) {
            case "jsonl":
                return this.entries.map((e) => JSON.stringify(e)).join("\n");
            case "json":
                return JSON.stringify(this.entries, null, 2);
            case "markdown":
                return this.exportMarkdown();
            case "text":
                return this.exportText();
        }
    }

    /** Get session statistics */
    getStats(): SessionStats {
        if (this._statsCache) {
            return this._statsCache;
        }

        const byRole: Record<string, number> = {};
        let tokenCount = 0;
        let cost = 0;
        let startedAt = "";

        for (const entry of this.entries) {
            byRole[entry.type] = (byRole[entry.type] ?? 0) + 1;

            if (!startedAt) {
                startedAt = entry.timestamp;
            }

            if (entry.type === "assistant") {
                if (entry.usage) {
                    tokenCount += (entry.usage.inputTokens ?? 0) + (entry.usage.outputTokens ?? 0);
                }

                if (entry.cost) {
                    cost += entry.cost;
                }
            }
        }

        const lastEntry = this.entries[this.entries.length - 1];
        const duration =
            startedAt && lastEntry ? new Date(lastEntry.timestamp).getTime() - new Date(startedAt).getTime() : 0;

        this._statsCache = {
            messageCount: this.entries.length,
            tokenCount,
            cost,
            duration,
            startedAt,
            byRole,
        };

        return this._statsCache;
    }

    /** Number of entries */
    get length(): number {
        return this.entries.length;
    }

    private exportMarkdown(): string {
        const lines: string[] = [`# Chat Session: ${this.id}\n`];

        for (const entry of this.entries) {
            switch (entry.type) {
                case "config":
                    lines.push(`> **Config:** ${entry.provider}/${entry.model}\n`);
                    break;
                case "user":
                    lines.push(`**User:** ${entry.content}\n`);
                    break;
                case "assistant":
                    lines.push(`**Assistant:** ${entry.content}\n`);
                    break;
                case "system":
                    lines.push(`*System: ${entry.content}*\n`);
                    break;
                case "context":
                    lines.push(`*Context${entry.label ? ` [${entry.label}]` : ""}: ${entry.content}*\n`);
                    break;
            }
        }

        return lines.join("\n");
    }

    private exportText(): string {
        const lines: string[] = [];

        for (const entry of this.entries) {
            if (entry.type === "user") {
                lines.push(`You: ${entry.content}`);
            } else if (entry.type === "assistant") {
                lines.push(`AI: ${entry.content}`);
            }
        }

        return lines.join("\n");
    }
}

/** Minimal interface for manager reference (avoids circular imports) */
export interface ChatSessionManagerRef {
    save(session: ChatSession): Promise<void>;
    load(sessionId: string): Promise<ChatSession>;
}
