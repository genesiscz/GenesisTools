export interface DisplaySettings {
    uiFontSize: number;
    headerFontSize: number;
    logFontSize: number;
}

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
    uiFontSize: 12,
    headerFontSize: 11,
    logFontSize: 11,
};

const STORAGE_KEY = "dbg.displaySettings";

export function loadDisplaySettings(): DisplaySettings {
    if (typeof window === "undefined") {
        return DEFAULT_DISPLAY_SETTINGS;
    }

    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return DEFAULT_DISPLAY_SETTINGS;
        }

        const parsed = JSON.parse(raw) as Partial<DisplaySettings>;

        return {
            uiFontSize: clampFontSize(parsed.uiFontSize, DEFAULT_DISPLAY_SETTINGS.uiFontSize),
            headerFontSize: clampFontSize(parsed.headerFontSize, DEFAULT_DISPLAY_SETTINGS.headerFontSize),
            logFontSize: clampFontSize(parsed.logFontSize, DEFAULT_DISPLAY_SETTINGS.logFontSize),
        };
    } catch {
        return DEFAULT_DISPLAY_SETTINGS;
    }
}

export function saveDisplaySettings(settings: DisplaySettings): void {
    if (typeof window === "undefined") {
        return;
    }

    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
        // localStorage unavailable
    }
}

function clampFontSize(value: unknown, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return fallback;
    }

    return Math.min(18, Math.max(9, Math.round(value)));
}

export function applyDisplaySettings(settings: DisplaySettings): void {
    if (typeof document === "undefined") {
        return;
    }

    const root = document.documentElement;
    root.style.setProperty("--dbg-font-ui", `${settings.uiFontSize}px`);
    root.style.setProperty("--dbg-font-header", `${settings.headerFontSize}px`);
    root.style.setProperty("--dbg-font-log", `${settings.logFontSize}px`);
}
