import { chmodSync } from "node:fs";
import { Storage } from "@app/utils/storage/storage";
import type {
    ContactConfig,
    TelegramConfigData,
    TelegramConfigDataV2,
    TelegramContactV2,
} from "./types";
import {
    DEFAULT_MODE_CONFIG,
    DEFAULT_STYLE_PROFILE,
    DEFAULT_WATCH_CONFIG,
    DEFAULTS,
} from "./types";

export function migrateContactV1toV2(v1: ContactConfig): TelegramContactV2 {
    const hasAsk = v1.actions.includes("ask");

    return {
        userId: v1.userId,
        displayName: v1.displayName,
        username: v1.username,
        chatType: "user",
        actions: v1.actions,
        watch: { ...DEFAULT_WATCH_CONFIG },
        modes: {
            autoReply: {
                enabled: hasAsk,
                provider: v1.askProvider,
                model: v1.askModel,
                systemPrompt: v1.askSystemPrompt,
            },
            assistant: { ...DEFAULT_MODE_CONFIG.assistant },
            suggestions: { ...DEFAULT_MODE_CONFIG.suggestions },
        },
        styleProfile: { ...DEFAULT_STYLE_PROFILE },
        replyDelayMin: v1.replyDelayMin,
        replyDelayMax: v1.replyDelayMax,
    };
}

export function migrateConfigV1toV2(config: TelegramConfigData | TelegramConfigDataV2): TelegramConfigDataV2 {
    if ("version" in config && config.version === 2) {
        return config as TelegramConfigDataV2;
    }

    const v1 = config as TelegramConfigData;
    return {
        version: 2,
        apiId: v1.apiId,
        apiHash: v1.apiHash,
        session: v1.session,
        me: v1.me,
        contacts: v1.contacts.map(migrateContactV1toV2),
        globalDefaults: {
            modes: { ...DEFAULT_MODE_CONFIG },
            watch: { ...DEFAULT_WATCH_CONFIG },
            styleProfile: { ...DEFAULT_STYLE_PROFILE },
        },
        configuredAt: v1.configuredAt,
    };
}

export class TelegramToolConfig {
    private storage = new Storage("telegram");
    private data: TelegramConfigDataV2 | null = null;

    async load(): Promise<TelegramConfigDataV2 | null> {
        const raw = await this.storage.getConfig<TelegramConfigData | TelegramConfigDataV2>();

        if (!raw) {
            return null;
        }

        this.data = migrateConfigV1toV2(raw);
        return this.data;
    }

    async save(config: TelegramConfigDataV2): Promise<void> {
        await this.storage.setConfig(config);
        this.data = config;
        this.protect();
    }

    async updateSession(session: string): Promise<void> {
        await this.storage.setConfigValue("session", session);

        if (this.data) {
            this.data.session = session;
        }

        this.protect();
    }

    getApiId(): number {
        return this.data?.apiId ?? DEFAULTS.apiId;
    }

    getApiHash(): string {
        return this.data?.apiHash ?? DEFAULTS.apiHash;
    }

    getSession(): string {
        return this.data?.session ?? "";
    }

    getContacts(): TelegramContactV2[] {
        return this.data?.contacts ?? [];
    }

    hasValidSession(): boolean {
        return !!this.data?.session;
    }

    private protect(): void {
        try {
            chmodSync(this.storage.getConfigPath(), 0o600);
        } catch {
            // ignore -- file may not exist yet
        }
    }
}
