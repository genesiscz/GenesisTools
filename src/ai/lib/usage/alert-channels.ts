import { sendInboxMessage } from "@app/question/lib/message";
import { type MacosChannelSettings, macosAlertChannel } from "@genesiscz/utils/ai/usage/alerts/channels/macos";
import type { AlertChannel, AlertChannelTable } from "@genesiscz/utils/ai/usage/alerts/types";
import { aiUsageCommand } from "@genesiscz/utils/genesis-tools/tools/ai";

/**
 * The GenesisTools widget inbox: the alert becomes an unread message card. It lives in this tool and not in the
 * shared package, because the inbox writer is `@app/question`; the engine only knows the `AlertChannel` interface.
 *
 * It does not interrupt, so the engine delivers it in quiet hours too; the card is therefore written without the
 * question sinks that do interrupt (the user's notification banner and sound).
 */
const inboxAlertChannel: AlertChannel = {
    id: "inbox",
    interrupts: false,
    async deliver(alert) {
        await sendInboxMessage({
            title: alert.title,
            text: `${alert.message}\n\nAcknowledge: ${aiUsageCommand("alerts", "ack", String(alert.id))}`,
            agentLabel: "AI usage alerts",
            source: "cli",
            interrupt: inboxAlertChannel.interrupts,
        });
    },
};

/** Every alert channel, keyed by its id; a new channel is one entry here and one id in `AlertChannelId`. */
export function alertChannels(notifications: MacosChannelSettings): AlertChannelTable {
    return {
        macos: macosAlertChannel(notifications),
        inbox: inboxAlertChannel,
    } satisfies AlertChannelTable;
}
