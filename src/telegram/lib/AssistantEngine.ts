import { homedir } from "node:os";
import { resolve } from "node:path";
import { AIChat } from "@ask/AIChat";
import type { AskModeConfig } from "./types";

export interface AssistantRequest {
    sessionId: string;
    mode: AskModeConfig;
    incomingText: string;
    conversationHistory?: string;
    stylePrompt?: string;
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

    async ask(request: AssistantRequest): Promise<string> {
        const chat = this.getChat(request.sessionId, request.mode);

        if (request.stylePrompt) {
            chat.session.add({
                role: "system",
                content: `[Style profile]\n${request.stylePrompt}`,
            });
        }

        if (request.conversationHistory) {
            chat.session.add({
                role: "system",
                content: `[Recent conversation]\n${request.conversationHistory}`,
            });
        }

        const response = await chat.send(request.incomingText);

        return response.content;
    }

    async disposeAll(): Promise<void> {
        const disposals = [...this.sessions.values()].map((chat) => chat.dispose());
        await Promise.all(disposals);
        this.sessions.clear();
    }
}

export const assistantEngine = new AssistantEngine();
