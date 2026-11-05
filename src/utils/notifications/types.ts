import type { NotificationAction } from "@genesiscz/utils/macos/notifications";

export interface SystemChannelConfig {
    enabled: boolean;
    sound?: string;
    title?: string;
    ignoreDnD?: boolean;
}

export interface TelegramChannelConfig {
    enabled: boolean;
    botToken?: string;
    chatId?: string;
    apiRoot?: string;
}

export interface WebhookChannelConfig {
    enabled: boolean;
    url?: string;
}

export interface SayChannelConfig {
    enabled: boolean;
    voice?: string;
    /** `tools say --provider`: macos, xai, openai. Unset = the say profile default. */
    provider?: string;
}

/**
 * APNs token auth for a real phone (a simulator needs none: `xcrun simctl push` delivers to it). The key file is the
 * `.p8` App Store Connect gives once; the topic defaults to the app's bundle id.
 */
export interface PhoneApnsConfig {
    teamId?: string;
    keyId?: string;
    keyPath?: string;
    topic?: string;
}

/**
 * Push to the phones that registered with this Mac (`POST /api/push/devices`). Each device record names how it is
 * reached (APNs or the simulator), so the transport is a property of the device, not of this config.
 */
export interface PhoneChannelConfig {
    enabled: boolean;
    /**
     * Whether the prompt and the options go on the lock screen. Apple carries the payload; off sends a fixed title and
     * line instead of the event's title, subtitle and message, which all name the topic (the buttons work either way,
     * their tokens are sealed to the device).
     */
    text?: boolean;
    apns?: PhoneApnsConfig;
    /** When an alert goes to the phone at all (F14); absent fields take the defaults in `phoneWhen`. */
    when?: PhoneWhenConfig;
}

/**
 * When the phone gets an alert (F14). `desk: "away"` sends an alert to the phone only while the Mac is locked or idle
 * `idleMinutes`; an alert that comes while someone works at the Mac shows on the Mac's own banner only, and the phone
 * never gets it later. `"always"` sends every time.
 * `quiet` is a local `HH:MM` span with no alert, which a time-sensitive event still breaks. Retractions always go.
 */
export interface PhoneWhenConfig {
    desk?: "away" | "always";
    idleMinutes?: number;
    quiet?: { from: string; to: string };
}

export interface ChannelConfigs {
    system: SystemChannelConfig;
    telegram: TelegramChannelConfig;
    webhook: WebhookChannelConfig;
    say: SayChannelConfig;
    phone: PhoneChannelConfig;
}

export type ChannelName = keyof ChannelConfigs;

export interface AppChannelOverrides {
    meta: Record<string, unknown>;
    channels: {
        [K in ChannelName]?: Partial<ChannelConfigs[K]>;
    };
}

export interface NotifyGlobalConfig {
    terminalNotifierPath?: string;
    channels: ChannelConfigs;
    apps: Record<string, AppChannelOverrides>;
}

/** Merged result -- global + app overrides applied */
export type ResolvedChannels = ChannelConfigs;

export interface NotificationEvent {
    app: string;
    title?: string;
    message: string;
    subtitle?: string;
    group?: string;
    open?: string;
    execute?: string;
    /** Per-call sound override (falls back to channel config) */
    sound?: string;
    /** Per-call DnD bypass (falls back to channel config) */
    ignoreDnD?: boolean;
    /** Custom icon path/URL (terminal-notifier only) */
    appIcon?: string;
    /**
     * Stable id, so the banner can be retracted or replaced later (`genesis-app` only, the
     * `system` channel forwards it to {@link NotificationOptions.id}).
     */
    id?: string;
    /** Buttons on the banner (`genesis-app` only, forwarded to {@link NotificationOptions.actions}). */
    actions?: NotificationAction[];
    /**
     * The system channel counts an osascript hand-off as delivered unless this is set. macOS
     * never confirms that hand-off, so a caller that reports the outcome to a person (the
     * `tools notify` exit code) sets it; pollers that re-post an undelivered event must not.
     */
    requireConfirmed?: boolean;
    /** What the phone channel shows beside the alert: one-tap answers and the thread it groups under. */
    phone?: PhoneNoticeExtras;
    /** Breaks through Focus where the channel can (the phone's time-sensitive level). */
    timeSensitive?: boolean;
    /**
     * Per-call channel allow-list. When set, only these channels may fire for
     * this event (still subject to each channel being enabled in config). When
     * undefined, all config-enabled channels fire (default behaviour).
     */
    only?: ChannelName[];
}

/** The phone-only part of an event (nested by the channel that reads it). */
export interface PhoneNoticeExtras {
    /** Groups the notices of one session on the lock screen (APNs `thread-id`). */
    thread?: string;
    /**
     * One button per option letter. Each answers through the act door (`POST /api/act`) with its token, which is sealed
     * to each device before it leaves the Mac.
     */
    answers?: { letters: string[]; recommended?: string; tokens: Record<string, string> };
}

/** What one channel did with one event. */
export interface ChannelReceipt {
    suppressed?: string;
    /** The channel accepted the event, or had nothing to send (switched off, no target). */
    ok: boolean;
    /** Why it did not send, or what it sent to (a phone channel names its devices). */
    detail?: string;
}

/** The kind of a field a user may set on a channel (`tools monitor notify set`, the monitor settings page). */
export type ChannelFieldKind = "string" | "boolean";

/**
 * One notification channel: everything a caller needs to know about it. The dispatcher, Monitor, the notify wizard and
 * the shops channels read {@link ChannelTable}, so a new channel is one entry and the compiler names every place that
 * must learn about it.
 */
export interface ChannelDefinition<K extends ChannelName> {
    name: K;
    label: string;
    defaults: ChannelConfigs[K];
    /** The flat fields a user may set (`enabled` included); nested settings have their own command. */
    fields: Readonly<Record<string, ChannelFieldKind>>;
    /** Fields that never leave this process (masked in every view). */
    secretKeys: readonly string[];
    /** Why a switched-on channel cannot send (no token, no device); undefined when it can. */
    unusable(config: ChannelConfigs[K]): string | undefined;
    /** One line for a list, secrets masked. */
    describe(config: ChannelConfigs[K]): string;
    /** Sends one event. Never throws. A switched-off channel answers `{ ok: true }` without sending. */
    post(event: NotificationEvent, config: ChannelConfigs[K]): Promise<ChannelReceipt>;
    /**
     * Takes a posted notice back by its stable id (`NotificationEvent.id`), switched on or not, since a notice posted
     * before a switch-off still shows. True when something was taken back. Never throws.
     */
    retract(noticeId: string, config: ChannelConfigs[K]): Promise<boolean>;
}

export type ChannelTable = { readonly [K in ChannelName]: ChannelDefinition<K> };
