import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { suggestCommand, toolCommand } from "@genesiscz/utils/cli";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { formatBytes } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, renderCliSection } from "@genesiscz/utils/table";
import { type Command, InvalidArgumentError } from "commander";
import { costByFolder, duplicatePackages, folderClosures, packageSizes, whyChain } from "../lib/program/closure";
import {
    DEFAULT_TIMEOUT_MS,
    generateTrace,
    type ProgramRuntime,
    resolveTsconfig,
    runProgramWorker,
} from "../lib/program/run";
import { groupSites, SITE_SORT_KEYS, type SiteSortKey, sitesForKey, sortGroups } from "../lib/program/sites";
import { analyzeTrace } from "../lib/program/trace";
import type { FileCost } from "../lib/program/types";
import { numberArg, runUsage } from "./options";

interface RuntimeFlags {
    runtime: ProgramRuntime;
    heap?: number;
    timeout: number;
    json?: boolean;
}

const SORT_KEYS = ["instantiations", "types", "symbols", "ms"] as const;
type SortKey = (typeof SORT_KEYS)[number];

function runtimeOption(command: Command): Command {
    return command
        .option(
            "--runtime <name>",
            "node (V8, as tsc and reviewers run) or bun",
            (value: string) => {
                if (value !== "node" && value !== "bun") {
                    throw new InvalidArgumentError("Must be node or bun.");
                }

                return value;
            },
            "node"
        )
        .option(
            "--heap <MiB>",
            "Heap limit of the checking process (node, default 16384); a larger program fails as out of memory",
            numberArg({ min: 64, integer: true })
        )
        .option(...timeoutOption())
        .option("--json", "The result as JSON");
}

/** `--timeout <s>`: the check is stopped (its whole process group) after this long. */
function timeoutOption(): [string, string, (raw: string) => number, number] {
    const seconds = DEFAULT_TIMEOUT_MS / 1000;
    return [
        "--timeout <s>",
        `Stop the check after this many seconds (default ${seconds})`,
        // A timer holds at most 2^31-1 ms; past it boundedCommand throws a bare Error instead of a usage message.
        numberArg({ min: 1, max: Math.floor(2_147_483_647 / 1000), integer: true }),
        seconds,
    ];
}

/** A usage-error boundary whose check stops on Ctrl-C: the signal reaches the worker's process group. */
function runCheck(command: Command, action: (signal: AbortSignal) => Promise<void>): Promise<void> {
    return runUsage(command, () => withInterrupt(action));
}

function siteSortKey(value: string): SiteSortKey {
    const key = SITE_SORT_KEYS.find((candidate) => candidate === value);

    if (!key) {
        throw new InvalidArgumentError(`Must be one of ${SITE_SORT_KEYS.join(", ")}.`);
    }

    return key;
}

function sortKey(value: string): SortKey {
    const key = SORT_KEYS.find((candidate) => candidate === value);

    if (!key) {
        throw new InvalidArgumentError(`Must be one of ${SORT_KEYS.join(", ")}.`);
    }

    return key;
}

/** A path for a command typed in the current folder: relative inside it, absolute outside (rows are relative to the tsconfig's folder). */
function fromCwd(path: string): string {
    const rel = relative(process.cwd(), path);
    return rel.startsWith("..") ? path : rel;
}

/** Exact, with separators: a before and after comparison needs every digit. */
const n = (value: number) => value.toLocaleString("en-US");

export function registerProgramCommands(parent: Command): void {
    const program = parent
        .command("program")
        .description(
            "What a TypeScript program costs to check, and why: heap per phase, the files and folders that create the most types, what one folder's program would hold, and trace hot spots"
        );

    runtimeOption(
        program
            .command("cost")
            .description("Heap after parse, bind and check (after a full GC), time, files and the checker's counts")
            .argument("[tsconfig]", "A tsconfig.json or the folder holding one (default ./tsconfig.json)")
    ).action(async (tsconfig: string | undefined, options: RuntimeFlags, command: Command) => {
        await runCheck(command, async (signal) => {
            const result = await runProgramWorker("phases", {
                tsconfig: resolveTsconfig(tsconfig),
                runtime: options.runtime,
                heapMiB: options.heap,
                timeoutMs: options.timeout * 1000,
                signal,
            });

            if (options.json) {
                out.result(result);
                return;
            }

            renderCliHeader(
                "TypeScript program cost",
                `${result.config} · TypeScript ${result.typescript} · ${result.runtime}`
            );
            const phases = createBoxTable(["PHASE", "HEAP MIB", "RSS MIB", "AT"]);

            for (const phase of result.phases) {
                phases.push([phase.phase, n(phase.heapMiB), n(phase.rssMiB), `${(phase.ms / 1000).toFixed(1)} s`]);
            }

            out.println(phases.toString());
            out.println(
                `files ${n(result.size.files)} (node_modules ${n(result.size.nodeModulesFiles)}, ${formatBytes(result.size.nodeModulesBytes)}; all ${formatBytes(result.size.sourceBytes)}) · types ${n(result.types)} · instantiations ${n(result.instantiations)} · symbols ${n(result.symbols)} · diagnostics ${result.diagnostics}`
            );

            if (!result.gcForced) {
                out.println("heap is the raw heap in use: this runtime offered no full collection");
            }

            for (const line of result.firstDiagnostics) {
                out.println(line);
            }
        });
    });

    runtimeOption(
        program
            .command("files")
            .description("Each file's check, ranked by what it created (the first user of a library type pays for it)")
            .argument("[tsconfig]", "A tsconfig.json or the folder holding one (default ./tsconfig.json)")
            .option("--top <n>", "Rows", numberArg({ min: 1, integer: true }), 30)
            .option("--by <key>", `Rank by ${SORT_KEYS.join(", ")} (default instantiations)`, sortKey, "instantiations")
            .option("--folders", "Sum per folder instead of per file")
    ).action(
        async (
            tsconfig: string | undefined,
            options: RuntimeFlags & { top: number; by: SortKey; folders?: boolean },
            command: Command
        ) => {
            await runCheck(command, async (signal) => {
                const result = await runProgramWorker("files", {
                    tsconfig: resolveTsconfig(tsconfig),
                    runtime: options.runtime,
                    heapMiB: options.heap,
                    timeoutMs: options.timeout * 1000,
                    signal,
                });
                const rows: Array<Omit<FileCost, "bytes"> & { name: string; count?: number }> = options.folders
                    ? costByFolder(result.rows).map((row) => ({
                          ...row,
                          file: row.folder,
                          name: row.folder,
                          count: row.files,
                      }))
                    : result.rows.map((row) => ({ ...row, name: row.file }));
                rows.sort((a, b) => b[options.by] - a[options.by]);
                const top = rows.slice(0, options.top);

                if (options.json) {
                    out.result({ ...result, rows: top });
                    return;
                }

                renderCliHeader(
                    `Checker work per ${options.folders ? "folder" : "file"}`,
                    `${result.config} · ranked by ${options.by}`
                );
                const table = createBoxTable([
                    options.folders ? "FOLDER" : "FILE",
                    "INSTANTIATIONS",
                    "TYPES",
                    "SYMBOLS",
                    "MS",
                    ...(options.folders ? ["FILES"] : []),
                ]);

                for (const row of top) {
                    table.push([
                        row.name,
                        n(row.instantiations),
                        n(row.types),
                        n(row.symbols),
                        n(Math.round(row.ms)),
                        ...(options.folders ? [n(row.count ?? 0)] : []),
                    ]);
                }

                out.println(table.toString());
                out.println(
                    `program: types ${n(result.types)} · instantiations ${n(result.instantiations)} · symbols ${n(result.symbols)} · ${n(result.rows.length)} files checked`
                );
                const next = options.folders
                    ? ["program", "files", ...(tsconfig ? [tsconfig] : [])]
                    : [
                          "program",
                          "own",
                          top[0] ? fromCwd(resolve(dirname(result.config), top[0].name)) : "<file>",
                          ...(tsconfig ? ["--tsconfig", tsconfig] : []),
                      ];
                out.println(`Next: ${suggestCommand("tools ts", { replaceCommand: next })}`);
            });
        }
    );

    runtimeOption(
        program
            .command("own")
            .description(
                "One file's own check cost in a program of the targets and the tsconfig's .d.ts files: their imports are checked first, then each target. Compare a file before and after an edit"
            )
            .argument("<files...>", "Files of the project")
            .option("--tsconfig <path>", "The project's tsconfig (default ./tsconfig.json)")
    ).action(async (files: string[], options: RuntimeFlags & { tsconfig?: string }, command: Command) => {
        await runCheck(command, async (signal) => {
            const result = await runProgramWorker("own", {
                tsconfig: resolveTsconfig(options.tsconfig),
                runtime: options.runtime,
                heapMiB: options.heap,
                timeoutMs: options.timeout * 1000,
                signal,
                files,
            });

            if (options.json) {
                out.result(result);
                return;
            }

            const table = createBoxTable(["FILE", "MS", "TYPES", "INSTANTIATIONS", "SYMBOLS", "DIAGNOSTICS"]);

            for (const row of result.rows) {
                table.push([
                    row.file,
                    n(Math.round(row.ms)),
                    n(row.types),
                    n(row.instantiations),
                    n(row.symbols),
                    String(row.diagnostics.length),
                ]);
            }

            out.println(table.toString());

            for (const row of result.rows) {
                for (const line of row.diagnostics.slice(0, 5)) {
                    out.println(line);
                }
            }
        });
    });

    runtimeOption(
        program
            .command("closure")
            .description(
                "What a tsconfig of only one folder would hold, the declaration packages by size, and why a package is in"
            )
            .argument("[tsconfig]", "A tsconfig.json or the folder holding one (default ./tsconfig.json)")
            .option("--top <n>", "Rows per table (default 30)", numberArg({ min: 1, integer: true }), 30)
            .option("--why <needle>", "The import chain from a project file to the first file whose path contains this")
            .option(
                "--no-ambient",
                "Leave out the project's root .d.ts files (a folder tsconfig that does not include them)"
            )
    ).action(
        async (
            tsconfig: string | undefined,
            options: RuntimeFlags & { top: number; why?: string; ambient: boolean },
            command: Command
        ) => {
            await runCheck(command, async (signal) => {
                const graph = await runProgramWorker("graph", {
                    tsconfig: resolveTsconfig(tsconfig),
                    runtime: options.runtime,
                    heapMiB: options.heap,
                    timeoutMs: options.timeout * 1000,
                    signal,
                });

                if (options.why) {
                    const chain = whyChain(graph, options.why);

                    if (options.json) {
                        out.result({ needle: options.why, chain });
                        return;
                    }

                    out.println(
                        chain ? chain.join("\n  -> ") : `no project file reaches a file matching ${options.why}`
                    );
                    return;
                }

                const folders = folderClosures(graph, { ambient: options.ambient });
                const packages = packageSizes(graph);
                const duplicates = duplicatePackages(graph);
                const totalBytes = graph.files.reduce((sum, file) => sum + file.bytes, 0);

                if (options.json) {
                    out.result({ files: graph.files.length, bytes: totalBytes, folders, packages, duplicates });
                    return;
                }

                renderCliHeader(
                    "Program closure",
                    `${graph.config} · ${n(graph.files.length)} files, ${formatBytes(totalBytes)}`
                );
                renderCliSection("A tsconfig of one folder would hold");
                const folderTable = createBoxTable([
                    "FOLDER",
                    "BYTES",
                    "FILES",
                    "OWN",
                    "OTHER FOLDERS",
                    "NODE_MODULES",
                ]);

                for (const row of folders.slice(0, options.top)) {
                    folderTable.push([
                        row.folder,
                        formatBytes(row.bytes),
                        n(row.files),
                        n(row.own),
                        n(row.otherFolderFiles),
                        n(row.nodeModulesFiles),
                    ]);
                }

                out.println(folderTable.toString());
                renderCliSection("Declaration packages by size");
                const packageTable = createBoxTable(["PACKAGE", "BYTES", "FILES", "DIRECT IMPORTERS"]);

                for (const row of packages.slice(0, options.top)) {
                    const importers = row.importers.length
                        ? `${row.importers.length}: ${row.importers.slice(0, 2).join(", ")}${row.importers.length > 2 ? " …" : ""}`
                        : "0 (through other packages)";
                    packageTable.push([row.name, formatBytes(row.bytes), n(row.files), importers]);
                }

                out.println(packageTable.toString());

                if (duplicates.length > 0) {
                    renderCliSection("Packages in the program from more than one installed copy");
                    const duplicateTable = createBoxTable(["PACKAGE", "COPIES", "EXTRA BYTES", "FOLDERS"]);

                    for (const row of duplicates.slice(0, options.top)) {
                        duplicateTable.push([
                            row.name,
                            n(row.copies.length),
                            formatBytes(row.extraBytes),
                            row.copies.map((copy) => `${copy.folder} (${n(copy.files)})`).join("\n"),
                        ]);
                    }

                    out.println(duplicateTable.toString());
                }

                out.println(
                    `Next: ${suggestCommand("tools ts", { replaceCommand: ["program", "closure", ...(tsconfig ? [tsconfig] : []), "--why", packages[0]?.name ?? "<package>"] })}`
                );
            });
        }
    );

    runtimeOption(
        program
            .command("sites")
            .description(
                "Rank what costs the checker most across the program, by what is called or referenced: every call, new, JSX element and type reference measured on its own during the first check"
            )
            .argument("[tsconfig]", "A tsconfig.json or the folder holding one (default ./tsconfig.json)")
            .option("--top <n>", "Rows", numberArg({ min: 1, integer: true }), 30)
            .option("--by <key>", `Rank by ${SITE_SORT_KEYS.join(", ")}`, siteSortKey, "instantiations")
            .option(
                "--min-sites <n>",
                "Only groups with at least this many sites (2 or more finds repeated shapes)",
                numberArg({ min: 1, integer: true }),
                1
            )
            .option("--key <text>", "List the single sites whose key contains this, costliest first, instead of groups")
            .option("--project-only", "Only keys declared in the project, not in packages or default libraries")
    ).action(
        async (
            tsconfig: string | undefined,
            options: RuntimeFlags & {
                top: number;
                by: SiteSortKey;
                minSites: number;
                key?: string;
                projectOnly?: boolean;
            },
            command: Command
        ) => {
            await runCheck(command, async (signal) => {
                const result = await runProgramWorker("sites", {
                    tsconfig: resolveTsconfig(tsconfig),
                    runtime: options.runtime,
                    heapMiB: options.heap,
                    timeoutMs: options.timeout * 1000,
                    signal,
                });
                const attributed = result.sites.reduce((sum, site) => sum + site.instantiations, 0);
                const share = `${((100 * attributed) / Math.max(1, result.instantiations)).toFixed(0)}% of ${n(result.instantiations)} instantiations at ${n(result.sites.length)} sites of ${n(result.minInstantiations)} or more`;

                if (options.key) {
                    const needle = options.key;
                    const rows = sitesForKey(result.sites, needle, options.projectOnly ?? false).slice(0, options.top);

                    if (options.json) {
                        out.result({ key: needle, sites: rows });
                        return;
                    }

                    const table = createBoxTable(["WHERE", "INSTANTIATIONS", "TYPES", "MS", "KIND", "KEY"]);

                    for (const site of rows) {
                        table.push([
                            `${site.file}:${site.line}`,
                            n(site.instantiations),
                            n(site.types),
                            n(Math.round(site.ms)),
                            site.kind,
                            site.key,
                        ]);
                    }

                    out.println(table.toString());
                    return;
                }

                const groups = sortGroups(
                    groupSites(result.sites).filter(
                        (group) => group.sites >= options.minSites && (!options.projectOnly || !group.external)
                    ),
                    options.by
                ).slice(0, options.top);

                if (options.json) {
                    out.result({ ...result, sites: undefined, groups, attributed });
                    return;
                }

                renderCliHeader("Checker work by what is called", `${result.config} · ${share}`);
                const table = createBoxTable([
                    "KIND",
                    "KEY",
                    "INSTANTIATIONS",
                    "MEDIAN",
                    "SITES",
                    "FILES",
                    "MS",
                    "COSTLIEST",
                ]);

                for (const group of groups) {
                    table.push([
                        group.kind,
                        group.key,
                        n(group.instantiations),
                        n(group.medianInstantiations),
                        n(group.sites),
                        n(group.files),
                        n(group.ms),
                        `${group.max.file}:${group.max.line} (${n(group.max.instantiations)})`,
                    ]);
                }

                out.println(table.toString());
                out.println(
                    "A high MEDIAN over many SITES is a code shape that costs at every use; one large site with a low median is the first use of a library type."
                );
                const first = groups[0];

                if (first) {
                    out.println(
                        `Next: ${suggestCommand("tools ts", { replaceCommand: ["program", "sites", ...(tsconfig ? [tsconfig] : []), "--key", first.key.split(" @ ")[0] ?? first.key] })}`
                    );
                }
            });
        }
    );

    program
        .command("trace")
        .description(
            "Run tsc --generateTrace (or read a trace folder) and list the slowest files and expressions with their source line"
        )
        .argument("[tsconfig]", "A tsconfig.json or the folder holding one (default ./tsconfig.json)")
        .option("--dir <path>", "An existing --generateTrace folder to read instead of running tsc")
        .option("--top <n>", "Rows per table (default 30)", numberArg({ min: 1, integer: true }), 30)
        .option("--min-ms <n>", "Smallest single check event to list (default 50)", numberArg({ min: 1 }), 50)
        .option("--heap <MiB>", "Heap limit of tsc (default 16384)", numberArg({ min: 64, integer: true }))
        .option(...timeoutOption())
        .option("--json", "The result as JSON")
        .action(
            async (
                tsconfig: string | undefined,
                options: { dir?: string; top: number; minMs: number; heap?: number; timeout: number; json?: boolean },
                command: Command
            ) => {
                await runCheck(command, async (signal) => {
                    const config = resolveTsconfig(tsconfig);
                    if (!options.dir) {
                        out.log.info("tsc --generateTrace (a large program takes a minute)");
                    }

                    const dir =
                        options.dir ??
                        (await generateTrace({
                            tsconfig: config,
                            heapMiB: options.heap,
                            timeoutMs: options.timeout * 1000,
                            signal,
                        }));
                    const report = analyzeTrace({
                        traceJson: readFileSync(join(dir, "trace.json"), "utf8"),
                        root: dirname(config),
                        minMs: options.minMs,
                    });

                    if (options.json) {
                        out.result({
                            dir,
                            ...report,
                            files: report.files.slice(0, options.top),
                            hotSpots: report.hotSpots.slice(0, options.top),
                        });
                        return;
                    }

                    renderCliHeader(
                        "Trace hot spots",
                        `${dir} · check ${(report.checkMs / 1000).toFixed(1)} s over ${n(report.files.length)} files`
                    );
                    const fileTable = createBoxTable(["FILE", "CHECK MS"]);

                    for (const file of report.files.slice(0, options.top)) {
                        fileTable.push([file.file, n(file.ms)]);
                    }

                    out.println(fileTable.toString());
                    renderCliSection(`Slowest check events of at least ${options.minMs} ms (nested events overlap)`);
                    const spotTable = createBoxTable(["WHERE", "MS", "EVENT", "SOURCE"]);

                    for (const spot of report.hotSpots.slice(0, options.top)) {
                        spotTable.push([`${spot.file}:${spot.line}`, n(spot.ms), spot.event, spot.source]);
                    }

                    out.println(spotTable.toString());
                });
            }
        );

    program.addHelpText(
        "after",
        [
            "",
            "Examples:",
            `  ${toolCommand("ts program cost", "--heap", "3072")}`,
            `  ${toolCommand("ts program files", "--folders")}`,
            `  ${toolCommand("ts program own", "src/artifact/runtime/kit/chartjs.tsx")}`,
            `  ${toolCommand("ts program closure", "--why", "stripe")}`,
            `  ${toolCommand("ts program trace", "--min-ms", "100")}`,
            `  ${toolCommand("ts program sites", "--min-sites", "5", "--by", "median")}`,
        ].join("\n")
    );
}
