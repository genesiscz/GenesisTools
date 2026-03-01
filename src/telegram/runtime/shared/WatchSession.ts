import type { TGClient } from "../../lib/TGClient";
import type { TelegramHistoryStore } from "../../lib/TelegramHistoryStore";
import type { TelegramMessage } from "../../lib/TelegramMessage";
import type { TelegramContactV2 } from "../../lib/types";

export interface WatchMessage {
    id: number;
    text: string;
    isOutgoing: boolean;
    senderName: string;
    date: Date;
    mediaDesc?: string;
}

export type InputMode = "chat" | "careful";

export class WatchSession {
    private messages: WatchMessage[] = [];
    private listeners: Array<() => void> = [];
    private _inputMode: InputMode = "chat";
    private _currentContact: TelegramContactV2;
    private unreadCounts = new Map<string, number>();

    constructor(
        private client: TGClient,
        private store: TelegramHistoryStore,
        private myName: string,
        contact: TelegramContactV2,
        private allContacts: TelegramContactV2[]
    ) {
        this._currentContact = contact;
    }

    get currentContact(): TelegramContactV2 {
        return this._currentContact;
    }

    get inputMode(): InputMode {
        return this._inputMode;
    }

    get contextLength(): number {
        return this._currentContact.watch?.contextLength ?? 30;
    }

    async loadHistory(): Promise<void> {
        const rows = this.store.queryMessages(this._currentContact.userId, {
            limit: this.contextLength,
        });

        this.messages = rows.map((r) => ({
            id: r.id,
            text: r.text ?? "",
            isOutgoing: r.is_outgoing === 1,
            senderName: r.is_outgoing === 1 ? this.myName : this._currentContact.displayName,
            date: new Date(r.date_unix * 1000),
            mediaDesc: r.media_desc ?? undefined,
        }));

        this.notify();
    }

    subscribe(listener: () => void): () => void {
        this.listeners.push(listener);
        return () => {
            this.listeners = this.listeners.filter((l) => l !== listener);
        };
    }

    private notify() {
        for (const l of this.listeners) {
            l();
        }
    }

    getMessages(): WatchMessage[] {
        return this.messages.slice(-this.contextLength);
    }

    getContacts(): TelegramContactV2[] {
        return this.allContacts;
    }

    addIncoming(msg: TelegramMessage): void {
        this.messages.push({
            id: msg.id,
            text: msg.text,
            isOutgoing: false,
            senderName: this._currentContact.displayName,
            date: msg.date,
            mediaDesc: msg.mediaDescription,
        });
        this.notify();
    }

    async sendMessage(text: string): Promise<void> {
        const sent = await this.client.sendMessage(this._currentContact.userId, text);
        this.store.insertMessages(this._currentContact.userId, [
            {
                id: sent.id,
                senderId: undefined,
                text,
                mediaDescription: undefined,
                isOutgoing: true,
                date: new Date().toISOString(),
                dateUnix: Math.floor(Date.now() / 1000),
            },
        ]);

        this.messages.push({
            id: sent.id,
            text,
            isOutgoing: true,
            senderName: this.myName,
            date: new Date(),
        });
        this.notify();
    }

    async switchContact(contact: TelegramContactV2): Promise<void> {
        this._currentContact = contact;
        this.messages = [];
        this.clearUnread(contact.userId);
        await this.loadHistory();
    }

    toggleCarefulMode(): void {
        this._inputMode = this._inputMode === "chat" ? "careful" : "chat";
        this.notify();
    }

    incrementUnread(contactId: string): void {
        const current = this.unreadCounts.get(contactId) ?? 0;
        this.unreadCounts.set(contactId, current + 1);
        this.notify();
    }

    getUnreadCount(contactId: string): number {
        return this.unreadCounts.get(contactId) ?? 0;
    }

    clearUnread(contactId: string): void {
        this.unreadCounts.delete(contactId);
    }

    getUnreadCounts(): Map<string, number> {
        return this.unreadCounts;
    }

    async handleSlashCommand(input: string): Promise<{ handled: boolean; output?: string }> {
        const trimmed = input.trim();

        if (!trimmed.startsWith("/")) {
            return { handled: false };
        }

        const parts = trimmed.slice(1).split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1).join(" ");

        switch (cmd) {
            case "careful":
                this.toggleCarefulMode();
                return { handled: true, output: `Input mode: ${this._inputMode}` };

            case "send":
                if (this._inputMode === "careful" && args) {
                    await this.sendMessage(args);
                    return { handled: true };
                }
                return { handled: true, output: "Usage: /send <message>" };

            case "quit":
            case "exit":
                return { handled: true, output: "__EXIT__" };

            case "ask":
                return { handled: true, output: `[assistant] ${args}` };

            case "suggest":
                return { handled: true, output: "[suggestions loading...]" };

            case "model":
                return { handled: true, output: "[model selector]" };

            case "style":
                return { handled: true, output: "[style profile]" };

            case "attachment": {
                const msgId = Number.parseInt(args, 10);

                if (Number.isNaN(msgId)) {
                    return { handled: true, output: "Usage: /attachment <message_id>" };
                }

                const atts = this.store.getAttachments(this._currentContact.userId, msgId);

                if (atts.length === 0) {
                    return { handled: true, output: "No attachments for this message" };
                }

                const list = atts
                    .map(
                        (a) =>
                            `  [${a.attachment_index}] ${a.kind} ${a.file_name ?? ""} ${a.is_downloaded ? "downloaded" : "not downloaded"}`
                    )
                    .join("\n");
                return { handled: true, output: `Attachments:\n${list}` };
            }

            case "help":
                return {
                    handled: true,
                    output: [
                        "Commands:",
                        "  /ask <question>     Ask assistant about the conversation",
                        "  /suggest            Generate reply suggestions",
                        "  /send <text>        Send message (required in /careful mode)",
                        "  /careful            Toggle careful mode (require /send)",
                        "  /model              Switch AI model",
                        "  /style              Derive/preview style profile",
                        "  /attachment <id>    List/download attachments",
                        "  /contacts           Switch to contact list",
                        "  /quit               Exit watch mode",
                    ].join("\n"),
                };

            default:
                return { handled: true, output: `Unknown command: /${cmd}. Type /help for available commands.` };
        }
    }
}
