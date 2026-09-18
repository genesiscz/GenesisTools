import { z } from "zod";
import type { WakeMatch } from "./types";

const phraseSchema = z.string().trim().min(1).max(80);

export function normalizeUtterance(text: string): string {
    return text
        .toLocaleLowerCase("en-US")
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[^a-z0-9\u00c0-\u024f\s]/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
}

export function parseWakePhrases(raw: string): string[] {
    const phrases = raw
        .split(",")
        .map((part) => normalizeUtterance(part))
        .filter(Boolean);
    return z.array(phraseSchema).min(1).parse(phrases);
}

export function matchWake(text: string, phrases: string[]): WakeMatch | null {
    const normalized = normalizeUtterance(text);
    if (!normalized) {
        return null;
    }
    const ordered = [...phrases].sort((a, b) => b.length - a.length);
    for (const phrase of ordered) {
        if (normalized === phrase) {
            return { matched: phrase, remainder: "" };
        }
        if (normalized.startsWith(`${phrase} `)) {
            return { matched: phrase, remainder: normalized.slice(phrase.length).trim() };
        }
        const token = ` ${phrase} `;
        const padded = ` ${normalized} `;
        const at = padded.indexOf(token);
        if (at >= 0) {
            const after = padded.slice(at + token.length).trim();
            return { matched: phrase, remainder: after };
        }
    }
    return null;
}

export const DEFAULT_WAKE_PHRASES = ["hey genesis", "ok genesis", "genesis"];
