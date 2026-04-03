import { Storage } from "@app/utils/storage/storage";
import type { AppChannelOverrides, ChannelConfigs, ChannelName, NotifyGlobalConfig, ResolvedChannels } from "./types";

const DEFAULT_CHANNELS: ChannelConfigs = {
    system: { enabled: true, sound: "Ping", title: "GenesisTools", ignoreDnD: false },
    telegram: { enabled: false },
    webhook: { enabled: false },
    say: { enabled: false },
};

const EMPTY_APP: AppChannelOverrides = {
    meta: {},
    channels: {},
};

function mergeChannels(global: ChannelConfigs, overrides: AppChannelOverrides["channels"]): ResolvedChannels {
    return {
        system: { ...global.system, ...overrides.system },
        telegram: { ...global.telegram, ...overrides.telegram },
        webhook: { ...global.webhook, ...overrides.webhook },
        say: { ...global.say, ...overrides.say },
    };
}

export class NotificationsConfig {
    private storage = new Storage("notify");
    private cached: NotifyGlobalConfig | null = null;

    async load(): Promise<NotifyGlobalConfig> {
        if (this.cached) {
            return this.cached;
        }

        const raw = await this.storage.getConfig<Partial<NotifyGlobalConfig>>();
        const rawChannels = raw?.channels;
        const config: NotifyGlobalConfig = {
            terminalNotifierPath: raw?.terminalNotifierPath,
            channels: {
                system: { ...DEFAULT_CHANNELS.system, ...rawChannels?.system },
                telegram: { ...DEFAULT_CHANNELS.telegram, ...rawChannels?.telegram },
                webhook: { ...DEFAULT_CHANNELS.webhook, ...rawChannels?.webhook },
                say: { ...DEFAULT_CHANNELS.say, ...rawChannels?.say },
            },
            apps: raw?.apps ?? {},
        };

        this.cached = config;
        return config;
    }

    private async save(): Promise<void> {
        if (!this.cached) {
            return;
        }

        const snapshot: NotifyGlobalConfig = this.cached;

        await this.storage.withConfigLock(async () => {
            await this.storage.setConfig(snapshot);
        });
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
        const config = await this.load();

        if (!config.apps[app]) {
            config.apps[app] = { ...EMPTY_APP, channels: {} };
        }

        config.apps[app].channels[channel] = {
            ...config.apps[app].channels[channel],
            ...override,
        };

        await this.save();
    }

    async setAppMeta(app: string, meta: Record<string, unknown>): Promise<void> {
        const config = await this.load();

        if (!config.apps[app]) {
            config.apps[app] = { ...EMPTY_APP, channels: {} };
        }

        config.apps[app].meta = { ...config.apps[app].meta, ...meta };
        await this.save();
    }

    async setGlobalChannel<K extends ChannelName>(channel: K, value: ChannelConfigs[K]): Promise<void> {
        const config = await this.load();
        config.channels[channel] = value;
        await this.save();
    }

    invalidate(): void {
        this.cached = null;
    }
}

export const notificationsConfig = new NotificationsConfig();
