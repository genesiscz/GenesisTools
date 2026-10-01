import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { GENESIS_EXTENSION_ID } from "./registry";

export interface ChromiumBrowser {
    browser: string;
    /** The browser's user-data folder, which holds `Default`, `Profile 1`, ... */
    userDataDir: string;
}

export function chromiumBrowsers(home = homedir()): ChromiumBrowser[] {
    const support = join(home, "Library", "Application Support");
    return [
        { browser: "Brave", userDataDir: join(support, "BraveSoftware", "Brave-Browser") },
        { browser: "Chrome", userDataDir: join(support, "Google", "Chrome") },
        { browser: "Chromium", userDataDir: join(support, "Chromium") },
    ];
}

export interface ExtensionProfile {
    browser: string;
    profile: string;
    /** Loaded in this browser profile and not disabled. */
    loaded: boolean;
    /** Loaded, but missing a host in `wanted` or loaded before `builtAt`: it runs an older build until Reload. */
    stale: boolean;
    /** When the browser last (re)loaded it, in ms since 1970, or null when not recorded. */
    loadedAt: number | null;
}

/** Chrome's preference timestamps are microseconds since 1601-01-01. */
const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000;

function chromeTime(value: unknown): number | null {
    if (typeof value !== "string" || !/^\d+$/.test(value)) {
        return null;
    }

    return Number(BigInt(value) / 1000n) - CHROME_EPOCH_OFFSET_MS;
}

/**
 * Where the extension is loaded, read from each Chromium profile's `Secure Preferences` (read-only).
 * `wanted` is the current build's `host_permissions` and `builtAt` its build time; a profile that has
 * not granted one of those hosts, or last loaded the extension before that build, runs an older build.
 */
export function extensionProfiles({
    home = homedir(),
    extensionId = GENESIS_EXTENSION_ID,
    wanted = [],
    builtAt = null,
}: {
    home?: string;
    extensionId?: string;
    wanted?: string[];
    builtAt?: number | null;
} = {}): ExtensionProfile[] {
    return chromiumBrowsers(home).flatMap(({ browser, userDataDir }) => {
        if (!existsSync(userDataDir)) {
            return [];
        }

        const profiles = readdirSync(userDataDir)
            .filter((name) => name === "Default" || name.startsWith("Profile "))
            .sort();
        return profiles.flatMap((profile) => {
            const entry = readExtensionEntry(join(userDataDir, profile, "Secure Preferences"), extensionId);

            if (!entry) {
                return [];
            }

            const reasons = entry.disable_reasons;
            const disabled = Array.isArray(reasons) ? reasons.length > 0 : typeof reasons === "number" && reasons > 0;
            const granted = isRecord(entry.granted_permissions) ? entry.granted_permissions.explicit_host : undefined;
            const hosts = Array.isArray(granted) ? granted : [];
            const loaded = !disabled;
            const loadedAt = chromeTime(entry.last_update_time);
            const older = builtAt !== null && loadedAt !== null && loadedAt < builtAt;
            const missingHost = wanted.some((host) => !hosts.includes(host));
            return [{ browser, profile, loaded, stale: loaded && (missingHost || older), loadedAt }];
        });
    });
}

function readExtensionEntry(file: string, extensionId: string): Record<string, unknown> | null {
    if (!existsSync(file)) {
        return null;
    }

    try {
        const prefs: unknown = SafeJSON.parse(readFileSync(file, "utf8"), { strict: true });
        const extensions = isRecord(prefs) ? prefs.extensions : undefined;
        const settings = isRecord(extensions) ? extensions.settings : undefined;
        const entry = isRecord(settings) ? settings[extensionId] : undefined;
        return isRecord(entry) ? entry : null;
    } catch (error) {
        logger.debug({ error, file }, "browser-router: profile preferences are not readable");
        return null;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
