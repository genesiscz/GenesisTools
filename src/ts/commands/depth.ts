import { ui } from "@genesiscz/utils/cli/ui";
import type { Block } from "@genesiscz/utils/json2md";
import { logger } from "@genesiscz/utils/logger";
import { formatTable } from "@genesiscz/utils/table";
import { type Command, Option } from "commander";
import pc from "picocolors";
import { createAreaGrouping } from "../lib/areas";
import {
    DEPTH_UNITS,
    type DepthReport,
    type DepthUnit,
    type ModuleDepth,
    measureDepth,
    THIN_BODY_LINES,
} from "../lib/depth";
import { emit, resolveFormat } from "../lib/format";
import { buildImportIndex } from "../lib/import-index";
import { loadFiles } from "../lib/load";
import {
    addFormatOptions,
    addScanOptions,
    type FormatCliFlags,
    numberArg,
    runUsage,
    type ScanCliFlags,
} from "./options";

interface DepthCliOptions extends FormatCliFlags, ScanCliFlags {
    by?: DepthUnit;
    within?: string[];
    split?: string[];
    minExports?: number;
    limit?: number;
    deep?: number;
}

const SHALLOW_HEADERS = [
    "MODULE",
    "SHALLOW",
    "EXPORTS",
    "IFACE",
    "CODE",
    "SHARE",
    "RE-EXP",
    "THIN",
    "IMPORTERS",
    "AREAS",
];
const DEEP_HEADERS = ["MODULE", "DEEP", "EXPORTS", "CODE LINES", "LINES/EXPORT", "IMPORTERS", "AREAS"];

function collect(value: string, previous: string[] = []): string[] {
    return [...previous, value];
}

function shallowRow(module: ModuleDepth): string[] {
    return [
        module.module,
        module.shallow.toFixed(2),
        String(module.exports),
        String(module.interfaceChars),
        String(module.codeChars),
        `${Math.round(module.interfaceShare * 100)}%`,
        `${Math.round(module.reexportRatio * 100)}%`,
        `${module.thinExports}/${module.exportedFunctions}`,
        String(module.importerFiles),
        String(module.importerAreas),
    ];
}

function deepRow(module: ModuleDepth): string[] {
    return [
        module.module,
        String(module.deep),
        String(module.exports),
        String(module.codeLines),
        String(module.linesPerExport),
        String(module.importerFiles),
        String(module.importerAreas),
    ];
}

function legend(report: DepthReport): string[] {
    return [
        `IFACE is characters of exported signatures (whitespace collapsed, members of exported classes, interfaces and object APIs included, private ones not); CODE is the module's characters without comments.`,
        `SHARE = IFACE / CODE. RE-EXP = share of exports re-exported from elsewhere. THIN = exported functions with a body of at most ${THIN_BODY_LINES} lines / all exported functions.`,
        `SHALLOW = 0.6 × SHARE + 0.4 × (re-exports + thin exports) / exports. DEEP = code lines per export × log2(1 + importers).`,
        `Importers are counted within: ${report.within.join(", ")}.`,
    ];
}

function renderText(report: DepthReport): string[] {
    const lines: string[] = [];

    lines.push("");
    lines.push(
        `${pc.bold("depth")} ${pc.green(`${report.scanned.modules} module(s)`)} ${pc.dim(
            `by ${report.by} · ${report.scanned.files} files · ${report.skipped.typesOnly} types-only and ` +
                `${report.skipped.fewExports} with too few exports left out of the shallow ranking`
        )}`
    );
    lines.push("");
    lines.push(pc.bold(pc.underline("Shallow first")) + pc.dim("  (the interface is nearly the whole module)"));

    if (report.shallow.length === 0) {
        lines.push(pc.dim("  none above the thresholds"));
    } else {
        lines.push(
            ...formatTable(report.shallow.map(shallowRow), SHALLOW_HEADERS, {
                alignRight: [1, 2, 3, 4, 5, 6, 7, 8, 9],
                maxColWidth: 70,
            }).split("\n")
        );
    }

    lines.push("");
    lines.push(pc.bold(pc.underline("Deep")) + pc.dim("  (much behaviour behind few exports, many importers)"));

    if (report.deep.length === 0) {
        lines.push(pc.dim("  none: no module has an importer within the counted paths"));
    } else {
        lines.push(
            ...formatTable(report.deep.map(deepRow), DEEP_HEADERS, {
                alignRight: [1, 2, 3, 4, 5, 6],
                maxColWidth: 70,
            }).split("\n")
        );
    }

    lines.push("");

    for (const line of legend(report)) {
        lines.push(pc.dim(line));
    }

    return lines;
}

function renderMarkdown(report: DepthReport): Block[] {
    return [
        { h1: "Module depth" },
        `${report.scanned.modules} modules by ${report.by}, ${report.scanned.files} files. ` +
            `${report.skipped.typesOnly} types-only and ${report.skipped.fewExports} with too few exports are left out of the shallow ranking.`,
        { h2: "Shallow first" },
        report.shallow.length === 0
            ? "None above the thresholds."
            : {
                  table: {
                      rows: report.shallow.map((module) => ({
                          Module: module.module,
                          Shallow: module.shallow,
                          Exports: module.exports,
                          "Interface chars": module.interfaceChars,
                          "Code chars": module.codeChars,
                          "Interface share": module.interfaceShare,
                          "Re-export ratio": module.reexportRatio,
                          Thin: `${module.thinExports}/${module.exportedFunctions}`,
                          Importers: module.importerFiles,
                          Areas: module.importerAreas,
                      })),
                  },
              },
        { h2: "Deep" },
        report.deep.length === 0
            ? "None: no module has an importer within the counted paths."
            : {
                  table: {
                      rows: report.deep.map((module) => ({
                          Module: module.module,
                          Deep: module.deep,
                          Exports: module.exports,
                          "Code lines": module.codeLines,
                          "Lines per export": module.linesPerExport,
                          Importers: module.importerFiles,
                          Areas: module.importerAreas,
                      })),
                  },
              },
        { ul: legend(report) },
    ];
}

const MODULE_COLS: Array<keyof ModuleDepth> = [
    "module",
    "files",
    "exports",
    "reexports",
    "reexportRatio",
    "exportedFunctions",
    "thinExports",
    "interfaceChars",
    "codeChars",
    "codeLines",
    "interfaceShare",
    "linesPerExport",
    "importerFiles",
    "importerAreas",
    "typesOnly",
    "shallow",
    "deep",
];

function compactOf(report: DepthReport): unknown {
    const rowOf = (module: ModuleDepth): unknown[] => MODULE_COLS.map((col) => module[col]);

    return {
        by: report.by,
        within: report.within,
        scanned: report.scanned,
        skipped: report.skipped,
        cols: MODULE_COLS,
        shallow: report.shallow.map(rowOf),
        deep: report.deep.map(rowOf),
        modules: report.modules.map(rowOf),
    };
}

async function runDepthCommand(paths: string[], options: DepthCliOptions): Promise<void> {
    const format = resolveFormat(options);
    const by = options.by ?? "folder";
    const within = options.within && options.within.length > 0 ? options.within : paths;
    const scan = { tests: options.tests === true, ignore: options.ignore };
    const loaded = await loadFiles(paths, scan);

    for (const input of loaded.empty) {
        logger.error({ input }, "No TypeScript source found");
        process.exitCode = 1;
    }

    const index = buildImportIndex(within, scan);
    const report = measureDepth(loaded.entries, index, {
        by,
        within,
        moduleGrouping: createAreaGrouping({ roots: paths, split: options.split }),
        importerGrouping: createAreaGrouping({ roots: within, split: options.split }),
        minExports: options.minExports,
        limit: options.limit,
        deepLimit: options.deep,
    });

    emit(format, {
        text: () => renderText(report),
        md: () => renderMarkdown(report),
        json: () => report,
        compact: () => compactOf(report),
    });

    ui.raw("");
    ui.raw(
        `${pc.cyan("●")} ${report.scanned.modules} module(s) by ${by} · ${report.shallow.length} shallow shown · ` +
            `${report.deep.length} deep shown · importers within ${within.join(", ")} (${index.files.size} files)`
    );
}

export function registerDepthCommands(program: Command): void {
    const command = program
        .command("depth")
        .description(
            "Shallow-module finder: interface size against implementation, pass-through exports, and importers per module"
        )
        .argument("<paths...>", "Files or directories whose modules are measured")
        .addOption(
            new Option("--by <unit>", "A module is a folder (the first folder under each path) or one file")
                .choices(DEPTH_UNITS)
                .default("folder")
        )
        .option(
            "--within <path>",
            "Count importers from these paths (default: the scanned paths); repeatable",
            collect,
            [] as string[]
        )
        .option(
            "--split <dir>",
            "Group one level deeper inside this folder, as in `tools ts areas`; repeatable",
            collect,
            [] as string[]
        )
        .option(
            "--min-exports <n>",
            "A module needs this many exported names to be ranked shallow (default 2)",
            numberArg({ min: 1, integer: true })
        )
        .option("--limit <n>", "Rows in the shallow table (default 25)", numberArg({ min: 1, integer: true }))
        .option("--deep <n>", "Rows in the deep table (default 10)", numberArg({ min: 1, integer: true }));

    addScanOptions(command);
    addFormatOptions(command);

    command.addHelpText(
        "after",
        [
            "",
            "A module is deep when much behaviour sits behind a small interface, and shallow when the",
            "interface is nearly as big as the implementation. Per module:",
            "  interface   characters of exported signatures, whitespace collapsed (members of exported",
            "              classes, interfaces and object APIs count, private members do not)",
            "  code        the module's characters and lines without comments",
            "  re-exports  share of exported names re-exported from another module (pass-through)",
            `  thin        exported functions whose body is at most ${THIN_BODY_LINES} lines (forwarders)`,
            "  importers   distinct files and areas outside the module that import it",
            "",
            "  shallow = 0.6 × interface/code + 0.4 × (re-exports + thin exports) / exports   (0 to 1)",
            "  deep    = code lines per export × log2(1 + importer files)",
            "",
            "Modules whose every export is a type or an interface are left out of the shallow ranking.",
            "",
            "Examples:",
            "  tools ts depth src/utils",
            "  tools ts depth src/utils --within src --json",
            "  tools ts depth src/utils/ai --by file --limit 40",
        ].join("\n")
    );

    command.action(async (paths: string[], options: DepthCliOptions) => {
        await runUsage(command, () => runDepthCommand(paths, options));
    });
}
