import { SafeJSON } from "@genesiscz/utils/json";
import type { PageMeta } from "./extract";

interface MarkdownLine {
    text: string;
    /** A fence line or a line inside a fenced code block. */
    code: boolean;
}

/**
 * Split markdown into lines, marking fenced code. Every rewrite below runs only on prose lines, so a
 * `# comment` or `- item` inside a code block is never treated as a heading or a list.
 */
function classifyLines(markdown: string): { lines: MarkdownLine[]; unclosedFence: boolean } {
    const lines: MarkdownLine[] = [];
    let fence: string | null = null;

    for (const text of markdown.split("\n")) {
        const marker = text.match(/^\s*(`{3,}|~{3,})/)?.[1];

        if (fence === null) {
            if (marker) {
                fence = marker;
            }

            lines.push({ text, code: marker !== undefined });
            continue;
        }

        lines.push({ text, code: true });

        if (marker && marker[0] === fence[0] && marker.length >= fence.length && text.trim() === marker) {
            fence = null;
        }
    }

    return { lines, unclosedFence: fence !== null };
}

/** Trim trailing spaces, keep at most one blank line between prose blocks, and end with one newline. */
export function normalizeMarkdown(markdown: string): string {
    const result: string[] = [];
    let previousBlank = false;

    for (const line of classifyLines(markdown).lines) {
        const text = line.text.trimEnd();
        const blank = !line.code && text === "";

        if (blank && previousBlank) {
            continue;
        }

        result.push(text);
        previousBlank = blank;
    }

    return `${result.join("\n").replace(/^\n+/, "").trimEnd()}\n`;
}

/** Trim trailing spaces everywhere and collapse runs of blank lines inside code blocks. */
export function compactCodeBlocks(markdown: string): string {
    const result: string[] = [];
    let previousBlankCode = false;

    for (const line of classifyLines(markdown).lines) {
        const text = line.text.trimEnd();
        const blankCode = line.code && text === "";

        if (blankCode && previousBlankCode) {
            continue;
        }

        result.push(text);
        previousBlankCode = blankCode;
    }

    return result.join("\n");
}

/** Raw HTML: runs of spaces and tabs become one space, and at most one blank line remains. */
export function compactWhitespace(text: string): string {
    return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
}

/** YAML front matter with the page's title, URL, author and date. Values are quoted, so a `:` stays text. */
export function frontMatter(meta: PageMeta): string {
    const fields: Array<[string, string | undefined]> = [
        ["title", meta.title],
        ["url", meta.url],
        ["author", meta.author],
        ["date", meta.publishedTime],
    ];
    const lines = fields
        .filter((field): field is [string, string] => field[1] !== undefined)
        .map(([key, value]) => `${key}: ${SafeJSON.stringify(value)}`);

    return `---\n${lines.join("\n")}\n---\n\n`;
}

/** Conversion leftovers worth reporting. HTML inside code blocks and inline code is content, not a leftover. */
export function validateMarkdown(markdown: string): string[] {
    const { lines, unclosedFence } = classifyLines(markdown);
    const prose = lines
        .filter((line) => !line.code)
        .map((line) => line.text.replace(/`+[^`]*`+/g, ""))
        .join("\n");
    const issues: string[] = [];

    const htmlTags = prose.match(/<(?!br\b)[a-z][^>]*>/gi)?.length ?? 0;
    if (htmlTags > 0) {
        issues.push(`${htmlTags} HTML tags remaining in output`);
    }

    const emptyLinks = prose.match(/(?<!!)\[\s*\]\(\s*\)/g)?.length ?? 0;
    if (emptyLinks > 0) {
        issues.push(`${emptyLinks} empty links found`);
    }

    const brokenImages = prose.match(/!\[[^\]]*\]\(\s*\)/g)?.length ?? 0;
    if (brokenImages > 0) {
        issues.push(`${brokenImages} images with empty src`);
    }

    if (unclosedFence) {
        issues.push("Unclosed code block detected");
    }

    return issues;
}
