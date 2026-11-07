import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Private data on a recording's screen: emails, tokens and keys, phone numbers, IBANs and card numbers, found in the
 * text OCR read off its frames (Vision, on this Mac; no screen text leaves it). Each hit becomes one hidden part for
 * as long as it shows. Every pattern lives in `PRIVATE_PATTERNS`; a new kind is one row there.
 */
export const PRIVATE_KINDS = ["email", "token", "phone", "iban", "card"] as const;
export type PrivateKind = (typeof PRIVATE_KINDS)[number];

export interface PrivatePattern {
    kind: PrivateKind;
    /** What the editor's list and the hidden part's label call it. */
    label: string;
    /** Global regexes; a match counts only when `valid` (when given) says so. */
    patterns: RegExp[];
    valid?: (value: string) => boolean;
}

const digitsOf = (value: string): string => value.replace(/\D/g, "");

/** The Luhn check every payment card number passes. */
export function luhnValid(value: string): boolean {
    const digits = digitsOf(value);

    if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) {
        return false;
    }

    let sum = 0;

    for (let index = 0; index < digits.length; index++) {
        let digit = Number(digits[digits.length - 1 - index]);

        if (index % 2 === 1) {
            digit *= 2;

            if (digit > 9) {
                digit -= 9;
            }
        }

        sum += digit;
    }

    return sum % 10 === 0;
}

/** The ISO 13616 check (mod 97 is 1) of an IBAN, spaces ignored. */
export function ibanValid(value: string): boolean {
    const compact = value.replace(/\s/g, "").toUpperCase();

    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) {
        return false;
    }

    const moved = compact.slice(4) + compact.slice(0, 4);
    let rest = 0;

    for (const char of moved) {
        const code = char >= "A" && char <= "Z" ? String(char.charCodeAt(0) - 55) : char;

        for (const digit of code) {
            rest = (rest * 10 + Number(digit)) % 97;
        }
    }

    return rest === 1;
}

/** A long string looks random when it mixes letters and digits (a git SHA is lowercase hex and stays visible). */
function looksRandom(value: string): boolean {
    const body = value.replace(/^[^=:]*[=:]\s*/, "");
    return /[A-Za-z]/.test(body) && /\d/.test(body) && !/^[0-9a-f]+$/.test(body);
}

/** In priority order: a match that overlaps an earlier kind's match is left to that kind. */
export const PRIVATE_PATTERNS: readonly PrivatePattern[] = [
    {
        kind: "iban",
        label: "IBAN",
        patterns: [/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g],
        valid: ibanValid,
    },
    {
        kind: "card",
        label: "Card number",
        patterns: [/\b\d(?:[ -]?\d){12,18}\b/g],
        valid: luhnValid,
    },
    {
        kind: "token",
        label: "Token or key",
        patterns: [
            /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
            /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}\b/g,
            /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
            /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
            /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
            /\bAKIA[0-9A-Z]{16}\b/g,
            /\bAIza[0-9A-Za-z_-]{30,}\b/g,
            /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g,
            /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
            /\b(?:api[_-]?key|token|secret|password|passwd|bearer)\b["']?\s*[:=]\s*["']?[^\s"']{8,}/gi,
            /\b[A-Za-z0-9_-]{32,}\b/g,
        ],
        valid: (value) => !/^[A-Za-z0-9_-]{32,}$/.test(value) || looksRandom(value),
    },
    {
        kind: "email",
        label: "Email",
        patterns: [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g],
    },
    {
        kind: "phone",
        label: "Phone number",
        patterns: [
            /\+\d{1,3}[ .-]?(?:\(?\d{1,4}\)?[ .-]?){2,5}\d{2,4}\b/g,
            /\(\d{3}\) ?\d{3}[ .-]\d{4}\b/g,
            // Not inside a dotted run of numbers: an IP address or a version is not a phone number.
            /(?<![\d.])\d{3}[ .-]\d{3}[ .-]\d{3,4}(?![\d.])/g,
        ],
        valid: (value) => {
            const count = digitsOf(value).length;
            return count >= 9 && count <= 15;
        },
    },
];

export interface PrivateMatch {
    kind: PrivateKind;
    /** Character offsets in the text. */
    start: number;
    end: number;
    value: string;
}

/** Every private match in one line of text, without overlaps, in text order. */
export function findPrivateText(text: string): PrivateMatch[] {
    const found: PrivateMatch[] = [];

    for (const pattern of PRIVATE_PATTERNS) {
        for (const regex of pattern.patterns) {
            for (const match of text.matchAll(new RegExp(regex.source, regex.flags))) {
                const value = match[0];
                const start = match.index ?? 0;
                const end = start + value.length;

                if (pattern.valid && !pattern.valid(value)) {
                    continue;
                }

                if (found.some((other) => start < other.end && end > other.start)) {
                    continue;
                }

                found.push({ kind: pattern.kind, start, end, value });
            }
        }
    }

    return found.sort((a, b) => a.start - b.start);
}

/** The value as a list may show it: its first and last two characters, the rest dotted. Never the whole value. */
export function maskPrivate(value: string): string {
    const compact = value.trim();

    if (compact.length <= 6) {
        return "•".repeat(compact.length);
    }

    return `${compact.slice(0, 2)}${"•".repeat(Math.min(8, compact.length - 4))}${compact.slice(-2)}`;
}

/** A rectangle as fractions of the movie's picture, from its top left. */
export interface FractionBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** One OCR line of a frame, placed over the movie. */
export interface ScreenLine extends FractionBox {
    text: string;
}

/** One frame's screen text: shown from `atUs` until `untilUs` (source microseconds). */
export interface ScreenTextFrame {
    atUs: number;
    untilUs: number;
    lines: ScreenLine[];
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * Where a match sits in its OCR line: the line's box narrowed by the share of characters before and after it (a
 * proportional font makes this approximate), padded so the hidden part covers the whole value.
 */
export function matchBox(line: ScreenLine, match: { start: number; end: number }): FractionBox {
    const length = Math.max(1, line.text.length);
    const padX = Math.max(line.width * 0.03, line.height * 0.6, 0.004);
    const padY = Math.max(line.height * 0.25, 0.003);
    const left = clamp01(line.x + (line.width * match.start) / length - padX);
    const right = clamp01(line.x + (line.width * match.end) / length + padX);
    const top = clamp01(line.y - padY);
    const bottom = clamp01(line.y + line.height + padY);
    // A hidden part is at least 1 % of the picture each way (addRedaction's floor).
    const width = Math.max(0.012, right - left);
    const height = Math.max(0.012, bottom - top);
    return { x: Math.min(left, 1 - width), y: Math.min(top, 1 - height), width, height };
}

/** What a hit is: a private kind, a name the caller gave, or a text it asked for (hideText). */
export type HitKind = PrivateKind | "name" | "text";

/** A match in one OCR line: its kind and label, the matched value, and its character offsets. */
export interface TextMatch {
    kind: HitKind;
    label: string;
    value: string;
    start: number;
    end: number;
}

export type LineMatcher = (text: string) => TextMatch[];

/** Where the value was at one sample: the hidden part's rectangle then (keyframes of a tracked hidden part). */
export interface TrackKey extends FractionBox {
    atUs: number;
}

export interface PrivateHit {
    /** Stable for the same scan: list and apply name a hit by it. */
    id: string;
    kind: HitKind;
    label: string;
    /** The value with its middle dotted; the whole value is never printed or saved. */
    masked: string;
    fromUs: number;
    toUs: number;
    /** Every place it covered, as one rectangle. */
    box: FractionBox;
    /** Its place at each sample, in time order; one key when it never moved. */
    keys: TrackKey[];
    /** Areas inside it the hidden part leaves visible: what does not move with the text (a toast over a scroll). */
    exclude?: FractionBox[];
}

const labelOf = (kind: PrivateKind): string => PRIVATE_PATTERNS.find((pattern) => pattern.kind === kind)?.label ?? kind;

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * OCR often reads a space into an address or a token ("alice@example. com", "sk- ant"): the line is matched with
 * the spaces next to . @ _ - removed, and each match's offsets are mapped back to the line as OCR read it.
 */
export function compacting(matcher: LineMatcher): LineMatcher {
    return (text) => {
        let compact = "";
        const index: number[] = [];

        for (let at = 0; at < text.length; at++) {
            const char = text[at];

            if (/\s/.test(char)) {
                const before = compact.at(-1) ?? "";
                const after = text.slice(at + 1).trimStart()[0] ?? "";

                if (/[.@_-]/.test(before) || /[.@_-]/.test(after)) {
                    continue;
                }
            }

            compact += char;
            index.push(at);
        }

        return matcher(compact).map((match) => ({
            ...match,
            start: index[match.start] ?? match.start,
            end: (index[match.end - 1] ?? match.end - 1) + 1,
        }));
    };
}

/** The private patterns, plus `names` (people, companies) the caller wants hidden too, matched without case. */
export function privateMatcher(names: readonly string[] = []): LineMatcher {
    const wanted = names.map((name) => name.trim()).filter(Boolean);
    const namePattern = wanted.length ? new RegExp(wanted.map(escapeRegExp).join("|"), "gi") : undefined;
    return compacting((text) => {
        const found: TextMatch[] = findPrivateText(text).map((match) => ({ ...match, label: labelOf(match.kind) }));

        for (const match of namePattern ? text.matchAll(namePattern) : []) {
            const start = match.index ?? 0;
            const end = start + match[0].length;

            if (!found.some((other) => start < other.end && end > other.start)) {
                found.push({ kind: "name", label: "Name", value: match[0].toLowerCase(), start, end });
            }
        }

        return found.sort((a, b) => a.start - b.start);
    });
}

/** A literal text (without case) or a regular expression's source, as hideText asks for it. */
export function textMatcher(options: { text?: string; pattern?: string }): LineMatcher {
    const source = options.pattern ?? (options.text ? escapeRegExp(options.text.trim()) : undefined);

    if (!source) {
        throw new Error("give text (the words to hide) or pattern (a regular expression)");
    }

    // A literal text matches with the spaces OCR leaves out or reads in: "alice@example.com" finds "alice@example. com".
    const regex = new RegExp(
        options.pattern ?? [...(options.text ?? "").replace(/\s+/g, "")].map(escapeRegExp).join("\\s*"),
        "gi"
    );
    return compacting((text) =>
        [...text.matchAll(regex)]
            .filter((match) => match[0].length > 0)
            .map((match) => ({
                kind: "text" as const,
                label: "Text",
                value: match[0].replace(/\s+/g, "").toLowerCase(),
                start: match.index ?? 0,
                end: (match.index ?? 0) + match[0].length,
            }))
    );
}

function overlap(a: FractionBox, b: FractionBox): number {
    const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);

    if (width <= 0 || height <= 0) {
        return 0;
    }

    return (width * height) / Math.min(a.width * a.height, b.width * b.height);
}

function union(a: FractionBox, b: FractionBox): FractionBox {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return {
        x,
        y,
        width: Math.max(a.x + a.width, b.x + b.width) - x,
        height: Math.max(a.y + a.height, b.y + b.height) - y,
    };
}

const round6 = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;
const rounded = (box: FractionBox): FractionBox => ({
    x: round6(box.x),
    y: round6(box.y),
    width: round6(box.width),
    height: round6(box.height),
});
const sameBox = (a: FractionBox, b: FractionBox): boolean =>
    Math.abs(a.x - b.x) < 0.001 &&
    Math.abs(a.y - b.y) < 0.001 &&
    Math.abs(a.width - b.width) < 0.001 &&
    Math.abs(a.height - b.height) < 0.001;

function hitId(kind: string, value: string, fromUs: number, box: FractionBox): string {
    const key = `${kind}|${value}|${Math.round(fromUs / 100_000)}|${box.x.toFixed(2)},${box.y.toFixed(2)}`;
    return `p${createHash("sha1").update(key).digest("hex").slice(0, 8)}`;
}

/** A sample of the same value continues a hit when it overlaps the hit's last place, or moved straight up or down. */
function continues(last: FractionBox, box: FractionBox, maxShift: number): boolean {
    if (overlap(last, box) > 0.3) {
        return true;
    }

    return (
        Math.abs(last.x - box.x) <= 0.03 &&
        Math.abs(last.width - box.width) <= Math.max(0.01, last.width * 0.3) &&
        Math.abs(last.y - box.y) <= maxShift
    );
}

const inside = (box: FractionBox, area: FractionBox): boolean => {
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    return x >= area.x && x <= area.x + area.width && y >= area.y && y <= area.y + area.height;
};

/**
 * The hits of `matcher` in a movie's screen text, tracked over time: the same value on consecutive samples is one hit
 * while it stays in place or scrolls (up to `maxShift` of the picture between two samples), with its place at each
 * sample as keys. A gap up to `gapUs` is bridged (a sample can miss a line OCR read on its neighbours). It starts half
 * way between the last sample without it and the first with it (at most 0.5 s early), and lasts until the sample
 * after its last. A match
 * whose centre lies in an `exclude` area (a floating toast, a tab bar) is not a hit.
 */
export function textHits(
    frames: readonly ScreenTextFrame[],
    matcher: LineMatcher,
    {
        gapUs = 1_500_000,
        maxShift = 0.35,
        exclude = [],
    }: { gapUs?: number; maxShift?: number; exclude?: readonly FractionBox[] } = {}
): PrivateHit[] {
    interface Open {
        kind: HitKind;
        label: string;
        value: string;
        fromUs: number;
        toUs: number;
        keys: TrackKey[];
    }

    const open: Open[] = [];
    const done: Open[] = [];
    const ordered = [...frames].sort((a, b) => a.atUs - b.atUs);

    for (const [index, frame] of ordered.entries()) {
        for (const track of open.splice(0)) {
            (track.toUs + gapUs >= frame.atUs ? open : done).push(track);
        }

        const previous = ordered[index - 1];
        const taken = new Set<Open>();

        for (const line of frame.lines) {
            for (const match of matcher(line.text)) {
                const box = matchBox(line, match);

                if (exclude.some((area) => inside(box, area))) {
                    continue;
                }

                const candidates = open.filter(
                    (track) =>
                        !taken.has(track) &&
                        track.kind === match.kind &&
                        track.value === match.value &&
                        continues(track.keys[track.keys.length - 1], box, maxShift)
                );
                const track = candidates.sort(
                    (a, b) =>
                        Math.abs(a.keys[a.keys.length - 1].y - box.y) - Math.abs(b.keys[b.keys.length - 1].y - box.y)
                )[0];

                if (track) {
                    track.toUs = Math.max(track.toUs, frame.untilUs);
                    track.keys.push({ atUs: frame.atUs, ...box });
                    taken.add(track);
                } else {
                    // Half way back to the sample without it, at most half a second early.
                    const fromUs = previous
                        ? Math.max(Math.round((previous.atUs + frame.atUs) / 2), frame.atUs - 500_000)
                        : frame.atUs;
                    const started: Open = {
                        kind: match.kind,
                        label: match.label,
                        value: match.value,
                        fromUs,
                        toUs: frame.untilUs,
                        keys: [{ atUs: frame.atUs, ...box }],
                    };
                    open.push(started);
                    taken.add(started);
                }
            }
        }
    }

    done.push(...open);
    return done
        .filter((track) => track.toUs > track.fromUs)
        .sort((a, b) => a.fromUs - b.fromUs || a.keys[0].y - b.keys[0].y)
        .map((track) => {
            // A key between two of the same place adds nothing: the place holds until the key where it moves.
            const keys = track.keys
                .filter(
                    (key, index, all) =>
                        index === 0 ||
                        index === all.length - 1 ||
                        !(sameBox(all[index - 1], key) && sameBox(all[index + 1], key))
                )
                .map((key) => ({ atUs: key.atUs, ...rounded(key) }));
            const still = keys.every((key) => sameBox(key, keys[0]));
            const box = rounded(keys.reduce<FractionBox>((all, key) => union(all, key), keys[0]));
            return {
                id: hitId(track.kind, track.value, track.fromUs, keys[0]),
                kind: track.kind,
                label: track.label,
                masked: maskPrivate(track.value),
                fromUs: track.fromUs,
                toUs: track.toUs,
                box,
                keys: still ? [keys[0]] : keys,
            };
        });
}

/** The private hits of a movie's screen text (and of `names`), tracked over time (textHits). */
export function privateHits(
    frames: readonly ScreenTextFrame[],
    options: { gapUs?: number; names?: readonly string[]; exclude?: readonly FractionBox[] } = {}
): PrivateHit[] {
    return textHits(frames, privateMatcher(options.names), { gapUs: options.gapUs, exclude: options.exclude });
}

/** The edit's record of the private data it hid: the hit ids already applied, so a second apply adds none twice. */
export const privacySchema = z.object({
    applied: z.array(z.string()).default([]),
});
export type EditPrivacy = z.infer<typeof privacySchema>;

/** How a private hit is hidden: never a spotlight, which shows the inside. */
export const PRIVATE_STYLES = ["blur", "pixelate", "black"] as const;
