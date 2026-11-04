import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage/storage";
import { loadTelegramBotConfig, resolveTelegramTarget } from "@genesiscz/utils/telegram-bot/lib/config";
import { CHANNEL_NAMES, CHANNELS } from "./channels";
import type {
    AppChannelOverrides,
    ChannelConfigs,
    ChannelName,
    NotifyGlobalConfig,
    ResolvedChannels,
    TelegramChannelConfig,
} from "./types";

/** One key per channel of the table, each built by `entry` (a mapped object the compiler checks for every name). */
function perChannel(entry: <K extends ChannelName>(name: K) => ChannelConfigs[K]): ChannelConfigs {
    return Object.fromEntries(CHANNEL_NAMES.map((name) => [name, entry(name)])) as unknown as ChannelConfigs;
}

const DEFAULT_CHANNELS: ChannelConfigs = perChannel((name) => structuredClone(CHANNELS[name].defaults));

function mergeChannels(global: ChannelConfigs, overrides: AppChannelOverrides["channels"]): ResolvedChannels {
    return perChannel((name) => ({ ...global[name], ...overrides[name] }));
}

/**
 * A switched-on Telegram channel that names no token or no chat sends through the one bot
 * (`tools telegram-bot configure`) to its notifications chat. A channel that names both keeps them, so a notify
 * config and a bot config that name different chats both keep working.
 */
async function withBotTarget(telegram: TelegramChannelConfig): Promise<TelegramChannelConfig> {
    if (!telegram.enabled || (telegram.botToken && telegram.chatId)) {
        return telegram;
    }

    const target = resolveTelegramTarget({
        purpose: "notifications",
        own: telegram,
        bot: await loadTelegramBotConfig().catch((err: unknown) => {
            logger.warn({ err }, "notify: could not read the Telegram bot config; the channel keeps its own target");
            return null;
        }),
    });

    return target ? { ...telegram, botToken: target.botToken, chatId: String(target.chatId) } : telegram;
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
            // A channel the file predates (the phone, added 2026-11-04) reads as its defaults: no migration needed.
            channels: perChannel((name) => ({ ...DEFAULT_CHANNELS[name], ...rawChannels[name] })),
            apps: (raw.apps as Record<string, AppChannelOverrides>) ?? {},
        };

        this.cached = config;
        return config;
    }

    async getChannels(app: string): Promise<ResolvedChannels> {
        const config = await this.load();
        const appOverrides = config.apps[app]?.channels ?? {};
        const merged = mergeChannels(config.channels, appOverrides);
        return { ...merged, telegram: await withBotTarget(merged.telegram) };
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

            const merged: Record<string, unknown> = {
                ...config.apps[app].channels[channel],
                ...override,
            };

            // An `undefined` value means "stop overriding this key": drop it so
            // the global channel value applies again instead of a literal null.
            for (const key of Object.keys(merged)) {
                if (merged[key] === undefined) {
                    delete merged[key];
                }
            }

            config.apps[app].channels[channel] = merged as Partial<ChannelConfigs[K]>;
        });

        this.cached = null;
    }

    /** Remove every per-app override for `channel`, so the global value applies again. */
    async clearAppChannel(app: string, channel: ChannelName): Promise<void> {
        await this.storage.atomicConfigUpdate<NotifyGlobalConfig>((config) => {
            const overrides = config.apps?.[app]?.channels;

            if (overrides) {
                delete overrides[channel];
            }
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
