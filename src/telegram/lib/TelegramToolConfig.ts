import { chmodSync } from "node:fs";
import { Storage } from "@app/utils/storage/storage";
import type {
    ContactConfig,
    ContactModesConfig,
    TelegramConfigData,
    TelegramDefaultsConfig,
    WatchConfig,
} from "./types";
import {
    DEFAULT_MODE_CONFIG,
    DEFAULT_STYLE_PROFILE,
    DEFAULT_WATCH_CONFIG,
    DEFAULTS,
    TELEGRAM_CONFIG_VERSION,
} from "./types";

function cloneModesConfig(): ContactModesConfig {
    return {
        autoReply: { ...DEFAULT_MODE_CONFIG.autoReply },
        assistant: { ...DEFAULT_MODE_CONFIG.assistant },
        suggestions: { ...DEFAULT_MODE_CONFIG.suggestions },
    };
}

function cloneWatchConfig(): WatchConfig {
    return { ...DEFAULT_WATCH_CONFIG };
}

function normalizeModes(contact: ContactConfig): ContactModesConfig {
    const modes = cloneModesConfig();

    if (contact.modes) {
        modes.autoReply = { ...modes.autoReply, ...contact.modes.autoReply };
        modes.assistant = { ...modes.assistant, ...contact.modes.assistant };
        modes.suggestions = { ...modes.suggestions, ...contact.modes.suggestions };
    }

    if (contact.askProvider) {
        modes.autoReply.provider = contact.askProvider;
    }

    if (contact.askModel) {
        modes.autoReply.model = contact.askModel;
    }

    if (contact.askSystemPrompt) {
        modes.autoReply.systemPrompt = contact.askSystemPrompt;
    }

    modes.autoReply.enabled = contact.actions.includes("ask") || modes.autoReply.enabled;

    return modes;
}

function normalizeContact(contact: ContactConfig): ContactConfig {
    const watch = contact.watch ? { ...cloneWatchConfig(), ...contact.watch } : cloneWatchConfig();
    const modes = normalizeModes(contact);
    const styleProfile = { ...DEFAULT_STYLE_PROFILE, ...contact.styleProfile };

    return {
        ...contact,
        dialogType: contact.dialogType ?? "user",
        replyDelayMin: contact.replyDelayMin ?? DEFAULTS.replyDelayMin,
        replyDelayMax: contact.replyDelayMax ?? DEFAULTS.replyDelayMax,
        watch,
        modes,
        styleProfile,
    };
}

function normalizeDefaults(defaults: TelegramDefaultsConfig | undefined): TelegramDefaultsConfig {
    if (!defaults) {
        return {
            autoReply: { ...DEFAULT_MODE_CONFIG.autoReply },
            assistant: { ...DEFAULT_MODE_CONFIG.assistant },
            suggestions: { ...DEFAULT_MODE_CONFIG.suggestions },
        };
    }

    return {
        autoReply: { ...DEFAULT_MODE_CONFIG.autoReply, ...defaults.autoReply },
        assistant: { ...DEFAULT_MODE_CONFIG.assistant, ...defaults.assistant },
        suggestions: { ...DEFAULT_MODE_CONFIG.suggestions, ...defaults.suggestions },
    };
}

function normalizeConfig(config: TelegramConfigData): TelegramConfigData {
    const contacts = config.contacts.map((contact) => normalizeContact(contact));

    return {
        ...config,
        version: TELEGRAM_CONFIG_VERSION,
        defaults: normalizeDefaults(config.defaults),
        contacts,
    };
}

export class TelegramToolConfig {
    private storage = new Storage("telegram");
    private data: TelegramConfigData | null = null;

    async load(): Promise<TelegramConfigData | null> {
        const raw = await this.storage.getConfig<TelegramConfigData>();

        if (!raw) {
            this.data = null;
            return null;
        }

        const normalized = normalizeConfig(raw);
        this.data = normalized;

        if (raw.version !== normalized.version || JSON.stringify(raw) !== JSON.stringify(normalized)) {
            await this.storage.setConfig(normalized);
            this.protect();
        }

        return normalized;
    }

    async save(config: TelegramConfigData): Promise<void> {
        const normalized = normalizeConfig(config);
        await this.storage.setConfig(normalized);
        this.data = normalized;
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

    getContacts(): ContactConfig[] {
        return this.data?.contacts ?? [];
    }

    getDefaults(): TelegramDefaultsConfig {
        return normalizeDefaults(this.data?.defaults);
    }

    hasValidSession(): boolean {
        return !!this.data?.session;
    }

    private protect(): void {
        try {
            chmodSync(this.storage.getConfigPath(), 0o600);
        } catch {
            // ignore — file may not exist yet
        }
    }
}
