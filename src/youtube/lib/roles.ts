import type { PowerUserEntry, YtRole } from "@app/youtube/lib/config.types";

/** Config-derived role. Unlisted emails are plain users. Matching is case-insensitive (users table is COLLATE NOCASE). */
export function roleForEmail(powerUsers: PowerUserEntry[], email: string): YtRole {
    const normalized = email.trim().toLowerCase();
    const entry = powerUsers.find((powerUser) => powerUser.email.trim().toLowerCase() === normalized);

    return entry?.type ?? "user";
}

export function isPowerRole(role: YtRole): boolean {
    return role === "admin" || role === "dev";
}
