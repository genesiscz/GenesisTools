import { ReadStream } from "node:tty";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import { render } from "ink";
import type { NewMessageEvent } from "telegram/events";
import { ConversationSyncService } from "../lib/ConversationSyncService";
import { TelegramHistoryStore } from "../lib/TelegramHistoryStore";
import { TelegramMessage } from "../lib/TelegramMessage";
import { TelegramToolConfig } from "../lib/TelegramToolConfig";
import { TGClient } from "../lib/TGClient";
import { WatchInkApp } from "../runtime/ink/WatchInkApp";
import { WatchSession } from "../runtime/shared/WatchSession";

export function registerWatchCommand(program: Command): void {
    program
        .command("watch [contact]")
        .description("Watch a conversation in real-time with AI assistant features")
        .option("--context-length <n>", "Number of recent messages to show", Number.parseInt)
        .action(async (contactArg: string | undefined, opts: { contextLength?: number }) => {
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

            const connectSpinner = p.spinner();
            connectSpinner.start("Connecting to Telegram...");

            const client = TGClient.fromConfig(config);
            const connected = await client.connect();

            if (!connected) {
                connectSpinner.stop("Session expired");
                p.log.error("Failed to connect. Re-run: tools telegram configure");
                process.exit(1);
            }

            const me = await client.getMe();
            const myName = [me.firstName, me.lastName].filter(Boolean).join(" ");
            connectSpinner.stop(`Connected as ${myName}`);

            const store = new TelegramHistoryStore();
            store.open();
            const syncService = new ConversationSyncService(client, store);
            const bufferedEvents: NewMessageEvent[] = [];
            let session: WatchSession | null = null;
            let sessionReady = false;

            try {
                let contact = contactArg
                    ? data.contacts.find(
                          (c) =>
                              c.displayName.toLowerCase() === contactArg.toLowerCase() ||
                              c.userId === contactArg ||
                              c.username?.toLowerCase() === contactArg.toLowerCase()
                      )
                    : undefined;

                if (!contact) {
                    const choices = data.contacts.map((c) => {
                        const icon =
                            c.chatType === "group" ? "[group]" : c.chatType === "channel" ? "[channel]" : "[user]";
                        return { value: c.userId, label: `${icon} ${c.displayName}` };
                    });

                    const selected = await p.select({
                        message: "Which conversation to watch?",
                        options: choices,
                    });

                    if (p.isCancel(selected)) {
                        return;
                    }

                    contact = data.contacts.find((c) => c.userId === selected);
                }

                if (!contact) {
                    p.log.error("Contact not found");
                    return;
                }

                if (opts.contextLength) {
                    contact = {
                        ...contact,
                        watch: { ...contact.watch, contextLength: opts.contextLength },
                    };
                }

                client.onNewMessage(async (event) => {
                    const msg = new TelegramMessage(event.message);
                    const senderId = msg.senderId;
                    const peer = event.message?.peerId;
                    const peerId = peer
                        ? String(
                              "userId" in peer
                                  ? peer.userId
                                  : "chatId" in peer
                                    ? peer.chatId
                                    : "channelId" in peer
                                      ? peer.channelId
                                      : ""
                          )
                        : "";
                    if (!session || !sessionReady) {
                        bufferedEvents.push(event);
                        return;
                    }

                    const currentContactId = session.currentContact.userId;

                    if (senderId === currentContactId || peerId === currentContactId) {
                        store.insertMessages(currentContactId, [msg.toJSON()]);
                        session.addIncoming(msg);
                    } else {
                        const matchedContact = data.contacts.find((c) => c.userId === senderId || c.userId === peerId);

                        if (matchedContact) {
                            store.insertMessages(matchedContact.userId, [msg.toJSON()]);
                            session.incrementUnread(matchedContact.userId);
                        }
                    }
                });

                const syncSpinner = p.spinner();
                syncSpinner.start("Syncing latest messages...");
                const syncResult = await syncService.syncLatest(contact.userId);
                syncSpinner.stop(`Synced ${syncResult.synced} new messages`);

                session = new WatchSession(client, store, myName, contact, data.contacts);
                await session.loadHistory();
                sessionReady = true;

                if (bufferedEvents.length > 0) {
                    for (const event of bufferedEvents) {
                        const msg = new TelegramMessage(event.message);
                        const senderId = msg.senderId;
                        const peer = event.message?.peerId;
                        const peerId = peer
                            ? String(
                                  "userId" in peer
                                      ? peer.userId
                                      : "chatId" in peer
                                        ? peer.chatId
                                        : "channelId" in peer
                                          ? peer.channelId
                                          : ""
                              )
                            : "";
                        const currentContactId = session.currentContact.userId;

                        if (senderId === currentContactId || peerId === currentContactId) {
                            store.insertMessages(currentContactId, [msg.toJSON()]);
                            session.addIncoming(msg);
                        } else {
                            const matchedContact = data.contacts.find(
                                (c) => c.userId === senderId || c.userId === peerId
                            );

                            if (matchedContact) {
                                store.insertMessages(matchedContact.userId, [msg.toJSON()]);
                                session.incrementUnread(matchedContact.userId);
                            }
                        }
                    }

                    bufferedEvents.length = 0;
                }

                p.log.info(`Watching ${contact.displayName}. Tab to switch contacts, /help for commands.`);

                // Clack prompts permanently damage process.stdin (readline internals).
                // Create a fresh TTY stream on fd 0 so Ink gets clean input.
                const freshStdin = new ReadStream(0);

                const { waitUntilExit } = render(<WatchInkApp session={session} />, { stdin: freshStdin });

                await waitUntilExit();
            } finally {
                store.close();
                await client.disconnect();
            }
        });
}
