/**
 * Document assembly: section joining, provenance headers and a table of contents.
 */

import { localTimestamp } from "./value";

/**
 * Joins sections with one blank line, dropping the empty ones.
 *
 * Dropping empties is not cosmetic. A conditional section that returns `""` otherwise leaves
 * three blank lines, and where two `--` fragments meet the result renders as an accidental
 * horizontal rule.
 */
export function joinSections(sections: ReadonlyArray<string | null | undefined>, lineEnding = "\n"): string {
    return sections
        .filter((section): section is string => Boolean(section && section.trim()))
        .map((section) => section.replace(/\r\n|\r|\n/g, lineEnding))
        .join(`${lineEnding}${lineEnding}`);
}

export interface ProvenanceInput {
    /** Local timestamp to the minute. Defaults to now. */
    generated?: string | Date;
    /** Commit SHA the data was read at. */
    commit?: string;
    /** One sentence naming what the document covers. */
    scope?: string;
    /** The exact command that regenerates this document. */
    reload?: string;
    /** Extra rows, rendered in insertion order after the known ones. */
    extra?: Record<string, string>;
}

/**
 * A provenance header: when, from what, covering what, and how to regenerate.
 *
 * Every line ends with two spaces, because that is the only reliable single line break inside
 * a markdown paragraph. Without them the whole header collapses onto one line.
 */
export function renderProvenance(input: ProvenanceInput): string {
    const generated =
        input.generated instanceof Date ? localTimestamp(input.generated) : (input.generated ?? localTimestamp());
    const rows: Array<[string, string]> = [["Generated", generated]];

    if (input.commit) {
        rows.push(["Commit", `\`${input.commit}\``]);
    }

    if (input.scope) {
        rows.push(["Scope", input.scope]);
    }

    if (input.reload) {
        rows.push(["Reload", `\`${input.reload}\``]);
    }

    for (const [key, value] of Object.entries(input.extra ?? {})) {
        rows.push([key, value]);
    }

    return rows.map(([key, value], index) => `**${key}:** ${value}${index === rows.length - 1 ? "" : "  "}`).join("\n");
}

/** GitHub's anchor rule: lowercase, drop punctuation, spaces become hyphens. */
export function slugifyHeading(text: string): string {
    return text
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, "")
        .replace(/\s+/g, "-");
}

export interface TocOptions {
    /** Lowest heading level to include. Default 2, so the document title is skipped. */
    minLevel?: number;
    /** Highest heading level to include. Default 3. */
    maxLevel?: number;
    /** Spaces per nesting level. Default 2. */
    indent?: number;
    bullet?: "-" | "*" | "+";
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*$/;
const FENCE_RE = /^\s*(```|~~~)/;

/**
 * Builds a table of contents from rendered markdown.
 *
 * Fenced blocks are skipped, because a `# comment` inside a shell example is not a heading
 * and linking to it produces a dead anchor.
 */
export function renderToc(markdown: string, options: TocOptions = {}): string {
    const { minLevel = 2, maxLevel = 3, indent = 2, bullet = "-" } = options;
    const seen = new Map<string, number>();
    const lines: string[] = [];
    let inFence = false;

    for (const line of markdown.split(/\r\n|\r|\n/)) {
        if (FENCE_RE.test(line)) {
            inFence = !inFence;
            continue;
        }

        if (inFence) {
            continue;
        }

        const match = line.match(HEADING_RE);

        if (!match) {
            continue;
        }

        const level = match[1]!.length;

        if (level < minLevel || level > maxLevel) {
            continue;
        }

        const text = match[2]!;
        const base = slugifyHeading(text);
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        const anchor = count === 0 ? base : `${base}-${count}`;

        lines.push(`${" ".repeat((level - minLevel) * indent)}${bullet} [${text}](#${anchor})`);
    }

    return lines.join("\n");
}
