import * as p from "@clack/prompts";
import type { Command } from "commander";
import { conversationSyncService } from "../lib/ConversationSyncService";
import { TelegramHistoryStore } from "../lib/TelegramHistoryStore";
import { TelegramToolConfig } from "../lib/TelegramToolConfig";
import { TGClient } from "../lib/TGClient";
import { runWatchRuntime } from "../runtime/light/WatchRuntime";

export function registerListenCommand(program: Command): void {
    program
        .command("listen")
        .description("Backward-compatible alias for watch daemon mode")
        .action(async () => {
            const config = new TelegramToolConfig();
            const data = await config.load();

            if (!data?.session) {
                p.log.error("Not configured. Run: tools telegram configure");
                process.exit(1);
            }

            if (data.contacts.length === 0) {
                p.log.warn("No contacts configured. Run: tools telegram configure");
                process.exit(1);
            }

            const client = TGClient.fromConfig(config);
            const authorized = await client.connect();

            if (!authorized) {
                p.log.error("Session expired. Run: tools telegram configure");
                process.exit(1);
            }

            const me = await client.getMe();
            const myName = me.firstName || "Me";
            const store = new TelegramHistoryStore();
            store.open();

            for (const contact of data.contacts) {
                await conversationSyncService.syncIncremental(client, store, contact.userId, { limit: 200 });
            }

            const shutdown = async () => {
                store.close();

                try {
                    await client.disconnect();
                } catch {
                    // ignore disconnect errors
                }

                process.exit(0);
            };

            process.on("SIGINT", shutdown);
            process.on("SIGTERM", shutdown);

            await runWatchRuntime({
                contacts: data.contacts,
                myName,
                client,
                store,
                daemon: true,
            });
        });
}
