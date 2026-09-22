import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { countTokens } from "@anthropic-ai/tokenizer";
import { toToon } from "@app/json/lib/toon";
import { ui } from "@genesiscz/utils/cli/ui";
import { findProjectRoot } from "@genesiscz/utils/fs/project-root";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { stripAnsi } from "@genesiscz/utils/string";
import type { Command } from "commander";
import pc from "picocolors";
import { exportedOnly, extractSkeleton, parseSource, type SkeletonSymbol } from "../lib/skeleton";
import { collectTypeNames, type ExpandedType, expandTypes } from "../lib/type-expand";

interface SkeletonOptions {
    json?: boolean;
    toon?: boolean;
    exported?: boolean;
    topLevel?: boolean;
    tests?: boolean;
    types?: boolean;
    exactTokens?: boolean;
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "build", "coverage", ".next", ".git"]);
const TEST_FILE = /[._](test|spec)\.[cm]?tsx?$/;

function isSource(path: string, includeTests: boolean): boolean {
    if (path.endsWith(".d.ts") || !SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext))) {
        return false;
    }

    return includeTests || !TEST_FILE.test(path);
}

/**
 * A directory argument expands to every source file under it, so `skeleton src/ts` works.
 *
 * ⚠️ `existsSync` does not make the later `statSync` and `readdirSync` atomic. A path can
 * vanish or become unreadable between the two — a build writing into the tree, a worktree
 * being removed — and an escaping exception aborted the whole command before it printed
 * anything for the files it had already walked. An unreadable entry is skipped and logged
 * instead, because a partial skeleton is worth more than a stack trace.
 */
function collectFiles(input: string, includeTests: boolean): string[] {
    const absolute = resolve(input);

    if (!existsSync(absolute)) {
        return [];
    }

    try {
        if (!statSync(absolute).isDirectory()) {
            return [absolute];
        }
    } catch (err) {
        logger.debug({ path: absolute, err }, "skeleton: could not stat a path, skipping it");

        return [];
    }

    const found: string[] = [];
    let entries: Dirent[];

    try {
        entries = readdirSync(absolute, { withFileTypes: true });
    } catch (err) {
        logger.debug({ path: absolute, err }, "skeleton: could not read a directory, skipping it");

        return [];
    }

    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (!SKIP_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) {
                found.push(...collectFiles(join(absolute, entry.name), includeTests));
            }
        } else if (isSource(entry.name, includeTests)) {
            found.push(join(absolute, entry.name));
        }
    }

    return found.sort();
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

function tokensOf(text: string, useEncoder: boolean): number {
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

export function renderSymbol(symbol: SkeletonSymbol): string {
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

    return `${indent}- ${pc.dim(range.padEnd(12))} ${kind}${pc.white(symbol.signature)}`;
}

async function runSkeleton(files: string[], options: SkeletonOptions): Promise<void> {
    const results: {
        file: string;
        symbols: SkeletonSymbol[];
        types: ExpandedType[];
        totalLines: number;
        coveredLines: number;
    }[] = [];

    const targets: string[] = [];

    for (const input of files) {
        const found = collectFiles(input, options.tests === true);

        if (found.length === 0) {
            logger.error({ input }, "No TypeScript source found");
            process.exitCode = 1;
            continue;
        }

        targets.push(...found);
    }

    const useEncoder = options.exactTokens === true;
    let originalChars = 0;
    let originalTokens = 0;

    for (const absolute of targets) {
        const text = await Bun.file(absolute).text();
        originalChars += text.length;
        originalTokens += tokensOf(text, useEncoder);
        const source = parseSource(absolute, text);
        let symbols = extractSkeleton(source);

        if (options.exported) {
            symbols = exportedOnly(symbols);
        }

        if (options.topLevel) {
            symbols = symbols.filter((symbol) => symbol.depth === 0);
        }

        const root = findProjectRoot(dirname(absolute)) ?? dirname(absolute);
        const types = options.types ? expandTypes(source, absolute, collectTypeNames(source), root) : [];

        // A skeleton omits silently, so report how much of the file it actually covers.
        // A commander entrypoint used to print 7 declarations for 527 lines with no hint.
        const seen = new Set<number>();

        for (const symbol of symbols) {
            for (let line = symbol.startLine; line <= symbol.endLine; line++) {
                seen.add(line);
            }
        }

        results.push({
            file: relative(process.cwd(), absolute) || absolute,
            symbols,
            types,
            totalLines: text.split("\n").length,
            coveredLines: seen.size,
        });
    }

    // The coverage numbers the text header prints, for every format. 🛑 `--json` and `--toon`
    // used to omit them entirely, and the percentage is the ONLY honest measure of what a
    // skeleton left out, so a machine consumer had no way to tell a faithful index from one
    // representing a tenth of the file.
    const coverageOf = (result: { symbols: unknown[]; totalLines: number; coveredLines: number }) => ({
        decls: result.symbols.length,
        totalLines: result.totalLines,
        coveredPct: result.totalLines > 0 ? Math.round((100 * result.coveredLines) / result.totalLines) : 100,
    });

    const report = (rendered: string): void => {
        const skeletonTokens = tokensOf(rendered, useEncoder);
        const saved = originalTokens > 0 ? 1 - skeletonTokens / originalTokens : 0;
        const stats = {
            files: results.length,
            originalChars,
            originalTokens,
            skeletonChars: rendered.length,
            skeletonTokens,
            savedRatio: Number(saved.toFixed(4)),
            tokenSource: useEncoder ? "encoder" : "estimate",
        };

        logger.debug(stats, "skeleton size");
        // ui.raw, not out.log.info: clack draws a `│` connector line above its bullet,
        // which is the wrong texture for a single closing stat. The blank line is what
        // that connector was providing, so it is kept deliberately.
        ui.raw("");
        ui.raw(
            `${pc.cyan("●")} ${results.length} file(s) · original ${exact(originalTokens)} tokens · ` +
                `skeleton ${exact(skeletonTokens)} tokens · ${Math.abs(saved * 100).toFixed(1)}% ` +
                `${saved < 0 ? "larger" : "smaller"}`
        );
    };

    if (options.toon) {
        // TOON names its columns once per table, so uniform rows are what make it
        // small. Omitting default fields the way the JSON shape does would break the
        // tabular form and make it larger, so every row carries every column here.
        // `kind` is dropped. A declaration's signature carries its keyword, and a member has
        // `depth > 0`. ⚠️ It is not FULLY recoverable: an object-literal `field` and `method`
        // both read as `name: value`, so only the signature's shape tells those two apart.
        const payload = {
            files: results.map((result) => ({
                file: result.file,
                ...coverageOf(result),
                symbols: result.symbols.map((symbol) => ({
                    startLine: symbol.startLine,
                    endLine: symbol.endLine,
                    depth: symbol.depth,
                    exported: symbol.exported,
                    signature: symbol.signature,
                })),
                // `--types` resolves declarations for every format, and `--json` carries
                // them. Omitting them here made `--types --toon` return nothing the flag
                // asked for, silently. It sits outside `symbols` so the tabular form the
                // comment above depends on is unaffected.
                ...(result.types.length > 0 ? { types: result.types } : {}),
            })),
        };
        const text = toToon(payload);

        report(text);
        out.print(text);
        return;
    }

    if (options.json) {
        // Columnar, for the same reason TOON is small: naming the fields once and
        // emitting positional rows removes ~80 chars of repeated keys per symbol,
        // which was 40% of the old payload. `name` is dropped because the signature carries
        // it, and `kind` for the reason given in the TOON branch above. Measured half the
        // size of the object form, and about 10% under the TOON output.
        const payload = {
            cols: ["startLine", "endLine", "depth", "exported", "signature"],
            files: results.map((result) => ({
                file: result.file,
                ...coverageOf(result),
                symbols: result.symbols.map((symbol) => [
                    symbol.startLine,
                    symbol.endLine,
                    symbol.depth,
                    symbol.exported,
                    symbol.signature,
                ]),
                ...(result.types.length > 0 ? { types: result.types } : {}),
            })),
            stats: { files: results.length, originalChars, originalTokens },
        };
        const text = SafeJSON.stringify(payload);

        report(text);
        out.print(text);
        return;
    }

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
            lines.push(renderSymbol(symbol));
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

    for (const line of lines) {
        out.println(line);
    }

    // Colour codes are not content, so they must not inflate the saving.
    report(lines.map((line) => stripAnsi(line)).join("\n"));
}

export function registerSkeletonCommands(program: Command): void {
    program
        .command("skeleton")
        .description("Print a file's whole API: every declaration with its signature and line span")
        .argument("<paths...>", "Files or directories; a directory is walked recursively")
        .option("--json", "Emit machine-readable JSON")
        .option("--toon", "Emit TOON: same data as --json, roughly 40% fewer tokens")
        .option("--exported", "Only exported top-level declarations")
        .option("--top-level", "Skip class and interface members")
        .option("--tests", "Include *.test.ts and *.spec.ts (skipped by default)")
        .option("--types", "Also print the declaration of every type named in the signatures")
        .option("--exact-tokens", "Count tokens with the BPE encoder instead of the chars-per-token estimate")
        .action(async (files: string[], options: SkeletonOptions) => {
            await runSkeleton(files, options);
        });
}
