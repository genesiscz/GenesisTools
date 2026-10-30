import { determineAccountLabel } from "@genesiscz/utils/claude/account-label";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage/storage";

/** @deprecated Use AIAccountEntry from @app/utils/config/ai.types instead */
export interface AccountConfig {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number; // Unix timestamp in ms
    label?: string;
}

/**
 * @deprecated Use `notificationsConfig.getChannels("claude")` from `@genesiscz/utils/notifications` instead.
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
    /** Hidden JSON-only toggle — alerts when extra usage enables and every +5%. Default off. */
    extraUsage?: boolean;
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
    /** Set when the ping used the login-long oat token instead of the short-lived OAuth pair. */
    via?: "login-long";
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

/**
 * Claude Code's own `crossSessionInbound` values. "accept" delivers a cross-session message (from
 * `tools claude message`, another agent, a script) without asking; "hold" keeps Claude Code's default, which holds a
 * message whose sender attests no permission mode for approval in a session that bypasses prompts.
 */
export const CROSS_SESSION_INBOUND_VALUES = ["accept", "hold"] as const;

export type CrossSessionInbound = (typeof CROSS_SESSION_INBOUND_VALUES)[number];

/**
 * How GenesisTools launches a Claude Code session on this machine (`tools claude run`, and `tools cmux agents new
 * claude` through it). A launch-time choice of the Claude harness, so it lives in the claude tool's config and not in
 * the AI config (accounts and models, shared by every provider) or Claude Code's own settings (every session).
 */
export interface LaunchPreferences {
    /**
     * "accept" passes `--settings {"crossSessionInbound":"accept"}` to every session GenesisTools starts; "hold" passes
     * nothing, so Claude Code's own settings decide. A per-run `--cross-messages` / `--no-cross-messages` wins.
     */
    crossSessionInbound: CrossSessionInbound;
}

export const DEFAULT_LAUNCH: LaunchPreferences = { crossSessionInbound: "accept" };

export interface ClaudeConfig {
    notifications: NotificationConfig;
    warmup?: WarmupConfig;
    /** Absent on disk until a value is set, so a load-and-save never pins today's default into the file. */
    launch?: Partial<LaunchPreferences>;
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

/** `~/.genesis-tools/claude/config.json`, for messages that say where a setting was saved. */
export function claudeConfigPath(): string {
    return storage.getConfigPath();
}

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
        launch: saved.launch,
    };
}

export function isCrossSessionInbound(value: unknown): value is CrossSessionInbound {
    return CROSS_SESSION_INBOUND_VALUES.some((known) => known === value);
}

/** `launch.crossSessionInbound` and where it came from: the config file, or the default when the file has none. */
export async function crossSessionInboundSetting(): Promise<{
    value: CrossSessionInbound;
    source: "file" | "default";
}> {
    const saved: unknown = (await loadConfig()).launch?.crossSessionInbound;

    if (saved === undefined) {
        return { value: DEFAULT_LAUNCH.crossSessionInbound, source: "default" };
    }

    if (!isCrossSessionInbound(saved)) {
        logger.warn(
            { saved, file: storage.getConfigPath() },
            `claude config launch.crossSessionInbound is not one of ${CROSS_SESSION_INBOUND_VALUES.join(", ")}; using the default`
        );
        return { value: DEFAULT_LAUNCH.crossSessionInbound, source: "default" };
    }

    return { value: saved, source: "file" };
}

/** The launch preferences with the defaults filled in, so callers never read the config shape themselves. */
export async function launchPreferences(): Promise<LaunchPreferences> {
    const inbound = await crossSessionInboundSetting();
    return { ...DEFAULT_LAUNCH, crossSessionInbound: inbound.value };
}

/** Saves `launch.crossSessionInbound` through the locked read-modify-write; the other keys stay as they are. */
export async function setCrossSessionInbound(value: CrossSessionInbound): Promise<void> {
    await updateConfig((config) => {
        config.launch = { ...config.launch, crossSessionInbound: value };
    });
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
            launch: raw.launch,
        };
        updater(config);
        // Write back the full merged config
        Object.assign(raw, config);
    });
}

/**
 * Fetch profiles for all accounts and update their labels in the config.
 * Best-effort — failures are silently ignored.
 */
export async function refreshAccountLabels(): Promise<void> {
    const { fetchOAuthProfile } = await import("@genesiscz/utils/claude/auth");
    const { AIConfig } = await import("@genesiscz/utils/ai/AIConfig");

    const config = await AIConfig.load();
    const accounts = config.getAccountsByProvider("anthropic-sub");

    if (accounts.length === 0) {
        return;
    }

    const profiles = await Promise.all(
        accounts.map((acc) =>
            fetchOAuthProfile(acc.tokens.accessToken ?? "").catch((err) => {
                logger.debug({ err, account: acc.name }, "[claude] refreshAccountLabels: per-account fetch failed");
                return undefined;
            })
        )
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
