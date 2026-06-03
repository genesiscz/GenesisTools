import { SafeJSON } from "@app/utils/json";

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

const STORAGE_KEY = "dbg.sessionPoolSettings";

const MIN_ACTIVE_SESSION_LIMIT_MINUTES = 5;
const MAX_ACTIVE_SESSION_LIMIT_MINUTES = 24 * 60;

export function activeSessionRetentionMs(settings: SessionPoolSettings): number {
    return settings.activeSessionLimitMinutes * 60 * 1000;
}

export function loadSessionPoolSettings(): SessionPoolSettings {
    if (typeof window === "undefined") {
        return DEFAULT_SESSION_POOL_SETTINGS;
    }

    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return DEFAULT_SESSION_POOL_SETTINGS;
        }

        const parsed = SafeJSON.parse(raw) as Partial<SessionPoolSettings>;

        return {
            activeSessionLimitMinutes: clampActiveSessionLimitMinutes(parsed.activeSessionLimitMinutes),
            keepAllAlive: parsed.keepAllAlive !== false,
        };
    } catch {
        return DEFAULT_SESSION_POOL_SETTINGS;
    }
}

export function saveSessionPoolSettings(settings: SessionPoolSettings): void {
    if (typeof window === "undefined") {
        return;
    }

    try {
        window.localStorage.setItem(STORAGE_KEY, SafeJSON.stringify(settings));
    } catch {
        // localStorage unavailable
    }
}

function clampActiveSessionLimitMinutes(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return DEFAULT_SESSION_POOL_SETTINGS.activeSessionLimitMinutes;
    }

    return Math.min(MAX_ACTIVE_SESSION_LIMIT_MINUTES, Math.max(MIN_ACTIVE_SESSION_LIMIT_MINUTES, Math.round(value)));
}

export { MIN_ACTIVE_SESSION_LIMIT_MINUTES, MAX_ACTIVE_SESSION_LIMIT_MINUTES };
