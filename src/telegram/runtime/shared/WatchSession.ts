import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import logger from "@app/logger";
import { modelSelector } from "@ask/providers/ModelSelector";
import pc from "picocolors";
import { assistantEngine } from "../../lib/AssistantEngine";
import { styleProfileEngine } from "../../lib/StyleProfileEngine";
import { suggestionEngine } from "../../lib/SuggestionEngine";
import { TelegramContact } from "../../lib/TelegramContact";
import type { TelegramHistoryStore } from "../../lib/TelegramHistoryStore";
import { TelegramMessage } from "../../lib/TelegramMessage";
import type { TGClient } from "../../lib/TGClient";
import type { ContactConfig } from "../../lib/types";

interface ContactState {
    contact: TelegramContact;
    historyLines: string[];
    lastIncoming?: string;
    pendingSuggestions: string[];
}

export interface WatchSessionOptions {
    contacts: ContactConfig[];
    myName: string;
    client: TGClient;
    store: TelegramHistoryStore;
    contextLengthOverride?: number;
}

export class WatchSession {
    private states = new Map<string, ContactState>();

    constructor(private options: WatchSessionOptions) {
        for (const config of options.contacts) {
            const contact = TelegramContact.fromConfig(config);
            const contextLength = options.contextLengthOverride ?? contact.contextLength;
            const rows = this.options.store.getByDateRange(contact.userId, undefined, undefined, contextLength);
            const historyLines = rows
                .map((row) => {
                    const name = row.is_outgoing ? this.options.myName : contact.displayName;
                    const content = row.text ?? row.media_desc ?? "";

                    if (!content) {
                        return undefined;
                    }

                    return `${name}: ${content}`;
                })
                .filter((line): line is string => line !== undefined);

            this.states.set(contact.userId, {
                contact,
                historyLines,
                pendingSuggestions: [],
            });
        }
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
            }

            logger.info(`${pc.bold(pc.cyan(state.contact.displayName))}: ${message.preview}`);

            const suggestionMode = state.contact.suggestionMode;

            if (!suggestionMode.enabled) {
                return;
            }

            if (suggestionMode.trigger === "auto" || suggestionMode.trigger === "hybrid") {
                if (suggestionMode.autoDelayMs > 0) {
                    await Bun.sleep(suggestionMode.autoDelayMs);
                }

                const suggestions = await this.generateSuggestionsForState(state);
                this.printSuggestions(state.contact.displayName, suggestions);
            }
        });
    }

    private pushHistory(state: ContactState, line: string): void {
        const maxLength = this.options.contextLengthOverride ?? state.contact.contextLength;
        state.historyLines.push(line);

        while (state.historyLines.length > maxLength) {
            state.historyLines.shift();
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

    private async generateSuggestionsForState(state: ContactState): Promise<string[]> {
        if (!state.lastIncoming) {
            return [];
        }

        const suggestions = await suggestionEngine.generateSuggestions({
            sessionId: `watch-${state.contact.userId}`,
            mode: state.contact.suggestionMode,
            incomingText: state.lastIncoming,
            conversationHistory: this.getHistoryText(state),
            stylePrompt: state.contact.config.styleProfile?.derivedPrompt,
        });

        state.pendingSuggestions = suggestions;
        return suggestions;
    }

    private printSuggestions(contactLabel: string, suggestions: string[]): void {
        if (suggestions.length === 0) {
            logger.info(`[suggest:${contactLabel}] no options generated`);
            return;
        }

        logger.info(pc.yellow(`Suggestions for ${contactLabel}:`));

        for (let i = 0; i < suggestions.length; i++) {
            logger.info(`  ${i + 1}. ${suggestions[i]}`);
        }
    }

    async runLightPromptLoop(): Promise<void> {
        const rl = createInterface({ input, output });

        logger.info(
            "Watch commands: /suggest <contact>, /send <contact> <text>, /ask <contact> <question>, /model <contact> <mode>, /style derive <contact>, /quit"
        );

        try {
            while (true) {
                const line = (await rl.question(pc.dim("watch> "))).trim();

                if (!line) {
                    continue;
                }

                if (line === "/quit" || line === "/exit") {
                    break;
                }

                await this.executeCommand(line);
            }
        } finally {
            rl.close();
        }
    }

    private async executeCommand(line: string): Promise<void> {
        const parts = line.split(" ").filter(Boolean);
        const command = parts[0];

        if (command === "/suggest") {
            const contactArg = parts[1];

            if (!contactArg) {
                logger.warn("Usage: /suggest <contact>");
                return;
            }

            const state = this.findState(contactArg);

            if (!state) {
                logger.warn(`Unknown contact: ${contactArg}`);
                return;
            }

            const suggestions = await this.generateSuggestionsForState(state);
            this.printSuggestions(state.contact.displayName, suggestions);
            return;
        }

        if (command === "/send") {
            const contactArg = parts[1];

            if (!contactArg) {
                logger.warn("Usage: /send <contact> <text>");
                return;
            }

            const state = this.findState(contactArg);

            if (!state) {
                logger.warn(`Unknown contact: ${contactArg}`);
                return;
            }

            const text = parts.slice(2).join(" ");

            if (!text) {
                logger.warn("Message text is required.");
                return;
            }

            const sent = await this.options.client.sendMessage(state.contact.userId, text);
            const nowUnix = Math.floor(Date.now() / 1000);

            this.options.store.upsertMessageWithRevision(
                state.contact.userId,
                {
                    id: sent.id,
                    senderId: undefined,
                    text,
                    mediaDescription: undefined,
                    isOutgoing: true,
                    date: new Date(nowUnix * 1000).toISOString(),
                    dateUnix: nowUnix,
                    attachments: [],
                },
                "create"
            );

            this.pushHistory(state, `${this.options.myName}: ${text}`);
            logger.info(`Sent to ${state.contact.displayName}`);
            return;
        }

        if (command === "/ask") {
            const contactArg = parts[1];

            if (!contactArg) {
                logger.warn("Usage: /ask <contact> <question>");
                return;
            }

            const state = this.findState(contactArg);

            if (!state) {
                logger.warn(`Unknown contact: ${contactArg}`);
                return;
            }

            const question = parts.slice(2).join(" ");

            if (!question) {
                logger.warn("Question is required.");
                return;
            }

            const answer = await assistantEngine.ask({
                sessionId: `watch-assistant-${state.contact.userId}`,
                mode: state.contact.assistantMode,
                incomingText: question,
                conversationHistory: this.getHistoryText(state),
                stylePrompt: state.contact.config.styleProfile?.derivedPrompt,
            });

            logger.info(pc.green(answer));
            return;
        }

        if (command === "/model") {
            const contactArg = parts[1];
            const modeArg = parts[2] as "autoReply" | "assistant" | "suggestions" | undefined;

            if (!contactArg || !modeArg) {
                logger.warn("Usage: /model <contact> <autoReply|assistant|suggestions>");
                return;
            }

            const state = this.findState(contactArg);

            if (!state) {
                logger.warn(`Unknown contact: ${contactArg}`);
                return;
            }

            const mode = state.contact.config.modes?.[modeArg];

            if (!mode) {
                logger.warn(`Mode ${modeArg} missing in contact configuration.`);
                return;
            }

            const choice = await modelSelector.selectModel();

            if (!choice) {
                return;
            }

            mode.provider = choice.provider.name;
            mode.model = choice.model.id;
            logger.info(`Updated ${state.contact.displayName} ${modeArg} model to ${mode.provider}/${mode.model}`);
            return;
        }

        if (command === "/style" && parts[1] === "derive") {
            const contactArg = parts[2];

            if (!contactArg) {
                logger.warn("Usage: /style derive <contact>");
                return;
            }

            const state = this.findState(contactArg);

            if (!state) {
                logger.warn(`Unknown contact: ${contactArg}`);
                return;
            }

            const result = await styleProfileEngine.deriveStylePrompt(state.contact, this.options.store);

            if (!result) {
                logger.warn("No style profile generated (rules missing or no matching messages).");
                return;
            }

            if (!state.contact.config.styleProfile) {
                state.contact.config.styleProfile = {
                    enabled: true,
                    refresh: "incremental",
                    rules: [],
                    previewInWatch: false,
                };
            }

            state.contact.config.styleProfile.derivedPrompt = result.prompt;
            state.contact.config.styleProfile.derivedAt = result.generatedAt;
            logger.info(`Derived style profile (${result.sampleCount} samples).`);
            logger.info(result.prompt);
            return;
        }

        logger.warn("Unknown command.");
    }
}
