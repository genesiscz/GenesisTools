/**
 * Per-dashboard preferences stored at ~/.genesis-tools/dashboards/<key>.config.json.
 *
 * Used to remember the user's answer to "Install as launchd agent?" so we
 * don't pester on every `up`. Schema is intentionally minimal; extend as new
 * persistent decisions surface.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { SafeJSON } from "@app/utils/json";
import { configFilePath } from "./pidFile";

export interface DashboardPreferences {
    /** Did the user dismiss the launchd first-run prompt? */
    launchdPromptDismissed?: boolean;
    /** Did we successfully install the launchd plist for this app? */
    launchdInstalled?: boolean;
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
    } catch {
        // Corrupted file is treated as no preferences — caller will overwrite on next write.
    }

    return {};
}

export function writePreferences(key: string, prefs: DashboardPreferences): void {
    const file = configFilePath(key);
    const existing = readPreferences(key);
    const merged: DashboardPreferences = { ...existing, ...prefs };
    writeFileSync(file, `${SafeJSON.stringify(merged, null, 2)}\n`);
}
