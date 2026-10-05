import { statSync } from "node:fs";
import { dirname, relative } from "node:path";
import { ui } from "@genesiscz/utils/cli/ui";
import { findProjectRoot } from "@genesiscz/utils/fs/project-root";
import type { Block } from "@genesiscz/utils/json2md";
import { logger } from "@genesiscz/utils/logger";
import { stripAnsi } from "@genesiscz/utils/string";
import { formatTable } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { emit, isMachineFormat, type Rendered, render, resolveFormat } from "../lib/format";
import { loadFiles } from "../lib/load";
import { fanInOf, packByBudget, rankFiles } from "../lib/rank";
import { exportedOnly, type SkeletonSymbol } from "../lib/skeleton";
import { collectTypeNames, type ExpandedType, expandTypes } from "../lib/type-expand";
import {
    addFormatOptions,
    addScanOptions,
    type FormatCliFlags,
    numberArg,
    runUsage,
    type ScanCliFlags,
} from "./options";

interface SkeletonOptions extends FormatCliFlags, ScanCliFlags {
    exported?: boolean;
    topLevel?: boolean;
    types?: boolean;
    exactTokens?: boolean;
    includeNames?: boolean;
    includeHash?: boolean;
    includeLocals?: boolean;
    functionContext?: number;
    rank?: boolean;
    maxTokens?: number;
    filesOnly?: boolean;
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

export function tokensOf(text: string, encoder: ((text: string) => number) | undefined): number {
    return encoder ? encoder(text) : Math.ceil(text.length / CHARS_PER_TOKEN);
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
    originalTokens: number;
    originalChars: number;
    /** 0..1 importance, only with `--rank`, `--max-tokens` or `--files-only`. */
    rank?: number;
    /** How many of the scanned files import this one. */
    importers?: number;
}

interface RankedResult extends SkeletonResult {
    size: number;
    fanIn: number;
    mtimeMs: number;
    tokens: number;
    rank: number;
}

function rankOf(result: SkeletonResult): { rank?: number; importers?: number } {
    return result.rank === undefined ? {} : { rank: Number(result.rank.toFixed(3)), importers: result.importers ?? 0 };
}

function rankLabel(result: SkeletonResult): string {
    return result.rank === undefined ? "" : ` · rank ${result.rank.toFixed(2)} · imported by ${result.importers ?? 0}`;
}

function mtimeOf(path: string): number {
    try {
        return statSync(path).mtimeMs;
    } catch (err) {
        logger.debug({ err, path }, "skeleton: could not stat a file for ranking, treating it as old");
        return 0;
    }
}

function emitFilesOnly(format: ReturnType<typeof resolveFormat>, results: SkeletonResult[]): string {
    const rows = results.map((result) => ({
        file: result.file,
        ...rankOf(result),
        decls: result.symbols.length,
    }));

    return emit(format, {
        text: () => {
            // A path is the payload: the helper's default 50-column cut would shorten it.
            const [header, rule, ...body] = formatTable(
                rows.map((row) => [
                    (row.rank ?? 0).toFixed(2),
                    String(row.importers ?? 0),
                    String(row.decls),
                    row.file,
                ]),
                ["RANK", "IMPORTERS", "DECLS", "FILE"],
                { alignRight: [0, 1, 2], maxColWidth: Number.POSITIVE_INFINITY }
            )
                .split("\n")
                .map((line) => line.trimEnd());

            return [pc.dim(header), pc.dim(rule), ...body];
        },
        md: () => [{ h1: "Files by importance" }, { table: { rows } }],
        toon: () => ({ files: rows }),
        json: () => ({ files: rows }),
    });
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
    const context = options.functionContext ?? 0;
    const ranking = options.rank === true || options.maxTokens !== undefined || options.filesOnly === true;

    const loaded = await loadFiles(paths, {
        tests: options.tests === true,
        ignore: options.ignore,
        locals: options.includeLocals === true,
        hash: options.includeHash === true,
        functionContext: context,
        keepSource: options.types === true,
        imports: ranking,
    });

    for (const input of loaded.empty) {
        logger.error({ input }, "No TypeScript source found");
        process.exitCode = 1;
    }

    // lazy: saves 2.97 ms cold import (tools ts imports lazy src/ts/index.ts, 2026-09-24) — only --exact-tokens uses the tokenizer
    const encoder = options.exactTokens ? (await import("@anthropic-ai/tokenizer")).countTokens : undefined;
    let results: SkeletonResult[] = [];
    let originalTokens = 0;

    for (const entry of loaded.entries) {
        const entryTokens = tokensOf(entry.text, encoder);
        originalTokens += entryTokens;

        let symbols = entry.symbols;

        if (options.exported) {
            symbols = exportedOnly(symbols);
        }

        if (options.topLevel) {
            symbols = symbols.filter((symbol) => symbol.depth === 0);
        }

        const source = entry.source;
        // The project root is walked for --types only; a plain skeleton paid one walk per file.
        const types =
            options.types && source
                ? expandTypes(
                      source,
                      entry.absolute,
                      collectTypeNames(source),
                      findProjectRoot(dirname(entry.absolute)) ?? dirname(entry.absolute)
                  )
                : [];

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
            originalTokens: entryTokens,
            originalChars: entry.text.length,
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

        // Every row carries the same keys, even a declaration with no body. TOON turns an array
        // of objects into one table only when their keys match, so a missing `body` on one row
        // would drop the whole file back to a list of separate objects.
        if (context > 0) {
            row.body = symbol.body ?? [];
            row.bodyTruncated = symbol.bodyTruncated === true;
        }

        return row;
    };

    const rendered = (shown: SkeletonResult[], stats: Record<string, unknown>): Rendered => ({
        text: () => {
            const lines: string[] = [];

            for (const result of shown) {
                lines.push("");
                const coverage = coverageOf(result);
                const share = coverage.coveredPct;
                const cover = `${coverage.decls} decls · ${share}% of ${coverage.totalLines} lines`;

                lines.push(
                    `${pc.bold("skeleton")} ${pc.green(result.file)} ${share < 60 ? pc.yellow(`(${cover})`) : pc.dim(`(${cover})`)}${pc.dim(rankLabel(result))}`
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

            for (const result of shown) {
                const coverage = coverageOf(result);

                blocks.push({ h2: result.file });
                blocks.push(
                    `${coverage.decls} declarations · ${coverage.coveredPct}% of ${coverage.totalLines} lines covered${rankLabel(result)}`
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
        toon: () => ({
            files: shown.map((result) => ({
                file: result.file,
                ...coverageOf(result),
                ...rankOf(result),
                symbols: result.symbols.map((symbol) => {
                    const row = objectOf(symbol);

                    return Array.isArray(row.body) ? { ...row, body: row.body.join("\n") } : row;
                }),
                ...(result.types.length > 0 ? { types: result.types } : {}),
            })),
            stats: { files: shown.length, ...stats },
        }),
        json: () => ({
            files: shown.map((result) => ({
                file: result.file,
                ...coverageOf(result),
                ...rankOf(result),
                symbols: result.symbols.map(objectOf),
                ...(result.types.length > 0 ? { types: result.types } : {}),
            })),
            stats: { files: shown.length, ...stats },
        }),
        compact: () => ({
            cols,
            files: shown.map((result) => ({
                file: result.file,
                ...coverageOf(result),
                ...rankOf(result),
                symbols: result.symbols.map(rowOf),
                // `--types` resolves declarations for every format. Omitting them from the
                // compact form made `--types --toon` return nothing the flag asked for.
                ...(result.types.length > 0 ? { types: result.types } : {}),
            })),
            stats: { files: shown.length, ...stats },
        }),
    });

    const measure = (text: string): string => (isMachineFormat(format) ? text : stripAnsi(text));
    let omitted: SkeletonResult[] = [];

    if (ranking) {
        const budget = options.maxTokens;
        // A file costs what it adds to the output in the chosen format: line spans, kind tags, bodies and
        // referenced types included, not just its signatures. The empty document is paid for once, up front.
        const costOf = (shown: SkeletonResult[]): number =>
            tokensOf(measure(render(format, rendered(shown, {}))), encoder);
        const overhead = budget === undefined ? 0 : costOf([]);
        // results[i] is loaded.entries[i]: both were built in one pass.
        const fanIn = fanInOf({ files: loaded.entries, modules: loaded.modules });
        const inputs = results.map((result, index) => {
            const entry = loaded.entries[index];
            const importers = fanIn.get(entry.absolute) ?? 0;

            return {
                ...result,
                size: entry.text.length,
                fanIn: importers,
                mtimeMs: mtimeOf(entry.absolute),
                tokens: budget === undefined ? 0 : Math.max(1, costOf([{ ...result, rank: 0, importers }]) - overhead),
            };
        });
        const ranked = rankFiles({ files: inputs, now: Date.now(), keyOf: (file) => file.file });
        const packed =
            budget === undefined
                ? { included: ranked, elided: [] as RankedResult[] }
                : packByBudget({ files: ranked, budget: Math.max(0, budget - overhead) });

        results = packed.included.map((file) => ({ ...file, importers: file.fanIn }));
        omitted = packed.elided.map((file) => ({ ...file, importers: file.fanIn }));
        originalTokens = results.reduce((sum, result) => sum + result.originalTokens, 0);
    }

    const originalChars = results.reduce((sum, result) => sum + result.originalChars, 0);
    const omittedStat = ranking ? { omitted: omitted.map((file) => file.file) } : {};
    const omittedNote = () => {
        if (omitted.length === 0) {
            return;
        }

        const shown = omitted.slice(0, 5).map((file) => file.file);
        const more = omitted.length > shown.length ? `, +${omitted.length - shown.length} more` : "";

        ui.raw(
            `${pc.yellow("●")} ${omitted.length} lower-ranked file(s) did not fit --max-tokens ${options.maxTokens}: ${shown.join(", ")}${more}`
        );
    };

    if (options.filesOnly) {
        emitFilesOnly(format, results);
        ui.raw("");
        ui.raw(`${pc.cyan("●")} ${results.length} file(s) ranked`);
        omittedNote();

        return;
    }

    const printed = emit(format, rendered(results, { originalChars, originalTokens, ...omittedStat }));

    const measured = measure(printed);
    const skeletonTokens = tokensOf(measured, encoder);
    const saved = originalTokens > 0 ? 1 - skeletonTokens / originalTokens : 0;

    logger.debug(
        {
            files: results.length,
            originalChars,
            originalTokens,
            skeletonChars: measured.length,
            skeletonTokens,
            savedRatio: Number(saved.toFixed(4)),
            tokenSource: encoder ? "encoder" : "estimate",
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
    omittedNote();
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
        .option(
            "--function-context <lines>",
            "Print the first N lines of each body under its signature",
            numberArg({ min: 0, integer: true })
        )
        .option("--exact-tokens", "Count tokens with the BPE encoder instead of the chars-per-token estimate")
        .option("--rank", "Order files by importance (importers, size, recency) instead of by path")
        .option(
            "--max-tokens <n>",
            "Keep the highest-ranked files whose skeletons fit this token budget (implies --rank)",
            numberArg({ min: 1, integer: true })
        )
        .option("--files-only", "List the ranked files without their declarations (implies --rank)");

    addScanOptions(command);
    addFormatOptions(command);

    command.action(async (paths: string[], options: SkeletonOptions) => {
        await runUsage(command, () => runSkeleton(paths, options));
    });
}
