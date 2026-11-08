import { ui } from "@genesiscz/utils/cli/ui";
import type { Block } from "@genesiscz/utils/json2md";
import { logger } from "@genesiscz/utils/logger";
import { formatTable } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import {
    type AreaReport,
    buildAreaReport,
    createAreaGrouping,
    type ForbidRule,
    parseForbid,
    renderMermaid,
} from "../lib/areas";
import { emit, isMachineFormat, resolveFormat, UsageError } from "../lib/format";
import { buildImportIndex } from "../lib/import-index";
import {
    addFormatOptions,
    addScanOptions,
    type FormatCliFlags,
    numberArg,
    runUsage,
    type ScanCliFlags,
} from "./options";

interface AreasCliOptions extends FormatCliFlags, ScanCliFlags {
    split?: string[];
    depth?: number;
    forbid?: string[];
    limit?: number;
    mermaid?: boolean;
    minEdges?: number;
}

const SITES_SHOWN = 8;

function collect(value: string, previous: string[] = []): string[] {
    return [...previous, value];
}

function edgeNote(dynamic: number, typeOnly: number): string {
    const parts: string[] = [];

    if (dynamic > 0) {
        parts.push(`${dynamic} dynamic`);
    }

    if (typeOnly > 0) {
        parts.push(`${typeOnly} type-only`);
    }

    return parts.join(", ");
}

function renderText(report: AreaReport, rules: ForbidRule[], limit: number): string[] {
    const lines: string[] = [];
    const scanned = report.scanned;

    lines.push("");
    lines.push(
        `${pc.bold("areas")} ${pc.green(`${scanned.areas} area(s)`)} ${pc.dim(
            `· ${scanned.files} files · ${scanned.lines} lines · ${scanned.crossEdges} cross-area import sites ` +
                `(${scanned.dynamicEdges} dynamic) · ${report.mutual.length} mutual pair(s)`
        )}`
    );
    lines.push("");
    lines.push(
        ...formatTable(
            report.areas
                .slice(0, limit)
                .map((area) => [
                    area.area,
                    String(area.files),
                    String(area.lines),
                    String(area.fanIn),
                    String(area.fanOut),
                    String(area.edgesIn),
                    String(area.edgesOut),
                    String(area.internal),
                ]),
            ["AREA", "FILES", "LINES", "FAN-IN", "FAN-OUT", "IN", "OUT", "INTERNAL"],
            { alignRight: [1, 2, 3, 4, 5, 6, 7], maxColWidth: 70 }
        ).split("\n")
    );

    if (report.areas.length > limit) {
        lines.push(pc.dim(`… ${report.areas.length - limit} more area(s); raise --limit to see them`));
    }

    lines.push("");
    lines.push(pc.bold(pc.underline("Mutual pairs")) + pc.dim("  (two areas importing each other)"));

    if (report.mutual.length === 0) {
        lines.push(pc.dim("  none"));
    }

    for (const pair of report.mutual.slice(0, limit)) {
        const dynamic =
            pair.abDynamic + pair.baDynamic > 0 ? pc.dim(`  (dynamic ${pair.abDynamic} / ${pair.baDynamic})`) : "";
        lines.push(`  ${pc.red(`${pair.a} <-> ${pair.b}`)}  ${pair.ab} / ${pair.ba}${dynamic}`);
    }

    lines.push("");
    lines.push(pc.bold(pc.underline("Cross-area edges")) + pc.dim("  (import sites, heaviest first)"));

    for (const edge of report.edges.slice(0, limit)) {
        const note = edgeNote(edge.dynamic, edge.typeOnly);
        lines.push(`  ${edge.from} ${pc.dim("->")} ${edge.to}  ${edge.count}${note ? pc.dim(`  (${note})`) : ""}`);
    }

    if (report.edges.length > limit) {
        lines.push(pc.dim(`  … ${report.edges.length - limit} more edge(s)`));
    }

    for (const rule of rules) {
        const broken = report.violations.filter((violation) => violation.rule === rule.text);

        lines.push("");
        lines.push(
            `${pc.bold(pc.underline(`Forbidden: ${rule.text}`))} ${
                broken.length === 0 ? pc.green("kept") : pc.red(`${broken.length} area edge(s) break it`)
            }`
        );

        for (const violation of broken) {
            lines.push(`  ${pc.red(`${violation.from} -> ${violation.to}`)}  ${violation.count}`);

            for (const site of violation.sites.slice(0, SITES_SHOWN)) {
                lines.push(
                    `    ${pc.cyan(`${site.file}:${site.line}`)} ${pc.dim(site.specifier)}${site.dynamic ? pc.dim(" (dynamic)") : ""}`
                );
            }

            if (violation.sites.length > SITES_SHOWN) {
                lines.push(pc.dim(`    … ${violation.sites.length - SITES_SHOWN} more site(s); --json lists all`));
            }
        }
    }

    return lines;
}

function renderMarkdown(report: AreaReport, rules: ForbidRule[], limit: number): Block[] {
    const scanned = report.scanned;
    const blocks: Block[] = [
        { h1: "Area import graph" },
        `${scanned.areas} areas, ${scanned.files} files, ${scanned.lines} lines. ` +
            `${scanned.crossEdges} cross-area import sites, ${scanned.dynamicEdges} of them dynamic. ` +
            `${report.mutual.length} mutual pairs.`,
        {
            table: {
                rows: report.areas.slice(0, limit).map((area) => ({
                    Area: area.area,
                    Files: area.files,
                    Lines: area.lines,
                    "Fan-in": area.fanIn,
                    "Fan-out": area.fanOut,
                    In: area.edgesIn,
                    Out: area.edgesOut,
                    Internal: area.internal,
                })),
            },
        },
        { h2: "Mutual pairs" },
    ];

    if (report.mutual.length === 0) {
        blocks.push("None.");
    } else {
        blocks.push({
            table: {
                rows: report.mutual.slice(0, limit).map((pair) => ({
                    A: pair.a,
                    B: pair.b,
                    "A to B": pair.ab,
                    "B to A": pair.ba,
                    "Dynamic A to B": pair.abDynamic,
                    "Dynamic B to A": pair.baDynamic,
                })),
            },
        });
    }

    blocks.push({ h2: "Cross-area edges" });
    blocks.push({
        table: {
            rows: report.edges.slice(0, limit).map((edge) => ({
                From: edge.from,
                To: edge.to,
                Sites: edge.count,
                Dynamic: edge.dynamic,
                "Type-only": edge.typeOnly,
            })),
        },
    });

    for (const rule of rules) {
        const broken = report.violations.filter((violation) => violation.rule === rule.text);

        blocks.push({ h2: `Forbidden: ${rule.text}` });

        if (broken.length === 0) {
            blocks.push("Kept: no edge breaks it.");
            continue;
        }

        blocks.push({
            ul: broken.map(
                (violation) =>
                    `\`${violation.from}\` -> \`${violation.to}\` (${violation.count}): ` +
                    violation.sites.map((site) => `\`${site.file}:${site.line}\``).join(", ")
            ),
        });
    }

    return blocks;
}

function compactOf(report: AreaReport): unknown {
    return {
        scanned: report.scanned,
        areaCols: ["area", "files", "lines", "fanIn", "fanOut", "edgesIn", "edgesOut", "internal"],
        areas: report.areas.map((a) => [
            a.area,
            a.files,
            a.lines,
            a.fanIn,
            a.fanOut,
            a.edgesIn,
            a.edgesOut,
            a.internal,
        ]),
        edgeCols: ["from", "to", "count", "dynamic", "typeOnly"],
        edges: report.edges.map((e) => [e.from, e.to, e.count, e.dynamic, e.typeOnly]),
        mutualCols: ["a", "b", "ab", "ba", "abDynamic", "baDynamic"],
        mutual: report.mutual.map((p) => [p.a, p.b, p.ab, p.ba, p.abDynamic, p.baDynamic]),
        violationCols: ["rule", "from", "to", "count", "dynamic", "sites"],
        siteCols: ["file", "line", "specifier", "target", "dynamic"],
        violations: report.violations.map((v) => [
            v.rule,
            v.from,
            v.to,
            v.count,
            v.dynamic,
            v.sites.map((s) => [s.file, s.line, s.specifier, s.target, s.dynamic]),
        ]),
    };
}

/** TOON tables hold scalars only, so a violation's sites become one flat table beside the violations. */
function toonOf(report: AreaReport): unknown {
    return {
        scanned: report.scanned,
        areas: report.areas,
        edges: report.edges,
        mutual: report.mutual,
        violations: report.violations.map(({ sites: _sites, ...violation }) => violation),
        violationSites: report.violations.flatMap((violation) =>
            violation.sites.map((site) => ({ rule: violation.rule, from: violation.from, to: violation.to, ...site }))
        ),
    };
}

async function runAreasCommand(paths: string[], options: AreasCliOptions): Promise<void> {
    const format = resolveFormat(options);

    if (options.mermaid && isMachineFormat(format)) {
        throw new UsageError(
            "--mermaid prints Mermaid source (or a fenced block with --md); drop the JSON format flag"
        );
    }

    const rules = (options.forbid ?? []).map(parseForbid);
    const limit = options.limit ?? 40;
    const index = buildImportIndex(paths, { tests: options.tests === true, ignore: options.ignore });

    for (const input of index.empty) {
        logger.error({ input }, "No TypeScript source found");
        process.exitCode = 1;
    }

    const grouping = createAreaGrouping({ roots: paths, split: options.split, depth: options.depth });
    const report = buildAreaReport(index, grouping, { forbid: rules });

    if (options.mermaid) {
        const flowchart = renderMermaid(report, { minEdges: options.minEdges ?? 5 });

        emit(format, {
            text: () => flowchart.split("\n"),
            md: () => [{ code: { content: flowchart, language: "mermaid" } }],
            json: () => ({ mermaid: flowchart }),
        });
    } else {
        emit(format, {
            text: () => renderText(report, rules, limit),
            md: () => renderMarkdown(report, rules, limit),
            json: () => report,
            compact: () => compactOf(report),
            toon: () => toonOf(report),
        });
    }

    ui.raw("");
    ui.raw(
        `${pc.cyan("●")} ${report.scanned.areas} area(s) · ${report.scanned.files} files · ` +
            `${report.mutual.length} mutual pair(s) · ${report.scanned.outside} import site(s) leave the scanned paths · ` +
            `${report.scanned.unresolved} unresolved`
    );

    if (report.violations.length > 0) {
        ui.raw(`${pc.red("●")} ${report.violations.length} area edge(s) break a --forbid rule`);
        process.exitCode = 1;
    }
}

export function registerAreasCommands(program: Command): void {
    const command = program
        .command("areas")
        .description(
            "Static import graph grouped into areas: size, fan-in and fan-out, mutual pairs, cross-area edges, forbidden directions"
        )
        .argument("<paths...>", "Files or directories; an area is the first folder under each one")
        .option(
            "--split <dir>",
            "Group one level deeper inside this folder (src/utils gives src/utils/ai, src/utils/(root)); repeatable",
            collect,
            [] as string[]
        )
        .option(
            "--depth <n>",
            "Folder levels below a scanned path (or a --split folder) that make one area (default 1)",
            numberArg({ min: 1, integer: true })
        )
        .option(
            "--forbid <rule>",
            'A direction that must not exist, "<from>-><to>" by area prefix: "src/utils->src/" lists every utils area importing a tool; repeatable, exit 1 when broken',
            collect,
            [] as string[]
        )
        .option(
            "--limit <n>",
            "Rows per table in text and markdown (default 40; JSON has every row)",
            numberArg({ min: 1, integer: true })
        )
        .option("--mermaid", "Print a Mermaid flowchart of the areas instead (mutual edges red, dynamic-only dashed)")
        .option(
            "--min-edges <n>",
            "With --mermaid: draw an edge only with at least this many import sites (default 5)",
            numberArg({ min: 1, integer: true })
        );

    addScanOptions(command);
    addFormatOptions(command);

    command.addHelpText(
        "after",
        [
            "",
            "Edges are import sites (one import statement, re-export, require() or import() each), resolved",
            "with Bun's resolver, so tsconfig `paths` aliases count. Type-only imports count as static",
            "coupling and are reported apart; dynamic import() edges are counted and marked, since they load",
            "lazily. Tests are skipped unless --tests.",
            "",
            "Examples:",
            "  tools ts areas src --split src/utils",
            '  tools ts areas src --split src/utils --forbid "src/utils->src/" --json',
            "  tools ts areas src --mermaid --min-edges 20 > areas.mmd",
        ].join("\n")
    );

    command.action(async (paths: string[], options: AreasCliOptions) => {
        await runUsage(command, () => runAreasCommand(paths, options));
    });
}
