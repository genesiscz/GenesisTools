import { homedir } from "node:os";
import { resolve } from "node:path";
import { AIChat } from "@ask/AIChat";
import type { AIChatTool } from "@ask/lib/types";
import { createAssistantTools } from "./AssistantTools";
import type { TelegramHistoryStore } from "./TelegramHistoryStore";
import type { AskModeConfig } from "./types";

const MAX_HISTORY_CONTEXT_CHARS = 90_000;

export interface AssistantRequest {
    sessionId: string;
    mode: AskModeConfig;
    incomingText: string;
    conversationHistory?: string;
    stylePrompt?: string;
    rawStyleSamples?: string[];
    store?: TelegramHistoryStore;
    chatId?: string;
    includeFullDbHistory?: boolean;
}

export class AssistantEngine {
    private sessions = new Map<string, AIChat>();

    private getCacheKey(sessionId: string, mode: AskModeConfig): string {
        return `${sessionId}:${mode.provider ?? "default"}:${mode.model ?? "default"}`;
    }

    private getChat(sessionId: string, mode: AskModeConfig): AIChat {
        const key = this.getCacheKey(sessionId, mode);
        const existing = this.sessions.get(key);

        if (existing) {
            return existing;
        }

        const chat = new AIChat({
            provider: mode.provider ?? "openai",
            model: mode.model ?? "gpt-4o-mini",
            systemPrompt: mode.systemPrompt,
            temperature: mode.temperature,
            maxTokens: mode.maxTokens,
            logLevel: "silent",
            session: {
                id: key,
                dir: resolve(homedir(), ".genesis-tools/telegram/ai-sessions"),
                autoSave: true,
            },
        });

        this.sessions.set(key, chat);

        return chat;
    }

    private buildTools(
        store: TelegramHistoryStore | undefined,
        chatId: string | undefined
    ): Record<string, AIChatTool> {
        if (!store || !chatId) {
            return {};
        }

        return createAssistantTools(store, chatId);
    }

    private buildFullHistoryContext(store: TelegramHistoryStore, chatId: string): string {
        const rows = store.queryMessages(chatId, {
            sender: "any",
        });
        const lines = rows.map((row) => {
            const who = row.is_outgoing ? "me" : "them";
            const text = row.text ?? row.media_desc ?? "";
            return `${row.date_iso} ${who}: ${text}`;
        });

        const all = lines.join("\n");

        if (all.length <= MAX_HISTORY_CONTEXT_CHARS) {
            return all;
        }

        return all.slice(all.length - MAX_HISTORY_CONTEXT_CHARS);
    }

    private buildPrompt(request: AssistantRequest): string {
        const sections: string[] = [];

        if (request.stylePrompt) {
            sections.push(`[Style summary]\n${request.stylePrompt}`);
        }

        if (request.rawStyleSamples && request.rawStyleSamples.length > 0) {
            sections.push(`[Raw style samples]\n${request.rawStyleSamples.join("\n")}`);
        }

        if (request.conversationHistory) {
            sections.push(`[Recent conversation]\n${request.conversationHistory}`);
        }

        if (request.includeFullDbHistory && request.store && request.chatId) {
            sections.push(
                "[Full DB history snapshot]\n" +
                    this.buildFullHistoryContext(request.store, request.chatId) +
                    "\n\n[Note] If you need specific ranges/filters, use available tools (query_messages/search_messages/list_attachments/get_stats/get_suggestion_feedback)."
            );
        }

        sections.push(`[User request]\n${request.incomingText}`);

        return sections.join("\n\n");
    }

    async ask(request: AssistantRequest): Promise<string> {
        const chat = this.getChat(request.sessionId, request.mode);
        const tools = this.buildTools(request.store, request.chatId);
        const toolCount = Object.keys(tools).length;

        if (toolCount > 0) {
            chat.updateConfig({
                tools,
            });
        }

        const response = await chat.send(this.buildPrompt(request), {
            addToHistory: false,
        });

        return response.content;
    }

    async disposeAll(): Promise<void> {
        const disposals = [...this.sessions.values()].map((chat) => chat.dispose());
        await Promise.all(disposals);
        this.sessions.clear();
    }
}

export const assistantEngine = new AssistantEngine();
