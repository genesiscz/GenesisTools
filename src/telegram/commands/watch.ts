import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { conversationSyncService } from "../lib/ConversationSyncService";
import { TelegramHistoryStore } from "../lib/TelegramHistoryStore";
import { TelegramToolConfig } from "../lib/TelegramToolConfig";
import { TGClient } from "../lib/TGClient";
import type { ContactConfig, TelegramRuntimeMode } from "../lib/types";
import { runWatchInkApp } from "../runtime/ink/WatchInkApp";
import { runWatchRuntime } from "../runtime/light/WatchRuntime";

function resolveContact(contacts: ContactConfig[], nameOrId: string): ContactConfig | undefined {
    const lower = nameOrId.toLowerCase();

    return contacts.find((contact) => {
        if (contact.userId === nameOrId) {
            return true;
        }

        if (contact.displayName.toLowerCase() === lower) {
            return true;
        }

        if (contact.username?.toLowerCase() === lower) {
            return true;
        }

        if (contact.username?.toLowerCase() === lower.replace(/^@/, "")) {
            return true;
        }

        return false;
    });
}

export function registerWatchCommand(program: Command): void {
    program
        .command("watch [contact]")
        .description("Watch configured Telegram dialogs in daemon/light/ink mode")
        .option("--all", "Watch all configured contacts")
        .option("--runtime <mode>", "daemon|light|ink")
        .option("--context-length <n>", "Override context length", (value) => Number.parseInt(value, 10))
        .action(
            async (
                contactName: string | undefined,
                opts: {
                    all?: boolean;
                    runtime?: TelegramRuntimeMode;
                    contextLength?: number;
                }
            ) => {
                p.intro(pc.bgMagenta(pc.white(" telegram watch ")));

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

                let targetContacts: ContactConfig[] = [];

                if (opts.all) {
                    targetContacts = data.contacts;
                } else if (contactName) {
                    const found = resolveContact(data.contacts, contactName);

                    if (!found) {
                        p.log.error(`Contact "${contactName}" not found.`);
                        process.exit(1);
                    }

                    targetContacts = [found];
                } else {
                    const selected = await p.select({
                        message: "Which contact to watch?",
                        options: [
                            ...data.contacts.map((contact) => ({
                                value: contact.userId,
                                label: contact.displayName,
                                hint: contact.username ? `@${contact.username}` : contact.dialogType,
                            })),
                            { value: "__all__", label: "All contacts" },
                        ],
                    });

                    if (p.isCancel(selected)) {
                        return;
                    }

                    if (selected === "__all__") {
                        targetContacts = data.contacts;
                    } else {
                        const found = data.contacts.find((contact) => contact.userId === selected);

                        if (!found) {
                            return;
                        }

                        targetContacts = [found];
                    }
                }

                const spinner = p.spinner();
                spinner.start("Connecting to Telegram...");

                const client = TGClient.fromConfig(config);
                const authorized = await client.connect();

                if (!authorized) {
                    spinner.stop("Session expired");
                    p.log.error("Session expired. Run: tools telegram configure");
                    process.exit(1);
                }

                const me = await client.getMe();
                const myName = me.firstName || "Me";
                spinner.stop(`Connected as ${myName}`);

                const store = new TelegramHistoryStore();
                store.open();

                for (const contact of targetContacts) {
                    await conversationSyncService.syncIncremental(client, store, contact.userId, {
                        limit: 200,
                    });
                }

                const runtimeMode: TelegramRuntimeMode =
                    opts.runtime ?? targetContacts[0]?.watch?.runtimeMode ?? "daemon";

                const shutdown = async () => {
                    store.close();

                    try {
                        await client.disconnect();
                    } catch {
                        // ignore disconnect errors
                    }
                };

                process.on("SIGINT", async () => {
                    await shutdown();
                    process.exit(0);
                });

                process.on("SIGTERM", async () => {
                    await shutdown();
                    process.exit(0);
                });

                if (runtimeMode === "ink") {
                    await runWatchInkApp({
                        contacts: targetContacts,
                        myName,
                        client,
                        store,
                        contextLength: opts.contextLength,
                    });
                } else {
                    await runWatchRuntime({
                        contacts: targetContacts,
                        myName,
                        client,
                        store,
                        contextLength: opts.contextLength,
                        daemon: runtimeMode === "daemon",
                    });
                }

                await shutdown();
            }
        );
}
