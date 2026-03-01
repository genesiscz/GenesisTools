import { AIChat } from "@app/ask/index.lib";
import { StyleProfileEngine } from "./StyleProfileEngine";
import type { TelegramHistoryStore } from "./TelegramHistoryStore";
import { DEFAULTS } from "./types";
import type { SuggestionModeConfig, TelegramContactV2 } from "./types";

interface SuggestionPromptInput {
    contactName: string;
    myName: string;
    stylePrompt?: string;
    recentCorrections?: Array<{ suggested: string; sent: string }>;
    count: number;
}

export class SuggestionEngine {
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

    async suggest(
        recentMessages: Array<{ sender: string; text: string }>,
        customPrompt?: string,
    ): Promise<string[]> {
        const config = this.getConfig();
        const count = config.count ?? 3;

        let stylePrompt: string | undefined;

        if (this.contact.styleProfile?.enabled && this.contact.styleProfile.rules.length > 0) {
            stylePrompt = this.styleEngine.buildStylePrompt(this.contact.userId, {
                rules: this.contact.styleProfile.rules,
                exampleCount: 15,
            });
        }

        const corrections = this.store
            .getRecentSuggestionEdits(this.contact.userId, 10)
            .filter((e) => e.suggested_text !== e.sent_text)
            .map((e) => ({ suggested: e.suggested_text, sent: e.sent_text }));

        const systemPrompt = SuggestionEngine.buildSuggestionPrompt({
            contactName: this.contact.displayName,
            myName: this.myName,
            stylePrompt,
            recentCorrections: corrections,
            count,
        });

        const context = recentMessages.map((m) => `${m.sender}: ${m.text}`).join("\n");

        const userMessage = customPrompt
            ? `${customPrompt}\n\nRecent conversation:\n${context}`
            : `Generate ${count} reply suggestions for this conversation:\n\n${context}`;

        const chat = new AIChat({
            provider: config.provider ?? DEFAULTS.askProvider,
            model: config.model ?? DEFAULTS.askModel,
            systemPrompt,
            temperature: config.temperature ?? 0.8,
        });

        const response = await chat.send(userMessage);
        return SuggestionEngine.parseSuggestions(response.content);
    }

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

    scheduleAutoSuggest(
        recentMessages: Array<{ sender: string; text: string }>,
        onSuggestions: (suggestions: string[]) => void,
    ): void {
        const config = this.getConfig();

        if (config.trigger === "manual") {
            return;
        }

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
        const lines = raw
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
        const suggestions: string[] = [];

        for (const line of lines) {
            const match = line.match(/^\d+[.):\-]\s*(.+)/);

            if (match) {
                suggestions.push(match[1].trim());
            }
        }

        return suggestions;
    }
}
