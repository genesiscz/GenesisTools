import { z } from "zod";

export interface WakeMatch {
    matched: string;
    remainder: string;
}

const phraseSchema = z.string().trim().min(1).max(80);

/** "hey jeff" is how every tested STT provider hears "hey jev"; keep it as a phonetic alias. */
export const DEFAULT_WAKE_PHRASES = ["hey jev", "hey jeff", "hey genesis", "ok genesis"];

export const STOP_PHRASES = ["stop", "cancel", "wait", "abort", "never mind"] as const;

export function normalizeUtterance(text: string): string {
    return text
        .toLocaleLowerCase("en-US")
        .replace(/[‘’]/g, "'")
        .replace(/[^a-z0-9À-ɏ\s]/gi, " ")
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

/**
 * Deterministic matcher: longest phrase first; exact, prefix, or embedded. The remainder is the
 * text after the phrase, which is what a listen pipeline treats as the command.
 */
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
            return { matched: phrase, remainder: padded.slice(at + token.length).trim() };
        }
    }

    return null;
}

export function isStopUtterance(text: string): boolean {
    const normalized = normalizeUtterance(text);
    return STOP_PHRASES.some((phrase) => normalized === phrase);
}
