import { loadPersistedSettings, savePersistedSettings } from "@ui/settings";

export type LineBoundaries = "show" | "hide";

export type TimestampMode = "every" | "change" | "never";

export type LogFontFamily = "default" | "jetbrains" | "system" | "fira-code" | "ibm-plex";

export interface LogFontFamilyPreset {
    label: string;
    css: string;
    /** Load Google Fonts when this preset is active. */
    webFont?: boolean;
}

export const LOG_FONT_FAMILY_PRESETS: Record<LogFontFamily, LogFontFamilyPreset> = {
    default: {
        label: "Default",
        css: "'JetBrains Mono', ui-monospace, Menlo, Monaco, Consolas, monospace",
    },
    jetbrains: {
        label: "JetBrains",
        css: "'JetBrains Mono', ui-monospace, Menlo, Monaco, Consolas, monospace",
        webFont: true,
    },
    system: {
        label: "System",
        css: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas, monospace",
    },
    "fira-code": {
        label: "Fira Code",
        css: "'Fira Code', ui-monospace, Menlo, Monaco, Consolas, monospace",
        webFont: true,
    },
    "ibm-plex": {
        label: "IBM Plex",
        css: "'IBM Plex Mono', ui-monospace, Menlo, Monaco, Consolas, monospace",
        webFont: true,
    },
};

export const LOG_FONT_FAMILY_OPTIONS = Object.entries(LOG_FONT_FAMILY_PRESETS).map(([value, preset]) => ({
    value: value as LogFontFamily,
    label: preset.label,
}));

export interface DisplaySettings {
    uiFontSize: number;
    headerFontSize: number;
    logFontSize: number;
    lineBoundaries: LineBoundaries;
    logFontFamily: LogFontFamily;
    timestampMode: TimestampMode;
    showLineId: boolean;
    wrapLongLines: boolean;
    fullJsonContext: boolean;
}

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
    uiFontSize: 12,
    headerFontSize: 11,
    logFontSize: 11,
    lineBoundaries: "show",
    logFontFamily: "default",
    timestampMode: "every",
    showLineId: true,
    wrapLongLines: true,
    fullJsonContext: false,
};

export const DEFAULT_LOG_DISPLAY_SETTINGS: Pick<
    DisplaySettings,
    "timestampMode" | "lineBoundaries" | "showLineId" | "wrapLongLines" | "fullJsonContext"
> = {
    timestampMode: DEFAULT_DISPLAY_SETTINGS.timestampMode,
    lineBoundaries: DEFAULT_DISPLAY_SETTINGS.lineBoundaries,
    showLineId: DEFAULT_DISPLAY_SETTINGS.showLineId,
    wrapLongLines: DEFAULT_DISPLAY_SETTINGS.wrapLongLines,
    fullJsonContext: DEFAULT_DISPLAY_SETTINGS.fullJsonContext,
};

export const DEFAULT_TYPOGRAPHY_SETTINGS: Pick<
    DisplaySettings,
    "uiFontSize" | "headerFontSize" | "logFontSize" | "logFontFamily"
> = {
    uiFontSize: DEFAULT_DISPLAY_SETTINGS.uiFontSize,
    headerFontSize: DEFAULT_DISPLAY_SETTINGS.headerFontSize,
    logFontSize: DEFAULT_DISPLAY_SETTINGS.logFontSize,
    logFontFamily: DEFAULT_DISPLAY_SETTINGS.logFontFamily,
};

export const DISPLAY_SETTINGS_STORAGE_KEY = "dbg.displaySettings";

const persistOptions = {
    storageKey: DISPLAY_SETTINGS_STORAGE_KEY,
    defaults: DEFAULT_DISPLAY_SETTINGS,
    parse: parseDisplaySettings,
};

const WEB_FONTS_LINK_ID = "dbg-web-fonts";
const WEB_FONTS_URL =
    "https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500&family=IBM+Plex+Mono:wght@400;500&family=JetBrains+Mono:wght@400;500;600;700&display=swap";

const LOG_FONT_FAMILIES = new Set<LogFontFamily>(Object.keys(LOG_FONT_FAMILY_PRESETS) as LogFontFamily[]);

const TIMESTAMP_MODES = new Set<TimestampMode>(["every", "change", "never"]);

export function parseDisplaySettings(raw: unknown): DisplaySettings {
    const parsed = (raw ?? {}) as Partial<DisplaySettings>;

    return {
        uiFontSize: clampFontSize(parsed.uiFontSize, DEFAULT_DISPLAY_SETTINGS.uiFontSize),
        headerFontSize: clampFontSize(parsed.headerFontSize, DEFAULT_DISPLAY_SETTINGS.headerFontSize),
        logFontSize: clampFontSize(parsed.logFontSize, DEFAULT_DISPLAY_SETTINGS.logFontSize),
        lineBoundaries: parsed.lineBoundaries === "hide" ? "hide" : "show",
        logFontFamily: parseLogFontFamily(parsed.logFontFamily),
        timestampMode: parseTimestampMode(parsed.timestampMode),
        showLineId: parsed.showLineId !== false,
        wrapLongLines: parsed.wrapLongLines !== false,
        fullJsonContext: parsed.fullJsonContext === true,
    };
}

export function loadDisplaySettings(): DisplaySettings {
    return loadPersistedSettings(persistOptions);
}

export function saveDisplaySettings(settings: DisplaySettings): void {
    savePersistedSettings(persistOptions, settings);
}

function clampFontSize(value: unknown, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return fallback;
    }

    return Math.min(18, Math.max(9, Math.round(value)));
}

function parseLogFontFamily(value: unknown): LogFontFamily {
    if (typeof value === "string" && LOG_FONT_FAMILIES.has(value as LogFontFamily)) {
        return value as LogFontFamily;
    }

    return DEFAULT_DISPLAY_SETTINGS.logFontFamily;
}

function parseTimestampMode(value: unknown): TimestampMode {
    if (typeof value === "string" && TIMESTAMP_MODES.has(value as TimestampMode)) {
        return value as TimestampMode;
    }

    return DEFAULT_DISPLAY_SETTINGS.timestampMode;
}

export function resolveLogFontFamilyCss(family: LogFontFamily): string {
    return LOG_FONT_FAMILY_PRESETS[family].css;
}

function syncWebFonts(family: LogFontFamily): void {
    if (typeof document === "undefined") {
        return;
    }

    const preset = LOG_FONT_FAMILY_PRESETS[family];
    const existing = document.getElementById(WEB_FONTS_LINK_ID);

    if (preset.webFont) {
        if (!existing) {
            const link = document.createElement("link");
            link.id = WEB_FONTS_LINK_ID;
            link.rel = "stylesheet";
            link.href = WEB_FONTS_URL;
            document.head.appendChild(link);
        }
        return;
    }

    if (existing) {
        existing.remove();
    }
}

export function applyDisplaySettings(settings: DisplaySettings): void {
    if (typeof document === "undefined") {
        return;
    }

    const root = document.documentElement;
    syncWebFonts(settings.logFontFamily);
    root.style.setProperty("--dbg-font-ui", `${settings.uiFontSize}px`);
    root.style.setProperty("--dbg-font-header", `${settings.headerFontSize}px`);
    root.style.setProperty("--dbg-font-log", `${settings.logFontSize}px`);
    root.style.setProperty("--dbg-font-family", resolveLogFontFamilyCss(settings.logFontFamily));
    root.dataset.dbgLineBoundaries = settings.lineBoundaries;
    root.dataset.dbgTimestampMode = settings.timestampMode;
    root.dataset.dbgShowLineId = settings.showLineId ? "true" : "false";
    root.dataset.dbgWrapLines = settings.wrapLongLines ? "true" : "false";
}
