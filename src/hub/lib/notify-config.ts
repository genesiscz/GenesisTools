import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { Storage, withFileLock } from "@genesiscz/utils/storage";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";

// What the PR notifier watches and which events it posts: `~/.genesis-tools/hub/notify.json`.
// Written by `tools hub notify set` (the hub's settings popover calls it) and read by every poll.

const log = logger.child({ component: "hub/notify-config" });

export const NOTIFY_EVENTS = ["thread", "ciFailed", "ciPassed", "botReview", "merged"] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

/** The daemon's interval grammar (src/daemon/lib/interval.ts): "every N minutes", never "3m". */
export function daemonEvery(intervalMinutes: number): string {
    const minutes = Math.max(1, Math.round(intervalMinutes));
    return `every ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export const NOTIFY_EVENT_LABELS: Record<NotifyEvent, string> = {
    thread: "New review threads",
    ciFailed: "CI failed",
    ciPassed: "CI passed",
    botReview: "A review bot finished",
    merged: "PR merged",
};

export interface NotifyRepoConfig {
    enabled: boolean;
    /** Per-repo switches; an event missing here follows the global switch. */
    events?: Partial<Record<NotifyEvent, boolean>>;
}

export interface NotifyConfig {
    /** The master switch: off, a poll does nothing. */
    enabled: boolean;
    /** Minutes between polls of one repo; errors back off from here. */
    intervalMinutes: number;
    /** Only PRs I opened. */
    onlyMine: boolean;
    events: Record<NotifyEvent, boolean>;
    /** Keyed by a checkout path; worktrees of one repo share its PRs, so any one of them is enough. */
    repos: Record<string, NotifyRepoConfig>;
    /** Logins that count as review bots besides the host's own bot accounts. */
    botLogins: string[];
}

export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 60;

export function defaultNotifyConfig(): NotifyConfig {
    return {
        enabled: true,
        intervalMinutes: 3,
        onlyMine: false,
        events: { thread: true, ciFailed: true, ciPassed: false, botReview: true, merged: true },
        repos: {},
        botLogins: [],
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventSwitches(value: unknown): Partial<Record<NotifyEvent, boolean>> {
    const out: Partial<Record<NotifyEvent, boolean>> = {};

    if (!isRecord(value)) {
        return out;
    }

    for (const event of NOTIFY_EVENTS) {
        if (typeof value[event] === "boolean") {
            out[event] = value[event];
        }
    }

    return out;
}

/**
 * The `--interval` flag: whole minutes inside the range, or an error. The CLI never clamps what a user
 * typed (`--interval 0` used to save 1 and exit 0); only a hand-edited file is clamped on read.
 */
export function parseIntervalFlag(value: string): number {
    const minutes = Number(value);

    if (
        value.trim() === "" ||
        !Number.isInteger(minutes) ||
        minutes < MIN_INTERVAL_MINUTES ||
        minutes > MAX_INTERVAL_MINUTES
    ) {
        throw new Error(
            `--interval takes whole minutes from ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES}, got ${value}`
        );
    }

    return minutes;
}

export function clampInterval(minutes: number): number {
    if (!Number.isFinite(minutes)) {
        return defaultNotifyConfig().intervalMinutes;
    }

    return Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.round(minutes)));
}

/** Any stored shape onto a complete config; unknown keys and wrong types fall back to the defaults. */
export function normalizeNotifyConfig(raw: unknown): NotifyConfig {
    const base = defaultNotifyConfig();

    if (!isRecord(raw)) {
        return base;
    }

    const repos: Record<string, NotifyRepoConfig> = {};

    if (isRecord(raw.repos)) {
        for (const [path, value] of Object.entries(raw.repos)) {
            if (!isRecord(value)) {
                continue;
            }

            const events = eventSwitches(value.events);
            repos[path] = {
                enabled: value.enabled !== false,
                ...(Object.keys(events).length > 0 ? { events } : {}),
            };
        }
    }

    return {
        enabled: typeof raw.enabled === "boolean" ? raw.enabled : base.enabled,
        intervalMinutes:
            typeof raw.intervalMinutes === "number" ? clampInterval(raw.intervalMinutes) : base.intervalMinutes,
        onlyMine: typeof raw.onlyMine === "boolean" ? raw.onlyMine : base.onlyMine,
        events: { ...base.events, ...eventSwitches(raw.events) },
        repos,
        botLogins: Array.isArray(raw.botLogins)
            ? raw.botLogins.filter((login): login is string => typeof login === "string" && login.trim() !== "")
            : base.botLogins,
    };
}

/** The events one repo posts: its own switches over the global ones. */
export function repoEvents(config: NotifyConfig, repoPath: string): Record<NotifyEvent, boolean> {
    return { ...config.events, ...config.repos[repoPath]?.events };
}

export function watchedRepoPaths(config: NotifyConfig): string[] {
    return Object.entries(config.repos)
        .filter(([, repo]) => repo.enabled)
        .map(([path]) => path);
}

export interface NotifySettingsChange {
    enabled?: boolean;
    intervalMinutes?: number;
    onlyMine?: boolean;
    /** Global switches, or the repo's own when `repo` is set. */
    events?: Partial<Record<NotifyEvent, boolean>>;
    /** Scopes `events` to this repo, and is the repo `repoEnabled` turns on or off. */
    repo?: string;
    repoEnabled?: boolean;
    /** Drop the repo's own event switches so it follows the global ones again. */
    resetRepoEvents?: boolean;
    botLogins?: string[];
}

/** One settings change applied to a config; pure, so the CLI and the tests share it. */
export function applyNotifySettings(config: NotifyConfig, change: NotifySettingsChange): NotifyConfig {
    const next: NotifyConfig = {
        ...config,
        events: { ...config.events },
        repos: Object.fromEntries(
            Object.entries(config.repos).map(([path, repo]) => [
                path,
                { ...repo, ...(repo.events ? { events: { ...repo.events } } : {}) },
            ])
        ),
        botLogins: [...config.botLogins],
    };

    if (change.enabled !== undefined) {
        next.enabled = change.enabled;
    }

    if (change.intervalMinutes !== undefined) {
        next.intervalMinutes = clampInterval(change.intervalMinutes);
    }

    if (change.onlyMine !== undefined) {
        next.onlyMine = change.onlyMine;
    }

    if (change.botLogins !== undefined) {
        next.botLogins = [...new Set(change.botLogins.map((login) => login.trim()).filter(Boolean))];
    }

    if (change.repo === undefined) {
        Object.assign(next.events, change.events ?? {});
        return next;
    }

    const repo = next.repos[change.repo] ?? { enabled: false };

    if (change.repoEnabled !== undefined) {
        repo.enabled = change.repoEnabled;
    }

    if (change.resetRepoEvents) {
        delete repo.events;
    }

    if (change.events && Object.keys(change.events).length > 0) {
        repo.events = { ...repo.events, ...change.events };
    }

    next.repos[change.repo] = repo;
    return next;
}

export function notifyDir(): string {
    return new Storage("hub").getBaseDir();
}

export function notifyConfigPath(dir = notifyDir()): string {
    return join(dir, "notify.json");
}

export function readNotifyConfig(path = notifyConfigPath()): NotifyConfig {
    if (!existsSync(path)) {
        return defaultNotifyConfig();
    }

    try {
        return normalizeNotifyConfig(SafeJSON.parse(readFileSync(path, "utf8")));
    } catch (err) {
        log.warn({ err, path }, "notify config unreadable; using the defaults");
        return defaultNotifyConfig();
    }
}

/** Read, change and write back under a lock, so the hub and a poll never lose each other's write. */
export async function updateNotifyConfig(
    change: NotifySettingsChange,
    path = notifyConfigPath()
): Promise<NotifyConfig> {
    mkdirSync(dirname(path), { recursive: true });
    return withFileLock(`${path}.lock`, async () => {
        const next = applyNotifySettings(readNotifyConfig(path), change);
        atomicWriteFileSync(path, `${SafeJSON.stringify(next, null, 2)}\n`);
        log.debug({ path, change }, "notify config updated");
        return next;
    });
}
