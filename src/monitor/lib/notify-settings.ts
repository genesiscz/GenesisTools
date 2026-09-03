import { logger } from "@genesiscz/utils/logger";
import {
    type ChannelConfigs,
    type ChannelName,
    dispatchNotification,
    dispatchSay,
    dispatchSystem,
    dispatchTelegram,
    dispatchWebhook,
    type NotificationEvent,
    notificationsConfig,
    type ResolvedChannels,
    type SayChannelConfig,
    type SystemChannelConfig,
    type TelegramChannelConfig,
    type WebhookChannelConfig,
} from "@genesiscz/utils/notifications";
import { maskSecrets } from "./types";
import { WatcherValidationError } from "./validate";

export const NOTIFY_APP = "monitor";
export const CHANNEL_NAMES: readonly ChannelName[] = ["system", "say", "telegram", "webhook"];

/** Monitor-specific switches stored under `apps.monitor.meta` in the shared notify config. */
export interface MonitorNotifyMeta {
    /** Notify when a watcher turns degraded (down always notifies). Default true. */
    onDegraded: boolean;
    /** Notify when a watcher recovers. Default true. */
    onRecover: boolean;
}

export interface ChannelView {
    name: ChannelName;
    /** Effective value for the monitor app (global merged with the app override). */
    resolved: Record<string, unknown>;
    /** Which keys the monitor app overrides. */
    overridden: string[];
}

export interface NotifySettings {
    app: string;
    meta: MonitorNotifyMeta;
    channels: ChannelView[];
}

export interface NotifySettingsPatch {
    meta?: Partial<MonitorNotifyMeta>;
    channels?: {
        [K in ChannelName]?: Partial<ChannelConfigs[K]> | null;
    };
}

function readMeta(raw: Record<string, unknown>): MonitorNotifyMeta {
    return {
        onDegraded: raw.onDegraded !== false,
        onRecover: raw.onRecover !== false,
    };
}

export async function getMonitorNotifyMeta(): Promise<MonitorNotifyMeta> {
    return readMeta(await notificationsConfig.getAppMeta(NOTIFY_APP));
}

export async function getNotifySettings(): Promise<NotifySettings> {
    notificationsConfig.invalidate();
    const config = await notificationsConfig.load();
    const resolved: ResolvedChannels = await notificationsConfig.getChannels(NOTIFY_APP);
    const overrides = config.apps[NOTIFY_APP]?.channels ?? {};

    return {
        app: NOTIFY_APP,
        meta: readMeta(config.apps[NOTIFY_APP]?.meta ?? {}),
        channels: CHANNEL_NAMES.map((name) => ({
            name,
            resolved: maskSecrets(resolved[name] as unknown as Record<string, unknown>),
            overridden: Object.keys(overrides[name] ?? {}),
        })),
    };
}

const STRING_FIELDS: Record<ChannelName, readonly string[]> = {
    system: ["sound", "title"],
    say: ["voice", "provider"],
    telegram: ["botToken", "chatId"],
    webhook: ["url"],
};

const BOOLEAN_FIELDS: Record<ChannelName, readonly string[]> = {
    system: ["enabled", "ignoreDnD"],
    say: ["enabled"],
    telegram: ["enabled"],
    webhook: ["enabled"],
};

function cleanChannelPatch(name: ChannelName, raw: unknown): Record<string, unknown> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new WatcherValidationError(`channels.${name} must be an object`);
    }

    const record = raw as Record<string, unknown>;
    const clean: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(record)) {
        if (BOOLEAN_FIELDS[name].includes(key)) {
            if (typeof value !== "boolean") {
                throw new WatcherValidationError(`channels.${name}.${key} must be a boolean`);
            }

            clean[key] = value;
            continue;
        }

        if (STRING_FIELDS[name].includes(key)) {
            if (typeof value !== "string") {
                throw new WatcherValidationError(`channels.${name}.${key} must be a string`);
            }

            // Empty string clears the app override for that key.
            clean[key] = value.trim() === "" ? undefined : value.trim();
            continue;
        }

        throw new WatcherValidationError(`channels.${name}.${key} is not a known field`);
    }

    return clean;
}

/**
 * Wraps a validated key/value bag as the override of one channel. The keys have
 * been checked against that channel's field list by then, so this is where the
 * loose record becomes the channel's own config type, in one place.
 */
export function channelOverride<K extends ChannelName>(
    channel: K,
    override: unknown
): NonNullable<NotifySettingsPatch["channels"]> {
    // Validation lives here, so no caller (HTTP or CLI) can hand an unchecked bag to setAppChannel.
    return { [channel]: cleanChannelPatch(channel, override) as Partial<ChannelConfigs[K]> };
}

function applyChannelOverride<K extends ChannelName>(channel: K, override: Partial<ChannelConfigs[K]>): Promise<void> {
    return notificationsConfig.setAppChannel(NOTIFY_APP, channel, override);
}

export function parseNotifySettingsPatch(value: unknown): NotifySettingsPatch {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new WatcherValidationError("body must be a JSON object");
    }

    const record = value as Record<string, unknown>;
    const patch: NotifySettingsPatch = {};

    if (record.meta !== undefined) {
        const meta = record.meta;

        if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
            throw new WatcherValidationError("meta must be an object");
        }

        const metaRecord = meta as Record<string, unknown>;
        patch.meta = {};

        for (const key of ["onDegraded", "onRecover"] as const) {
            if (metaRecord[key] !== undefined) {
                if (typeof metaRecord[key] !== "boolean") {
                    throw new WatcherValidationError(`meta.${key} must be a boolean`);
                }

                patch.meta[key] = metaRecord[key];
            }
        }
    }

    if (record.channels !== undefined) {
        const channels = record.channels;

        if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
            throw new WatcherValidationError("channels must be an object");
        }

        patch.channels = {};

        for (const [name, raw] of Object.entries(channels as Record<string, unknown>)) {
            if (!CHANNEL_NAMES.includes(name as ChannelName)) {
                throw new WatcherValidationError(`unknown channel "${name}"`);
            }

            const channel = name as ChannelName;
            Object.assign(patch.channels, raw === null ? { [channel]: null } : channelOverride(channel, raw));
        }
    }

    return patch;
}

/**
 * Writes monitor-app overrides into the shared notify config. `null` for a
 * channel removes every override so the global `tools notify config` value
 * applies again.
 */
export async function updateNotifySettings(patch: NotifySettingsPatch): Promise<NotifySettings> {
    if (patch.meta && Object.keys(patch.meta).length > 0) {
        await notificationsConfig.setAppMeta(NOTIFY_APP, patch.meta);
    }

    for (const channel of CHANNEL_NAMES) {
        const override = patch.channels?.[channel];

        if (override === undefined) {
            continue;
        }

        if (override === null) {
            await notificationsConfig.clearAppChannel(NOTIFY_APP, channel);
            continue;
        }

        await applyChannelOverride(channel, override);
    }

    logger.info({ patch: describePatch(patch) }, "monitor: notification settings updated");

    return getNotifySettings();
}

function describePatch(patch: NotifySettingsPatch): Record<string, unknown> {
    const channels: Record<string, unknown> = {};

    for (const [name, override] of Object.entries(patch.channels ?? {})) {
        channels[name] = override === null ? null : maskSecrets(override as Record<string, unknown>);
    }

    return { meta: patch.meta, channels };
}

/**
 * Demo through the app-default channels. With `channel` set, only that one
 * fires, and it fires even when it is currently disabled (that is the point
 * of a demo button on a box you are about to switch on).
 */
export async function sendTestNotification(channel?: ChannelName): Promise<{ sent: true; channels: ChannelName[] }> {
    const resolved = await notificationsConfig.getChannels(NOTIFY_APP);
    const targets = channel ? [channel] : CHANNEL_NAMES.filter((name) => resolved[name].enabled);
    const event: NotificationEvent = {
        app: NOTIFY_APP,
        title: "Monitor test",
        subtitle: "notification check",
        message: `Monitor notifications work. Channels: ${targets.join(", ") || "none"}.`,
        group: "monitor-test",
    };

    if (!channel) {
        await dispatchNotification(event);

        return { sent: true, channels: targets };
    }

    const config = { ...resolved[channel], enabled: true };

    switch (channel) {
        case "system":
            await dispatchSystem(event, config as SystemChannelConfig);
            break;
        case "say":
            await dispatchSay(event.message, config as SayChannelConfig);
            break;
        case "telegram":
            await dispatchTelegram(event, config as TelegramChannelConfig);
            break;
        case "webhook":
            await dispatchWebhook(event, config as WebhookChannelConfig);
            break;
    }

    return { sent: true, channels: [channel] };
}
