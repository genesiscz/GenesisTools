import { readFileSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    DEFAULT_HOOKS_CONFIG,
    type HooksConfig,
    hooksConfigPath,
    INSTALLED_KEY,
    loadHooksConfigForWrite,
    SHIPPED_DEFAULTS_KEY,
} from "./config";
import { claudeSettingsPath, wiringStatus } from "./install";
import { writeJsonFile } from "./write-json";

/** What `hooks install --write` / `uninstall --write` last wired, as they saw it. */
export interface InstalledRecord {
    at: string;
    claude: {
        state: "missing" | "installed" | "stale";
        events: string[];
        settingsPath: string;
        dist: string;
        target: string | null;
    };
}

function readRaw(path: string): Record<string, unknown> | null {
    try {
        const raw: unknown = SafeJSON.parse(readFileSync(path, "utf8"));
        return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    } catch {
        // A missing or unreadable file has no record; the writers refuse an unreadable one earlier.
        return null;
    }
}

/** True when the file's shipped-defaults copy is older than the defaults this build ships. */
export function hooksFileListsOldDefaults(path: string): boolean {
    const shipped = readRaw(path)?.[SHIPPED_DEFAULTS_KEY];

    if (shipped === undefined) {
        return false;
    }

    return SafeJSON.stringify(shipped) !== SafeJSON.stringify(DEFAULT_HOOKS_CONFIG);
}

export function readInstalledRecord(path: string): InstalledRecord | null {
    const record = readRaw(path)?.[INSTALLED_KEY];
    return typeof record === "object" && record !== null ? (record as InstalledRecord) : null;
}

/**
 * Writes `hooks.json` with EVERY setting, so each knob is visible and editable in the file, plus
 * the shipped defaults at write time (`_shippedDefaults`). The loader counts a value as an
 * override only where it differs from that copy (`storedOverrides` in config.ts), so listing a
 * default does not freeze it. The install record survives writes that do not pass a new one.
 */
export function writeHooksFile(options: { path: string; config: HooksConfig; installed?: InstalledRecord }): void {
    const installed = options.installed ?? readInstalledRecord(options.path);

    writeJsonFile(options.path, {
        ...options.config,
        ...(installed ? { [INSTALLED_KEY]: installed } : {}),
        [SHIPPED_DEFAULTS_KEY]: DEFAULT_HOOKS_CONFIG,
    });
}

/**
 * Writes what `install` / `uninstall` just left in Claude's settings into `hooks.json`, beside the
 * full settings. It records the last wiring; `hooks doctor` still reads the live state.
 */
export function recordInstallState(options: { dist: string; target: string | null; path?: string }): InstalledRecord {
    const path = options.path ?? hooksConfigPath();
    const wired = wiringStatus({ dist: options.dist });
    const installed: InstalledRecord = {
        at: new Date().toISOString(),
        claude: {
            state: wired.state,
            events: wired.events,
            settingsPath: claudeSettingsPath(),
            dist: options.dist,
            target: options.target,
        },
    };

    writeHooksFile({ path, config: loadHooksConfigForWrite(path), installed });
    return installed;
}
