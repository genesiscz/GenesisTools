import { AssistantEngine } from "../../lib/AssistantEngine";
import { StyleProfileEngine } from "../../lib/StyleProfileEngine";
import { SuggestionEngine } from "../../lib/SuggestionEngine";
import type { TelegramHistoryStore } from "../../lib/TelegramHistoryStore";
import type { TelegramMessage } from "../../lib/TelegramMessage";
import type { TGClient } from "../../lib/TGClient";
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
    private _pendingSuggestions: string[] | null = null;
    private _autoSuggestCallback: ((suggestions: string[]) => void) | null = null;

    private assistantEngine: AssistantEngine;
    private suggestionEngine: SuggestionEngine;
    private styleEngine: StyleProfileEngine;

    constructor(
        private client: TGClient,
        private store: TelegramHistoryStore,
        private myName: string,
        contact: TelegramContactV2,
        private allContacts: TelegramContactV2[],
    ) {
        this._currentContact = contact;
        this.assistantEngine = new AssistantEngine(store, contact, myName);
        this.suggestionEngine = new SuggestionEngine(store, contact, myName);
        this.styleEngine = new StyleProfileEngine(store);
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

        const triggerMode = this._currentContact.modes.suggestions.trigger;

        if (triggerMode === "auto" || triggerMode === "hybrid") {
            const recentMsgs = this.messages.slice(-10).map((m) => ({
                sender: m.senderName,
                text: m.text,
            }));

            this.suggestionEngine.scheduleAutoSuggest(recentMsgs, (suggestions) => {
                this._pendingSuggestions = suggestions;
                this._autoSuggestCallback?.(suggestions);
                this.notify();
            });
        }

        this.notify();
    }

    onAutoSuggest(callback: (suggestions: string[]) => void): void {
        this._autoSuggestCallback = callback;
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
        this._pendingSuggestions = null;
        this.clearUnread(contact.userId);
        this.assistantEngine = new AssistantEngine(this.store, contact, this.myName);
        this.suggestionEngine = new SuggestionEngine(this.store, contact, this.myName);
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
                return this.handleAsk(args);

            case "suggest":
                return this.handleSuggest(args);

            case "pick":
                return this.handlePick(args);

            case "style":
                return this.handleStyle();

            case "model":
                return this.handleModel(args);

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
                            `  [${a.attachment_index}] ${a.kind} ${a.file_name ?? ""} ${a.is_downloaded ? "downloaded" : "not downloaded"}`,
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
                        "  /suggest [prompt]   Generate reply suggestions",
                        "  /pick <n> [edit]    Pick/edit a suggestion and send",
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

    private async handleAsk(args: string): Promise<{ handled: boolean; output?: string }> {
        if (!args) {
            return { handled: true, output: "Usage: /ask <question>" };
        }

        try {
            const answer = await this.assistantEngine.ask(args);
            return { handled: true, output: answer };
        } catch (err) {
            return { handled: true, output: `Assistant error: ${err instanceof Error ? err.message : String(err)}` };
        }
    }

    private async handleSuggest(args: string): Promise<{ handled: boolean; output?: string }> {
        try {
            const recentMsgs = this.messages.slice(-10).map((m) => ({
                sender: m.senderName,
                text: m.text,
            }));
            const customPrompt = args || undefined;
            const suggestions = await this.suggestionEngine.suggest(recentMsgs, customPrompt);

            this._pendingSuggestions = suggestions;

            const formatted = suggestions.map((s, i) => `  ${i + 1}. ${s}`).join("\n");
            return {
                handled: true,
                output: `Suggestions:\n${formatted}\n\nUse /pick <number> to select, or /pick <number> <edited text> to edit and send.`,
            };
        } catch (err) {
            return { handled: true, output: `Suggestion error: ${err instanceof Error ? err.message : String(err)}` };
        }
    }

    private async handlePick(args: string): Promise<{ handled: boolean; output?: string }> {
        if (!this._pendingSuggestions || this._pendingSuggestions.length === 0) {
            return { handled: true, output: "No pending suggestions. Use /suggest first." };
        }

        const pickParts = args.split(/\s+/);
        const index = Number.parseInt(pickParts[0], 10) - 1;

        if (Number.isNaN(index) || index < 0 || index >= this._pendingSuggestions.length) {
            return { handled: true, output: `Invalid choice. Pick 1-${this._pendingSuggestions.length}` };
        }

        const original = this._pendingSuggestions[index];
        const edited = pickParts.length > 1 ? pickParts.slice(1).join(" ") : original;

        const sent = await this.client.sendMessage(this._currentContact.userId, edited);

        this.store.insertMessages(this._currentContact.userId, [
            {
                id: sent.id,
                senderId: undefined,
                text: edited,
                mediaDescription: undefined,
                isOutgoing: true,
                date: new Date().toISOString(),
                dateUnix: Math.floor(Date.now() / 1000),
            },
        ]);

        this.messages.push({
            id: sent.id,
            text: edited,
            isOutgoing: true,
            senderName: this.myName,
            date: new Date(),
        });

        this.suggestionEngine.trackEdit(original, edited, edited, sent.id);

        this._pendingSuggestions = null;
        this.notify();

        return { handled: true, output: `Sent: "${edited}"` };
    }

    private handleStyle(): { handled: boolean; output?: string } {
        try {
            const analysis = this.styleEngine.analyzeStyle(this._currentContact.userId, "me", 200);
            const lines = [
                `Style analysis (${analysis.totalMessages} messages):`,
                ...analysis.traits.map((t) => `  - ${t}`),
            ];

            if (analysis.commonPatterns.length > 0) {
                lines.push("Common starters:");
                lines.push(...analysis.commonPatterns.map((p) => `  - ${p}`));
            }

            return { handled: true, output: lines.join("\n") };
        } catch (err) {
            return { handled: true, output: `Style error: ${err instanceof Error ? err.message : String(err)}` };
        }
    }

    private handleModel(args: string): { handled: boolean; output?: string } {
        if (!args) {
            const current = this._currentContact.modes.assistant;
            return {
                handled: true,
                output: [
                    "Current models:",
                    `  Assistant: ${current.provider ?? "default"}/${current.model ?? "default"}`,
                    `  Suggestions: ${this._currentContact.modes.suggestions.provider ?? "default"}/${this._currentContact.modes.suggestions.model ?? "default"}`,
                    "",
                    "Usage: /model assistant <provider>/<model>",
                    "       /model suggestions <provider>/<model>",
                ].join("\n"),
            };
        }

        const modelParts = args.split(/\s+/);
        const mode = modelParts[0];
        const modelSpec = modelParts[1];

        if (!modelSpec || !modelSpec.includes("/")) {
            return { handled: true, output: "Usage: /model <mode> <provider>/<model>" };
        }

        const [provider, ...modelNameParts] = modelSpec.split("/");
        const model = modelNameParts.join("/");

        if (mode === "assistant" || mode === "suggestions" || mode === "autoReply") {
            this._currentContact = {
                ...this._currentContact,
                modes: {
                    ...this._currentContact.modes,
                    [mode]: { ...this._currentContact.modes[mode], provider, model },
                },
            };

            if (mode === "assistant") {
                this.assistantEngine.resetSession();
            }

            return { handled: true, output: `${mode} model set to ${provider}/${model}` };
        }

        return { handled: true, output: `Unknown mode: ${mode}. Use assistant, suggestions, or autoReply` };
    }
}
