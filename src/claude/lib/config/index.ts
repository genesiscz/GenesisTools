import type { OAuthProfileResponse } from "@app/utils/claude/auth";
import { Storage } from "@app/utils/storage/storage";

/** @deprecated Use AIAccountEntry from @app/utils/config/ai.types instead */
export interface AccountConfig {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number; // Unix timestamp in ms
    label?: string;
}

/**
 * @deprecated Use `notificationsConfig.getChannels("claude")` from `@app/utils/notifications` instead.
 * Kept for backward compatibility with existing config files.
 */
export interface NotificationChannels {
    macos: boolean;
    telegram?: { botToken: string; chatId: string };
    webhook?: { url: string };
}

export interface NotificationConfig {
    sessionThresholds: number[];
    weeklyThresholds: number[];
    channels: NotificationChannels;
    watchInterval: number;
}

export interface WarmupSchedule {
    startHour: number; // 0-23
    endHour: number; // 1-24 (last warmup ping at endHour - 5)
}

export interface WarmupSessionConfig {
    enabled: boolean;
    accounts: string[]; // multiselect from configured accounts
    schedule: WarmupSchedule;
    notify: boolean; // notify on warmup
    notifyOnlyIfUnused: boolean; // only if session was "Not Used" (utilization === null/0)
}

export interface WarmupWeeklyConfig {
    enabled: boolean;
    accounts: string[];
    notify: boolean;
}

export interface WarmupTodayEvent {
    account: string;
    type: "session" | "weekly";
    time: string; // "06:00"
    success: boolean;
}

export interface WarmupTodayLog {
    date: string; // "2026-04-04", resets on first warmup of new day
    events: WarmupTodayEvent[];
}

export interface WarmupConfig {
    session: WarmupSessionConfig;
    weekly: WarmupWeeklyConfig;
    todayLog: WarmupTodayLog;
}

export interface ClaudeConfig {
    notifications: NotificationConfig;
    warmup?: WarmupConfig;
}

export const DEFAULT_WARMUP: WarmupConfig = {
    session: {
        enabled: false,
        accounts: [],
        schedule: { startHour: 6, endHour: 22 },
        notify: true,
        notifyOnlyIfUnused: true,
    },
    weekly: {
        enabled: false,
        accounts: [],
        notify: true,
    },
    todayLog: { date: "", events: [] },
};

const DEFAULT_NOTIFICATIONS: NotificationConfig = {
    sessionThresholds: [80],
    weeklyThresholds: [20, 40, 60, 80],
    channels: { macos: true },
    watchInterval: 60,
};

const DEFAULT_CONFIG: ClaudeConfig = {
    notifications: DEFAULT_NOTIFICATIONS,
};

const storage = new Storage("claude");

/** Execute fn while holding an exclusive lock on the claude config file. */
export function withConfigLock<T>(fn: () => Promise<T>, timeout?: number): Promise<T> {
    return storage.withConfigLock(fn, timeout);
}

export async function loadConfig(): Promise<ClaudeConfig> {
    const saved = await storage.getConfig<Partial<ClaudeConfig>>();
    if (!saved) {
        return { ...DEFAULT_CONFIG };
    }
    return {
        notifications: {
            ...DEFAULT_NOTIFICATIONS,
            ...saved.notifications,
            channels: {
                ...DEFAULT_NOTIFICATIONS.channels,
                ...saved.notifications?.channels,
            },
        },
        warmup: saved.warmup
            ? {
                  session: { ...DEFAULT_WARMUP.session, ...saved.warmup.session },
                  weekly: { ...DEFAULT_WARMUP.weekly, ...saved.warmup.weekly },
                  todayLog: saved.warmup.todayLog ?? DEFAULT_WARMUP.todayLog,
              }
            : undefined,
    };
}

export async function saveConfig(config: ClaudeConfig): Promise<void> {
    await storage.setConfig(config);
}

/**
 * Atomically read-modify-write the claude config.
 * Acquires file lock, reads fresh config from disk, calls updater, saves.
 * Prevents TOCTOU bugs where stale in-memory config overwrites
 * tokens refreshed by another process (e.g. daemon).
 */
export function updateConfig(updater: (config: ClaudeConfig) => void): Promise<ClaudeConfig> {
    return storage.atomicConfigUpdate<ClaudeConfig>((raw) => {
        // Apply defaults (same logic as loadConfig) before passing to updater
        const config: ClaudeConfig = {
            notifications: {
                ...DEFAULT_NOTIFICATIONS,
                ...raw.notifications,
                channels: {
                    ...DEFAULT_NOTIFICATIONS.channels,
                    ...raw.notifications?.channels,
                },
            },
            warmup: {
                session: { ...DEFAULT_WARMUP.session, ...raw.warmup?.session },
                weekly: { ...DEFAULT_WARMUP.weekly, ...raw.warmup?.weekly },
                todayLog: raw.warmup?.todayLog ?? DEFAULT_WARMUP.todayLog,
            },
        };
        updater(config);
        // Write back the full merged config
        Object.assign(raw, config);
    });
}

export function determineAccountLabel(profile: OAuthProfileResponse | undefined): string | undefined {
    if (!profile) {
        return undefined;
    }

    const tier = profile.organization.rate_limit_tier;

    if (tier.includes("max")) {
        // Extract multiplier: "max_5x" → "max 5x", "max_20x" → "max 20x"
        const match = tier.match(/max[_\s]*(\d+x?)/i);
        // Fall back to raw tier value (e.g. "max_5") rather than just "max"
        return match ? `max ${match[1]}` : tier.replace(/_/g, " ");
    }

    if (tier.includes("pro")) {
        return "pro";
    }

    return profile.organization.billing_type;
}

/**
 * Fetch profiles for all accounts and update their labels in the config.
 * Best-effort — failures are silently ignored.
 */
export async function refreshAccountLabels(): Promise<void> {
    const { fetchOAuthProfile } = await import("@app/utils/claude/auth");
    const { AIConfig } = await import("@app/utils/ai/AIConfig");

    const config = await AIConfig.load();
    const accounts = config.getAccountsByProvider("anthropic-sub");

    if (accounts.length === 0) {
        return;
    }

    const profiles = await Promise.all(
        accounts.map((acc) => fetchOAuthProfile(acc.tokens.accessToken ?? "").catch(() => undefined))
    );

    // Batch all label updates into a single disk write
    const updates = new Map<string, string>();

    for (let i = 0; i < accounts.length; i++) {
        const newLabel = determineAccountLabel(profiles[i]);

        if (newLabel && newLabel !== accounts[i].label) {
            updates.set(accounts[i].name, newLabel);
        }
    }

    if (updates.size > 0) {
        await config.mutate((data) => {
            for (const [name, label] of updates) {
                const acc = data.accounts.find((a) => a.name === name);

                if (acc) {
                    acc.label = label;
                }
            }
        });
    }
}
