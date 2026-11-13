import { createHash } from "node:crypto";
import { logger } from "@genesiscz/utils/logger";
import { foldWithIndex } from "@genesiscz/utils/macos/ocr-boxes";
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

/**
 * A rectangle as fractions of the movie's picture, from its top left: x and width are shares of the picture's width,
 * y and height shares of its height, so the same pixels are the same share each way only on a square picture.
 */
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
 * The picture shape (width over height in pixels) the pads around a hit were tuned on: 16:9 recordings, and the
 * generated moving-text movie that checks every frame with Vision OCR. There a pad's x share is the share of the height
 * it is written as; on any other shape the x share changes so the pad keeps the same pixels.
 */
const PAD_TUNED_ASPECT = 16 / 9;

/** A pad's share of the width on a picture of `aspect`: the pixels that `share` of the width is on a 16:9 picture. */
const widthShare = (share: number, aspect: number): number => (share * PAD_TUNED_ASPECT) / aspect;

/**
 * A margin of `lines` line heights around a box `height` high: that share of the height for y, and for x the pixels
 * the same share of the width is on a 16:9 picture (widthShare). Neither is under `floor`.
 */
function linePad(options: { height: number; lines: number; aspect: number; floor?: number }): { x: number; y: number } {
    const pad = options.height * options.lines;
    const floor = options.floor ?? 0;
    return { x: Math.max(floor, widthShare(pad, options.aspect)), y: Math.max(floor, pad) };
}

/**
 * Where a match sits in its OCR line: the line's box narrowed by the share of characters before and after it (a
 * proportional font makes this approximate), padded so the hidden part covers the whole value. The side pad is about
 * one line height in pixels (0.6 of the line's height as a share of a 16:9 width), and the same pixels on a picture of
 * any other `aspect` (its width over its height in pixels): one share on every shape gave a portrait phone a quarter.
 */
export function matchBox(options: {
    line: ScreenLine;
    match: { start: number; end: number };
    aspect: number;
}): FractionBox {
    const { line, match } = options;
    const length = Math.max(1, line.text.length);
    const padX = Math.max(line.width * 0.03, widthShare(line.height * 0.6, options.aspect), 0.004);
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
    /** Why: the motion was lost, the text seemed to rest while the picture under it changed, or two reads did not join. */
    why: "lost" | "rest" | "gap";
}

/** The content's motion carried a box this far: one key per picture, and why it stopped. */
export interface Carried {
    keys: TrackKey[];
    /** Where it got to: the asked time, or where it was lost, left the picture or the picture stood still. */
    reachedUs: number;
    box: FractionBox;
    /** R7 2: "scene" is a new screen that replaced what was under it (the text is gone, not lost). */
    end: "reached" | "lost" | "left" | "still" | "scene";
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

/** R8 7: a letter, a mark, a digit or an underscore in any script: what `\w` means in a hide pattern. */
const WORD = "\\p{L}\\p{M}\\p{N}_";
/** What a pattern may escape under the `u` flag; any other escaped sign is that sign. */
const SYNTAX = new Set([..."^$\\.*+?()[]{}|/"]);
const CLASS_ESCAPES = new Set([..."dDsSwWbBtnrvf0cxupPk123456789"]);

/**
 * R8 7: a hide pattern as a regular expression that knows every script, without case: `\w`, `\b` and `\B` take
 * letters of any language (`\w+ová` finds "Kovářová", `\bŠtěpán\b` finds the name), `\p{L}` is any letter, and an
 * escaped sign the `u` flag refuses (`\-`, `\:`) is that sign. A pattern that still does not compile with `u` (an old
 * form like `\8`) is compiled as it was written.
 */
export function unicodePattern(source: string): RegExp {
    let out = "";
    let inClass = false;

    for (let at = 0; at < source.length; at++) {
        const char = source[at];

        if (char === "\\" && at + 1 < source.length) {
            const next = source[at + 1];
            at++;

            if (next === "w") {
                out += inClass ? WORD : `[${WORD}]`;
            } else if (next === "W" && !inClass) {
                out += `[^${WORD}]`;
            } else if (next === "b" && !inClass) {
                out += `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`;
            } else if (next === "B" && !inClass) {
                out += `(?:(?<=[${WORD}])(?=[${WORD}])|(?<![${WORD}])(?![${WORD}]))`;
            } else if (SYNTAX.has(next) || CLASS_ESCAPES.has(next) || (inClass && next === "-")) {
                out += `\\${next}`;
            } else {
                out += next;
            }

            continue;
        }

        if (char === "[" && !inClass) {
            inClass = true;
        } else if (char === "]" && inClass) {
            inClass = false;
        }

        out += char;
    }

    try {
        return new RegExp(out, "giu");
    } catch (error) {
        logger.debug({ error, source }, "a hide pattern does not compile with the u flag; it is used as written");
        return new RegExp(source, "gi");
    }
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

/**
 * A literal text as a pattern source: without diacritics (run it on `foldWithIndex(line).folded`), and with the spaces
 * OCR leaves out or reads in between its letters, so "alice@example.com" finds "alice@example. com" and "Jiri" finds
 * "Jiří", as the Find tab matches.
 */
function literalSource(text: string): string {
    return [...foldWithIndex(text.replace(/\s+/g, "")).folded].map(escapeRegExp).join("\\s*");
}

/** The matches of `regexes` on `text` without diacritics, each as its [start, end) in `text`. */
function foldedMatches(text: string, regexes: readonly RegExp[]): Array<[number, number]> {
    const { folded, index } = foldWithIndex(text);
    return regexes
        .flatMap((regex) => [...folded.matchAll(regex)])
        .filter((match) => match[0].length > 0)
        .map((match): [number, number] => {
            const start = match.index ?? 0;
            return [index[start], index[start + match[0].length]];
        });
}

/** The private patterns, plus `names` (people, companies) to hide too, matched without case or accents. */
export function privateMatcher(names: readonly string[] = []): LineMatcher {
    const wanted = names.map((name) => name.trim()).filter(Boolean);
    // A name matches with the spaces OCR leaves out or reads in, as textMatcher does, so a name that the "no screen text
    // matches" warning counts as read is also hidden.
    // Each name is its own pattern (literalSource: escaped, so a name never adds regex syntax, and without accents): one
    // alternation returned the first name that matched, so "Ann A" took "Anna" of "Annabelle Johnson" and the longer
    // name stayed visible.
    const namePatterns = wanted.map((name) => new RegExp(literalSource(name), "giu"));
    return compacting((text) => {
        const privates: TextMatch[] = findPrivateText(text).map((match) => ({ ...match, label: labelOf(match.kind) }));
        const found = [...privates];

        // A joined name span can hold an email or a token: that part stays the private match, and the rest of the span
        // is still a name. Dropping the whole span left "Smith Jones" of "alice@example.com Smith Jones" visible.
        for (const span of nameSpans(text, namePatterns)) {
            for (const [start, end] of uncoveredParts(text, span, privates)) {
                // Without spaces, as textMatcher keeps a value: "Bob Builder" and "BobBuilder" are one track.
                const value = text.slice(start, end).replace(/\s+/g, "").toLowerCase();
                found.push({ kind: "name", label: "Name", value, start, end });
            }
        }

        return found.sort((a, b) => a.start - b.start);
    });
}

/** The parts of `span` that no match of `covered` (in text order) takes, without the spaces at their ends. */
function uncoveredParts(
    text: string,
    [start, end]: [number, number],
    covered: readonly TextMatch[]
): Array<[number, number]> {
    const parts: Array<[number, number]> = [];
    let at = start;

    for (const other of covered) {
        if (other.end > at && other.start < end) {
            if (other.start > at) {
                parts.push([at, other.start]);
            }

            at = Math.max(at, other.end);
        }
    }

    if (at < end) {
        parts.push([at, end]);
    }

    return parts
        .map(([from, to]): [number, number] => {
            while (from < to && /\s/.test(text[from] ?? "")) {
                from++;
            }

            while (to > from && /\s/.test(text[to - 1] ?? "")) {
                to--;
            }

            return [from, to];
        })
        .filter(([from, to]) => to > from);
}

/**
 * Where any of `patterns` matches in `text` without diacritics (foldedMatches), each found on its own and overlapping
 * spans joined into one.
 */
function nameSpans(text: string, patterns: readonly RegExp[]): Array<[number, number]> {
    const spans = foldedMatches(text, patterns).sort((a, b) => a[0] - b[0]);
    const joined: Array<[number, number]> = [];

    for (const span of spans) {
        const last = joined.at(-1);

        if (last && span[0] < last[1]) {
            last[1] = Math.max(last[1], span[1]);
        } else {
            joined.push([...span]);
        }
    }

    return joined;
}

/** What a hideText hides of an OCR line that holds a match: the match only, or the whole line (a name and its number). */
export const HIDE_UNITS = ["match", "line"] as const;
export type HideUnit = (typeof HIDE_UNITS)[number];

/**
 * A literal text (without case) or a regular expression's source, as hideText asks for it. Each OCR line is matched on
 * its own (Vision reads a run of text on one baseline as a line): `^` and `$` are the line's start and end, the match
 * is without case, and a space OCR reads next to . @ _ - is left out first. A literal text also matches without
 * accents, as the Find tab does, and with spaces OCR reads in or leaves out between its letters; a pattern runs on the
 * line as read. `unit: "line"` makes each match cover its whole OCR line. `texts` and
 * `patterns` look for several at once.
 */
export function textMatcher(options: TextMatcherOptions): LineMatcher {
    const literals = [options.text, ...(options.texts ?? [])]
        .map((text) => text?.trim())
        .filter((text): text is string => Boolean(text))
        .map((text) => unicodePattern(literalSource(text)));
    // A pattern runs on the line as read: a regular expression may name accented letters on purpose.
    const patterns = [options.pattern, ...(options.patterns ?? [])]
        .filter((pattern): pattern is string => Boolean(pattern))
        .map(unicodePattern);

    if (literals.length + patterns.length === 0) {
        throw new Error("give text (the words to hide) or pattern (a regular expression), or texts and patterns");
    }

    // R6 3: every text and pattern in one pass over the screen text; each value is its own hit.
    const matches = compacting((text) =>
        [
            ...foldedMatches(text, literals),
            ...patterns
                .flatMap((regex) => [...text.matchAll(regex)])
                .filter((match) => match[0].length > 0)
                .map((match): [number, number] => [match.index ?? 0, (match.index ?? 0) + match[0].length]),
        ]
            .map(([start, end]) => ({
                kind: "text" as const,
                label: "Text",
                value: text.slice(start, end).replace(/\s+/g, "").toLowerCase(),
                start,
                end,
            }))
            .sort((a, b) => a.start - b.start)
    );
    return options.unit === "line"
        ? (text) => {
              const found = matches(text);
              // One part per line however many matches it holds: the whole line, named by its first match.
              return found.length > 0 ? [{ ...found[0], start: 0, end: text.length }] : [];
          }
        : matches;
}

/** R8: the shortest run of a hidden value's digits, or of its letters, that counts as a leak of it. */
const FRAGMENT_DIGITS = 4;
const FRAGMENT_LETTERS = 4;
/** A word of a value's letters from its middle (not its head or tail) counts only from this length. */
const FRAGMENT_INNER_LETTERS = 6;

/**
 * R7 and R8: `matcher`, and also a part of one of `values` (what the matcher found in the source) that a box edge or
 * the picture's edge cut: a line that is only the head or the tail of a value (3 characters with a digit, or 5), and
 * anywhere in a line a run of 4 or more of a value's digits ("(...8263)" of "4071-8263"), or a word of 4 or more
 * letters that starts or ends the value's letters (6 or more from its middle), so a box that covers only the left part
 * of a line is a leak of the right part. Each part is its own hit on the fragment's characters. The values stay in
 * memory; a hit shows them masked.
 */
export function edgeFragments(matcher: LineMatcher, values: readonly string[]): LineMatcher {
    // Letters compare without accents, as the matchers do: "Novak" on screen is a part of "jiřínovák".
    const bare = (text: string) => foldWithIndex(text).folded.toLowerCase();
    const known = [...new Set(values.map((value) => value.replace(/\s+/g, "").toLowerCase()))].map((value) => ({
        value,
        folded: bare(value),
        digits: value.replace(/\D/g, ""),
        letters: bare(value).replace(/[^\p{L}]/gu, ""),
    }));
    const partOf = (found: TextMatch, value: string): TextMatch => ({
        ...found,
        kind: "text",
        label: "Text (part of a hidden value)",
        value,
    });
    return (text) => {
        const own = matcher(text);
        const line = bare(text.replace(/\s+/g, ""));
        const enough = line.length >= 5 || (line.length >= 3 && /\d/.test(line));

        if (own.length === 0 && enough) {
            const whole = known.find(
                ({ folded }) => folded.length > line.length && (folded.startsWith(line) || folded.endsWith(line))
            );

            if (whole) {
                return [
                    { kind: "text", label: "Text (part at an edge)", value: whole.value, start: 0, end: text.length },
                ];
            }
        }

        const parts: TextMatch[] = [];
        // A run of digits, with - . / between them as a number is written ("71-8263"); or a part of it between those
        // signs, since OCR reads a digit of a moving number as one of them ("407182/3").
        for (const run of text.matchAll(/\d(?:[-./]?\d)*/g)) {
            const start = run.index ?? 0;
            const pieces = [
                { at: 0, text: run[0] },
                ...[...run[0].matchAll(/\d+/g)].map((piece) => ({ at: piece.index ?? 0, text: piece[0] })),
            ];

            for (const piece of pieces) {
                const digits = piece.text.replace(/\D/g, "");
                const owner =
                    digits.length >= FRAGMENT_DIGITS
                        ? known.find((one) => one.digits.length > 0 && one.digits.includes(digits))
                        : undefined;

                if (owner) {
                    const from = start + piece.at;
                    parts.push(
                        partOf(
                            { kind: "text", label: "", value: "", start: from, end: from + piece.text.length },
                            owner.value
                        )
                    );
                    break;
                }
            }
        }

        for (const run of text.matchAll(/\p{L}+/gu)) {
            const word = bare(run[0]);
            const owner =
                word.length >= FRAGMENT_LETTERS
                    ? known.find(
                          (one) =>
                              one.letters.length > word.length &&
                              (one.letters.startsWith(word) ||
                                  one.letters.endsWith(word) ||
                                  (word.length >= FRAGMENT_INNER_LETTERS && one.letters.includes(word)))
                      )
                    : undefined;

            if (owner) {
                const start = run.index ?? 0;
                parts.push(
                    partOf({ kind: "text", label: "", value: "", start, end: start + run[0].length }, owner.value)
                );
            }
        }

        const free = parts.filter((part) => !own.some((match) => part.start < match.end && part.end > match.start));
        return [...own, ...free].sort((a, b) => a.start - b.start);
    };
}

/** What textMatcher looks for: one text or pattern, or several (R6 3), and how much of its line a match covers. */
export interface TextMatcherOptions {
    text?: string;
    pattern?: string;
    texts?: readonly string[];
    patterns?: readonly string[];
    unit?: HideUnit;
}

/** R8 7: each text and pattern of a request that no line of `frames` matches, as a message names it. */
export function unmatchedQueries(
    frames: readonly ScreenTextFrame[],
    options: Omit<TextMatcherOptions, "unit">
): string[] {
    const queries = [
        ...[options.text, ...(options.texts ?? [])].filter(Boolean).map((text) => ({ text })),
        ...[options.pattern, ...(options.patterns ?? [])].filter(Boolean).map((pattern) => ({ pattern })),
    ];
    return queries
        .filter((query) => {
            const matcher = textMatcher(query);
            return !frames.some((frame) => frame.lines.some((line) => matcher(line.text).length > 0));
        })
        .map((query) => describeTextQuery(query));
}

/** The words a text request names, for a message: `"a", "b" or /c/`. */
export function describeTextQuery(options: Omit<TextMatcherOptions, "unit">): string {
    const said = [
        ...[options.text, ...(options.texts ?? [])].filter(Boolean).map((text) => `"${text}"`),
        ...[options.pattern, ...(options.patterns ?? [])].filter(Boolean).map((pattern) => `/${pattern}/`),
    ];
    return said.length > 1 ? `${said.slice(0, -1).join(", ")} or ${said.at(-1)}` : (said[0] ?? "the text");
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

/**
 * The keys of a hit read on still frames (each shown until the next): every read's place holds until 1 µs before the
 * next read of another place, the first from `fromUs` and the last until `toUs`, so the renderer, which moves a part
 * straight between keys and runs on past the last, places the part where the frame on screen shows the text. A hit
 * whose reads all stand in one place keeps its keys (it is a still part).
 */
function steppedKeys(keys: readonly TrackKey[], span: { fromUs: number; toUs: number }): TrackKey[] {
    if (keys.every((key) => sameBox(key, keys[0]))) {
        return [...keys];
    }

    const out: TrackKey[] = [{ ...keys[0], atUs: Math.min(span.fromUs, keys[0].atUs) }];

    for (const key of keys.slice(1)) {
        const held = out[out.length - 1];

        if (sameBox(held, key)) {
            continue;
        }

        if (key.atUs - 1 > held.atUs) {
            out.push({ ...held, atUs: key.atUs - 1 });
        }

        out.push(key);
    }

    const last = out[out.length - 1];

    if (span.toUs > last.atUs) {
        out.push({ ...last, atUs: span.toUs });
    }

    return out;
}

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

/**
 * R8 2: a carried place with half a line of margin on each side: the motion that carries it is measured on blocks
 * coarser than a line, and a read box (matchBox) is a line and a half high, so a third of it is half a line. Its x
 * share keeps the pixels it has on a 16:9 picture on a picture of any other `aspect` (linePad).
 */
function withMargin<T extends FractionBox>(box: T, aspect: number): T {
    const pad = linePad({ height: box.height, lines: 1 / 3, aspect });
    const x = clamp01(box.x - pad.x);
    const y = clamp01(box.y - pad.y);
    return {
        ...box,
        x,
        y,
        width: Math.min(1, box.x + box.width + pad.x) - x,
        height: Math.min(1, box.y + box.height + pad.y) - y,
    };
}

/** A rest whose picture keeps changing under it for less than this is the end of a scroll settling, not a lost text. */
const REST_SETTLE_US = 300_000;
/**
 * A rest is checked as a possible failed follow only when it is abrupt: the text moved half a line or more in this
 * time just before it. A scroll that slows to a stop (its last tenth of a second barely moves) simply ended.
 */
const REST_LOOKBACK_US = 200_000;
/** How long after its last read a carry must keep up with the read speed (brokeAway). */
const BROKE_AWAY_US = 100_000;
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
 * A track's speed where OCR read it, next to its `direction` end (-1 its start, 1 its end), as fractions of the picture
 * per microsecond in the direction of an extension past that end (so the way it came from, or the way it went on). Each
 * step between its keys there must go the same way, and the slowest step counts: a read that jitters has no speed.
 */
function innerVelocity(keys: readonly TrackKey[], direction: -1 | 1): { x: number; y: number } {
    const edge = direction < 0 ? keys[0] : keys[keys.length - 1];
    const near = keys.filter((key) => Math.abs(key.atUs - edge.atUs) <= REST_LOOKBACK_US);
    const steps: Array<{ x: number; y: number }> = [];

    for (let index = 1; index < near.length; index++) {
        const span = Math.max(1, near[index].atUs - near[index - 1].atUs);
        steps.push({
            x: (direction * (near[index].x - near[index - 1].x)) / span,
            y: (direction * (near[index].y - near[index - 1].y)) / span,
        });
    }

    if (steps.length < 2) {
        return { x: 0, y: 0 };
    }

    const mean = {
        x: steps.reduce((sum, step) => sum + step.x, 0) / steps.length,
        y: steps.reduce((sum, step) => sum + step.y, 0) / steps.length,
    };
    const length = Math.hypot(mean.x, mean.y);

    if (length === 0) {
        return { x: 0, y: 0 };
    }

    const unit = { x: mean.x / length, y: mean.y / length };
    const slowest = Math.min(...steps.map((step) => step.x * unit.x + step.y * unit.y));
    return slowest > 0 ? { x: unit.x * slowest, y: unit.y * slowest } : { x: 0, y: 0 };
}

/**
 * A carry broke away from a text that OCR read moving fast (R7 2): in its first tenth of a second it covered less than
 * half of what the read speed predicts (a uniform banner matches as still, a slide outruns the search).
 */
function brokeAway(options: { edge: TrackKey; keys: readonly TrackKey[]; inner: { x: number; y: number } }): boolean {
    const { edge, keys, inner } = options;
    const speed = Math.hypot(inner.x, inner.y);

    // Fast: at least half its own height in a tenth of a second.
    if (speed * BROKE_AWAY_US < edge.height * 0.5) {
        return false;
    }

    const within = keys.filter((key) => Math.abs(key.atUs - edge.atUs) <= BROKE_AWAY_US);
    const last = within[within.length - 1];

    if (!last) {
        return true;
    }

    const covered = Math.hypot(last.x - edge.x, last.y - edge.y);
    return covered < 0.5 * speed * Math.abs(last.atUs - edge.atUs);
}

/**
 * The band a text may have crossed while it could not be followed (R7 2: never wider than the text's own column or row
 * plus its travel): from its last known place along its direction of motion to the edge of what changed meanwhile (or
 * as far as its speed carries it in `travelUs`, when that is further), as wide as the text across the motion, and inside
 * the part of the picture that changed (so a status bar or a tab bar that stood still is never covered). With no
 * measured travel, its own place.
 */
export function sweptBand(options: {
    box: FractionBox;
    /** Fractions of the picture per microsecond, in the direction it travels. */
    velocity: { x: number; y: number };
    travelUs: number;
    area: FractionBox | undefined;
    /** The picture's width over its height in pixels: the pads keep the pixels they have on 16:9 (linePad). */
    aspect: number;
}): FractionBox {
    const { box, velocity } = options;
    const pad = linePad({ height: box.height, lines: 0.5, aspect: options.aspect, floor: 0.005 });
    const area = options.area ?? { x: 0, y: 0, width: 1, height: 1 };
    // The moving part, but never smaller than the text itself.
    const lo = { x: Math.min(area.x, box.x), y: Math.min(area.y, box.y) };
    const hi = {
        x: Math.max(area.x + area.width, box.x + box.width),
        y: Math.max(area.y + area.height, box.y + box.height),
    };
    const reach = { x: Math.abs(velocity.x) * options.travelUs, y: Math.abs(velocity.y) * options.travelUs };
    const clampBox = (left: number, top: number, right: number, bottom: number): FractionBox => {
        const x = Math.max(lo.x, clamp01(left));
        const y = Math.max(lo.y, clamp01(top));
        const r = Math.min(hi.x, clamp01(right));
        const b = Math.min(hi.y, clamp01(bottom));
        return { x, y, width: Math.max(0.012, r - x), height: Math.max(0.012, b - y) };
    };

    // No measured travel: only its own place (the picture under it changed, nothing says it went anywhere).
    if (velocity.x === 0 && velocity.y === 0) {
        return clampBox(box.x - pad.x, box.y - pad.y, box.x + box.width + pad.x, box.y + box.height + pad.y);
    }

    // On along its direction to where the picture stopped changing (a follow that failed under-measured its speed), and
    // past that as far as its speed carries it: the quarter-second change steps miss a text that only crossed a cell
    // between two of them (a banner that slid in from the edge). R8 3: only along a direction it really travels (half a
    // line or more in that time, the pad, so along x the same pixels on any shape); a drift of a few pixels across a
    // scroll swept the band over the whole picture.
    const travels = { x: reach.x >= pad.x, y: reach.y >= pad.y };
    // Along its main direction to the moving area's edge; across it (a slide that also drifts) only as far as it went.
    const main = Math.abs(velocity.x) >= Math.abs(velocity.y) ? "x" : "y";
    const left = velocity.x < 0 && travels.x ? Math.min(box.x - reach.x, main === "x" ? lo.x : 1) : box.x;
    const right =
        velocity.x > 0 && travels.x
            ? Math.max(box.x + box.width + reach.x, main === "x" ? hi.x : 0)
            : box.x + box.width;
    const top = velocity.y < 0 && travels.y ? Math.min(box.y - reach.y, main === "y" ? lo.y : 1) : box.y;
    const bottom =
        velocity.y > 0 && travels.y
            ? Math.max(box.y + box.height + reach.y, main === "y" ? hi.y : 0)
            : box.y + box.height;
    const band = clampBox(left - pad.x, top - pad.y, right + pad.x, bottom + pad.y);
    const x = velocity.x < 0 && travels.x ? clamp01(left - pad.x) : band.x;
    const y = velocity.y < 0 && travels.y ? clamp01(top - pad.y) : band.y;
    const r = velocity.x > 0 && travels.x ? clamp01(right + pad.x) : band.x + band.width;
    const b = velocity.y > 0 && travels.y ? clamp01(bottom + pad.y) : band.y + band.height;
    return { x, y, width: Math.max(0.012, r - x), height: Math.max(0.012, b - y) };
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
 *
 * With `stills` (a frames recording: its proxy shows each frame unchanged until the next one), a hit holds each read's
 * place until the next read and jumps there, and holds its first and last place to its start and end, so its part
 * stands where the picture shows the text. The renderer moves a part straight from one key to the next and runs on past
 * the last at the speed of the last two, which slid the part off a text that moved or jittered between two frames.
 *
 * `aspect` is the picture's width over its height in pixels: every pad around a hit keeps the pixels it has on 16:9.
 */
export function textHits(
    frames: readonly ScreenTextFrame[],
    matcher: LineMatcher,
    {
        aspect,
        gapUs = 1_500_000,
        maxShift = 0.35,
        exclude = [],
        motion,
        stills = false,
    }: {
        aspect: number;
        gapUs?: number;
        maxShift?: number;
        exclude?: readonly FractionBox[];
        motion?: MotionModel;
        stills?: boolean;
    }
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
        /** R8 2: every place OCR read it (the others are carried and get half a line of margin). */
        reads: Set<TrackKey>;
        /** How the motion carry ended before its first read and after its last (R7 2: a text that left needs no band). */
        ends?: { before?: Carried["end"]; after?: Carried["end"] };
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
        // R8 2: a carried place covers both the last read carried on and the next read moved back by the same motion,
        // so a line that reads wider at the next read (it slid in further) is covered on the way there too.
        return carried.keys
            .filter((key) => key.atUs < atUs)
            .map((key) => {
                const share = (key.atUs - last.atUs) / span;
                const spread = {
                    x: key.x + off.x * share,
                    y: key.y + off.y * share,
                    width: key.width + off.width * share,
                    height: key.height + off.height * share,
                };
                const next = {
                    x: key.x + off.x,
                    y: key.y + off.y,
                    width: key.width + off.width,
                    height: key.height + off.height,
                };
                return { atUs: key.atUs, ...union(spread, { ...next, y: spread.y, height: spread.height }) };
            });
    };

    /** R8 2: the place a track's motion carries it to at `atUs`, or its last place when the picture under it rests. */
    const carryTo = (track: Open, atUs: number): { keys: TrackKey[]; box: FractionBox } | undefined => {
        const last = track.keys[track.keys.length - 1];

        if (!motion?.moving(last.atUs, atUs)) {
            return { keys: [], box: last };
        }

        const carried = motion.carry(last, last.atUs, atUs);
        return carried.end === "reached"
            ? { keys: carried.keys.filter((key) => key.atUs < atUs), box: carried.box }
            : undefined;
    };
    const fragmentsOf = new Map<string, LineMatcher>();

    for (const [index, frame] of ordered.entries()) {
        for (const track of open.splice(0)) {
            (track.toUs + gapUs >= frame.atUs ? open : done).push(track);
        }

        const previous = ordered[index - 1];
        const taken = new Set<Open>();
        const matchedLines = new Set<ScreenLine>();

        for (const line of frame.lines) {
            for (const match of matcher(line.text)) {
                matchedLines.add(line);
                const box = matchBox({ line, match, aspect });

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
                    linked.track.reads.add(key);
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
                        reads: new Set([key]),
                        uncertain: [],
                    };
                    open.push(started);
                    taken.add(started);
                }
            }
        }

        // R8 2: OCR reads a sliding or half-covered line cut short or run into its neighbour, so the matcher misses it;
        // a line that holds a part of a moving track's value where its motion carries it is still that text: the track
        // goes on there (the carried place and the read part together) instead of being carried blind.
        for (const track of motion ? open : []) {
            if (taken.has(track) || track.keys[track.keys.length - 1].atUs >= frame.atUs) {
                continue;
            }

            let fragments = fragmentsOf.get(track.value);

            if (!fragments) {
                fragments = edgeFragments(() => [], [track.value]);
                fragmentsOf.set(track.value, fragments);
            }

            for (const line of frame.lines) {
                const found = matchedLines.has(line) ? [] : fragments(line.text);

                if (found.length === 0) {
                    continue;
                }

                const read = found
                    .map((part) => matchBox({ line, match: part, aspect }))
                    .reduce((all, box) => union(all, box));
                const carried = carryTo(track, frame.atUs);
                const centre = (box: FractionBox) => box.y + box.height / 2;

                if (
                    !carried ||
                    Math.abs(centre(carried.box) - centre(read)) > Math.max(read.height, 0.008) ||
                    read.x > carried.box.x + carried.box.width ||
                    read.x + read.width < carried.box.x
                ) {
                    continue;
                }

                track.keys.push(...carried.keys, { atUs: frame.atUs, ...union(carried.box, read) });
                track.toUs = Math.max(track.toUs, frame.untilUs);
                taken.add(track);
                matchedLines.add(line);
                break;
            }
        }
    }

    done.push(...open);

    if (motion) {
        for (const track of done) {
            extendWithMotion(track, motion);
        }

        bridgeGaps(done, motion);
        heldPlaces(done);

        for (const track of done) {
            // R8 3: a carried place that stands where the last read was (a still screen between reads) needs no margin.
            let read: TrackKey | undefined;
            track.keys = track.keys.map((key) => {
                if (track.reads.has(key)) {
                    read = key;
                    return key;
                }

                return read && sameBox(read, key) ? key : withMargin(key, aspect);
            });
        }
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
            const placed = (motion ? simplifyKeys(deduped) : deduped).map((key) => ({
                atUs: key.atUs,
                ...rounded(clipped(key)),
            }));
            const keys =
                stills && !motion
                    ? steppedKeys(placed, { fromUs: Math.round(track.fromUs), toUs: Math.round(track.toUs) })
                    : placed;

            // R8 2: the renderer runs a part on past its first and last key at their speed; a followed hit already has
            // keys for its whole motion, and running on from a sliver read at the edge to a whole line made a box of
            // negative width (nothing hidden), so it holds its first and last place instead.
            if (motion && keys.length > 1) {
                if (track.fromUs < keys[0].atUs) {
                    keys.unshift({ ...keys[0], atUs: Math.round(track.fromUs) });
                }

                const last = keys[keys.length - 1];

                if (track.toUs > last.atUs) {
                    keys.push({ ...last, atUs: Math.round(track.toUs) });
                }
            }

            const still = keys.every((key) => sameBox(key, keys[0]));
            const box = rounded(keys.reduce<FractionBox>((all, key) => union(all, key), keys[0]));
            const follow = motion ? followOf(track, motion) : undefined;
            return {
                id: hitId(track.kind, track.value, track.fromUs, keys[0]),
                kind: track.kind,
                label: track.label,
                masked: maskPrivate(track.value),
                fromUs: Math.round(track.fromUs),
                toUs: Math.round(track.toUs),
                box,
                keys: still ? [keys[0]] : keys,
                ...(track.uncertain.length > 0
                    ? {
                          uncertain: track.uncertain.map((stretch) => ({
                              fromUs: Math.round(stretch.fromUs),
                              toUs: Math.round(stretch.toUs),
                              box: rounded(stretch.box),
                              why: stretch.why,
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
            // Its own speed where OCR read it, in the direction of the extension (R7 2: a text that slid in fast from the
            // edge was read moving; a carry that then finds it standing still lost it).
            const inner = innerVelocity(track.keys, direction);
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

            track.ends = { ...track.ends, [direction < 0 ? "before" : "after"]: carried.end };

            if (carried.end !== "lost" && carried.end !== "still") {
                continue;
            }

            // Lost, or taken as resting while the picture under it still changes (a smear too heavy to match, a slide
            // faster than the search): hide the band it may cross until the picture under it rests. A new screen
            // ("scene") or a text that left the picture needs no band: the text is gone, and what comes next gets its own
            // reads.
            const broken = brokeAway({ edge, keys, inner });
            let rest = keys.length - 1;
            // Back from the end while each picture's step is under a tenth of the text's height: where its rest began.
            const crept = (a: FractionBox, b: FractionBox) => Math.hypot(a.x - b.x, a.y - b.y) < a.height * 0.1;

            while (carried.end === "still" && rest > 0 && crept(keys[rest - 1], keys[rest])) {
                rest--;
            }

            const start = broken
                ? edge
                : carried.end === "still" && keys.length > 0
                  ? keys[rest]
                  : { ...carried.box, atUs: carried.reachedUs };
            const travelled = [edge, ...keys].filter((key) => Math.abs(key.atUs - start.atUs) <= REST_LOOKBACK_US);
            const before = travelled[0] ?? edge;
            const moved = Math.hypot(start.x - before.x, start.y - before.y);

            // R7 2: a text that rests where it never moved is still: no band.
            if (!broken && carried.end === "still" && moved < start.height * 0.5) {
                continue;
            }

            const stopUs = model.changeEdge(start, start.atUs, direction, EXTEND_US);
            // Content slows down before it stops (a scroll, a sheet). A follow whose steps grew to more than half a line
            // and then stopped dead lost a text that went on (a uniform banner matches as still).
            const step = (index: number) => {
                const a = keys[index - 1] ?? edge;
                const b = keys[index] ?? edge;
                return Math.hypot(a.x - b.x, a.y - b.y);
            };
            const stalled =
                rest > 0 &&
                step(rest) >= start.height * 0.5 &&
                step(rest - 1) >= start.height * 0.25 &&
                step(rest) > 1.1 * step(rest - 1);

            // R7 2: the end of a scroll slows below what the blocks measure while the picture still settles (the change
            // steps run to the end of their quarter second). A rest is a failed follow only when the picture under it
            // keeps changing past that, or when the follow broke away from the speed OCR read or stalled.
            if (!broken && !stalled && carried.end === "still" && Math.abs(stopUs - start.atUs) < REST_SETTLE_US) {
                continue;
            }

            if (Math.abs(stopUs - start.atUs) < 1000) {
                continue;
            }

            // Its speed in the direction of the extension: what OCR read when the follow broke away, else over the last
            // tenth of a second of the follow.
            const span = Math.max(1, Math.abs(start.atUs - before.atUs));
            const velocity = broken ? inner : { x: (start.x - before.x) / span, y: (start.y - before.y) / span };
            const fromUs = Math.max(0, Math.min(start.atUs, stopUs) - BAND_MARGIN_US);
            const toUs = Math.max(start.atUs, stopUs) + BAND_MARGIN_US;

            track.uncertain.push({
                fromUs,
                toUs,
                why: carried.end === "lost" ? "lost" : "rest",
                box: sweptBand({
                    box: start,
                    velocity,
                    travelUs: Math.abs(stopUs - start.atUs) + BAND_MARGIN_US,
                    area: model.movingArea(fromUs, toUs),
                    aspect,
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
            const share = (a0: number, a1: number, b0: number, b1: number) =>
                (Math.min(a1, b1) - Math.max(a0, b0)) / Math.max(1e-6, Math.min(a1 - a0, b1 - b0));
            const sameColumn = share(from.x, from.x + from.width, to.x, to.x + to.width) >= 0.5;
            const sameRow = share(from.y, from.y + from.height, to.y, to.y + to.height) >= 0.5;

            // R7 2: followed all the way (the two hits meet in time), or two places in neither the same column nor the
            // same row (another copy of the value, not this one moved): no band.
            const gone = (end: Carried["end"] | undefined) => end === "left" || end === "scene";

            if (
                track.toUs >= next.fromUs ||
                (!sameColumn && !sameRow) ||
                gone(track.ends?.after) ||
                gone(next.ends?.before)
            ) {
                continue;
            }

            const pad = linePad({ height: Math.max(from.height, to.height), lines: 0.5, aspect, floor: 0.005 });
            const area = model.movingArea(from.atUs, to.atUs);
            const band = union(from, to);
            const inside = area ? union(area, band) : band;
            const x = Math.max(inside.x, clamp01(band.x - pad.x));
            const y = Math.max(inside.y, clamp01(band.y - pad.y));
            track.uncertain.push({
                fromUs: Math.max(0, from.atUs - BAND_MARGIN_US),
                toUs: to.atUs + BAND_MARGIN_US,
                why: "gap",
                box: {
                    x,
                    y,
                    width: Math.min(inside.x + inside.width, band.x + band.width + pad.x) - x,
                    height: Math.min(inside.y + inside.height, band.y + band.height + pad.y) - y,
                },
            });
        }
    }

    /**
     * R8 2: the motion carried a track off a place where OCR then reads its value again (a fixed title over a scroll
     * behind it, a header the blocks under it took for the content): the text stood there, so its read place stays
     * hidden until that read, beside the carried path.
     */
    function heldPlaces(tracks: Open[]): void {
        const reads = tracks.flatMap((track) => [...track.reads].map((key) => ({ track, key })));

        for (const track of tracks) {
            const last = track.lastRead;
            const again = reads
                .filter(
                    ({ track: other, key }) =>
                        other.kind === track.kind &&
                        other.value === track.value &&
                        key.atUs > last.atUs &&
                        key.atUs - last.atUs <= EXTEND_US &&
                        samePlace(last, key)
                )
                .sort((a, b) => a.key.atUs - b.key.atUs)[0];

            if (!again) {
                continue;
            }

            const between = track.keys.filter((key) => key.atUs > last.atUs && key.atUs < again.key.atUs);

            if (between.every((key) => samePlace(last, key))) {
                continue;
            }

            track.uncertain.push({
                fromUs: last.atUs,
                toUs: again.key.atUs,
                why: "rest",
                box: withMargin(union(last, again.key), aspect),
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

/** The private hits of a movie's screen text (and of `names`), tracked over time (textHits, with its `aspect`). */
export function privateHits(
    frames: readonly ScreenTextFrame[],
    options: { aspect: number; gapUs?: number; names?: readonly string[]; exclude?: readonly FractionBox[] }
): PrivateHit[] {
    return textHits(frames, privateMatcher(options.names), {
        aspect: options.aspect,
        gapUs: options.gapUs,
        exclude: options.exclude,
    });
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
