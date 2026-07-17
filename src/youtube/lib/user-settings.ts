import { isOutputLang } from "@app/youtube/lib/languages";
import type { SummaryFormat, SummaryLength, SummaryTone } from "@app/youtube/lib/video.types";

export type SettingsTaskKind = "summary" | "insights" | "ask";

export interface TaskDefaultSettings {
    tone?: SummaryTone;
    length?: SummaryLength;
    format?: SummaryFormat;
    /** 2-letter ISO output language for this action. */
    lang?: string;
    /** Preferred model (admin/dev only — the UI role-gates; the server just stores it). */
    model?: string;
}

export interface PanelSettings {
    autoOpen?: boolean;
    defaultTab?: string;
    collapsed?: boolean;
    floating?: boolean;
    rememberCollapse?: boolean;
}

export interface UserSettings {
    theme?: "system" | "light" | "dark";
    density?: "comfortable" | "compact";
    accent?: string;
    taskDefaults?: Partial<Record<SettingsTaskKind, TaskDefaultSettings>>;
    panel?: PanelSettings;
}

const THEMES: UserSettings["theme"][] = ["system", "light", "dark"];
const DENSITIES: UserSettings["density"][] = ["comfortable", "compact"];
const TASK_KINDS: SettingsTaskKind[] = ["summary", "insights", "ask"];
const TONES: SummaryTone[] = ["insightful", "funny", "actionable", "controversial"];
const LENGTHS: SummaryLength[] = ["short", "auto", "detailed"];
const FORMATS: SummaryFormat[] = ["list", "qa"];
const PANEL_BOOL_KEYS = ["autoOpen", "collapsed", "floating", "rememberCollapse"] as const;

/** The defaults every client sees before the user has customized anything. */
export const DEFAULT_USER_SETTINGS: UserSettings = {
    theme: "system",
    density: "comfortable",
    taskDefaults: {},
    panel: {},
};

/** Merge the stored (possibly sparse) settings over the defaults for client consumption. */
export function resolveUserSettings(stored: UserSettings | null | undefined): UserSettings {
    const s = stored ?? {};

    return {
        theme: s.theme ?? DEFAULT_USER_SETTINGS.theme,
        density: s.density ?? DEFAULT_USER_SETTINGS.density,
        accent: s.accent,
        taskDefaults: s.taskDefaults ?? {},
        panel: s.panel ?? {},
    };
}

type ValidationResult = { ok: true; value: UserSettings } | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a PATCH payload: rejects unknown top-level keys and bad enum/types
 * with a message (→ 400 in the route). Returns only the recognized keys.
 */
export function validateSettingsPatch(raw: unknown): ValidationResult {
    if (!isPlainObject(raw)) {
        return { ok: false, error: "settings must be an object" };
    }

    const allowed = new Set(["theme", "density", "accent", "taskDefaults", "panel"]);

    for (const key of Object.keys(raw)) {
        if (!allowed.has(key)) {
            return { ok: false, error: `unknown settings key: ${key}` };
        }
    }

    const value: UserSettings = {};

    if (raw.theme !== undefined) {
        if (!THEMES.includes(raw.theme as UserSettings["theme"])) {
            return { ok: false, error: "invalid theme" };
        }

        value.theme = raw.theme as UserSettings["theme"];
    }

    if (raw.density !== undefined) {
        if (!DENSITIES.includes(raw.density as UserSettings["density"])) {
            return { ok: false, error: "invalid density" };
        }

        value.density = raw.density as UserSettings["density"];
    }

    if (raw.accent !== undefined) {
        if (typeof raw.accent !== "string") {
            return { ok: false, error: "accent must be a string" };
        }

        value.accent = raw.accent;
    }

    if (raw.taskDefaults !== undefined) {
        const parsed = validateTaskDefaults(raw.taskDefaults);

        if (!parsed.ok) {
            return parsed;
        }

        value.taskDefaults = parsed.value;
    }

    if (raw.panel !== undefined) {
        const parsed = validatePanel(raw.panel);

        if (!parsed.ok) {
            return parsed;
        }

        value.panel = parsed.value;
    }

    return { ok: true, value };
}

function validateTaskDefaults(
    raw: unknown
): { ok: true; value: Partial<Record<SettingsTaskKind, TaskDefaultSettings>> } | { ok: false; error: string } {
    if (!isPlainObject(raw)) {
        return { ok: false, error: "taskDefaults must be an object" };
    }

    const value: Partial<Record<SettingsTaskKind, TaskDefaultSettings>> = {};

    for (const [kind, entry] of Object.entries(raw)) {
        if (!TASK_KINDS.includes(kind as SettingsTaskKind)) {
            return { ok: false, error: `unknown task kind: ${kind}` };
        }

        if (!isPlainObject(entry)) {
            return { ok: false, error: `taskDefaults.${kind} must be an object` };
        }

        const parsed = validateTaskEntry(kind, entry);

        if (!parsed.ok) {
            return parsed;
        }

        value[kind as SettingsTaskKind] = parsed.value;
    }

    return { ok: true, value };
}

function validateTaskEntry(
    kind: string,
    entry: Record<string, unknown>
): { ok: true; value: TaskDefaultSettings } | { ok: false; error: string } {
    const allowed = new Set(["tone", "length", "format", "lang", "model"]);

    for (const key of Object.keys(entry)) {
        if (!allowed.has(key)) {
            return { ok: false, error: `unknown taskDefaults.${kind} key: ${key}` };
        }
    }

    const value: TaskDefaultSettings = {};

    if (entry.tone !== undefined) {
        if (!TONES.includes(entry.tone as SummaryTone)) {
            return { ok: false, error: `invalid taskDefaults.${kind}.tone` };
        }

        value.tone = entry.tone as SummaryTone;
    }

    if (entry.length !== undefined) {
        if (!LENGTHS.includes(entry.length as SummaryLength)) {
            return { ok: false, error: `invalid taskDefaults.${kind}.length` };
        }

        value.length = entry.length as SummaryLength;
    }

    if (entry.format !== undefined) {
        if (!FORMATS.includes(entry.format as SummaryFormat)) {
            return { ok: false, error: `invalid taskDefaults.${kind}.format` };
        }

        value.format = entry.format as SummaryFormat;
    }

    if (entry.lang !== undefined) {
        if (typeof entry.lang !== "string" || !isOutputLang(entry.lang)) {
            return { ok: false, error: `invalid taskDefaults.${kind}.lang` };
        }

        value.lang = entry.lang;
    }

    if (entry.model !== undefined) {
        if (typeof entry.model !== "string") {
            return { ok: false, error: `taskDefaults.${kind}.model must be a string` };
        }

        value.model = entry.model;
    }

    return { ok: true, value };
}

function validatePanel(raw: unknown): { ok: true; value: PanelSettings } | { ok: false; error: string } {
    if (!isPlainObject(raw)) {
        return { ok: false, error: "panel must be an object" };
    }

    const allowed = new Set<string>([...PANEL_BOOL_KEYS, "defaultTab"]);

    for (const key of Object.keys(raw)) {
        if (!allowed.has(key)) {
            return { ok: false, error: `unknown panel key: ${key}` };
        }
    }

    const value: PanelSettings = {};

    for (const key of PANEL_BOOL_KEYS) {
        const entry = raw[key];

        if (entry !== undefined) {
            if (typeof entry !== "boolean") {
                return { ok: false, error: `panel.${key} must be a boolean` };
            }

            value[key] = entry;
        }
    }

    if (raw.defaultTab !== undefined) {
        if (typeof raw.defaultTab !== "string") {
            return { ok: false, error: "panel.defaultTab must be a string" };
        }

        value.defaultTab = raw.defaultTab;
    }

    return { ok: true, value };
}

/** Deep-merge a validated patch over current settings, one top-level section at a time. */
export function mergeUserSettings(current: UserSettings, patch: UserSettings): UserSettings {
    const next: UserSettings = { ...current };

    if (patch.theme !== undefined) {
        next.theme = patch.theme;
    }

    if (patch.density !== undefined) {
        next.density = patch.density;
    }

    if (patch.accent !== undefined) {
        next.accent = patch.accent;
    }

    if (patch.taskDefaults !== undefined) {
        const mergedTaskDefaults: Partial<Record<SettingsTaskKind, TaskDefaultSettings>> = { ...current.taskDefaults };

        for (const [kind, entry] of Object.entries(patch.taskDefaults)) {
            mergedTaskDefaults[kind as SettingsTaskKind] = {
                ...mergedTaskDefaults[kind as SettingsTaskKind],
                ...entry,
            };
        }

        next.taskDefaults = mergedTaskDefaults;
    }

    if (patch.panel !== undefined) {
        next.panel = { ...current.panel, ...patch.panel };
    }

    return next;
}
