import type { Api } from "telegram";
import type { ActionType, ContactConfig } from "./types";
import { DEFAULTS } from "./types";

export class TelegramContact {
    constructor(
        public readonly userId: string,
        public readonly displayName: string,
        public readonly username: string | undefined,
        public readonly config: ContactConfig,
    ) {}

    get actions(): ActionType[] {
        return this.config.actions;
    }

    get hasAskAction(): boolean {
        return this.config.actions.includes("ask");
    }

    get askSystemPrompt(): string {
        return this.config.askSystemPrompt ?? DEFAULTS.askSystemPrompt;
    }

    get askProvider(): string {
        return this.config.askProvider ?? DEFAULTS.askProvider;
    }

    get askModel(): string {
        return this.config.askModel ?? DEFAULTS.askModel;
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
            config,
        );
    }

    static fromConfig(config: ContactConfig): TelegramContact {
        return new TelegramContact(config.userId, config.displayName, config.username, config);
    }
}
