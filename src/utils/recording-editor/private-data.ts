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
    /** Where it moved but could not be followed: its swept band is hidden for that time. */
    uncertain?: UncertainStretch[];
    /** How well it was followed while the picture moved: the moving time it showed, and its places measured then. */
    follow?: { movingUs: number; keysInMotion: number };
}

/** A stretch where a moving text could not be followed: the band it may have swept is hidden instead. */
export interface UncertainStretch {
    fromUs: number;
    toUs: number;
    /** The band the text may have crossed meanwhile, as fractions of the picture. */
    box: FractionBox;
}

/** The content's motion carried a box this far: one key per picture, and why it stopped. */
export interface Carried {
    keys: TrackKey[];
    /** Where it got to: the asked time, or where it was lost, left the picture or the picture stood still. */
    reachedUs: number;
    box: FractionBox;
    end: "reached" | "lost" | "left" | "still";
}

/**
 * How the picture's content moves (motion.ts measures it): textHits carries each hit's place between its OCR reads
 * with it, so a scroll or a slide is followed frame by frame, also through frames OCR cannot read.
 */
export interface MotionModel {
    /** Whether any part of the picture moves between the two source times. */
    moving(fromUs: number, toUs: number): boolean;
    /** The part of the picture that moves between the two times; undefined when nothing does. */
    movingArea(fromUs: number, toUs: number): FractionBox | undefined;
    /** Where the picture under `box` stops changing from `atUs` on in `direction`, at most `limitUs` away. */
    changeEdge(box: FractionBox, atUs: number, direction: 1 | -1, limitUs: number): number;
    /** `box` carried by the content's motion from `fromUs` to `toUs` (either way); `untilStill` stops where it rests. */
    carry(box: FractionBox, fromUs: number, toUs: number, options?: { untilStill?: boolean }): Carried;
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
/** The part of a box inside the picture (a carried place can reach past an edge), at least 1.2 % each way. */
function clipped(box: FractionBox): FractionBox {
    const width = Math.max(0.012, Math.min(1, box.x + box.width) - Math.max(0, box.x));
    const height = Math.max(0.012, Math.min(1, box.y + box.height) - Math.max(0, box.y));
    return { x: Math.min(clamp01(box.x), 1 - width), y: Math.min(clamp01(box.y), 1 - height), width, height };
}
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

/** Centres close enough that two places are the same text: within most of a line's height, and a quarter its width. */
function samePlace(a: FractionBox, b: FractionBox): boolean {
    const dx = Math.abs(a.x + a.width / 2 - (b.x + b.width / 2));
    const dy = Math.abs(a.y + a.height / 2 - (b.y + b.height / 2));
    return dy <= Math.max(0.6 * b.height, 0.008) && dx <= Math.max(0.25 * b.width, 0.015);
}

/** A band hidden where a text could not be followed starts and ends this much wider: its edges are guessed. */
const BAND_MARGIN_US = 100_000;
/** Two reads of the same value this close, with motion between that did not join them, get the band between hidden. */
const GAP_BAND_US = 3_000_000;
/** How far a moving text is followed past its first and last OCR read: until the picture rests, at most this long. */
const EXTEND_US = 2_000_000;

/**
 * Keys that a straight line between their neighbours places within `tolerance` are left out: the renderer moves a part
 * straight from one key to the next, so they add nothing but size.
 */
function simplifyKeys(keys: readonly TrackKey[], tolerance = 0.002): TrackKey[] {
    if (keys.length <= 2) {
        return [...keys];
    }

    const keep = new Uint8Array(keys.length);
    keep[0] = 1;
    keep[keys.length - 1] = 1;
    const stack: Array<[number, number]> = [[0, keys.length - 1]];

    while (stack.length > 0) {
        const [first, last] = stack.pop() ?? [0, 0];
        let worst = -1;
        let worstError = tolerance;

        for (let index = first + 1; index < last; index++) {
            const placed = redactionBoxAt({ ...keys[first], track: [keys[first], keys[last]] }, keys[index].atUs);
            const error = Math.max(
                Math.abs(placed.x - keys[index].x),
                Math.abs(placed.y - keys[index].y),
                Math.abs(placed.width - keys[index].width),
                Math.abs(placed.height - keys[index].height)
            );

            if (error > worstError) {
                worst = index;
                worstError = error;
            }
        }

        if (worst > 0) {
            keep[worst] = 1;
            stack.push([first, worst], [worst, last]);
        }
    }

    return keys.filter((_, index) => keep[index]);
}

/**
 * The band a text may have crossed while it could not be followed: from its last known place on to the picture's edge
 * in the direction it was moving, as wide as the text across the motion; all that moved around it when the direction
 * is unknown.
 */
function sweptBand(options: {
    box: FractionBox;
    velocity: { x: number; y: number };
    area: FractionBox | undefined;
}): FractionBox {
    const { box, velocity } = options;
    const pad = Math.max(0.01, box.height * 0.5);
    const clampBox = (left: number, top: number, right: number, bottom: number): FractionBox => {
        const x = clamp01(left);
        const y = clamp01(top);
        return { x, y, width: Math.max(0.012, clamp01(right) - x), height: Math.max(0.012, clamp01(bottom) - y) };
    };

    // The direction is known: on to the picture's edge that way (the change steps, 4 a second, can miss a fast slide).
    if (Math.abs(velocity.y) >= Math.abs(velocity.x) && velocity.y !== 0) {
        return velocity.y > 0
            ? clampBox(box.x - pad, box.y - pad, box.x + box.width + pad, 1)
            : clampBox(box.x - pad, 0, box.x + box.width + pad, box.y + box.height + pad);
    }

    if (velocity.x !== 0) {
        return velocity.x > 0
            ? clampBox(box.x - pad, box.y - pad, 1, box.y + box.height + pad)
            : clampBox(0, box.y - pad, box.x + box.width + pad, box.y + box.height + pad);
    }

    const area = options.area ?? { x: 0, y: 0, width: 1, height: 1 };
    return clampBox(
        Math.min(box.x, area.x) - pad,
        Math.min(box.y, area.y) - pad,
        Math.max(box.x + box.width, area.x + area.width) + pad,
        Math.max(box.y + box.height, area.y + area.height) + pad
    );
}

/**
 * The hits of `matcher` in a movie's screen text, tracked over time. A match whose centre lies in an `exclude` area (a
 * floating toast, a tab bar) is not a hit.
 *
 * With `motion` (a movie): the same value on a later sample is the same hit only where the content's measured motion
 * carries its last place there; between the two samples the hit gets a key at every picture, so a scroll or a slide
 * is followed exactly, also through pictures OCR could not read. A sample the motion does not lead to is a new hit:
 * two lines that hold the same value are never joined. Past its first and last read a hit is carried while the picture
 * moves (it slid in, or scrolled away). Where the motion cannot be followed while the picture moves, the band the text
 * may cross is hidden for that time and reported as `uncertain`.
 *
 * Without `motion` (a frames recording's own OCR): the same value continues a hit while it stays in place or moves
 * straight up or down by at most `maxShift` of the picture between samples. A gap up to `gapUs` is bridged (a sample
 * can miss a line OCR read on its neighbours). A hit starts half way between the last sample without it and the first
 * with it (at most 0.5 s early), and lasts until the sample after its last.
 */
export function textHits(
    frames: readonly ScreenTextFrame[],
    matcher: LineMatcher,
    {
        gapUs = 1_500_000,
        maxShift = 0.35,
        exclude = [],
        motion,
    }: { gapUs?: number; maxShift?: number; exclude?: readonly FractionBox[]; motion?: MotionModel } = {}
): PrivateHit[] {
    interface Open {
        kind: HitKind;
        label: string;
        value: string;
        fromUs: number;
        toUs: number;
        keys: TrackKey[];
        /** Its first and last place OCR read (the other keys were carried by the motion). */
        firstRead: TrackKey;
        lastRead: TrackKey;
        uncertain: UncertainStretch[];
    }

    const open: Open[] = [];
    const done: Open[] = [];
    const ordered = [...frames].sort((a, b) => a.atUs - b.atUs);

    /** The keys that lead from the track's last place to `box` at `atUs`, or undefined when it is not the same text. */
    const linkTo = (track: Open, box: FractionBox, atUs: number): TrackKey[] | undefined => {
        const last = track.keys[track.keys.length - 1];

        if (!motion) {
            return continues(last, box, maxShift) ? [] : undefined;
        }

        if (!motion.moving(last.atUs, atUs)) {
            return overlap(last, box) > 0.3 || samePlace(last, box) ? [] : undefined;
        }

        const carried = motion.carry(last, last.atUs, atUs);

        if (carried.end !== "reached" || !samePlace(carried.box, box)) {
            return undefined;
        }

        // The measured path ends a little off the read place: the difference is spread over the way there.
        const span = Math.max(1, atUs - last.atUs);
        const off = {
            x: box.x - carried.box.x,
            y: box.y - carried.box.y,
            width: box.width - carried.box.width,
            height: box.height - carried.box.height,
        };
        return carried.keys
            .filter((key) => key.atUs < atUs)
            .map((key) => {
                const share = (key.atUs - last.atUs) / span;
                return {
                    atUs: key.atUs,
                    x: key.x + off.x * share,
                    y: key.y + off.y * share,
                    width: key.width + off.width * share,
                    height: key.height + off.height * share,
                };
            });
    };

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

                const linked = open
                    .filter((track) => !taken.has(track) && track.kind === match.kind && track.value === match.value)
                    .map((track) => ({ track, keys: linkTo(track, box, frame.atUs) }))
                    .filter((candidate): candidate is { track: Open; keys: TrackKey[] } => candidate.keys !== undefined)
                    .sort((a, b) => {
                        const distance = (track: Open) => Math.abs(track.keys[track.keys.length - 1].y - box.y);
                        return distance(a.track) - distance(b.track);
                    })[0];
                const key = { atUs: frame.atUs, ...box };

                if (linked) {
                    linked.track.toUs = Math.max(linked.track.toUs, frame.untilUs);
                    linked.track.keys.push(...linked.keys, key);
                    linked.track.lastRead = key;
                    taken.add(linked.track);
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
                        keys: [key],
                        firstRead: key,
                        lastRead: key,
                        uncertain: [],
                    };
                    open.push(started);
                    taken.add(started);
                }
            }
        }
    }

    done.push(...open);

    if (motion) {
        for (const track of done) {
            extendWithMotion(track, motion);
        }

        bridgeGaps(done, motion);
    }

    return done
        .filter((track) => track.toUs > track.fromUs)
        .sort((a, b) => a.fromUs - b.fromUs || a.keys[0].y - b.keys[0].y)
        .map((track) => {
            // A key between two of the same place adds nothing: the place holds until the key where it moves.
            const deduped = track.keys.filter(
                (key, index, all) =>
                    index === 0 ||
                    index === all.length - 1 ||
                    !(sameBox(all[index - 1], key) && sameBox(all[index + 1], key))
            );
            const keys = (motion ? simplifyKeys(deduped) : deduped).map((key) => ({
                atUs: key.atUs,
                ...rounded(clipped(key)),
            }));
            const still = keys.every((key) => sameBox(key, keys[0]));
            const box = rounded(keys.reduce<FractionBox>((all, key) => union(all, key), keys[0]));
            const follow = motion ? followOf(track, motion) : undefined;
            return {
                id: hitId(track.kind, track.value, track.fromUs, keys[0]),
                kind: track.kind,
                label: track.label,
                masked: maskPrivate(track.value),
                fromUs: track.fromUs,
                toUs: track.toUs,
                box,
                keys: still ? [keys[0]] : keys,
                ...(track.uncertain.length > 0
                    ? {
                          uncertain: track.uncertain.map((stretch) => ({
                              fromUs: Math.round(stretch.fromUs),
                              toUs: Math.round(stretch.toUs),
                              box: rounded(stretch.box),
                          })),
                      }
                    : {}),
                ...(follow && follow.movingUs > 0 ? { follow } : {}),
            };
        });

    /**
     * Carries a finished track past its first and last read while the picture moves there (it slid in, or scrolled on),
     * and covers the swept band where the motion cannot be followed.
     */
    function extendWithMotion(track: Open, model: MotionModel): void {
        for (const direction of [-1, 1] as const) {
            const edge = direction < 0 ? track.keys[0] : track.keys[track.keys.length - 1];
            const limitUs = direction < 0 ? Math.max(0, edge.atUs - EXTEND_US) : edge.atUs + EXTEND_US;
            const carried = model.carry(edge, edge.atUs, limitUs, { untilStill: true });
            const keys = carried.keys;

            if (direction < 0) {
                track.keys.unshift(...[...keys].reverse());
                track.fromUs = Math.min(track.fromUs, carried.reachedUs);
            } else {
                track.keys.push(...keys);
                track.toUs = Math.max(track.toUs, carried.reachedUs);
            }

            if (carried.end !== "lost" && carried.end !== "still") {
                continue;
            }

            // Lost, or taken as resting while the picture under it still changes (a smear too heavy to match, a slide
            // faster than the search): hide the band it may cross until the picture under it rests. A rest is checked from
            // where it began, the first carried place it no longer moves from.
            let rest = keys.length - 1;
            const resting = (key: FractionBox) =>
                Math.abs(key.x - carried.box.x) < 0.004 && Math.abs(key.y - carried.box.y) < 0.004;

            while (carried.end === "still" && rest > 0 && resting(keys[rest - 1])) {
                rest--;
            }

            const start =
                carried.end === "still" && keys.length > 0 ? keys[rest] : { ...carried.box, atUs: carried.reachedUs };
            const stopUs = model.changeEdge(start, start.atUs, direction, EXTEND_US);
            const before = (carried.end === "still" ? keys[rest - 1] : keys[keys.length - 2]) ?? edge;
            const span = Math.max(1, Math.abs(start.atUs - before.atUs));
            const velocity = {
                x: (direction * (start.x - before.x)) / span,
                y: (direction * (start.y - before.y)) / span,
            };
            if (Math.abs(stopUs - start.atUs) < 1000) {
                continue;
            }

            const fromUs = Math.max(0, Math.min(start.atUs, stopUs) - BAND_MARGIN_US);
            const toUs = Math.max(start.atUs, stopUs) + BAND_MARGIN_US;

            track.uncertain.push({
                fromUs,
                toUs,
                box: sweptBand({
                    box: start,
                    velocity: { x: direction * velocity.x, y: direction * velocity.y },
                    area: model.movingArea(fromUs, toUs),
                }),
            });
            track.fromUs = Math.min(track.fromUs, fromUs);
            track.toUs = Math.max(track.toUs, toUs);
        }
    }

    /**
     * Two hits of the same value that the motion could not join, the second read within GAP_BAND_US of the first while
     * the picture moves: the text may have travelled from the first's last read place to the second's first, so that
     * band is hidden between the two reads (a blur too heavy to follow, a move faster than the search).
     */
    function bridgeGaps(tracks: Open[], model: MotionModel): void {
        const ordered = [...tracks].sort((a, b) => a.firstRead.atUs - b.firstRead.atUs);

        for (const [index, track] of ordered.entries()) {
            const from = track.lastRead;
            const next = ordered
                .slice(index + 1)
                .find(
                    (other) =>
                        other.kind === track.kind &&
                        other.value === track.value &&
                        other.firstRead.atUs > from.atUs &&
                        other.firstRead.atUs - from.atUs <= GAP_BAND_US
                );

            if (!next || !model.moving(from.atUs, next.firstRead.atUs) || samePlace(from, next.firstRead)) {
                continue;
            }

            const to = next.firstRead;
            const pad = Math.max(0.01, Math.max(from.height, to.height) * 0.5);
            const band = union(from, to);
            const x = clamp01(band.x - pad);
            const y = clamp01(band.y - pad);
            track.uncertain.push({
                fromUs: Math.max(0, from.atUs - BAND_MARGIN_US),
                toUs: to.atUs + BAND_MARGIN_US,
                box: {
                    x,
                    y,
                    width: Math.min(1, band.x + band.width + pad) - x,
                    height: Math.min(1, band.y + band.height + pad) - y,
                },
            });
        }
    }

    /** The moving time of a track and the places it has then (read or carried). */
    function followOf(track: Open, model: MotionModel): { movingUs: number; keysInMotion: number } {
        const sliceUs = 100_000;
        let movingUs = 0;

        for (let at = track.fromUs; at < track.toUs; at += sliceUs) {
            if (model.moving(at, Math.min(track.toUs, at + sliceUs))) {
                movingUs += Math.min(sliceUs, track.toUs - at);
            }
        }

        const keysInMotion = track.keys.filter((key) => model.moving(key.atUs - 1, key.atUs + 1)).length;
        return { movingUs, keysInMotion };
    }
}

/** The private hits of a movie's screen text (and of `names`), tracked over time (textHits). */
export function privateHits(
    frames: readonly ScreenTextFrame[],
    options: { gapUs?: number; names?: readonly string[]; exclude?: readonly FractionBox[] } = {}
): PrivateHit[] {
    return textHits(frames, privateMatcher(options.names), { gapUs: options.gapUs, exclude: options.exclude });
}

/**
 * Where a hidden part is at a source time, as the renderer places it (RedactionTrack.swift): between two keyframes it
 * moves straight from one to the next, before the first and after the last it keeps the speed of the nearest two, a
 * single keyframe holds, and a part without keyframes keeps its own rectangle.
 */
export function redactionBoxAt(part: FractionBox & { track?: ReadonlyArray<TrackKey> }, atUs: number): FractionBox {
    const keys = part.track;

    if (!keys || keys.length === 0) {
        return { x: part.x, y: part.y, width: part.width, height: part.height };
    }

    if (keys.length === 1) {
        return { x: keys[0].x, y: keys[0].y, width: keys[0].width, height: keys[0].height };
    }

    let low = 0;
    let high = keys.length - 1;

    if (atUs <= keys[0].atUs) {
        high = 1;
    } else if (atUs >= keys[keys.length - 1].atUs) {
        low = keys.length - 2;
    } else {
        while (high - low > 1) {
            const mid = (low + high) >> 1;

            if (keys[mid].atUs <= atUs) {
                low = mid;
            } else {
                high = mid;
            }
        }
    }

    const a = keys[low];
    const b = keys[high];
    const f = b.atUs > a.atUs ? (atUs - a.atUs) / (b.atUs - a.atUs) : 0;
    return {
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        width: a.width + (b.width - a.width) * f,
        height: a.height + (b.height - a.height) * f,
    };
}

/** The edit's record of the private data it hid: the hit ids already applied, so a second apply adds none twice. */
export const privacySchema = z.object({
    applied: z.array(z.string()).default([]),
});
export type EditPrivacy = z.infer<typeof privacySchema>;

/** How a private hit is hidden: never a spotlight, which shows the inside. */
export const PRIVATE_STYLES = ["blur", "pixelate", "black"] as const;
