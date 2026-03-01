import { assistantEngine } from "./AssistantEngine";
import { styleRuleResolver } from "./StyleRuleResolver";
import type { TelegramContact } from "./TelegramContact";
import type { TelegramHistoryStore } from "./TelegramHistoryStore";
import { DEFAULT_MODE_CONFIG } from "./types";

export interface DerivedStyleResult {
    prompt: string;
    sampleCount: number;
    generatedAt: string;
}

export class StyleProfileEngine {
    async deriveStylePrompt(contact: TelegramContact, store: TelegramHistoryStore): Promise<DerivedStyleResult | null> {
        const styleConfig = contact.config.styleProfile;

        if (!styleConfig || !styleConfig.enabled || styleConfig.rules.length === 0) {
            return null;
        }

        const lines = styleRuleResolver.resolveRules(store, styleConfig.rules).slice(-500);

        if (lines.length === 0) {
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
            `Samples:\n${lines.join("\n")}`;

        const prompt = await assistantEngine.ask({
            sessionId: `style-${contact.userId}`,
            mode,
            incomingText: content,
        });

        return {
            prompt: prompt.trim(),
            sampleCount: lines.length,
            generatedAt: new Date().toISOString(),
        };
    }
}

export const styleProfileEngine = new StyleProfileEngine();
