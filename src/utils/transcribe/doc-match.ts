import type { TranscriptEntry } from "./types";

/** A word of a text: lower case, no diacritics, with its place in the original text. */
interface Word {
    norm: string;
    start: number;
    end: number;
    /** Inside a code span of a document: a reader may skip it ("DELETE …/releases/{id}/items"). */
    code?: boolean;
}

/** A line of a context document, as a person reads it from the screen: no heading marks, bold or backticks. */
export interface DocLine {
    doc: string;
    /** 1-based line number in the document. */
    line: number;
    text: string;
}

/** A passage of a transcript line that reads a document line aloud. */
export interface ReadAloudMatch {
    entry: number;
    /** The words as the transcript has them, from the first matched word to the last. */
    heard: string;
    start: number;
    end: number;
    doc: string;
    line: number;
    text: string;
    /** 0..1: how densely the matched words cover the document's part and the transcript's part. */
    score: number;
    /** Words read in the same order on both sides. */
    shared: number;
}

/** A spoken path or identifier (`lomeno type`, `employee only`) and the document identifier it names. */
export interface SpokenIdentifier {
    entry: number;
    heard: string;
    start: number;
    end: number;
    identifier: string;
    /** Words of the identifier the speaker said. */
    matched: number;
    score: number;
}

const DIACRITICS = /\p{M}/gu;

function fold(value: string): string {
    return value.normalize("NFD").replace(DIACRITICS, "").toLowerCase();
}

/** The words of a text; an identifier splits at its humps and separators ("ProductData.offerSection" is 4 words). */
function words(text: string): Word[] {
    const out: Word[] = [];

    for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
        const raw = match[0];
        const base = match.index ?? 0;
        let from = 0;

        for (const hump of raw.matchAll(/\p{Lu}?\p{Ll}+\p{N}*|\p{Lu}+\p{N}*(?!\p{Ll})|\p{N}+/gu)) {
            const at = hump.index ?? 0;

            if (at > from) {
                out.push({ norm: fold(raw.slice(from, at)), start: base + from, end: base + at });
            }

            out.push({ norm: fold(hump[0]), start: base + at, end: base + at + hump[0].length });
            from = at + hump[0].length;
        }

        if (from < raw.length) {
            out.push({ norm: fold(raw.slice(from)), start: base + from, end: base + raw.length });
        }
    }

    return out;
}

/** The words of a document line; those inside backticks are marked as code. */
function docWords(text: string): Word[] {
    const spans = [...text.matchAll(/`[^`]*`/g)].map((match) => [
        match.index ?? 0,
        (match.index ?? 0) + match[0].length,
    ]);
    return words(text).map((word) =>
        spans.some(([from, to]) => word.start >= from! && word.end <= to!) ? { ...word, code: true } : word
    );
}

function editDistanceAtMostOne(a: string, b: string): boolean {
    if (Math.abs(a.length - b.length) > 1) {
        return false;
    }

    let i = 0;
    let j = 0;
    let edits = 0;

    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            i += 1;
            j += 1;
            continue;
        }

        edits += 1;

        if (edits > 1) {
            return false;
        }

        if (a.length > b.length) {
            i += 1;
        } else if (b.length > a.length) {
            j += 1;
        } else {
            i += 1;
            j += 1;
        }
    }

    return edits + (a.length - i) + (b.length - j) <= 1;
}

/** Spoken and written forms of one word: equal, one a prefix of the other ("kap", "kapitola"), or one edit apart. */
function sameWord(a: string, b: string): boolean {
    if (a === b) {
        return true;
    }

    const shorter = Math.min(a.length, b.length);

    if (shorter >= 3 && (a.startsWith(b) || b.startsWith(a))) {
        return true;
    }

    return shorter >= 5 && editDistanceAtMostOne(a, b);
}

/** One word of an identifier said aloud: equal, a short ending more or less ("employees"), or one edit apart. */
function sameIdentifierWord(spoken: string, part: string): boolean {
    if (spoken === part) {
        return true;
    }

    const shorter = Math.min(spoken.length, part.length);
    const longer = Math.max(spoken.length, part.length);

    if (shorter >= 4 && longer - shorter <= 3 && (spoken.startsWith(part) || part.startsWith(spoken))) {
        return true;
    }

    return shorter >= 5 && editDistanceAtMostOne(spoken, part);
}

/** The longest common subsequence of two word lists under `sameWord`, as index pairs in order. */
function alignment(a: Word[], b: Word[]): [number, number][] {
    const rows = a.length + 1;
    const cols = b.length + 1;
    const table = new Uint16Array(rows * cols);

    for (let i = a.length - 1; i >= 0; i -= 1) {
        for (let j = b.length - 1; j >= 0; j -= 1) {
            table[i * cols + j] = sameWord(a[i]!.norm, b[j]!.norm)
                ? table[(i + 1) * cols + j + 1]! + 1
                : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
        }
    }

    const pairs: [number, number][] = [];
    let i = 0;
    let j = 0;

    while (i < a.length && j < b.length) {
        if (sameWord(a[i]!.norm, b[j]!.norm) && table[i * cols + j] === table[(i + 1) * cols + j + 1]! + 1) {
            pairs.push([i, j]);
            i += 1;
            j += 1;
        } else if (table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!) {
            i += 1;
        } else {
            j += 1;
        }
    }

    return pairs;
}

/** The readable lines of a markdown document: headings, list items and paragraphs, without the markup. */
export function docLines(doc: string, markdown: string, minWords = 6): DocLine[] {
    // The open fence's marker: a fence closes only with the same character, at least as long (four backticks around a
    // block that holds three-backtick lines).
    let fence: string | undefined;

    return markdown.split("\n").flatMap((raw, index) => {
        const marker = /^\s*(`{3,}|~{3,})/.exec(raw)?.[1];

        if (
            marker &&
            (!fence || (marker[0] === fence[0] && marker.length >= fence.length && !raw.trim().slice(marker.length)))
        ) {
            fence = fence ? undefined : marker;
            return [];
        }

        if (fence) {
            return [];
        }

        const text = raw
            .replace(/^\s*(#+|[-*+]|\d+\.)\s+/, "")
            .replace(/\*\*|__/g, "")
            .replace(/<!--.*?-->/g, "")
            .trim();

        if (text.startsWith("|") || text.startsWith("```") || words(text).length < minWords) {
            return [];
        }

        return [{ doc, line: index + 1, text }];
    });
}

/**
 * The passages of the transcript that read a document line aloud: at least `minShared` words in the same order, dense
 * on both sides (a reader skips a parenthesis or a long identifier, a discussion of the same topic scatters its words).
 */
export function findReadAloud(options: {
    entries: TranscriptEntry[];
    lines: DocLine[];
    minShared?: number;
    minDensity?: number;
}): ReadAloudMatch[] {
    const minShared = options.minShared ?? 5;
    const minDensity = options.minDensity ?? 0.55;
    const docs = options.lines.map((line) => ({ line, words: docWords(line.text) }));
    const found: ReadAloudMatch[] = [];

    for (const [entry, { text }] of options.entries.entries()) {
        const spoken = words(text);

        if (spoken.length < minShared) {
            continue;
        }

        const matches = docs.flatMap(({ line, words: written }) => {
            const pairs = alignment(spoken, written);

            if (pairs.length < minShared) {
                return [];
            }

            const [firstSpoken, firstWritten] = pairs[0]!;
            const [lastSpoken, lastWritten] = pairs.at(-1)!;
            const matchedWritten = new Set(pairs.map(([, written]) => written));
            const skippedCode = written
                .slice(firstWritten, lastWritten + 1)
                .filter((word, at) => word.code && !matchedWritten.has(firstWritten + at)).length;
            const spokenDensity = pairs.length / (lastSpoken - firstSpoken + 1);
            const writtenDensity = pairs.length / (lastWritten - firstWritten + 1 - skippedCode);

            // A path or a type said aloud is an identifier mention, not a passage read: three prose words at least.
            const prose = pairs.filter(([, at]) => !written[at]!.code && written[at]!.norm.length >= 3).length;

            if (spokenDensity < minDensity || writtenDensity < minDensity || prose < 3) {
                return [];
            }

            const start = spoken[firstSpoken]!.start;
            const end = spoken[lastSpoken]!.end;
            return [
                {
                    entry,
                    heard: text.slice(start, end),
                    start,
                    end,
                    doc: line.doc,
                    line: line.line,
                    text: pairs
                        .map(([spokenAt, writtenAt], index) => {
                            const previous = pairs[index - 1];
                            const gap = previous ? text.slice(spoken[previous[0]]!.end, spoken[spokenAt]!.start) : "";
                            return gap + line.text.slice(written[writtenAt]!.start, written[writtenAt]!.end);
                        })
                        .join(""),
                    score: Math.round(((spokenDensity + writtenDensity) / 2) * 100) / 100,
                    shared: pairs.length,
                },
            ];
        });

        // The best document line for each part of the transcript line; two lines read one after the other both stay.
        for (const match of matches.sort((a, b) => b.shared - a.shared || b.score - a.score)) {
            if (!found.some((kept) => kept.entry === entry && kept.start < match.end && match.start < kept.end)) {
                found.push(match);
            }
        }
    }

    return found.sort((a, b) => a.entry - b.entry || a.start - b.start);
}

/** The words of an identifier that a person says: letters, two or more, no HTTP method. */
function sayableWords(identifier: string): Word[] {
    return words(identifier).filter((word) => /^\p{L}{2,}\p{N}*$/u.test(word.norm) && !HTTP_METHODS.has(word.norm));
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

/** The identifiers of a markdown document: code spans and camelCase, PascalCase, SNAKE_CASE or dotted names. */
export function docIdentifiers(markdown: string): string[] {
    const found = new Set<string>();

    for (const match of markdown.matchAll(/`([^`\n]+)`/g)) {
        const code = match[1]!.trim();

        if (/^(GET|POST|PUT|PATCH|DELETE)\s+\//.test(code) || /^[/\w.{}?=…[\]-]+$/.test(code)) {
            found.add(code);
        }
    }

    for (const match of markdown.matchAll(
        /\b(?:[a-z]+(?:[A-Z][a-z]+)+|[A-Z][a-z]+(?:[A-Z][a-z]+)+|[A-Z]+(?:_[A-Z]+)+)\b/g
    )) {
        found.add(match[0]);
    }

    // A name of a branch or a file ("col-1234-x-2.0") is no identifier a person reads out.
    return [...found].filter(
        (identifier) =>
            !/\d-|-\d/.test(identifier) && (sayableWords(identifier).length >= 2 || identifier.includes("/"))
    );
}

/** Words that join the parts of a spoken path and are not part of it. */
const PATH_JOINERS = new Set(["lomeno", "slash", "tecka", "dot", "rovna", "se", "otaznik"]);
/** Words that mark the next word as a path part, so one word is enough: "lomeno type". */
const PATH_CUES = new Set(["lomeno", "slash"]);

/**
 * Spoken paths and identifiers: a run of transcript words that says two or more words of a document identifier in
 * order ("employee only" for `employeesOnly`), or one path segment after "lomeno" or "slash" (`/{type}`). The
 * identifier with the most words said wins, then the shortest. An identifier is marked at its first mention and again
 * after `repeatAfterSec` (120) without one.
 */
export function findSpokenIdentifiers(options: {
    entries: TranscriptEntry[];
    identifiers: string[];
    repeatAfterSec?: number;
}): SpokenIdentifier[] {
    const repeatAfterSec = options.repeatAfterSec ?? 120;
    const known = options.identifiers.map((identifier) => ({ identifier, words: sayableWords(identifier) }));
    const segments = new Map<string, string>();

    for (const identifier of options.identifiers) {
        for (const segment of identifier.split(/[/?&]/)) {
            const said = sayableWords(segment);

            if (said.length === 1 && segment.trim()) {
                segments.set(said[0]!.norm, `/${segment.replace(/=.*/, "").trim()}`);
            }
        }
    }

    const found: SpokenIdentifier[] = [];
    const lastMarked = new Map<string, number>();

    for (const [entry, { text, startSec }] of options.entries.entries()) {
        const spoken = words(text);
        let at = 0;

        // A comma or a sentence end between two words ends a run: "sections, products" is a list, not a path.
        const joined = (from: number, to: number): boolean =>
            !/[,;:!?]|\.\s/.test(text.slice(spoken[from]!.end, spoken[to]!.start));

        while (at < spoken.length) {
            const slashBefore = text[spoken[at]!.start - 1] === "/";
            const cue = slashBefore || (at > 0 && PATH_CUES.has(spoken[at - 1]!.norm));
            let best: { identifier: string; matched: number; total: number; endWord: number } | undefined;

            for (const { identifier, words: parts } of known) {
                for (let first = 0; first < parts.length; first += 1) {
                    let part = first;
                    let word = at;
                    let lastSaid = -1;

                    while (part < parts.length && word < spoken.length && (word === at || joined(word - 1, word))) {
                        if (sameIdentifierWord(spoken[word]!.norm, parts[part]!.norm)) {
                            lastSaid = word;
                            part += 1;
                            word += 1;
                        } else if (word > at && PATH_JOINERS.has(spoken[word]!.norm)) {
                            word += 1;
                        } else {
                            break;
                        }
                    }

                    const matched = part - first;

                    if (matched < 2) {
                        continue;
                    }

                    if (!best || matched > best.matched || (matched === best.matched && parts.length < best.total)) {
                        best = { identifier, matched, total: parts.length, endWord: lastSaid };
                    }
                }
            }

            const segment = cue ? segments.get(spoken[at]!.norm) : undefined;

            if (!best && segment) {
                best = { identifier: segment, matched: 1, total: 1, endWord: at };
            }

            if (!best) {
                at += 1;
                continue;
            }

            const seenAt = lastMarked.get(best.identifier);
            const now = startSec ?? 0;

            if (seenAt === undefined || now - seenAt >= repeatAfterSec) {
                const start = spoken[cue && best.matched === 1 && !slashBefore ? at - 1 : at]!.start;
                const end = spoken[best.endWord]!.end;
                found.push({
                    entry,
                    heard: text.slice(start, end),
                    start,
                    end,
                    identifier: best.identifier,
                    matched: best.matched,
                    score: Math.round((best.matched / best.total) * 100) / 100,
                });
                lastMarked.set(best.identifier, now);
            }

            at = best.endWord + 1;
        }
    }

    return found;
}
