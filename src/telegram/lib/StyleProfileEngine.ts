import { StyleRuleResolver } from "./StyleRuleResolver";
import type { TelegramHistoryStore } from "./TelegramHistoryStore";
import type { StyleSourceRule } from "./types";

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
                totalMessages: 0,
                avgLength: 0,
                avgWords: 0,
                usesEmojis: false,
                emojiFrequency: 0,
                usesSlang: false,
                traits: ["No messages to analyze"],
                commonPatterns: [],
            };
        }

        return this.analyzeStyleFromTexts(texts);
    }

    buildStylePrompt(options: StylePromptOptions): string {
        const messages = this.ruleResolver.resolveMessages(options.rules);
        const texts = messages.map((m) => m.text ?? "").filter(Boolean);

        if (texts.length === 0) {
            return "No messages available for style analysis.";
        }

        const analysis = this.analyzeStyleFromTexts(texts);
        const exampleCount = options.exampleCount ?? 15;
        const examples = this.selectRepresentativeExamples(texts, exampleCount);

        const sections: string[] = [];

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
        const emojiCount = texts.reduce(
            (s, t) => s + (t.match(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu) ?? []).length,
            0
        );
        const emojiFreq = emojiCount / texts.length;

        const traits: string[] = [];

        if (avgWords < 5) {
            traits.push("Very short messages (1-4 words)");
        } else if (avgWords < 10) {
            traits.push("Short messages (5-9 words)");
        } else if (avgWords < 20) {
            traits.push("Medium-length messages");
        } else {
            traits.push("Long, detailed messages");
        }

        if (emojiFreq > 1) {
            traits.push("Heavy emoji user");
        } else if (emojiFreq > 0.3) {
            traits.push("Moderate emoji user");
        } else if (emojiFreq > 0) {
            traits.push("Occasional emoji user");
        } else {
            traits.push("Rarely or never uses emojis");
        }

        const lowercaseRatio = texts.filter((t) => t === t.toLowerCase()).length / texts.length;

        if (lowercaseRatio > 0.8) {
            traits.push("Mostly lowercase");
        } else if (lowercaseRatio < 0.3) {
            traits.push("Uses proper capitalization");
        }

        const noPuncRatio = texts.filter((t) => !/[.!?]$/.test(t.trim())).length / texts.length;

        if (noPuncRatio > 0.7) {
            traits.push("Often omits ending punctuation");
        }

        const slangPatterns = /\b(lol|lmao|nah|yea|wanna|gonna|kinda|idk|imo|tbh|rn|tmrw|btw|omg|brb|ttyl)\b/i;
        const slangCount = texts.filter((t) => slangPatterns.test(t)).length;
        const usesSlang = slangCount / texts.length > 0.1;

        if (usesSlang) {
            traits.push("Uses informal slang/abbreviations");
        }

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

    private selectRepresentativeExamples(texts: string[], count: number): string[] {
        if (count <= 0) {
            return [];
        }

        if (texts.length <= count) {
            return texts;
        }

        const step = Math.max(1, Math.floor(texts.length / count));
        const examples: string[] = [];

        for (let i = 0; i < texts.length && examples.length < count; i += step) {
            const t = texts[i];

            if (t.length > 0 && t.length < 200) {
                examples.push(t);
            }
        }

        return examples;
    }
}
