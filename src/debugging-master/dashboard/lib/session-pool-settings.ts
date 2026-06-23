import { loadPersistedSettings, savePersistedSettings } from "@ui/settings";

export interface SessionPoolSettings {
    /** How long after exit a session stays in the live / mosaic pool. */
    activeSessionLimitSeconds: number;
    /** When true, show every live-pool session in the mosaic (no tile cap). */
    keepAllAlive: boolean;
}

export const DEFAULT_SESSION_POOL_SETTINGS: SessionPoolSettings = {
    activeSessionLimitSeconds: 60 * 60,
    keepAllAlive: true,
};

export const SESSION_POOL_SETTINGS_STORAGE_KEY = "dbg.sessionPoolSettings";

const persistOptions = {
    storageKey: SESSION_POOL_SETTINGS_STORAGE_KEY,
    defaults: DEFAULT_SESSION_POOL_SETTINGS,
    parse: parseSessionPoolSettings,
};

const MIN_ACTIVE_SESSION_LIMIT_SECONDS = 1;
const MAX_ACTIVE_SESSION_LIMIT_SECONDS = 4 * 60 * 60;

export function activeSessionRetentionMs(settings: SessionPoolSettings): number {
    return settings.activeSessionLimitSeconds * 1000;
}

export function formatActiveSessionLimit(seconds: number): string {
    const clamped = clampActiveSessionLimitSeconds(seconds);

    if (clamped < 60) {
        return `${clamped}s`;
    }

    const minutes = Math.floor(clamped / 60);
    const remainderSeconds = clamped % 60;

    if (clamped < 3600) {
        if (remainderSeconds === 0) {
            return `${minutes}m`;
        }

        return `${minutes}m ${remainderSeconds}s`;
    }

    const hours = Math.floor(clamped / 3600);
    const remainderMinutes = Math.floor((clamped % 3600) / 60);
    const tailSeconds = clamped % 60;

    if (remainderMinutes === 0 && tailSeconds === 0) {
        return `${hours}h`;
    }

    if (tailSeconds === 0) {
        return `${hours}h ${remainderMinutes}m`;
    }

    if (remainderMinutes === 0) {
        return `${hours}h ${tailSeconds}s`;
    }

    return `${hours}h ${remainderMinutes}m ${tailSeconds}s`;
}

type PersistedSessionPoolSettings = Partial<SessionPoolSettings> & {
    activeSessionLimitMinutes?: number;
};

export function parseSessionPoolSettings(raw: unknown): SessionPoolSettings {
    const parsed = (raw ?? {}) as PersistedSessionPoolSettings;

    return {
        activeSessionLimitSeconds: resolveActiveSessionLimitSeconds(parsed),
        keepAllAlive: parsed.keepAllAlive !== false,
    };
}

export function loadSessionPoolSettings(): SessionPoolSettings {
    return loadPersistedSettings(persistOptions);
}

export function saveSessionPoolSettings(settings: SessionPoolSettings): void {
    savePersistedSettings(persistOptions, settings);
}

function resolveActiveSessionLimitSeconds(parsed: PersistedSessionPoolSettings): number {
    if (typeof parsed.activeSessionLimitSeconds === "number") {
        return clampActiveSessionLimitSeconds(parsed.activeSessionLimitSeconds);
    }

    if (typeof parsed.activeSessionLimitMinutes === "number") {
        return clampActiveSessionLimitSeconds(parsed.activeSessionLimitMinutes * 60);
    }

    return DEFAULT_SESSION_POOL_SETTINGS.activeSessionLimitSeconds;
}

function clampActiveSessionLimitSeconds(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return DEFAULT_SESSION_POOL_SETTINGS.activeSessionLimitSeconds;
    }

    return Math.min(MAX_ACTIVE_SESSION_LIMIT_SECONDS, Math.max(MIN_ACTIVE_SESSION_LIMIT_SECONDS, Math.round(value)));
}

export { MAX_ACTIVE_SESSION_LIMIT_SECONDS, MIN_ACTIVE_SESSION_LIMIT_SECONDS };
