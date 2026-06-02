import { logger } from "@app/logger";
import { dispatchNotification } from "@app/utils/notifications";
import type { Notifier } from "./types";

export type NotifyChannel = "terminal" | "say" | "telegram";

const VALID_CHANNELS: ReadonlySet<NotifyChannel> = new Set<NotifyChannel>(["terminal", "say", "telegram"]);

export function parseChannels(raw: string): NotifyChannel[] {
    const trimmed = raw.trim().toLowerCase();

    if (trimmed === "none" || trimmed === "") {
        return [];
    }

    const channels: NotifyChannel[] = [];

    for (const part of trimmed.split(",")) {
        const ch = part.trim();

        if (VALID_CHANNELS.has(ch as NotifyChannel)) {
            channels.push(ch as NotifyChannel);
        } else if (ch) {
            logger.warn({ ch }, "ignoring unknown notify channel");
        }
    }

    return channels;
}

/**
 * Production notifier. `dispatchNotification` reads channel *config* from the
 * shared `notify` store; the `channels` filter here decides which channels we
 * actually want for THIS run. "terminal" maps to the system channel.
 * NOTE: channels disabled in `notify` config still won't fire even if requested —
 * the user must enable telegram/say there once. terminal (system) is on by default.
 */
export function createNotifier(channels: NotifyChannel[]): Notifier {
    const wantSystem = channels.includes("terminal");
    const wantSay = channels.includes("say");
    const wantTelegram = channels.includes("telegram");

    return {
        notify: async ({ title, message, subtitle }) => {
            if (!wantSystem && !wantSay && !wantTelegram) {
                return;
            }

            await dispatchNotification({
                app: "agent-watch",
                title,
                message,
                subtitle,
            });
        },
    };
}
