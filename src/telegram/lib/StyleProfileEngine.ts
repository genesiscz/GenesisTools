import { assistantEngine } from "./AssistantEngine";
import { styleRuleResolver } from "./StyleRuleResolver";
import type { TelegramContact } from "./TelegramContact";
import type { TelegramHistoryStore } from "./TelegramHistoryStore";
import { DEFAULT_MODE_CONFIG } from "./types";

export interface DerivedStyleResult {
    prompt: string;
    sampleCount: number;
    generatedAt: string;
    rawSamples: string[];
}

export class StyleProfileEngine {
    getRawStyleSamples(contact: TelegramContact, store: TelegramHistoryStore, limit = 200): string[] {
        const styleConfig = contact.config.styleProfile;

        if (!styleConfig || !styleConfig.enabled || styleConfig.rules.length === 0) {
            return [];
        }

        return styleRuleResolver.resolveRules(store, styleConfig.rules).slice(-limit);
    }

    async deriveStylePrompt(contact: TelegramContact, store: TelegramHistoryStore): Promise<DerivedStyleResult | null> {
        const rawSamples = this.getRawStyleSamples(contact, store, 500);

        if (rawSamples.length === 0) {
            return null;
        }

        const mode = contact.assistantMode.provider
            ? contact.assistantMode
            : {
                  ...DEFAULT_MODE_CONFIG.assistant,
              };

        const content =
            "You are deriving a style profile for one user's outbound Telegram writing. " +
            "Output a concise system prompt that captures tone, pacing, sentence length, greeting habits, and conflict de-escalation style. " +
            "Return only the final system prompt.\n\n" +
            `Samples:\n${rawSamples.join("\n")}`;

        const prompt = await assistantEngine.ask({
            sessionId: `style-${contact.userId}`,
            mode,
            incomingText: content,
        });

        return {
            prompt: prompt.trim(),
            sampleCount: rawSamples.length,
            generatedAt: new Date().toISOString(),
            rawSamples: rawSamples.slice(-120),
        };
    }
}

export const styleProfileEngine = new StyleProfileEngine();
