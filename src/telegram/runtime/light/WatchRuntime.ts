import logger from "@app/logger";
import { registerHandler } from "../../lib/handler";
import type { TelegramHistoryStore } from "../../lib/TelegramHistoryStore";
import type { TGClient } from "../../lib/TGClient";
import type { ContactConfig } from "../../lib/types";
import { WatchSession } from "../shared/WatchSession";

export interface WatchRuntimeOptions {
    contacts: ContactConfig[];
    myName: string;
    client: TGClient;
    store: TelegramHistoryStore;
    contextLength?: number;
    daemon?: boolean;
}

export async function runWatchRuntime(options: WatchRuntimeOptions): Promise<void> {
    if (options.daemon) {
        const initialHistory = new Map<string, string[]>();

        for (const contact of options.contacts) {
            const contextLength = options.contextLength ?? contact.watch?.contextLength ?? 30;
            const rows = options.store.getByDateRange(contact.userId, undefined, undefined, contextLength);
            const lines = rows
                .map((row) => {
                    const content = row.text || row.media_desc;

                    if (!content) {
                        return undefined;
                    }

                    const name = row.is_outgoing ? options.myName : contact.displayName;
                    return `${name}: ${content}`;
                })
                .filter((line): line is string => line !== undefined);

            initialHistory.set(contact.userId, lines);
        }

        registerHandler(options.client, {
            contacts: options.contacts,
            myName: options.myName,
            initialHistory,
            store: options.store,
        });

        logger.info("Daemon watch started. Press Ctrl+C to stop.");
        await new Promise(() => {});
    }

    const session = new WatchSession({
        contacts: options.contacts,
        myName: options.myName,
        client: options.client,
        store: options.store,
        contextLengthOverride: options.contextLength,
    });

    await session.startListeners();
    await session.runLightPromptLoop();
}
