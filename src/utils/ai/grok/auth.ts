import { existsSync, readFileSync } from "node:fs";
import { decodeJwt } from "@app/jwt/lib/jwt-core";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { grokAuthPath } from "./paths";
import type { GrokAuthEntry, GrokJwtClaims } from "./types";

function parseAuthEntries(raw: unknown): Map<string, GrokAuthEntry> {
    const entries = new Map<string, GrokAuthEntry>();

    if (typeof raw !== "object" || raw === null) {
        return entries;
    }

    for (const [key, value] of Object.entries(raw)) {
        if (typeof value !== "object" || value === null) {
            continue;
        }

        const entry = value as GrokAuthEntry;
        if (typeof entry.key === "string" && entry.key.length > 0) {
            entries.set(key, entry);
        }
    }

    return entries;
}

export function readAuthFile(path?: string): Map<string, GrokAuthEntry> {
    const authPath = path ?? grokAuthPath();

    if (!existsSync(authPath)) {
        return new Map();
    }

    try {
        return parseAuthEntries(SafeJSON.parse(readFileSync(authPath, "utf-8")));
    } catch (err) {
        logger.warn({ err, authPath }, "grok: failed to parse auth file");
        return new Map();
    }
}

export async function readAuthFileAsync(path?: string): Promise<Map<string, GrokAuthEntry>> {
    const authPath = path ?? grokAuthPath();

    if (!existsSync(authPath)) {
        return new Map();
    }

    try {
        const text = await Bun.file(authPath).text();
        return parseAuthEntries(SafeJSON.parse(text));
    } catch (err) {
        logger.warn({ err, authPath }, "grok: failed to parse auth file");
        return new Map();
    }
}

export function getActiveAuthEntry(entries: Map<string, GrokAuthEntry>): GrokAuthEntry | null {
    for (const entry of entries.values()) {
        if (entry.key.length > 0) {
            return entry;
        }
    }

    return null;
}

export function decodeJwtClaims(token: string): GrokJwtClaims | null {
    const result = decodeJwt(token);

    if (!result.ok) {
        logger.debug({ error: result.error }, "grok: jwt payload decode failed");
        return null;
    }

    return result.payload as GrokJwtClaims;
}

export function getTokenPrefix(token: string): string {
    if (token.length <= 8) {
        return token;
    }

    return `${token.slice(0, 8)}…`;
}

export function isTokenExpired(claims: GrokJwtClaims | null, nowSec = Math.floor(Date.now() / 1000)): boolean {
    if (!claims?.exp) {
        return false;
    }

    return claims.exp <= nowSec;
}
