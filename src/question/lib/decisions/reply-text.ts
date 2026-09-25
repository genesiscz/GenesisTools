/**
 * The text around a `❓ DECISION N` block: what is a footer, what is a recommendation, what is a
 * file reference. Pure string helpers shared by the block parser (read.ts) and the inbox.
 */

/** Lines a harness or a plugin appends that say nothing about the decision. */
const FOOTER_LINE = [
    /^\s*🌱\s*graft\b/u,
    /^\s*graft saved \d+ tokens/i,
    /^\s*STE100 is on\.?\s*$/i,
    /^\s*#{1,6}\s*❓\s*DECISIONS?\s*$/u,
];

export function isFooterLine(line: string): boolean {
    return FOOTER_LINE.some((pattern) => pattern.test(line));
}

const HEADING = /^\s{0,3}#{1,6}\s/;

export function isHeadingLine(line: string): boolean {
    return HEADING.test(line);
}

/** Lines under an option list that still talk about the decision: a recommendation, the why, a trade-off. */
const NOTE_LEAD =
    /^\s*(?:[-*]\s*)?[*_]*(?:recommend|i recommend|my recommendation|rationale|reason|why|note|trade[- ]?off|pros?\b|cons?\b|caveat|risk)/i;

export function isNoteLine(line: string): boolean {
    return NOTE_LEAD.test(line);
}

/** Text that trims the edges, drops footers and squeezes runs of blank lines; empty when nothing is left. */
export function cleanBlock(lines: readonly string[]): string {
    const kept: string[] = [];

    for (const line of lines) {
        if (isFooterLine(line)) {
            continue;
        }

        if (line.trim().length === 0 && kept.at(-1)?.trim().length === 0) {
            continue;
        }

        kept.push(line);
    }

    return kept.join("\n").trim();
}

/** The last `max` characters of a long context, marked; the whole text when it fits. */
export function boundContext(text: string, max: number): string {
    if (text.length <= max) {
        return text;
    }

    const cut = text.slice(text.length - max);
    const firstBreak = cut.indexOf("\n");
    return `…${firstBreak >= 0 && firstBreak < 200 ? cut.slice(firstBreak) : cut}`;
}

const IN_LABEL =
    /\s*\(\s*(?:this is\s+)?(?:my\s+)?(?:recommend(?:ed|ation)|i\s+recommend(?:\s+this)?)(?:\s*[,:;.-]\s*|\s+)?([^)]*)\)\s*/i;
const TRAILING_TAG = /\s*[*_]*\(?\b(?:recommended|my recommendation)\b\)?[*_]*\s*[.]?\s*$/i;
const LEADING_TAG = /^\s*[*_]*(?:recommended)[*_]*\s*[:\-–—]\s*/i;

export interface RecommendationMark {
    label: string;
    recommended: boolean;
    /** The words inside the marker after "recommendation": "because it costs nothing". */
    rationale: string | null;
}

/**
 * Finds "(recommended)", "(My recommendation, because …)", "Recommended: …" in an option label,
 * removes the marker and keeps its reason. A label without a marker comes back unchanged.
 */
export function stripRecommendation(label: string): RecommendationMark {
    const inner = IN_LABEL.exec(label);

    if (inner) {
        const reason = inner[1]?.replace(/^(?:because|since|as)\s+/i, "because ").trim() ?? "";
        const rest = `${label.slice(0, inner.index)} ${label.slice(inner.index + inner[0].length)}`
            .replace(/\s+/g, " ")
            .trim();
        return { label: rest, recommended: true, rationale: reason.length > 0 ? reason.replace(/[.]+$/, "") : null };
    }

    const trailing = TRAILING_TAG.exec(label);

    if (trailing && trailing.index > 0) {
        return { label: label.slice(0, trailing.index).trim(), recommended: true, rationale: null };
    }

    const leading = LEADING_TAG.exec(label);

    if (leading) {
        return { label: label.slice(leading[0].length).trim(), recommended: true, rationale: null };
    }

    return { label, recommended: false, rationale: null };
}

const NOTE_LETTER = /\brecommend(?:ed|ation|s)?\b[^a-z\n]{0,20}?\(?\b([a-z])\)/i;
const NOTE_LETTER_TAIL = /\b(?:option|pick|choose|go with|take)\s+\(?([a-z])\)/i;

/** The option letter a sentence like "I recommend b)" or "Recommended: c)" names; null when none. */
export function recommendedLetterIn(text: string): string | null {
    const match = NOTE_LETTER.exec(text) ?? (/recommend/i.test(text) ? NOTE_LETTER_TAIL.exec(text) : null);
    return match?.[1]?.toLowerCase() ?? null;
}

export interface TextRef {
    path: string;
    line: number;
    endLine: number | null;
}

// A path is a dotfile, a bare file name with an extension, or a slash path; a line number follows
// a colon, and a range follows a dash. `bunfig.toml:3`, `.gitignore:6`, `src/a/b.ts:21-40`,
// `/Users/x/app/main.swift:10`. A URL's `host:port` has no extension, so it does not match.
const REF =
    /(?<![\w./-])((?:~|\.{1,2})?(?:\/[\w.@+-]+)+\/?|(?:[\w@+-]+\/)+[\w.@+-]+|[\w@+-]+\.[A-Za-z][\w]{0,7}|\.[\w-]+):(\d{1,6})(?:-(\d{1,6}))?(?![\w.:-]*\d)/g;

/** Every `file:line` and `file:start-end` in a text, first seen first, each once. */
export function findRefs(text: string): TextRef[] {
    const seen = new Set<string>();
    const refs: TextRef[] = [];

    for (const match of text.matchAll(REF)) {
        const path = match[1] ?? "";
        const line = Number(match[2]);
        const endLine = match[3] ? Number(match[3]) : null;

        // A time such as 22:31 or a ratio has no extension and is not a path.
        if (!/[./]/.test(path) || !Number.isFinite(line) || line < 1) {
            continue;
        }

        const key = `${path}:${line}${endLine ? `-${endLine}` : ""}`;

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        refs.push({ path, line, endLine: endLine !== null && endLine >= line ? endLine : null });
    }

    return refs;
}
