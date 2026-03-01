import { parseDate } from "./DateParser";
import type { TelegramHistoryStore } from "./TelegramHistoryStore";
import type { MessageRowV2, StyleSourceRule } from "./types";

export class StyleRuleResolver {
    constructor(private store: TelegramHistoryStore) {}

    resolveMessages(rules: StyleSourceRule[]): MessageRowV2[] {
        const allMessages: MessageRowV2[] = [];

        for (const rule of rules) {
            const sender = rule.direction === "outgoing" ? "me" : "them";
            const messages = this.store.queryMessages(rule.sourceChatId, {
                sender,
                since: rule.since ? parseDate(rule.since) ?? undefined : undefined,
                until: rule.until ? parseDate(rule.until) ?? undefined : undefined,
                limit: rule.limit ?? 500,
            });

            let filtered = messages;

            if (rule.regex) {
                const re = new RegExp(rule.regex, "i");
                filtered = filtered.filter((m) => m.text && re.test(m.text));
            }

            allMessages.push(...filtered);
        }

        const seen = new Set<string>();
        return allMessages.filter((m) => {
            const key = `${m.chat_id}:${m.id}`;

            if (seen.has(key)) {
                return false;
            }

            seen.add(key);
            return true;
        });
    }
}
