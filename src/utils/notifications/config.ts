import { Storage } from "@app/utils/storage/storage";
import type { AppChannelOverrides, ChannelConfigs, ChannelName, NotifyGlobalConfig, ResolvedChannels } from "./types";

const DEFAULT_CHANNELS: ChannelConfigs = {
    system: { enabled: true, sound: "Ping", title: "GenesisTools", ignoreDnD: false },
    telegram: { enabled: false },
    webhook: { enabled: false },
    say: { enabled: false },
};

function mergeChannels(global: ChannelConfigs, overrides: AppChannelOverrides["channels"]): ResolvedChannels {
    return {
        system: { ...global.system, ...overrides.system },
        telegram: { ...global.telegram, ...overrides.telegram },
        webhook: { ...global.webhook, ...overrides.webhook },
        say: { ...global.say, ...overrides.say },
    };
}

/**
 * Migrate legacy flat notify config (pre-channels era) into the channels structure.
 * Old format: { title, sound, ignoreDnD, say: boolean }
 * New format: { channels: { system: {...}, say: {...}, ... }, apps: {} }
 */
function migrateLegacyConfig(raw: Record<string, unknown>): void {
    if (raw.channels) {
        return;
    }

    const channels: Record<string, Record<string, unknown>> = {};

    // Legacy system notification fields → channels.system
    if (raw.title || raw.sound || raw.ignoreDnD !== undefined) {
        channels.system = {
            enabled: true,
            ...(raw.title ? { title: raw.title } : {}),
            ...(raw.sound ? { sound: raw.sound } : {}),
            ...(raw.ignoreDnD !== undefined ? { ignoreDnD: raw.ignoreDnD } : {}),
        };
        delete raw.title;
        delete raw.sound;
        delete raw.ignoreDnD;
    }

    // Legacy say boolean → channels.say
    if (typeof raw.say === "boolean") {
        channels.say = { enabled: raw.say };
        delete raw.say;
    }

    if (Object.keys(channels).length > 0) {
        raw.channels = channels;
    }
}

export class NotificationsConfig {
    private storage = new Storage("notify");
    private cached: NotifyGlobalConfig | null = null;

    async load(): Promise<NotifyGlobalConfig> {
        if (this.cached) {
            return this.cached;
        }

        const raw = (await this.storage.getConfig<Record<string, unknown>>()) ?? {};

        // Migrate legacy flat config into channels structure
        migrateLegacyConfig(raw);

        const rawChannels = (raw.channels ?? {}) as Partial<ChannelConfigs>;
        const config: NotifyGlobalConfig = {
            terminalNotifierPath: raw.terminalNotifierPath as string | undefined,
            channels: {
                system: { ...DEFAULT_CHANNELS.system, ...rawChannels.system },
                telegram: { ...DEFAULT_CHANNELS.telegram, ...rawChannels.telegram },
                webhook: { ...DEFAULT_CHANNELS.webhook, ...rawChannels.webhook },
                say: { ...DEFAULT_CHANNELS.say, ...rawChannels.say },
            },
            apps: (raw.apps as Record<string, AppChannelOverrides>) ?? {},
        };

        this.cached = config;
        return config;
    }

    async getChannels(app: string): Promise<ResolvedChannels> {
        const config = await this.load();
        const appOverrides = config.apps[app]?.channels ?? {};
        return mergeChannels(config.channels, appOverrides);
    }

    async getAppMeta(app: string): Promise<Record<string, unknown>> {
        const config = await this.load();
        return config.apps[app]?.meta ?? {};
    }

    async setAppChannel<K extends ChannelName>(
        app: string,
        channel: K,
        override: Partial<ChannelConfigs[K]>
    ): Promise<void> {
        await this.storage.atomicConfigUpdate<NotifyGlobalConfig>((config) => {
            if (!config.apps) {
                config.apps = {};
            }

            if (!config.apps[app]) {
                config.apps[app] = { meta: {}, channels: {} };
            }

            config.apps[app].channels[channel] = {
                ...config.apps[app].channels[channel],
                ...override,
            };
        });

        this.cached = null;
    }

    async setAppMeta(app: string, meta: Record<string, unknown>): Promise<void> {
        await this.storage.atomicConfigUpdate<NotifyGlobalConfig>((config) => {
            if (!config.apps) {
                config.apps = {};
            }

            if (!config.apps[app]) {
                config.apps[app] = { meta: {}, channels: {} };
            }

            config.apps[app].meta = { ...config.apps[app].meta, ...meta };
        });

        this.cached = null;
    }

    async setGlobalChannel<K extends ChannelName>(channel: K, value: ChannelConfigs[K]): Promise<void> {
        await this.storage.atomicConfigUpdate<NotifyGlobalConfig>((config) => {
            if (!config.channels) {
                config.channels = structuredClone(DEFAULT_CHANNELS);
            }

            config.channels[channel] = value;
        });

        this.cached = null;
    }

    invalidate(): void {
        this.cached = null;
    }
}

export const notificationsConfig = new NotificationsConfig();
