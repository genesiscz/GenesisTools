import { formatTable } from "@app/utils/table";
import pc from "picocolors";
import { highlightQueryWords } from "./highlight";

export interface FormattedSearchResult {
    filePath: string;
    displayName: string;
    language: string | null;
    content: string;
    confidence: number;
    method: "bm25" | "cosine" | "rrf";
    indexName: string;
    startLine: number;
    endLine: number;
}

export type OutputFormat = "pretty" | "simple" | "table";

interface FormatOptions {
    results: FormattedSearchResult[];
    format: OutputFormat;
    query: string;
    mode: string;
    highlightWords?: string[];
}

function shortenPath(filePath: string, maxLen: number): string {
    if (filePath.length <= maxLen) {
        return filePath;
    }

    return `...${filePath.slice(-(maxLen - 3))}`;
}

function colorConfidence(confidence: number): string {
    const label = `${confidence}%`;

    if (confidence >= 70) {
        return pc.green(label);
    }

    if (confidence >= 40) {
        return pc.yellow(label);
    }

    return pc.red(label);
}

function formatHeader(count: number, query: string, mode: string): string {
    const noun = count === 1 ? "result" : "results";
    return `${pc.bold(`${count} ${noun}`)} for ${pc.cyan(`"${query}"`)} ${pc.dim(`(${mode})`)}`;
}

function highlightContent(content: string, words: string[] | undefined): string {
    if (!words || words.length === 0) {
        return content;
    }

    return highlightQueryWords(content, words);
}

function formatPretty(opts: FormatOptions): string {
    const lines: string[] = [formatHeader(opts.results.length, opts.query, opts.mode), ""];

    const groups = new Map<string, FormattedSearchResult[]>();

    for (const r of opts.results) {
        const existing = groups.get(r.filePath);

        if (existing) {
            existing.push(r);
        } else {
            groups.set(r.filePath, [r]);
        }
    }

    let groupIndex = 0;

    for (const [filePath, results] of groups) {
        if (groupIndex > 0) {
            lines.push("");
        }

        lines.push(pc.cyan(shortenPath(filePath, 60)));
        lines.push("");

        for (const r of results) {
            const header = [pc.bold(r.displayName), colorConfidence(r.confidence), pc.dim(r.method)].join("  ");
            lines.push(header);

            const langMarker = r.language ?? "";
            lines.push(`\`\`\`${langMarker}`);

            const highlighted = highlightContent(r.content, opts.highlightWords);
            lines.push(highlighted);

            lines.push("```");
            lines.push("");
        }

        groupIndex++;
    }

    return lines.join("\n").trimEnd();
}

function formatSimple(opts: FormatOptions): string {
    const parts: string[] = [];

    for (const r of opts.results) {
        const shortPath = shortenPath(r.filePath, 60);
        const header = `${pc.cyan(pc.bold(shortPath))} ${r.displayName} ${colorConfidence(r.confidence)} ${pc.dim(r.method)}`;
        parts.push(header);

        const highlighted = highlightContent(r.content, opts.highlightWords);
        const contentLines = highlighted.split("\n");
        const hasLineNums = r.startLine != null && !Number.isNaN(r.startLine);

        for (let i = 0; i < contentLines.length; i++) {
            if (hasLineNums) {
                const lineNum = r.startLine + i;
                parts.push(`${pc.dim(`${lineNum}|`)}${contentLines[i]}`);
            } else {
                parts.push(`${pc.dim("|")}${contentLines[i]}`);
            }
        }

        parts.push("");
    }

    return parts.join("\n").trimEnd();
}

function formatTableOutput(opts: FormatOptions): string {
    const header = formatHeader(opts.results.length, opts.query, opts.mode);

    const rows = opts.results.map((r) => [shortenPath(r.filePath, 40), r.displayName, `${r.confidence}%`, r.method]);

    const table = formatTable(rows, ["File", "Symbol", "Confidence", "Method"], {
        alignRight: [2],
    });

    return `${header}\n\n${table}`;
}

export function formatSearchResults(opts: FormatOptions): string {
    if (opts.results.length === 0) {
        return "No results found.";
    }

    switch (opts.format) {
        case "pretty":
            return formatPretty(opts);
        case "simple":
            return formatSimple(opts);
        case "table":
            return formatTableOutput(opts);
    }
}
