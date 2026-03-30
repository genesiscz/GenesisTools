import { isAbsolute, relative } from "node:path";
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
    baseDirs?: Map<string, string>;
    multiIndex?: boolean;
}

export function toDisplayPath(filePath: string, indexName: string, baseDirs?: Map<string, string>): string {
    const baseDir = baseDirs?.get(indexName);

    if (baseDir) {
        const rel = relative(baseDir, filePath);

        if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
            return rel;
        }
    }

    return filePath;
}

function truncateLeft(path: string, maxLen: number): string {
    if (path.length <= maxLen) {
        return path;
    }

    return `...${path.slice(-(maxLen - 3))}`;
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

export function renderCodeBlock(content: string, language: string | null, startLine: number, endLine: number): string {
    const lines = content.split("\n");
    const gutterWidth = String(endLine).length;
    const langLabel = language ? ` ${language}` : "";
    const lineRange = `L${startLine}\u2013${endLine}`;

    const parts: string[] = [];
    parts.push(pc.dim(`\u256D\u2500${langLabel} ${lineRange}`));

    for (let i = 0; i < lines.length; i++) {
        const lineNo = String(startLine + i).padStart(gutterWidth);
        parts.push(`${pc.dim(`${lineNo} \u2502`)} ${lines[i]}`);
    }

    parts.push(pc.dim(`\u2570${"\u2500".repeat(40)}`));
    return parts.join("\n");
}

function formatPretty(opts: FormatOptions): string {
    const lines: string[] = [formatHeader(opts.results.length, opts.query, opts.mode), ""];

    type GroupKey = string;
    const groups = new Map<GroupKey, { filePath: string; indexName: string; results: FormattedSearchResult[] }>();

    for (const r of opts.results) {
        const key = `${r.indexName}::${r.filePath}`;
        const existing = groups.get(key);

        if (existing) {
            existing.results.push(r);
        } else {
            groups.set(key, { filePath: r.filePath, indexName: r.indexName, results: [r] });
        }
    }

    let groupIndex = 0;

    for (const [, group] of groups) {
        if (groupIndex > 0) {
            lines.push("");
        }

        if (opts.multiIndex) {
            lines.push(pc.dim(`[${group.indexName}]`));
        }

        const displayPath = toDisplayPath(group.filePath, group.indexName, opts.baseDirs);
        lines.push(pc.cyan(displayPath));
        lines.push("");

        for (const r of group.results) {
            const header = [pc.bold(r.displayName), colorConfidence(r.confidence), pc.dim(r.method)].join("  ");
            lines.push(header);

            const highlighted = highlightContent(r.content, opts.highlightWords);
            const codeBlock = renderCodeBlock(highlighted, r.language, r.startLine, r.endLine);
            lines.push(codeBlock);
            lines.push("");
        }

        groupIndex++;
    }

    return lines.join("\n").trimEnd();
}

function formatSimple(opts: FormatOptions): string {
    const parts: string[] = [];

    for (const r of opts.results) {
        const displayPath = toDisplayPath(r.filePath, r.indexName, opts.baseDirs);
        const indexLabel = opts.multiIndex ? ` ${pc.dim(`[${r.indexName}]`)}` : "";
        const header = `${pc.cyan(pc.bold(displayPath))} ${r.displayName} ${colorConfidence(r.confidence)} ${pc.dim(r.method)}${indexLabel}`;
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

    if (opts.multiIndex) {
        const rows = opts.results.map((r) => {
            const displayPath = toDisplayPath(r.filePath, r.indexName, opts.baseDirs);
            return [r.indexName, truncateLeft(displayPath, 60), r.displayName, `${r.confidence}%`, r.method];
        });

        const table = formatTable(rows, ["Index", "File", "Symbol", "Confidence", "Method"], {
            alignRight: [3],
        });

        return `${header}\n\n${table}`;
    }

    const rows = opts.results.map((r) => {
        const displayPath = toDisplayPath(r.filePath, r.indexName, opts.baseDirs);
        return [truncateLeft(displayPath, 60), r.displayName, `${r.confidence}%`, r.method];
    });

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
