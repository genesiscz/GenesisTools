/**
 * Markdown written as headings with `- Key: value` lists, read back into data: the reverse of
 * `json2md` for documents an agent or a person fills in by hand.
 *
 *   # T03 The lock stays off · discussion 0539a97
 *   - Verdict: Valid [95%]
 *   - Rationale:
 *     - The guard returns early
 *   - Proposed draft reply:
 *
 *   ```markdown
 *   Fixed.
 *   ```
 *
 * becomes one section with three fields; `Rationale` carries its sub-bullets, `Proposed draft reply` the
 * fenced block that follows it. Hand edits are tolerated where the meaning stays clear, and reported as
 * warnings: Windows line ends, a byte-order mark, `*` or `+` bullets, `**Key:**` in bold, a heading of
 * any level, a value continued on the next indented line, a text left as plain paragraphs instead of a
 * fence, a fence longer than three backticks or written with tildes. An unclosed fence is a warning too:
 * its body runs to the end of the document, so a reader decides whether that can be trusted.
 */

export interface MdFence {
    /** The info string after the opening fence (`markdown`, `ts`), or "". */
    info: string;
    /** The lines between the fences, as written. */
    body: string;
    /** 1-based line of the opening fence. */
    line: number;
    closed: boolean;
}

export interface MdField {
    /** The key as written, without bullet, bold or colon. */
    key: string;
    value: string;
    /** 1-based line of the field. */
    line: number;
    /** Indented bullets under the field. */
    bullets: string[];
    /** The fenced block that follows the field before the next field, if any. */
    fence: MdFence | null;
    /** Plain lines that follow the field before the next field (text not put in a fence). */
    paragraphs: string[];
}

export interface MdSection {
    level: number;
    title: string;
    /** 1-based line of the heading; 0 for the text before the first heading. */
    line: number;
    fields: MdField[];
    /** Every line of the section that is not a field, a bullet of one, or its fence, trimmed at both ends. */
    text: string;
    /** Every line under the heading as written, fields included, trimmed at both ends (a free-form section). */
    body: string;
}

export interface MdWarning {
    line: number;
    message: string;
}

export interface MdDocument {
    /** Text before the first heading, as a section with level 0. */
    preamble: MdSection;
    sections: MdSection[];
    warnings: MdWarning[];
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^`]*?)[ \t]*$/;
const FIELD = /^ {0,1}[-*+][ \t]+(?:\*\*|__)?([^:*_\n][^:\n]*?)(?:\*\*|__)?[ \t]*:(?:\*\*|__)?[ \t]*(.*?)[ \t]*$/;
const BULLET = /^(?: {2,}|\t+)[-*+][ \t]+(.*?)[ \t]*$/;
const CONTINUATION = /^(?: {2,}|\t+)(\S.*?)[ \t]*$/;

function newSection(level: number, title: string, line: number): MdSection {
    return { level, title, line, fields: [], text: "", body: "" };
}

export function md2json(markdown: string): MdDocument {
    const lines = markdown.replace(/^﻿/, "").split(/\r\n|\r|\n/);
    const warnings: MdWarning[] = [];
    const preamble = newSection(0, "", 0);
    const sections: MdSection[] = [];
    let section = preamble;
    let field: MdField | null = null;
    let text: string[] = [];
    let body: string[] = [];

    const closeSection = (): void => {
        section.text = text.join("\n").trim();
        section.body = body.join("\n").trim();
        text = [];
        body = [];
        field = null;
    };

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const fence = FENCE.exec(raw);

        if (fence) {
            const [, indent, marker, info] = fence;
            const fenced: string[] = [];
            let j = i + 1;
            let closed = false;

            for (; j < lines.length; j++) {
                const candidate = lines[j].slice(
                    Math.min(indent.length, lines[j].length - lines[j].trimStart().length)
                );
                const trimmed = candidate.trimEnd();

                if (trimmed.startsWith(marker[0].repeat(marker.length)) && /^[`~]+$/.test(trimmed)) {
                    closed = true;
                    break;
                }

                fenced.push(lines[j]);
            }

            if (!closed) {
                warnings.push({
                    line: i + 1,
                    message: `the fence opened here is never closed; its text runs to the end`,
                });
            }

            // A missing closing fence pairs this opener with a later block's closer and swallows what lies between.
            const swallowed = fenced.findIndex((line) => HEADING.test(line));

            if (closed && swallowed !== -1) {
                warnings.push({
                    line: i + 1,
                    message: `the fence opened here holds the heading "${fenced[swallowed].trim()}" (line ${i + 2 + swallowed}); its closing fence is probably missing`,
                });
            }

            const block: MdFence = { info, body: fenced.join("\n"), line: i + 1, closed };
            body.push(...lines.slice(i, closed ? j + 1 : j));

            if (field && !field.fence) {
                field.fence = block;
            } else {
                text.push(...lines.slice(i, closed ? j + 1 : j));
            }

            i = j;
            continue;
        }

        const heading = HEADING.exec(raw);

        if (heading) {
            closeSection();
            section = newSection(heading[1].length, heading[2], i + 1);
            sections.push(section);
            continue;
        }

        body.push(raw);

        if (/^\s*<!--.*-->\s*$/.test(raw)) {
            continue;
        }

        const fieldMatch = FIELD.exec(raw);

        if (fieldMatch) {
            field = {
                key: fieldMatch[1].trim(),
                value: fieldMatch[2],
                line: i + 1,
                bullets: [],
                fence: null,
                paragraphs: [],
            };
            section.fields.push(field);
            continue;
        }

        const current = field as MdField | null;
        const bullet = BULLET.exec(raw);

        if (bullet && current) {
            current.bullets.push(bullet[1]);
            continue;
        }

        const continuation = CONTINUATION.exec(raw);

        if (
            continuation &&
            current &&
            current.bullets.length === 0 &&
            !current.fence &&
            current.paragraphs.length === 0
        ) {
            current.value = current.value ? `${current.value} ${continuation[1]}` : continuation[1];
            continue;
        }

        // Only a field waiting for a block (`- Proposed reply:` with nothing after the colon) takes plain lines.
        if (current && current.value === "" && !current.fence && raw.trim() && !/^\s*[-*+]\s/.test(raw)) {
            current.paragraphs.push(raw.trimEnd());
            continue;
        }

        if (current && !raw.trim() && current.paragraphs.length > 0) {
            current.paragraphs.push("");
            continue;
        }

        if (raw.trim()) {
            field = null;
        }

        text.push(raw);
    }

    closeSection();

    for (const s of [preamble, ...sections]) {
        for (const f of s.fields) {
            while (f.paragraphs.length > 0 && f.paragraphs[f.paragraphs.length - 1] === "") {
                f.paragraphs.pop();
            }
        }
    }

    return { preamble, sections, warnings };
}

/** The common leading indentation of the non-empty lines, removed (a block copied from an indented view). */
export function dedent(text: string): string {
    const lines = text.split("\n");
    const indents = lines.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length);
    const common = indents.length > 0 ? Math.min(...indents) : 0;

    return common > 0
        ? lines.map((line) => line.slice(Math.min(common, line.length - line.trimStart().length))).join("\n")
        : text;
}
