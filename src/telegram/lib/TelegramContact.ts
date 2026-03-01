import type {
    ActionType,
    AskModeConfig,
    ContactModesConfig,
    StyleProfileConfig,
    SuggestionModeConfig,
    TelegramContactV2,
    WatchConfig,
} from "./types";
import { DEFAULT_MODE_CONFIG, DEFAULT_STYLE_PROFILE, DEFAULT_WATCH_CONFIG, DEFAULTS } from "./types";

export class TelegramContact {
    readonly userId: string;
    readonly displayName: string;
    readonly username: string | undefined;
    readonly config: TelegramContactV2;

    constructor(config: TelegramContactV2) {
        this.userId = config.userId;
        this.displayName = config.displayName;
        this.username = config.username;
        this.config = config;
    }

    get actions(): ActionType[] {
        return this.config.actions;
    }

    get chatType() {
        return this.config.chatType;
    }

    get hasAskAction(): boolean {
        return this.config.actions.includes("ask");
    }

    get modes(): ContactModesConfig {
        return this.config.modes ?? DEFAULT_MODE_CONFIG;
    }

    get autoReply(): AskModeConfig {
        return this.modes.autoReply;
    }

    get assistant(): AskModeConfig {
        return this.modes.assistant;
    }

    get suggestions(): SuggestionModeConfig {
        return this.modes.suggestions;
    }

    get watch(): WatchConfig {
        return this.config.watch ?? DEFAULT_WATCH_CONFIG;
    }

    get contextLength(): number {
        return this.watch.contextLength;
    }

    get styleProfile(): StyleProfileConfig {
        return this.config.styleProfile ?? DEFAULT_STYLE_PROFILE;
    }

    get askProvider(): string {
        return this.autoReply.provider ?? DEFAULTS.askProvider;
    }

    get askModel(): string {
        return this.autoReply.model ?? DEFAULTS.askModel;
    }

    get askSystemPrompt(): string {
        return this.autoReply.systemPrompt ?? DEFAULTS.askSystemPrompt;
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

    static fromConfig(config: TelegramContactV2): TelegramContact {
        return new TelegramContact(config);
    }
}
