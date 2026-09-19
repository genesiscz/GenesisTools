import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage";
import { z } from "zod";
import { DEFAULT_EVALUATION_PROVIDER, EVALUATION_PROVIDERS } from "./types";

/**
 * Saved Jev defaults. Each key is a flag a caller would otherwise have to pass on every run; an
 * explicit flag always wins, then this file, then the built-in default. They live beside the
 * credentials in `~/.genesis-tools/jev/config.json` under one `settings` object, so a saved
 * default can never be mistaken for an API key.
 */
export const jevSettingsSchema = z
    .object({
        provider: z.enum(EVALUATION_PROVIDERS),
        scope: z.enum(["auto", "window", "chrome"]),
        menus: z.enum(["on", "off"]),
        stt: z.string().trim().min(1),
        language: z.string().trim().min(1),
        gate: z.number().gt(0).lte(1),
        maxSeconds: z.number().int().positive(),
        cursorOverlay: z.enum(["on", "off"]),
        confirmRisk: z.enum(["off", "medium", "high"]),
        narrowAt: z.number().int().positive(),
        speak: z.enum(["off", "decisions", "all"]),
        historyDepth: z.number().int().nonnegative(),
        browser: z.object({ port: z.number().int().positive() }).partial(),
    })
    .partial();

export type JevSettings = z.infer<typeof jevSettingsSchema>;
/** A settable path. Nested groups are addressed with a dot, as in `browser.port`. */
export type JevSettingKey = keyof JevSettings | "browser.port";

export interface SettingSpec {
    key: JevSettingKey;
    describe: string;
    /** Closed value set, or undefined for a free value. */
    values?: readonly string[];
    /** What applies when nothing is saved and no flag is passed. */
    fallback: string;
}

export const JEV_SETTINGS: readonly SettingSpec[] = [
    {
        key: "provider",
        describe: "Evaluation provider for every paid Jev call",
        values: EVALUATION_PROVIDERS,
        fallback: DEFAULT_EVALUATION_PROVIDER,
    },
    {
        key: "scope",
        describe: "listen AX scope; auto observes the whole window and narrows only if it overflows",
        values: ["auto", "window", "chrome"],
        fallback: "auto",
    },
    { key: "menus", describe: "listen offers the app's menu bar items", values: ["on", "off"], fallback: "on" },
    { key: "stt", describe: "listen speech-to-text provider", fallback: "deepgram" },
    { key: "language", describe: "listen STT languages, comma separated (e.g. cs,en)", fallback: "auto" },
    { key: "gate", describe: "listen admission probability", fallback: "0.8" },
    {
        key: "confirmRisk",
        describe: "require a spoken confirmation at or above this risk, whatever the probability",
        values: ["off", "medium", "high"],
        fallback: "off",
    },
    {
        key: "narrowAt",
        describe: "how many candidates make a screen ambiguous enough to offer the narrowing rows",
        fallback: "25",
    },
    {
        key: "speak",
        describe: "say the chosen label aloud: off, on every decision, or on everything",
        values: ["off", "decisions", "all"],
        fallback: "off",
    },
    {
        key: "historyDepth",
        describe: "how many past asks travel with each choice; higher resolves 'the third one'",
        fallback: "5",
    },
    {
        key: "browser.port",
        describe: "CDP port for the browser surface, so a non-default browser needs no --port",
        fallback: "9222",
    },
    {
        key: "cursorOverlay",
        describe: "draw the cursor overlay where an act landed, so a watching human sees it",
        values: ["on", "off"],
        fallback: "on",
    },
    { key: "maxSeconds", describe: "listen session budget in seconds", fallback: "60" },
];

const NUMERIC: ReadonlySet<JevSettingKey> = new Set<JevSettingKey>([
    "gate",
    "maxSeconds",
    "narrowAt",
    "historyDepth",
    "browser.port",
]);

/** Reads a dotted path out of the settings object; `undefined` when nothing is saved there. */
export function settingAt(settings: JevSettings, key: JevSettingKey): string | number | undefined {
    if (key === "browser.port") {
        return settings.browser?.port;
    }

    const value = settings[key as keyof JevSettings];
    return typeof value === "object" ? undefined : value;
}

function withSetting(settings: JevSettings, key: JevSettingKey, value: string | number): JevSettings {
    if (key === "browser.port") {
        return { ...settings, browser: { ...settings.browser, port: Number(value) } };
    }

    return { ...settings, [key]: value };
}

function withoutSetting(settings: JevSettings, key: JevSettingKey): JevSettings {
    if (key === "browser.port") {
        const browser = { ...settings.browser };
        delete browser.port;
        return Object.keys(browser).length === 0 ? omit(settings, "browser") : { ...settings, browser };
    }

    return omit(settings, key as keyof JevSettings);
}

function omit(settings: JevSettings, key: keyof JevSettings): JevSettings {
    const next = { ...settings };
    delete next[key];
    return next;
}

function settingsStore(): Storage {
    return new Storage("jev", { configFileMode: 0o600 });
}

let cache: JevSettings | null = null;

/** Read and cache the saved settings. Safe to call repeatedly; a broken file yields defaults. */
export async function loadJevSettings(): Promise<JevSettings> {
    const storage = settingsStore();
    const config = await storage.getConfig<{ settings?: unknown }>();
    const parsed = jevSettingsSchema.safeParse(config?.settings ?? {});
    if (!parsed.success) {
        logger.warn(
            { file: storage.getConfigPath(), issues: parsed.error.issues.map((issue) => issue.path.join(".")) },
            "Ignoring invalid saved Jev settings"
        );
        cache = {};
        return cache;
    }

    cache = parsed.data;
    return cache;
}

/**
 * The settings loaded so far. Synchronous on purpose: `selectedProvider` runs inside commander's
 * option resolution, and the CLI preloads through `loadJevSettings` in its preAction hook.
 */
export function savedJevSettings(): JevSettings {
    return cache ?? {};
}

export async function setJevSetting(key: JevSettingKey, raw: string): Promise<JevSettings> {
    const value = NUMERIC.has(key) ? Number(raw) : raw;
    const next = jevSettingsSchema.parse(withSetting(await loadJevSettings(), key, value));
    await settingsStore().setConfigValue("settings", next);
    cache = next;
    logger.debug({ key }, "Saved a Jev setting");
    return next;
}

export async function unsetJevSetting(key: JevSettingKey): Promise<JevSettings> {
    const current = withoutSetting(await loadJevSettings(), key);
    await settingsStore().setConfigValue("settings", current);
    cache = current;
    logger.debug({ key }, "Cleared a Jev setting");
    return current;
}

export function jevSettingsPath(): string {
    return settingsStore().getConfigPath();
}

export function parseSettingKey(raw: string): JevSettingKey | null {
    return JEV_SETTINGS.find((spec) => spec.key === raw)?.key ?? null;
}
