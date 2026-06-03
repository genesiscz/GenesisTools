import { loadPersistedSettings, savePersistedSettings } from "@ui/settings";

export interface SessionPoolSettings {
    /** How long after exit a session stays in the live / mosaic pool. */
    activeSessionLimitMinutes: number;
    /** When true, show every live-pool session in the mosaic (no tile cap). */
    keepAllAlive: boolean;
}

export const DEFAULT_SESSION_POOL_SETTINGS: SessionPoolSettings = {
    activeSessionLimitMinutes: 60,
    keepAllAlive: true,
};

export const SESSION_POOL_SETTINGS_STORAGE_KEY = "dbg.sessionPoolSettings";

const persistOptions = {
    storageKey: SESSION_POOL_SETTINGS_STORAGE_KEY,
    defaults: DEFAULT_SESSION_POOL_SETTINGS,
    parse: parseSessionPoolSettings,
};

const MIN_ACTIVE_SESSION_LIMIT_MINUTES = 5;
const MAX_ACTIVE_SESSION_LIMIT_MINUTES = 24 * 60;

export function activeSessionRetentionMs(settings: SessionPoolSettings): number {
    return settings.activeSessionLimitMinutes * 60 * 1000;
}

export function parseSessionPoolSettings(raw: unknown): SessionPoolSettings {
    const parsed = (raw ?? {}) as Partial<SessionPoolSettings>;

    return {
        activeSessionLimitMinutes: clampActiveSessionLimitMinutes(parsed.activeSessionLimitMinutes),
        keepAllAlive: parsed.keepAllAlive !== false,
    };
}

export function loadSessionPoolSettings(): SessionPoolSettings {
    return loadPersistedSettings(persistOptions);
}

export function saveSessionPoolSettings(settings: SessionPoolSettings): void {
    savePersistedSettings(persistOptions, settings);
}

function clampActiveSessionLimitMinutes(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return DEFAULT_SESSION_POOL_SETTINGS.activeSessionLimitMinutes;
    }

    return Math.min(MAX_ACTIVE_SESSION_LIMIT_MINUTES, Math.max(MIN_ACTIVE_SESSION_LIMIT_MINUTES, Math.round(value)));
}

export { MIN_ACTIVE_SESSION_LIMIT_MINUTES, MAX_ACTIVE_SESSION_LIMIT_MINUTES };
