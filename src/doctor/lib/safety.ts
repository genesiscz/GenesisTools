import { existsSync, readFileSync } from "node:fs";
import { SafeJSON } from "@app/utils/json";
import { matchesGlob } from "@app/utils/string";
import { BLACKLIST_FILE } from "./paths";
import type { Severity } from "./types";

export const CACHE_BLACKLIST_GLOBS = [
    "~/Library/Caches/JetBrains/**",
    "~/Library/Caches/com.jetbrains.*",
    "~/Library/Caches/Raycast/**",
    "~/Library/Caches/com.raycast.**",
    "~/Library/Caches/1Password/**",
    "~/Library/Caches/com.apple.iconservices*",
    "~/Library/Caches/com.apple.HomeKit",
    "~/Library/Caches/com.apple.AddressBook*",
    "~/Library/Caches/com.docker.docker",
    "~/Library/Caches/Cursor/**",
    "~/Library/Caches/com.microsoft.VSCode/**",
];

export const PROCESS_NEVER_KILL = new Set([
    "kernel_task",
    "launchd",
    "loginwindow",
    "WindowServer",
    "mds",
    "mds_stores",
    "mdworker",
    "coreaudiod",
    "SafeEjectGPUAgent",
    "airportd",
    "bluetoothd",
    "locationd",
    "cfprefsd",
    "UserEventAgent",
    "secd",
    "trustd",
    "powerd",
    "nsurlsessiond",
    "configd",
    "syslogd",
    "diskarbitrationd",
]);

export const PROCESS_AUTO_RESPAWN = new Set([
    "Finder",
    "Dock",
    "SystemUIServer",
    "ControlCenter",
    "NotificationCenter",
    "Spotlight",
    "TextInputMenuAgent",
    "CoreLocationAgent",
]);

export interface CachePathClassification {
    severity: Severity;
    reason?: string;
}

export interface ProcessClassification {
    severity: Severity;
    autoRespawn: boolean;
    reason?: string;
}

interface UserBlacklistFile {
    cacheGlobs?: string[];
}

function parseUserBlacklist(raw: string): UserBlacklistFile {
    return SafeJSON.parse(raw, { strict: true }) as UserBlacklistFile;
}

function loadUserBlacklist(): string[] {
    if (!existsSync(BLACKLIST_FILE)) {
        return [];
    }

    try {
        const parsed = parseUserBlacklist(readFileSync(BLACKLIST_FILE, "utf8"));
        return parsed.cacheGlobs ?? [];
    } catch {
        return [];
    }
}

export function classifyCachePath(path: string): CachePathClassification {
    const globs = [...CACHE_BLACKLIST_GLOBS, ...loadUserBlacklist()];

    for (const glob of globs) {
        if (matchesGlob(path, glob)) {
            const reason = extractReason(glob);
            return { severity: "blocked", reason };
        }
    }

    return { severity: "cautious" };
}

function extractReason(glob: string): string {
    if (glob.includes("JetBrains") || glob.includes("jetbrains")) {
        return "JetBrains IDE state (deleting corrupts indexes)";
    }

    if (glob.includes("Raycast") || glob.includes("raycast")) {
        return "Raycast keeps live state under Caches";
    }

    if (glob.includes("iconservices")) {
        return "Deleting breaks Finder icons";
    }

    if (glob.includes("HomeKit")) {
        return "HomeKit state";
    }

    if (glob.includes("AddressBook")) {
        return "Contacts state";
    }

    if (glob.includes("Docker")) {
        return "Docker Desktop state";
    }

    if (glob.includes("Cursor") || glob.includes("VSCode")) {
        return "Editor state (not regenerable cache)";
    }

    return "User-defined blacklist match";
}

export function classifyProcess(name: string): ProcessClassification {
    if (PROCESS_NEVER_KILL.has(name)) {
        return { severity: "blocked", autoRespawn: false, reason: "System-critical process" };
    }

    if (PROCESS_AUTO_RESPAWN.has(name)) {
        return { severity: "cautious", autoRespawn: true };
    }

    return { severity: "cautious", autoRespawn: false };
}
