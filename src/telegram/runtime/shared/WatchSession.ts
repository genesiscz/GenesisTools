import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import logger from "@app/logger";
import * as p from "@clack/prompts";
import { modelSelector } from "@ask/providers/ModelSelector";
import pc from "picocolors";
import { assistantEngine } from "../../lib/AssistantEngine";
import { attachmentDownloader } from "../../lib/AttachmentDownloader";
import { styleProfileEngine } from "../../lib/StyleProfileEngine";
import { suggestionEngine } from "../../lib/SuggestionEngine";
import { TelegramContact } from "../../lib/TelegramContact";
import type { TelegramHistoryStore } from "../../lib/TelegramHistoryStore";
import { TelegramMessage } from "../../lib/TelegramMessage";
import type { TGClient } from "../../lib/TGClient";
import type { ContactConfig } from "../../lib/types";

interface FeedEntry {
    id: number;
    direction: "in" | "out";
    text: string;
    timestampIso: string;
}

interface ContactState {
    contact: TelegramContact;
    historyLines: string[];
    messageFeed: FeedEntry[];
    lastIncoming?: string;
    lastIncomingMessageId?: number;
    pendingIncomingMessageId?: number;
    pendingSuggestions: string[];
    rawStyleSamples: string[];
    unreadCount: number;
}

export interface WatchSessionOptions {
    contacts: ContactConfig[];
    myName: string;
    client: TGClient;
    store: TelegramHistoryStore;
    contextLengthOverride?: number;
}

export interface WatchViewModel {
    carefulMode: boolean;
    activeChatId: string;
    contacts: Array<{
        id: string;
        name: string;
        unreadCount: number;
        isActive: boolean;
    }>;
    messages: FeedEntry[];
    pendingSuggestions: string[];
}

interface HandleResult {
    output?: string;
    exit?: boolean;
}

const MAX_FEED_MESSAGES = 500;

export class WatchSession {
    private states = new Map<string, ContactState>();
    private activeChatId: string;
    private carefulMode = false;
    private shouldExit = false;
    private listeners = new Set<() => void>();
    private suggestionTimers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(private options: WatchSessionOptions) {
        if (options.contacts.length === 0) {
            throw new Error("WatchSession requires at least one contact.");
        }

        this.activeChatId = options.contacts[0].userId;

        for (const config of options.contacts) {
            const contact = TelegramContact.fromConfig(config);
            const contextLength = options.contextLengthOverride ?? contact.contextLength;
            const rows = this.options.store.getByDateRange(contact.userId, undefined, undefined, Math.max(contextLength, 200));
            const historyLines = rows
                .map((row) => {
                    const content = row.text ?? row.media_desc ?? "";

                    if (!content) {
                        return undefined;
                    }

                    const name = row.is_outgoing ? this.options.myName : contact.displayName;
                    return `${name}: ${content}`;
                })
                .filter((line): line is string => line !== undefined);
            const messageFeed: FeedEntry[] = rows
                .map((row) => {
                    const text = row.text ?? row.media_desc ?? "";

                    if (!text) {
                        return undefined;
                    }

                    return {
                        id: row.id,
                        direction: row.is_outgoing ? "out" : "in",
                        text,
                        timestampIso: row.date_iso,
                    } satisfies FeedEntry;
                })
                .filter((entry): entry is FeedEntry => entry !== undefined);
            const rawStyleSamples = styleProfileEngine.getRawStyleSamples(contact, this.options.store, 120);

            this.states.set(contact.userId, {
                contact,
                historyLines,
                messageFeed,
                pendingSuggestions: [],
                unreadCount: 0,
                rawStyleSamples,
            });
        }
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);

        return () => {
            this.listeners.delete(listener);
        };
    }

    getViewModel(): WatchViewModel {
        const active = this.getRequiredState(this.activeChatId);

        return {
            carefulMode: this.carefulMode,
            activeChatId: this.activeChatId,
            contacts: [...this.states.values()].map((state) => ({
                id: state.contact.userId,
                name: state.contact.displayName,
                unreadCount: state.unreadCount,
                isActive: state.contact.userId === this.activeChatId,
            })),
            messages: active.messageFeed.slice(-200),
            pendingSuggestions: active.pendingSuggestions,
        };
    }

    private notifyViewUpdate(): void {
        for (const listener of this.listeners) {
            listener();
        }
    }

    private getRequiredState(chatId: string): ContactState {
        const state = this.states.get(chatId);

        if (!state) {
            throw new Error(`Unknown chat id: ${chatId}`);
        }

        return state;
    }

    getActiveState(): ContactState {
        return this.getRequiredState(this.activeChatId);
    }

    setActiveChat(chatId: string): void {
        const state = this.states.get(chatId);

        if (!state) {
            return;
        }

        this.activeChatId = chatId;
        state.unreadCount = 0;
        this.notifyViewUpdate();
    }

    cycleActiveChat(direction: 1 | -1 = 1): void {
        const ids = [...this.states.keys()];

        if (ids.length <= 1) {
            return;
        }

        const index = ids.findIndex((id) => id === this.activeChatId);

        if (index === -1) {
            this.activeChatId = ids[0];
            this.notifyViewUpdate();
            return;
        }

        const next = (index + direction + ids.length) % ids.length;
        this.setActiveChat(ids[next]);
    }

    private pushHistory(state: ContactState, line: string): void {
        const maxLength = this.options.contextLengthOverride ?? state.contact.contextLength;
        state.historyLines.push(line);

        while (state.historyLines.length > maxLength) {
            state.historyLines.shift();
        }
    }

    private pushFeed(state: ContactState, entry: FeedEntry): void {
        state.messageFeed.push(entry);

        while (state.messageFeed.length > MAX_FEED_MESSAGES) {
            state.messageFeed.shift();
        }
    }

    private getHistoryText(state: ContactState): string {
        return state.historyLines.join("\n");
    }

    private findState(target: string): ContactState | null {
        const lower = target.toLowerCase();

        for (const state of this.states.values()) {
            if (state.contact.userId === target) {
                return state;
            }

            if (state.contact.displayName.toLowerCase() === lower) {
                return state;
            }

            if (state.contact.username?.toLowerCase() === lower) {
                return state;
            }
        }

        return null;
    }

    private parseStateFromArgs(args: string[]): { state: ContactState; consumed: number } | null {
        if (args.length === 0) {
            return {
                state: this.getActiveState(),
                consumed: 0,
            };
        }

        const contactCandidate = this.findState(args[0]);

        if (contactCandidate) {
            return {
                state: contactCandidate,
                consumed: 1,
            };
        }

        return {
            state: this.getActiveState(),
            consumed: 0,
        };
    }

    private async sendText(state: ContactState, text: string, feedback?: { suggestionText: string; incomingMessageId?: number }): Promise<void> {
        const sent = await this.options.client.sendMessage(state.contact.userId, text);
        const timestampUnix = sent.date ? sent.date : Math.floor(Date.now() / 1000);
        const timestampIso = new Date(timestampUnix * 1000).toISOString();

        this.options.store.upsertMessageWithRevision(
            state.contact.userId,
            {
                id: sent.id,
                senderId: undefined,
                text,
                mediaDescription: undefined,
                isOutgoing: true,
                date: timestampIso,
                dateUnix: timestampUnix,
                attachments: [],
            },
            "create"
        );

        if (feedback) {
            this.options.store.recordSuggestionFeedback({
                chatId: state.contact.userId,
                incomingMessageId: feedback.incomingMessageId,
                suggestionText: feedback.suggestionText,
                sentText: text,
                editedText: feedback.suggestionText === text ? undefined : text,
            });
        }

        this.pushHistory(state, `${this.options.myName}: ${text}`);
        this.pushFeed(state, {
            id: sent.id,
            direction: "out",
            text,
            timestampIso,
        });

        logger.info(`${pc.green("You")} → ${pc.cyan(state.contact.displayName)}: ${text}`);
        this.notifyViewUpdate();
    }

    private async generateSuggestionsForState(state: ContactState): Promise<string[]> {
        if (!state.lastIncoming) {
            return [];
        }

        if (state.rawStyleSamples.length === 0) {
            state.rawStyleSamples = styleProfileEngine.getRawStyleSamples(state.contact, this.options.store, 120);
        }

        const suggestions = await suggestionEngine.generateSuggestions({
            sessionId: `watch-${state.contact.userId}`,
            mode: state.contact.suggestionMode,
            incomingText: state.lastIncoming,
            incomingMessageId: state.lastIncomingMessageId,
            conversationHistory: this.getHistoryText(state),
            stylePrompt: state.contact.config.styleProfile?.derivedPrompt,
            rawStyleSamples: state.rawStyleSamples,
            store: this.options.store,
            chatId: state.contact.userId,
        });

        state.pendingSuggestions = suggestions;
        state.pendingIncomingMessageId = state.lastIncomingMessageId;
        this.notifyViewUpdate();

        if (state.contact.suggestionMode.allowAutoSend && suggestions.length > 0) {
            await this.sendText(state, suggestions[0], {
                suggestionText: suggestions[0],
                incomingMessageId: state.pendingIncomingMessageId,
            });
            state.pendingSuggestions = [];
            state.pendingIncomingMessageId = undefined;
            this.notifyViewUpdate();
        }

        return suggestions;
    }

    private printSuggestions(state: ContactState): void {
        if (state.pendingSuggestions.length === 0) {
            logger.info(`[suggest:${state.contact.displayName}] no options generated`);
            return;
        }

        logger.info(pc.yellow(`Suggestions for ${state.contact.displayName}:`));

        for (let i = 0; i < state.pendingSuggestions.length; i++) {
            logger.info(`  ${i + 1}. ${state.pendingSuggestions[i]}`);
        }
    }

    private scheduleAutoSuggestion(state: ContactState): void {
        const existing = this.suggestionTimers.get(state.contact.userId);

        if (existing) {
            clearTimeout(existing);
        }

        const delayMs = state.contact.suggestionMode.autoDelayMs;
        const timer = setTimeout(async () => {
            try {
                await this.generateSuggestionsForState(state);
                this.printSuggestions(state);
            } catch (err) {
                logger.warn(`Auto suggestion failed: ${err}`);
            } finally {
                this.suggestionTimers.delete(state.contact.userId);
            }
        }, delayMs);

        this.suggestionTimers.set(state.contact.userId, timer);
    }

    async startListeners(): Promise<void> {
        this.options.client.onNewMessage(async (event) => {
            const message = new TelegramMessage(event.message);

            if (message.isOutgoing) {
                return;
            }

            const targetId = message.chatId ?? message.senderId;

            if (!targetId) {
                return;
            }

            const state = this.states.get(targetId);

            if (!state) {
                return;
            }

            const serialized = message.toJSON();
            this.options.store.upsertMessageWithRevision(targetId, serialized, "create");
            const content = message.contentForLLM;

            if (content) {
                this.pushHistory(state, `${state.contact.displayName}: ${content}`);
                state.lastIncoming = content;
                state.lastIncomingMessageId = message.id;
                this.pushFeed(state, {
                    id: message.id,
                    direction: "in",
                    text: content,
                    timestampIso: new Date(message.date.getTime()).toISOString(),
                });
            }

            if (state.contact.userId !== this.activeChatId) {
                state.unreadCount += 1;
            }

            logger.info(`${pc.bold(pc.cyan(state.contact.displayName))}: ${message.preview}`);
            this.notifyViewUpdate();

            const suggestionMode = state.contact.suggestionMode;

            if (!suggestionMode.enabled) {
                return;
            }

            if (suggestionMode.trigger === "auto" || suggestionMode.trigger === "hybrid") {
                this.scheduleAutoSuggestion(state);
            }
        });
    }

    private async handleCommand(line: string): Promise<HandleResult> {
        const parts = line.split(" ").filter(Boolean);
        const command = parts[0];
        const args = parts.slice(1);

        if (command === "/quit" || command === "/exit") {
            this.shouldExit = true;
            return { exit: true };
        }

        if (command === "/help") {
            const active = this.getActiveState();
            return {
                output:
                    "Commands:\n" +
                    "/chat <contact> | /next | /prev\n" +
                    "/suggest [contact]\n" +
                    "/pick [contact] <index> [edited text]\n" +
                    "/send [contact] <text>\n" +
                    "/ask [contact] <question>\n" +
                    "/attachment [contact] <messageId> [attachmentIndex] [outputPath]\n" +
                    "/model [contact] <autoReply|assistant|suggestions>\n" +
                    "/style derive [contact]\n" +
                    "/careful (toggle plain-text sending)\n" +
                    `/active: ${active.contact.displayName}`,
            };
        }

        if (command === "/careful") {
            this.carefulMode = !this.carefulMode;
            this.notifyViewUpdate();
            return {
                output: `Careful mode ${this.carefulMode ? "enabled" : "disabled"}`,
            };
        }

        if (command === "/chat") {
            if (args.length === 0) {
                return { output: "Usage: /chat <contact>" };
            }

            const state = this.findState(args[0]);

            if (!state) {
                return { output: `Unknown contact: ${args[0]}` };
            }

            this.setActiveChat(state.contact.userId);
            return { output: `Active chat: ${state.contact.displayName}` };
        }

        if (command === "/next") {
            this.cycleActiveChat(1);
            return { output: `Active chat: ${this.getActiveState().contact.displayName}` };
        }

        if (command === "/prev") {
            this.cycleActiveChat(-1);
            return { output: `Active chat: ${this.getActiveState().contact.displayName}` };
        }

        if (command === "/suggest") {
            const target = this.parseStateFromArgs(args);

            if (!target) {
                return { output: "Unable to resolve contact." };
            }

            await this.generateSuggestionsForState(target.state);
            this.printSuggestions(target.state);
            return { output: `Generated suggestions for ${target.state.contact.displayName}` };
        }

        if (command === "/pick") {
            const target = this.parseStateFromArgs(args);

            if (!target) {
                return { output: "Unable to resolve contact." };
            }

            const indexRaw = args[target.consumed];
            const index = indexRaw ? Number(indexRaw) : Number.NaN;

            if (!Number.isInteger(index) || index < 1) {
                return { output: "Usage: /pick [contact] <index> [edited text]" };
            }

            const suggestion = target.state.pendingSuggestions[index - 1];

            if (!suggestion) {
                return { output: `No suggestion at index ${index}` };
            }

            const inlineEditedText = args.slice(target.consumed + 1).join(" ").trim();
            let sendText = inlineEditedText;

            if (!sendText) {
                const promptValue = await p.text({
                    message: `Edit suggestion ${index} before send (empty = keep as-is):`,
                    initialValue: suggestion,
                });

                if (p.isCancel(promptValue)) {
                    return { output: "Suggestion send cancelled." };
                }

                const textValue = (promptValue as string).trim();
                sendText = textValue.length > 0 ? textValue : suggestion;
            }

            await this.sendText(target.state, sendText, {
                suggestionText: suggestion,
                incomingMessageId: target.state.pendingIncomingMessageId,
            });

            target.state.pendingSuggestions = [];
            target.state.pendingIncomingMessageId = undefined;
            this.notifyViewUpdate();
            return { output: `Sent suggestion ${index} to ${target.state.contact.displayName}` };
        }

        if (command === "/send") {
            const target = this.parseStateFromArgs(args);

            if (!target) {
                return { output: "Unable to resolve contact." };
            }

            const text = args.slice(target.consumed).join(" ").trim();

            if (!text) {
                return { output: "Usage: /send [contact] <text>" };
            }

            await this.sendText(target.state, text);
            return { output: `Sent to ${target.state.contact.displayName}` };
        }

        if (command === "/ask") {
            const target = this.parseStateFromArgs(args);

            if (!target) {
                return { output: "Unable to resolve contact." };
            }

            const question = args.slice(target.consumed).join(" ").trim();

            if (!question) {
                return { output: "Usage: /ask [contact] <question>" };
            }

            if (target.state.rawStyleSamples.length === 0) {
                target.state.rawStyleSamples = styleProfileEngine.getRawStyleSamples(
                    target.state.contact,
                    this.options.store,
                    120
                );
            }

            const answer = await assistantEngine.ask({
                sessionId: `watch-assistant-${target.state.contact.userId}`,
                mode: target.state.contact.assistantMode,
                incomingText: question,
                conversationHistory: this.getHistoryText(target.state),
                stylePrompt: target.state.contact.config.styleProfile?.derivedPrompt,
                rawStyleSamples: target.state.rawStyleSamples,
                store: this.options.store,
                chatId: target.state.contact.userId,
                includeFullDbHistory: true,
            });

            logger.info(pc.green(answer));
            return { output: answer };
        }

        if (command === "/attachment") {
            const target = this.parseStateFromArgs(args);

            if (!target) {
                return { output: "Unable to resolve contact." };
            }

            const messageIdRaw = args[target.consumed];
            const attachmentIndexRaw = args[target.consumed + 1];
            const messageId = messageIdRaw ? Number(messageIdRaw) : Number.NaN;
            const attachmentIndex = attachmentIndexRaw && /^\d+$/.test(attachmentIndexRaw) ? Number(attachmentIndexRaw) : 0;

            if (!Number.isInteger(messageId) || messageId <= 0) {
                return { output: "Usage: /attachment [contact] <messageId> [attachmentIndex] [outputPath]" };
            }

            let outputPath = args
                .slice(target.consumed + (attachmentIndexRaw && /^\d+$/.test(attachmentIndexRaw) ? 2 : 1))
                .join(" ")
                .trim();

            if (!outputPath) {
                const inputPath = await p.text({
                    message: "Output path (leave empty for default chats/<id>/attachments path):",
                    initialValue: "",
                });

                if (!p.isCancel(inputPath)) {
                    outputPath = (inputPath as string).trim();
                }
            }

            const result = await attachmentDownloader.downloadByLocator(
                this.options.client,
                this.options.store,
                {
                    chatId: target.state.contact.userId,
                    messageId,
                    attachmentIndex,
                },
                {
                    outputPath: outputPath || undefined,
                }
            );

            return { output: `Attachment saved: ${result.outputPath} (${result.bytes} bytes)` };
        }

        if (command === "/model") {
            const target = this.parseStateFromArgs(args);

            if (!target) {
                return { output: "Unable to resolve contact." };
            }

            const modeArg = args[target.consumed] as "autoReply" | "assistant" | "suggestions" | undefined;

            if (!modeArg || !["autoReply", "assistant", "suggestions"].includes(modeArg)) {
                return { output: "Usage: /model [contact] <autoReply|assistant|suggestions>" };
            }

            const mode = target.state.contact.config.modes?.[modeArg];

            if (!mode) {
                return { output: `Mode ${modeArg} missing in contact config.` };
            }

            const choice = await modelSelector.selectModel();

            if (!choice) {
                return { output: "Model selection cancelled." };
            }

            mode.provider = choice.provider.name;
            mode.model = choice.model.id;
            return { output: `Updated ${target.state.contact.displayName} ${modeArg} -> ${mode.provider}/${mode.model}` };
        }

        if (command === "/style" && args[0] === "derive") {
            const target = this.parseStateFromArgs(args.slice(1));

            if (!target) {
                return { output: "Usage: /style derive [contact]" };
            }

            const result = await styleProfileEngine.deriveStylePrompt(target.state.contact, this.options.store);

            if (!result) {
                return { output: "No style profile generated (rules missing or no matching messages)." };
            }

            if (!target.state.contact.config.styleProfile) {
                target.state.contact.config.styleProfile = {
                    enabled: true,
                    refresh: "incremental",
                    rules: [],
                    previewInWatch: false,
                };
            }

            target.state.contact.config.styleProfile.derivedPrompt = result.prompt;
            target.state.contact.config.styleProfile.derivedAt = result.generatedAt;
            target.state.rawStyleSamples = result.rawSamples;
            return { output: `Derived style profile from ${result.sampleCount} samples.` };
        }

        return { output: "Unknown command. Use /help." };
    }

    async handleInput(line: string): Promise<HandleResult> {
        const trimmed = line.trim();

        if (!trimmed) {
            return {};
        }

        if (trimmed.startsWith("/")) {
            return this.handleCommand(trimmed);
        }

        if (this.carefulMode) {
            return { output: "Careful mode is on. Use /send to send messages." };
        }

        const active = this.getActiveState();
        await this.sendText(active, trimmed);
        return { output: `Sent to ${active.contact.displayName}` };
    }

    async runLightPromptLoop(): Promise<void> {
        const rl = createInterface({ input, output });

        logger.info(
            "Live watch mode. Plain text sends to active chat. Use /help for commands. /careful toggles explicit /send-only mode."
        );

        try {
            while (!this.shouldExit) {
                const active = this.getActiveState();
                const prompt = `${pc.dim("watch")}(${pc.cyan(active.contact.displayName)}${this.carefulMode ? pc.yellow(":careful") : ""})> `;
                const line = await rl.question(prompt);
                const result = await this.handleInput(line);

                if (result.output) {
                    logger.info(result.output);
                }

                if (result.exit) {
                    break;
                }
            }
        } finally {
            rl.close();
        }
    }
}
