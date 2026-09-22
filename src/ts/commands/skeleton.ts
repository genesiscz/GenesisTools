import { dirname, relative } from "node:path";
import { countTokens } from "@anthropic-ai/tokenizer";
import { ui } from "@genesiscz/utils/cli/ui";
import { findProjectRoot } from "@genesiscz/utils/fs/project-root";
import type { Block } from "@genesiscz/utils/json2md";
import { logger } from "@genesiscz/utils/logger";
import { stripAnsi } from "@genesiscz/utils/string";
import type { Command } from "commander";
import pc from "picocolors";
import { emit, isMachineFormat, resolveFormat } from "../lib/format";
import { loadFiles } from "../lib/load";
import { exportedOnly, type SkeletonSymbol } from "../lib/skeleton";
import { collectTypeNames, type ExpandedType, expandTypes } from "../lib/type-expand";
import { addFormatOptions, addScanOptions, type FormatCliFlags, type ScanCliFlags } from "./options";

interface SkeletonOptions extends FormatCliFlags, ScanCliFlags {
    exported?: boolean;
    topLevel?: boolean;
    types?: boolean;
    exactTokens?: boolean;
    includeNames?: boolean;
    includeHash?: boolean;
    includeLocals?: boolean;
    functionContext?: string;
}

/**
 * Measured 2026-09-19 with `@anthropic-ai/tokenizer`, Anthropic's own vocabulary:
 * 30,000 chars of this repo's TypeScript came to 7,959 tokens, so 3.77. Two other
 * readings agree it belongs near there: a whole Claude session gave 4.28 chars per
 * input token (3.17M transcript chars against 741,803 newly cached tokens), and
 * this file's own skeleton output measures 3.45.
 *
 * An earlier version of this constant read 2.54, taken from the GPT-3 encoder in
 * `@genesiscz/utils/tokens`. That encoder counts roughly 40% more tokens than
 * Anthropic's for the same source, so it overstated the cost badly.
 *
 * The tokenizer package carries the Claude 1 and 2 vocabulary rather than Opus 5's,
 * so this is the right family, not an exact figure. `tools ai tokens --method api`
 * is the only exact route. `--exact-tokens` swaps this estimate for the tokenizer.
 */
const CHARS_PER_TOKEN = 3.77;

export function tokensOf(text: string, useEncoder: boolean): number {
    return useEncoder ? countTokens(text) : Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Exact counts, not compacted: the point of the stat is the real total. */
function exact(value: number): string {
    return value.toLocaleString("en-US");
}

/** Openers that already tell a reader what the symbol is, so the kind tag would repeat them. */
const DECLARATION_KEYWORDS = new Set([
    "async",
    "class",
    "const",
    "enum",
    "function",
    "interface",
    "let",
    "module",
    "namespace",
    "type",
    "var",
]);

export function renderSymbol(symbol: SkeletonSymbol, withName = false): string {
    const range = `L${symbol.startLine}-L${symbol.endLine}`;
    const indent = "    ".repeat(symbol.depth);
    // Print the kind only when the signature does not already say it. A class member or an
    // object field carries no keyword and needs the tag; a declaration keyword already says
    // what it is, so tagging it produced "const export const x".
    //
    // 🛑 Matching the kind against the keyword alone was not enough: an arrow-function const
    // is kinded `function` while its keyword is `const`, which rendered as
    // "function export const fn = (x: number)". ANY declaration keyword is self-describing.
    // Every leading modifier is stripped, not just one: `export async function load()` left
    // `async` as the opener, which is not a declaration keyword, so the kind was printed
    // anyway and rendered as "function export async function load()".
    const opener =
        symbol.signature
            .replace(
                /^(?:(?:export|declare|default|async|abstract|static|public|private|protected|override|readonly)\s+)+/,
                ""
            )
            .split(/[\s(]/)[0] ?? "";
    const evident = symbol.kind === opener || DECLARATION_KEYWORDS.has(opener);
    const kind = evident ? "" : `${pc.cyan(symbol.kind)} `;
    const tag = withName ? `${pc.yellow(symbol.name)}${symbol.local ? pc.dim(" ·local") : ""} ` : "";
    const hash = symbol.hash ? pc.dim(` #${symbol.hash}`) : "";

    return `${indent}- ${pc.dim(range.padEnd(12))} ${tag}${kind}${pc.white(symbol.signature)}${hash}`;
}

interface SkeletonResult {
    file: string;
    symbols: SkeletonSymbol[];
    types: ExpandedType[];
    totalLines: number;
    coveredLines: number;
}

function coverageOf(result: Pick<SkeletonResult, "symbols" | "totalLines" | "coveredLines">) {
    return {
        decls: result.symbols.length,
        totalLines: result.totalLines,
        coveredPct: result.totalLines > 0 ? Math.round((100 * result.coveredLines) / result.totalLines) : 100,
    };
}

async function runSkeleton(paths: string[], options: SkeletonOptions): Promise<void> {
    const format = resolveFormat(options);
    const context = options.functionContext === undefined ? 0 : Number.parseInt(options.functionContext, 10);

    if (Number.isNaN(context) || context < 0) {
        throw new Error(`--function-context wants a whole number of lines, got ${options.functionContext}`);
    }

    const loaded = await loadFiles(paths, {
        tests: options.tests === true,
        ignore: options.ignore,
        locals: options.includeLocals === true,
        hash: options.includeHash === true,
        functionContext: context,
        keepSource: options.types === true,
    });

    for (const input of loaded.empty) {
        logger.error({ input }, "No TypeScript source found");
        process.exitCode = 1;
    }

    const useEncoder = options.exactTokens === true;
    const results: SkeletonResult[] = [];
    let originalTokens = 0;

    for (const entry of loaded.entries) {
        originalTokens += tokensOf(entry.text, useEncoder);

        let symbols = entry.symbols;

        if (options.exported) {
            symbols = exportedOnly(symbols);
        }

        if (options.topLevel) {
            symbols = symbols.filter((symbol) => symbol.depth === 0);
        }

        const root = findProjectRoot(dirname(entry.absolute)) ?? dirname(entry.absolute);
        const source = entry.source;
        const types =
            options.types && source ? expandTypes(source, entry.absolute, collectTypeNames(source), root) : [];

        // A skeleton omits silently, so report how much of the file it actually covers.
        // A commander entrypoint used to print 7 declarations for 527 lines with no hint.
        const seen = new Set<number>();

        for (const symbol of symbols) {
            for (let line = symbol.startLine; line <= symbol.endLine; line += 1) {
                seen.add(line);
            }
        }

        results.push({
            file: entry.file,
            symbols,
            types,
            totalLines: entry.text.split("\n").length,
            coveredLines: seen.size,
        });
    }

    // The columns the machine formats carry. Every `--include-*` flag adds one, so a consumer
    // reads `cols` rather than guessing. `name` and `kind` are off by default because they
    // cost a quarter of the payload on a 20,000 symbol tree and the signature carries the name
    // in readable form already.
    const withNames = options.includeNames === true;
    const cols = [
        "startLine",
        "endLine",
        "depth",
        "exported",
        ...(withNames ? ["name", "kind"] : []),
        ...(options.includeLocals === true ? ["local"] : []),
        ...(options.includeHash === true ? ["hash"] : []),
        "signature",
        ...(context > 0 ? ["body"] : []),
    ];

    const rowOf = (symbol: SkeletonSymbol): unknown[] => [
        symbol.startLine,
        symbol.endLine,
        symbol.depth,
        symbol.exported,
        ...(withNames ? [symbol.name, symbol.kind] : []),
        ...(options.includeLocals === true ? [symbol.local === true] : []),
        ...(options.includeHash === true ? [symbol.hash ?? ""] : []),
        symbol.signature,
        ...(context > 0 ? [symbol.body ?? []] : []),
    ];

    const objectOf = (symbol: SkeletonSymbol): Record<string, unknown> => {
        const row: Record<string, unknown> = {
            startLine: symbol.startLine,
            endLine: symbol.endLine,
            depth: symbol.depth,
            exported: symbol.exported,
        };

        if (withNames) {
            row.name = symbol.name;
            row.kind = symbol.kind;
        }

        if (options.includeLocals === true) {
            row.local = symbol.local === true;
        }

        if (options.includeHash === true) {
            row.hash = symbol.hash ?? "";
        }

        row.signature = symbol.signature;

        if (context > 0 && symbol.body) {
            row.body = symbol.body;
            row.bodyTruncated = symbol.bodyTruncated === true;
        }

        return row;
    };

    const printed = emit(format, {
        text: () => {
            const lines: string[] = [];

            for (const result of results) {
                lines.push("");
                const coverage = coverageOf(result);
                const share = coverage.coveredPct;
                const cover = `${coverage.decls} decls · ${share}% of ${coverage.totalLines} lines`;

                lines.push(
                    `${pc.bold("skeleton")} ${pc.green(result.file)} ${share < 60 ? pc.yellow(`(${cover})`) : pc.dim(`(${cover})`)}`
                );

                if (result.symbols.length === 0) {
                    const filtered = options.exported || options.topLevel;
                    lines.push(pc.dim(filtered ? "  nothing left after the active filters" : "  nothing to show"));
                    continue;
                }

                for (const symbol of result.symbols) {
                    lines.push(renderSymbol(symbol, withNames));

                    for (const line of symbol.body ?? []) {
                        lines.push(pc.dim(`${"    ".repeat(symbol.depth + 1)}│ ${line.trim()}`));
                    }

                    if (symbol.bodyTruncated) {
                        lines.push(pc.dim(`${"    ".repeat(symbol.depth + 1)}│ …`));
                    }
                }

                if (result.types.length === 0) {
                    continue;
                }

                lines.push("");
                lines.push(pc.bold(`  referenced types (${result.types.length})`));

                for (const type of result.types) {
                    lines.push("");

                    if (type.external) {
                        lines.push(`  ${pc.cyan(type.name)} ${pc.dim(`— ${type.text}`)}`);
                        continue;
                    }

                    const where = `${relative(process.cwd(), type.file) || type.file}:${type.startLine}`;
                    const nested = type.depth > 1 ? pc.dim(" · reached through another type") : "";

                    lines.push(`  ${pc.cyan(type.name)} ${pc.dim(where)}${nested}`);

                    for (const line of type.text.split("\n")) {
                        lines.push(`    ${pc.white(line)}`);
                    }

                    if (type.truncated) {
                        // "truncated at line N" read as a cosmetic cut; it hid a whole field once.
                        lines.push(pc.yellow(`    … cut here, the rest of ${type.name} is not shown`));
                    }
                }
            }

            return lines;
        },
        md: () => {
            const blocks: Block[] = [{ h1: "Skeleton" }];

            for (const result of results) {
                const coverage = coverageOf(result);

                blocks.push({ h2: result.file });
                blocks.push(
                    `${coverage.decls} declarations · ${coverage.coveredPct}% of ${coverage.totalLines} lines covered`
                );

                if (coverage.coveredPct < 60) {
                    blocks.push({
                        callout: {
                            kind: "warning",
                            title: "Most of this file is not represented",
                            body: "The skeleton lists declarations. Long bodies and anything it cannot name are missing, so read the file before concluding it is small.",
                        },
                    });
                }

                if (result.symbols.length === 0) {
                    blocks.push("_nothing to show_");
                    continue;
                }

                blocks.push({
                    table: {
                        rows: result.symbols.map((symbol) => ({
                            Lines: `L${symbol.startLine}-L${symbol.endLine}`,
                            ...(withNames ? { Name: symbol.name, Kind: symbol.kind } : {}),
                            ...(options.includeHash === true ? { Hash: symbol.hash ?? "" } : {}),
                            Signature: symbol.signature,
                        })),
                    },
                });

                if (context > 0) {
                    for (const symbol of result.symbols) {
                        if (!symbol.body || symbol.body.length === 0) {
                            continue;
                        }

                        blocks.push({ h3: `${symbol.name} — L${symbol.startLine}` });
                        blocks.push({
                            code: {
                                language: "ts",
                                content: [...symbol.body, ...(symbol.bodyTruncated ? ["// …"] : [])].join("\n"),
                            },
                        });
                    }
                }
            }

            return blocks;
        },
        json: () => ({
            files: results.map((result) => ({
                file: result.file,
                ...coverageOf(result),
                symbols: result.symbols.map(objectOf),
                ...(result.types.length > 0 ? { types: result.types } : {}),
            })),
            stats: { files: results.length, originalChars: loaded.originalChars, originalTokens },
        }),
        compact: () => ({
            cols,
            files: results.map((result) => ({
                file: result.file,
                ...coverageOf(result),
                symbols: result.symbols.map(rowOf),
                // `--types` resolves declarations for every format. Omitting them from the
                // compact form made `--types --toon` return nothing the flag asked for.
                ...(result.types.length > 0 ? { types: result.types } : {}),
            })),
            stats: { files: results.length, originalChars: loaded.originalChars, originalTokens },
        }),
    });

    const measured = isMachineFormat(format) ? printed : stripAnsi(printed);
    const skeletonTokens = tokensOf(measured, useEncoder);
    const saved = originalTokens > 0 ? 1 - skeletonTokens / originalTokens : 0;

    logger.debug(
        {
            files: results.length,
            originalChars: loaded.originalChars,
            originalTokens,
            skeletonChars: measured.length,
            skeletonTokens,
            savedRatio: Number(saved.toFixed(4)),
            tokenSource: useEncoder ? "encoder" : "estimate",
            format,
        },
        "skeleton size"
    );
    // ui.raw, not out.log.info: clack draws a `│` connector line above its bullet,
    // which is the wrong texture for a single closing stat. The blank line is what
    // that connector was providing, so it is kept deliberately.
    ui.raw("");
    ui.raw(
        `${pc.cyan("●")} ${results.length} file(s) · original ${exact(originalTokens)} tokens · ` +
            `skeleton ${exact(skeletonTokens)} tokens · ${Math.abs(saved * 100).toFixed(1)}% ` +
            `${saved < 0 ? "larger" : "smaller"}`
    );
}

export function registerSkeletonCommands(program: Command): void {
    const command = program
        .command("skeleton")
        .description("Print a file's whole API: every declaration with its signature and line span")
        .argument("<paths...>", "Files or directories; a directory is walked recursively")
        .option("--exported", "Only exported top-level declarations")
        .option("--top-level", "Skip class and interface members")
        .option("--types", "Also print the declaration of every type named in the signatures")
        .option("--include-names", "Add the name and kind of every declaration as their own fields")
        .option("--include-hash", "Add a fingerprint of each declaration, with its own name blanked out")
        .option("--include-locals", "Also collect declarations inside function bodies")
        .option("--function-context <lines>", "Print the first N lines of each body under its signature")
        .option("--exact-tokens", "Count tokens with the BPE encoder instead of the chars-per-token estimate");

    addScanOptions(command);
    addFormatOptions(command);

    command.action(async (paths: string[], options: SkeletonOptions) => {
        await runSkeleton(paths, options);
    });
}
