import logger from "@app/logger";
import { parseDate } from "./DateParser";
import type { TelegramHistoryStore } from "./TelegramHistoryStore";
import type { MessageRowV2, StyleSourceRule } from "./types";

const MAX_REGEX_LENGTH = 200;

function hasObviousCatastrophicPattern(pattern: string): boolean {
    return /(\([^)]*[+*][^)]*\))[+*]/.test(pattern) || /(\.\*){2,}/.test(pattern);
}

export class StyleRuleResolver {
    constructor(private store: TelegramHistoryStore) {}

    resolveMessages(rules: StyleSourceRule[]): MessageRowV2[] {
        const allMessages: MessageRowV2[] = [];

        for (const rule of rules) {
            const sender = rule.direction === "outgoing" ? "me" : "them";
            const messages = this.store.queryMessages(rule.sourceChatId, {
                sender,
                since: rule.since ? (parseDate(rule.since) ?? undefined) : undefined,
                until: rule.until ? (parseDate(rule.until) ?? undefined) : undefined,
                limit: rule.limit ?? 500,
            });

            let filtered = messages;

            if (rule.regex) {
                const pattern = rule.regex.trim();

                if (!pattern || pattern.length > MAX_REGEX_LENGTH || hasObviousCatastrophicPattern(pattern)) {
                    logger.warn({ ruleId: rule.id, pattern }, "Skipping unsafe style regex");
                } else {
                    try {
                        const re = new RegExp(pattern, "i");
                        filtered = filtered.filter((m) => {
                            if (!m.text) {
                                return false;
                            }

                            try {
                                return re.test(m.text);
                            } catch (err) {
                                logger.warn({ err, ruleId: rule.id, pattern }, "Regex test failed; skipping rule");
                                return false;
                            }
                        });
                    } catch (err) {
                        logger.warn({ err, ruleId: rule.id, pattern }, "Invalid style regex; skipping rule");
                    }
                }
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
