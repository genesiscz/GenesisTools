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
}

export interface WebhookChannelConfig {
    enabled: boolean;
    url?: string;
}

export interface SayChannelConfig {
    enabled: boolean;
    voice?: string;
}

export interface ChannelConfigs {
    system: SystemChannelConfig;
    telegram: TelegramChannelConfig;
    webhook: WebhookChannelConfig;
    say: SayChannelConfig;
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
export interface ResolvedChannels {
    system: SystemChannelConfig;
    telegram: TelegramChannelConfig;
    webhook: WebhookChannelConfig;
    say: SayChannelConfig;
}

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
}
