import { assistantEngine } from "./AssistantEngine";
import type { SuggestionModeConfig } from "./types";

export interface SuggestionRequest {
    sessionId: string;
    mode: SuggestionModeConfig;
    incomingText: string;
    conversationHistory?: string;
    stylePrompt?: string;
}

export class SuggestionEngine {
    async generateSuggestions(request: SuggestionRequest): Promise<string[]> {
        const desired = Math.max(1, Math.min(request.mode.count, 5));
        const prompt =
            `Generate ${desired} possible message replies. ` +
            "Return each option on a new line without numbering. Keep each line under 220 characters." +
            `\n\nLatest incoming message:\n${request.incomingText}`;

        const response = await assistantEngine.ask({
            sessionId: `${request.sessionId}:suggestions`,
            mode: request.mode,
            conversationHistory: request.conversationHistory,
            stylePrompt: request.stylePrompt,
            incomingText: prompt,
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
