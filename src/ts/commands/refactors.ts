import { ui } from "@genesiscz/utils/cli/ui";
import type { Block } from "@genesiscz/utils/json2md";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";
import { emit, resolveFormat } from "../lib/format";
import { loadFiles } from "../lib/load";
import {
    ANALYSERS,
    DEFAULT_ANALYSERS,
    type Recommendation,
    type RefactorReport,
    resolveAnalysers,
    runRefactors,
    type Severity,
} from "../lib/refactors";
import {
    addFormatOptions,
    addScanOptions,
    type FormatCliFlags,
    numberArg,
    runUsage,
    type ScanCliFlags,
} from "./options";

interface RefactorsCliOptions extends FormatCliFlags, ScanCliFlags {
    include?: string;
    minLines?: number;
    similarity?: number;
    maxFunctionLines?: number;
    maxParams?: number;
    maxDeclarations?: number;
    limit?: number;
    locals?: boolean;
    includePatterns?: boolean;
    includeSameFile?: boolean;
}

const SEVERITY_MARK: Record<Severity, string> = { high: "🛑", medium: "⚠️", low: "❗" };

function colourFor(severity: Severity): (text: string) => string {
    if (severity === "high") {
        return pc.red;
    }

    return severity === "medium" ? pc.yellow : pc.dim;
}

function renderText(report: RefactorReport, limit: number): string[] {
    const lines: string[] = [];

    lines.push("");
    lines.push(
        `${pc.bold("refactors")} ${pc.green(`${report.recommendations.length} recommendation(s)`)} ` +
            pc.dim(
                `· ${report.bySeverity.high} high, ${report.bySeverity.medium} medium, ${report.bySeverity.low} low ` +
                    `· ${report.savedLines} lines could go · analysers: ${report.analysers.join(", ")}`
            )
    );

    if (report.recommendations.length === 0) {
        lines.push(pc.dim("  nothing above the thresholds"));

        return lines;
    }

    let current = "";

    for (const recommendation of report.recommendations.slice(0, limit)) {
        if (recommendation.analyser !== current) {
            current = recommendation.analyser;
            lines.push("");
            lines.push(pc.bold(pc.underline(current)));
        }

        const colour = colourFor(recommendation.severity);

        lines.push("");
        lines.push(`${SEVERITY_MARK[recommendation.severity]} ${colour(recommendation.title)}`);

        for (const detail of recommendation.detail) {
            lines.push(pc.dim(`    ${detail}`));
        }

        for (const site of recommendation.sites.slice(0, 20)) {
            const mark = site.canonical ? pc.green(" ← keep this one") : "";

            lines.push(`    ${pc.cyan(`${site.file}:${site.startLine}`)} ${pc.dim(site.name)}${mark}`);
        }

        if (recommendation.sites.length > 20) {
            lines.push(pc.dim(`    … ${recommendation.sites.length - 20} more`));
        }

        lines.push(`    ${pc.dim("→")} ${recommendation.action}`);
    }

    if (report.recommendations.length > limit) {
        lines.push("");
        lines.push(pc.dim(`… ${report.recommendations.length - limit} more; raise --limit to see them`));
    }

    return lines;
}

function renderMarkdown(report: RefactorReport, limit: number): Block[] {
    const blocks: Block[] = [
        { h1: "Recommended refactors" },
        `${report.recommendations.length} recommendations across ${report.scanned.files} files. ` +
            `${report.bySeverity.high} high, ${report.bySeverity.medium} medium, ${report.bySeverity.low} low. ` +
            `Roughly ${report.savedLines} lines would go.`,
        {
            table: {
                rows: report.recommendations.slice(0, limit).map((recommendation) => ({
                    Severity: recommendation.severity,
                    Analyser: recommendation.analyser,
                    Finding: recommendation.title,
                    Sites: recommendation.sites.length,
                    Lines: recommendation.savedLines,
                })),
            },
        },
    ];

    let current = "";

    for (const recommendation of report.recommendations.slice(0, limit)) {
        if (recommendation.analyser !== current) {
            current = recommendation.analyser;
            blocks.push({ h2: current });
        }

        blocks.push({ h3: recommendation.title });
        blocks.push({ ul: recommendation.detail });
        blocks.push({
            ul: recommendation.sites.map(
                (site) =>
                    `\`${site.file}:${site.startLine}-${site.endLine}\` ${site.name}` +
                    (site.canonical ? " — **keep this one**" : "")
            ),
        });
        blocks.push({
            callout: {
                kind: recommendation.severity === "high" ? "warning" : "tip",
                title: "Do",
                body: recommendation.action,
            },
        });
    }

    return blocks;
}

function compactOf(recommendation: Recommendation): unknown[] {
    return [
        recommendation.analyser,
        recommendation.severity,
        recommendation.title,
        recommendation.savedLines,
        recommendation.score,
        recommendation.action,
        recommendation.sites.map((site) => [
            site.file,
            site.startLine,
            site.endLine,
            site.name,
            site.canonical === true,
        ]),
    ];
}

async function runRefactorsCommand(paths: string[], options: RefactorsCliOptions): Promise<void> {
    if (options.include?.trim() === "help") {
        for (const analyser of ANALYSERS) {
            const isDefault = DEFAULT_ANALYSERS.includes(analyser.name);

            out.println(
                `${pc.cyan(analyser.name.padEnd(16))} ${analyser.summary}${isDefault ? pc.dim("  (on by default)") : ""}`
            );
        }

        return;
    }

    const format = resolveFormat(options);
    const analysers = resolveAnalysers(options.include);
    const limit = options.limit ?? 40;
    const needsImports = analysers.some(
        (analyser) => analyser.name === "shadowed" || analyser.name === "unused-exports"
    );
    const loaded = await loadFiles(paths, {
        tests: options.tests === true,
        ignore: options.ignore,
        locals: options.locals === true,
        hash: true,
        imports: needsImports,
    });

    for (const input of loaded.empty) {
        logger.error({ input }, "No TypeScript source found");
        process.exitCode = 1;
    }

    const report = runRefactors(analysers, {
        entries: loaded.entries,
        modules: loaded.modules,
        options: {
            minLines: options.minLines ?? 3,
            similarity: options.similarity ?? 0.8,
            maxFunctionLines: options.maxFunctionLines ?? 60,
            maxParams: options.maxParams ?? 4,
            maxDeclarations: options.maxDeclarations ?? 40,
            limit,
            includePatterns: options.includePatterns === true,
            includeSameFile: options.includeSameFile === true,
            recommend: true,
        },
    });

    emit(format, {
        text: () => renderText(report, limit),
        md: () => renderMarkdown(report, limit),
        json: () => ({ ...report, recommendations: report.recommendations.slice(0, limit) }),
        compact: () => ({
            cols: ["analyser", "severity", "title", "savedLines", "score", "action", "sites"],
            siteCols: ["file", "startLine", "endLine", "name", "canonical"],
            analysers: report.analysers,
            bySeverity: report.bySeverity,
            savedLines: report.savedLines,
            scanned: report.scanned,
            recommendations: report.recommendations.slice(0, limit).map(compactOf),
        }),
    });

    ui.raw("");
    ui.raw(
        `${pc.cyan("●")} ${report.recommendations.length} recommendation(s) · ` +
            `${report.bySeverity.high} high · ${report.savedLines} lines could go · ` +
            `${report.scanned.files} files scanned`
    );
}

export function registerRefactorsCommands(program: Command): void {
    const command = program
        .command("refactors")
        .description("Ranked refactor recommendations: duplicates, shadowed helpers, long functions, and more")
        .argument("<paths...>", "Files or directories; a directory is walked recursively")
        .option(
            "--include <list>",
            `Comma-separated analysers, or "all", or "help" to list them (default: ${DEFAULT_ANALYSERS.join(",")})`
        )
        .option(
            "--min-lines <n>",
            "Ignore declarations shorter than this (default 3)",
            numberArg({ min: 1, integer: true })
        )
        .option(
            "--similarity <ratio>",
            "How alike two bodies must be, 0 to 1 (default 0.8)",
            numberArg({ min: 0, max: 1 })
        )
        .option(
            "--max-function-lines <n>",
            "A function longer than this is reported (default 60)",
            numberArg({ min: 1, integer: true })
        )
        .option(
            "--max-params <n>",
            "More positional parameters than this is reported (default 4)",
            numberArg({ min: 1, integer: true })
        )
        .option(
            "--max-declarations <n>",
            "A file with more top-level declarations is reported (default 40)",
            numberArg({ min: 1, integer: true })
        )
        .option("--locals", "Also consider declarations inside function bodies")
        .option("--include-patterns", "Keep the duplicate groups that look like a deliberate repeated shape")
        .option("--include-same-file", "Keep the duplicate groups whose copies all live in one file")
        .option(
            "--limit <n>",
            "Show at most this many recommendations (default 40)",
            numberArg({ min: 1, integer: true })
        );

    addScanOptions(command);
    addFormatOptions(command);

    command.action(async (paths: string[], options: RefactorsCliOptions) => {
        await runUsage(command, () => runRefactorsCommand(paths, options));
    });
}
