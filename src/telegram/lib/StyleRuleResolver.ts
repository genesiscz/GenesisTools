import type { TelegramHistoryStore } from "./TelegramHistoryStore";
import type { StyleSourceRule } from "./types";

export class StyleRuleResolver {
    resolveRule(store: TelegramHistoryStore, rule: StyleSourceRule): string[] {
        const since = rule.since ? new Date(rule.since) : undefined;
        const until = rule.until ? new Date(rule.until) : undefined;
        const sender = rule.direction === "outgoing" ? "me" : "them";

        let lines = store
            .queryMessages(rule.sourceChatId, {
                since,
                until,
                sender,
                limit: rule.limit,
            })
            .map((row) => row.text ?? row.media_desc ?? "")
            .map((line) => line.trim())
            .filter(Boolean);

        if (rule.regex) {
            try {
                const regex = new RegExp(rule.regex, "i");
                lines = lines.filter((line) => regex.test(line));
            } catch {
                // ignore invalid regex in rule
            }
        }

        return lines;
    }

    resolveRules(store: TelegramHistoryStore, rules: StyleSourceRule[]): string[] {
        const output: string[] = [];

        for (const rule of rules) {
            const ruleLines = this.resolveRule(store, rule);
            output.push(...ruleLines);
        }

        return output;
    }
}

export const styleRuleResolver = new StyleRuleResolver();
