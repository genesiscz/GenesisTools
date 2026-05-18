import { dispatchNotification } from "@app/utils/notifications";
import type { QaEntry } from "../types";
import { registerSink, type Sink } from "./registry-exports";

export function formatNotification(e: QaEntry): { title: string; message: string } {
    return {
        title: `${e.project} · ${e.tag}`,
        message: `❯ ${e.question}\n\n${e.answerMd}`,
    };
}

export const notificationSink: Sink = {
    name: "notification",
    isEnabled: (c) => c.sinks.notify,
    emit: async (entry) => {
        const { title, message } = formatNotification(entry);
        // dispatchNotification self-gates per channel via notificationsConfig.getChannels("question")
        // and isolates per-channel failures internally — it does NOT throw. Channel selection
        // (macOS banner / Telegram / webhook / TTS) is the user's `tools notify` config, not ours.
        // This deletes the entire bespoke Telegram sink: one delegate, all channels, zero dup config.
        await dispatchNotification({ app: "question", title, message });
    },
};

registerSink(notificationSink);
