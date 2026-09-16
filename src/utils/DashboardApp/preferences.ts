/**
 * Per-dashboard preferences stored at ~/.genesis-tools/dashboards/<key>.config.json.
 *
 * Used to remember the user's answer to "Install as launchd agent?" so we
 * don't pester on every `up`. Schema is intentionally minimal; extend as new
 * persistent decisions surface.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
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
    /** `install --dev` registered `spawn.previewCmd`; `up` and `restart` keep that until the next `install`. */
    launchdServe?: "preview";
}

export function readPreferences(key: string): DashboardPreferences {
    const file = configFilePath(key);
    if (!existsSync(file)) {
        return {};
    }

    try {
        const raw = readFileSync(file, "utf-8");
        const parsed = SafeJSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as DashboardPreferences;
        }
    } catch (err) {
        logger.debug({ err, key, file }, "failed to parse dashboard preferences");
    }

    return {};
}

export function writePreferences(key: string, prefs: DashboardPreferences): void {
    const file = configFilePath(key);
    mkdirSync(dirname(file), { recursive: true });
    const existing = readPreferences(key);
    const merged: DashboardPreferences = { ...existing, ...prefs };
    writeFileSync(file, `${SafeJSON.stringify(merged, null, 2)}\n`);
}
