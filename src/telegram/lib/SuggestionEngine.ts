import { assistantEngine } from "./AssistantEngine";
import type { TelegramHistoryStore } from "./TelegramHistoryStore";
import type { SuggestionModeConfig } from "./types";

export interface SuggestionRequest {
    sessionId: string;
    mode: SuggestionModeConfig;
    incomingText: string;
    incomingMessageId?: number;
    conversationHistory?: string;
    stylePrompt?: string;
    rawStyleSamples?: string[];
    store?: TelegramHistoryStore;
    chatId?: string;
}

function buildFeedbackExamples(store: TelegramHistoryStore | undefined, chatId: string | undefined): string {
    if (!store || !chatId) {
        return "";
    }

    const rows = store.getSuggestionFeedback(chatId, 25);

    if (rows.length === 0) {
        return "";
    }

    const lines = rows.map((row) => {
        const editedSuffix = row.was_edited ? ` | edited="${row.edited_text ?? ""}"` : "";
        return `suggested="${row.suggestion_text}" | sent="${row.sent_text}"${editedSuffix}`;
    });

    return `\n\n[Suggestion edit feedback]\n${lines.join("\n")}`;
}

export class SuggestionEngine {
    async generateSuggestions(request: SuggestionRequest): Promise<string[]> {
        const desired = Math.max(1, Math.min(request.mode.count, 5));
        const feedbackExamples = buildFeedbackExamples(request.store, request.chatId);
        const prompt =
            `Generate ${desired} possible message replies. ` +
            "Return each option on a new line without numbering. Keep each line under 220 characters." +
            `\n\nLatest incoming message:\n${request.incomingText}` +
            feedbackExamples;

        const response = await assistantEngine.ask({
            sessionId: `${request.sessionId}:suggestions`,
            mode: request.mode,
            conversationHistory: request.conversationHistory,
            stylePrompt: request.stylePrompt,
            rawStyleSamples: request.rawStyleSamples,
            incomingText: prompt,
            store: request.store,
            chatId: request.chatId,
            includeFullDbHistory: true,
        });

        const lines = response
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => line.replace(/^[-*\d.)\s]+/, ""));

        return lines.slice(0, desired);
    }
}

export const suggestionEngine = new SuggestionEngine();
