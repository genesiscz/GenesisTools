import type { Api } from "telegram";
import type { ActionType, AskModeConfig, ContactConfig, SuggestionModeConfig, TelegramRuntimeMode } from "./types";
import { DEFAULT_MODE_CONFIG, DEFAULT_WATCH_CONFIG, DEFAULTS } from "./types";

export class TelegramContact {
    constructor(
        public readonly userId: string,
        public readonly displayName: string,
        public readonly username: string | undefined,
        public readonly config: ContactConfig
    ) {}

    get actions(): ActionType[] {
        return this.config.actions;
    }

    get hasAskAction(): boolean {
        return this.actions.includes("ask") || this.autoReplyMode.enabled;
    }

    get watchEnabled(): boolean {
        return this.config.watch?.enabled ?? DEFAULT_WATCH_CONFIG.enabled;
    }

    get contextLength(): number {
        return this.config.watch?.contextLength ?? DEFAULT_WATCH_CONFIG.contextLength;
    }

    get runtimeMode(): TelegramRuntimeMode {
        return this.config.watch?.runtimeMode ?? DEFAULT_WATCH_CONFIG.runtimeMode ?? "daemon";
    }

    get autoReplyMode(): AskModeConfig {
        return {
            ...DEFAULT_MODE_CONFIG.autoReply,
            ...this.config.modes?.autoReply,
            enabled: this.config.modes?.autoReply?.enabled ?? this.actions.includes("ask"),
        };
    }

    get assistantMode(): AskModeConfig {
        return {
            ...DEFAULT_MODE_CONFIG.assistant,
            ...this.config.modes?.assistant,
        };
    }

    get suggestionMode(): SuggestionModeConfig {
        return {
            ...DEFAULT_MODE_CONFIG.suggestions,
            ...this.config.modes?.suggestions,
        };
    }

    get askSystemPrompt(): string {
        return this.autoReplyMode.systemPrompt ?? DEFAULTS.askSystemPrompt;
    }

    get askProvider(): string {
        return this.autoReplyMode.provider ?? DEFAULTS.askProvider;
    }

    get askModel(): string {
        return this.autoReplyMode.model ?? DEFAULTS.askModel;
    }

    get replyDelayMin(): number {
        return this.config.replyDelayMin ?? DEFAULTS.replyDelayMin;
    }

    get replyDelayMax(): number {
        return this.config.replyDelayMax ?? DEFAULTS.replyDelayMax;
    }

    get randomDelay(): number {
        return this.replyDelayMin + Math.random() * (this.replyDelayMax - this.replyDelayMin);
    }

    static fromUser(user: Api.User, config: ContactConfig): TelegramContact {
        const displayName = `${user.firstName || ""} ${user.lastName || ""}`.trim();

        return new TelegramContact(
            user.id.toString(),
            displayName || config.displayName,
            user.username ?? undefined,
            config
        );
    }

    static fromConfig(config: ContactConfig): TelegramContact {
        return new TelegramContact(config.userId, config.displayName, config.username, config);
    }
}
