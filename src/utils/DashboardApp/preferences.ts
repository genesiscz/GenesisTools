/**
 * Per-dashboard preferences stored at ~/.genesis-tools/dashboards/<key>.config.json.
 *
 * Used to remember the user's answer to "Install as launchd agent?" so we
 * don't pester on every `up`. Schema is intentionally minimal; extend as new
 * persistent decisions surface.
 */
import { readFileSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync, isJsonObject, isMissingFileError } from "@genesiscz/utils/storage/atomic-file";
import { configFilePath } from "./pidFile";
import type { DashboardBindHost } from "./types";

export interface DashboardPreferences {
    /** Did the user dismiss the launchd first-run prompt? */
    launchdPromptDismissed?: boolean;
    /** Did we successfully install the launchd plist for this app? */
    launchdInstalled?: boolean;
    /**
     * Listen address for this dashboard, overriding the registry entry. `"0.0.0.0"` opens one
     * dashboard to the LAN (a tunnel, a phone) without a code change; `"127.0.0.1"` pins it back.
     */
    bindHost?: DashboardBindHost;
    /** `install --preview` registered `spawn.previewCmd`; `up` and `restart` keep that until the next `install`. */
    launchdServe?: "preview";
}

/** The saved preferences, or null when there is no file. Throws when the file exists but is not a JSON object. */
function loadPreferencesFile(file: string): DashboardPreferences | null {
    let raw: string;

    try {
        raw = readFileSync(file, "utf-8");
    } catch (err) {
        if (isMissingFileError(err)) {
            return null;
        }

        throw err;
    }

    const parsed: unknown = SafeJSON.parse(raw);

    if (!isJsonObject(parsed)) {
        throw new Error("the file does not hold a JSON object");
    }

    return parsed as DashboardPreferences;
}

/** For reading only: a file that cannot be used reads as no preferences, with a warning. */
export function readPreferences(key: string): DashboardPreferences {
    const file = configFilePath(key);

    try {
        return loadPreferencesFile(file) ?? {};
    } catch (err) {
        logger.warn({ err, key, file }, `dashboard preferences ${file} could not be read; using none`);
        return {};
    }
}

/**
 * Merges `prefs` into the saved file. Throws, and leaves the file alone, when it exists but cannot be read
 * as a JSON object: merging into `{}` would write over everything the user set by hand (`bindHost`).
 */
export function writePreferences(key: string, prefs: DashboardPreferences): void {
    const file = configFilePath(key);
    let existing: DashboardPreferences | null;

    try {
        existing = loadPreferencesFile(file);
    } catch (err) {
        throw new Error(`Cannot read dashboard preferences ${file}, so it was left untouched. Fix or move it.`, {
            cause: err,
        });
    }

    const merged: DashboardPreferences = { ...existing, ...prefs };
    atomicWriteFileSync(file, `${SafeJSON.stringify(merged, null, 2)}\n`);
}
