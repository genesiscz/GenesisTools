import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import { SafeJSON } from "@genesiscz/utils/json";
import {
    checkDocument,
    type DocumentCheck,
    loadDocumentModule,
    writeDocument,
} from "@genesiscz/utils/json2md/document-file";
import { type DocumentEnvironment, shortPath } from "@genesiscz/utils/json2md/environment";
import { type CheckResult, stripStamp, type Verdict } from "@genesiscz/utils/json2md/integrity";
import { logger, out } from "@genesiscz/utils/logger";
import { createBoxTable, formatDotStatus, renderCliHeader } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { documentEnvironment } from "./document-env";

/** How each verdict is shown, and whether it should fail the command. */
const VERDICT: Record<Verdict, { dot: "ok" | "warn" | "err" | "dim"; label: string; fails: boolean }> = {
    clean: { dot: "ok", label: "clean", fails: false },
    stale: { dot: "warn", label: "stale", fails: true },
    "hand-edited": { dot: "err", label: "hand-edited", fails: true },
    unstamped: { dot: "dim", label: "unstamped", fails: false },
    unsupported: { dot: "err", label: "unsupported", fails: true },
};

function absolute(path: string): string {
    return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

/**
 * Turns a verdict into instructions.
 *
 * A verdict alone is not actionable. "hand-edited" tells the reader something happened; these
 * lines tell them which of the four possible homes the edit actually belongs in.
 */
function guidance(check: CheckResult): string[] {
    if (check.verdict === "hand-edited") {
        return [
            "Someone edited the generated markdown directly. Regenerating would discard that edit.",
            "Move the edit to where it belongs, then regenerate:",
            "  1. it is a data fix    → put it in the .json file",
            "  2. it is a shape fix   → put it in the .ts render function",
            "  3. it is one-off prose → put it in a file that is not generated",
            "  4. it was a mistake    → re-run with --force, which overwrites it",
        ];
    }

    if (check.verdict === "stale") {
        return [
            check.dataChanged
                ? "The data moved and nobody touched the markdown."
                : "The generator changed since this file was written.",
            "Regenerating is safe.",
        ];
    }

    if (check.verdict === "unstamped") {
        return [
            "This file carries no stamp, so a hand edit cannot be ruled out.",
            "If nothing in it needs keeping, build once with --force to overwrite it and start the tracking.",
        ];
    }

    if (check.verdict === "unsupported") {
        return ["The stamp is newer than this build. Upgrade GenesisTools rather than regenerating."];
    }

    return [];
}

function colourDiff(diff: string): string {
    return diff
        .split("\n")
        .map((line) => {
            if (line.startsWith("+")) {
                return pc.green(line);
            }

            if (line.startsWith("-")) {
                return pc.red(line);
            }

            return pc.dim(line);
        })
        .join("\n");
}

/** Finds the generator that a markdown file's own stamp names. */
async function moduleForMarkdown(markdownPath: string): Promise<string | null> {
    const file = Bun.file(markdownPath);

    if (!(await file.exists())) {
        return null;
    }

    const { stamp } = stripStamp(await file.text());

    if (!stamp?.generator) {
        return null;
    }

    return resolve(dirname(markdownPath), stamp.generator);
}

const JSON_SAMPLE = {
    summary: { total: 3, done: 1 },
    items: [
        { id: 1, name: "first", status: "done" },
        { id: 2, name: "second", status: "open" },
        { id: 3, name: "third", status: "open" },
    ],
};

/**
 * The scaffolded module ALWAYS carries the package specifier, wherever it lands.
 *
 * An earlier version wrote an absolute path when the package did not resolve. That produced a
 * module that ran on exactly one machine and committed a home directory into whatever repo
 * the document lived in. The portable import plus a one-time `tools link install` is the
 * better trade: the file is the same everywhere, and the setup is visible and reversible.
 */
function template(input: {
    data: string;
    title: string;
    moduleName: string;
    specifier: string;
    build?: string;
    check?: string;
}): string {
    return `import { defineDocument } from ${SafeJSON.stringify(input.specifier)};

/**
 * Generated document. Three files work together:
 *
 *   ${input.data}   the data
 *   ${input.moduleName}   this file, the only place a shape decision lives
 *   ${input.moduleName.replace(/\.ts$/, ".md")}   the output, never edited by hand
 *
${input.build ? ` * Regenerate:  ${input.build}\n` : ""}${input.check ? ` * Verify:      ${input.check}\n` : ""} *
 *
 * The .md carries a stamp recording the hash of the generated body, so a hand edit is
 * detected and the build refuses to overwrite it.
 */

interface Item {
    id: number;
    name: string;
    status: string;
}

interface Data {
    summary: { total: number; done: number };
    items: Item[];
}

export default defineDocument<Data>({
    data: ${SafeJSON.stringify(input.data)},
    options: {
        title: ${SafeJSON.stringify(input.title)},
        provenance: { scope: "generated from the JSON beside this file" },
    },
    render: (d) => [
        {
            badges: [
                { label: "total", value: d.summary.total },
                { label: "done", value: d.summary.done },
            ],
        },
        { h2: "Items" },
        {
            table: {
                rows: d.items,
                columns: [
                    { key: "id", align: "right" },
                    { key: "name", header: "Name" },
                    { key: "status", header: "Status" },
                ],
            },
        },
    ],
});
`;
}

function registerBuild(program: Command, env: DocumentEnvironment): void {
    program
        .command("build")
        .description("Render one or more document modules to their .md files")
        .argument("<files...>", "document modules (.ts) that default-export defineDocument(...)")
        .option("--force", "overwrite even when the markdown was edited by hand")
        .option("--dry-run", "render and report, but write nothing")
        .action(async (files: string[], flags: { force?: boolean; dryRun?: boolean }) => {
            let refused = 0;

            for (const file of files) {
                const modulePath = absolute(file);
                const unlinkedDir = await env.unresolvedImporterDir(modulePath);

                if (unlinkedDir) {
                    refused += 1;
                    env.reportUnresolved(unlinkedDir, "error");
                    continue;
                }

                const definition = await loadDocumentModule(modulePath);
                const result = await writeDocument(modulePath, definition, {
                    force: flags.force,
                    dryRun: flags.dryRun,
                    ...env.hints(),
                });

                logger.debug({ file: modulePath, outcome: result.outcome, out: result.outPath }, "json2md: build");

                if (result.outcome === "refused" && result.check) {
                    refused += 1;
                    out.log.error(`${shortPath(result.outPath)}: ${result.check.message} Refusing to overwrite it.`);

                    for (const line of guidance(result.check)) {
                        out.log.info(line);
                    }

                    const forceCommand = env.forceBuildCommand?.(file);
                    if (forceCommand) {
                        out.log.info(forceCommand);
                    }

                    continue;
                }

                // A dry run reports `unchanged` for everything it did not write, including a file
                // it WOULD write (missing, or stale). Only a `clean` check means up to date.
                if (flags.dryRun && result.outcome === "unchanged" && result.check?.verdict !== "clean") {
                    out.log.info(
                        `${shortPath(result.outPath)} would be written from ${shortPath(result.dataPath)} (dry run).`
                    );
                    continue;
                }

                if (result.outcome === "unchanged") {
                    out.log.info(`${shortPath(result.outPath)} is already up to date.`);
                    continue;
                }

                out.log.success(`${shortPath(result.outPath)} written from ${shortPath(result.dataPath)}.`);
            }

            if (refused > 0) {
                process.exitCode = 1;
            }
        });
}

function registerCheck(program: Command, env: DocumentEnvironment): void {
    program
        .command("check")
        .description("Report whether generated markdown is current, stale, or edited by hand")
        .argument("<files...>", "document modules (.ts), or the generated .md files")
        .option("--quiet", "print nothing when everything is clean")
        .action(async (files: string[], flags: { quiet?: boolean }) => {
            const results: DocumentCheck[] = [];

            for (const file of files) {
                const given = absolute(file);
                const modulePath = given.endsWith(".md") ? await moduleForMarkdown(given) : given;

                if (modulePath === null) {
                    out.log.error(`${shortPath(given)} has no stamp naming its generator, so it cannot be checked.`);
                    process.exitCode = 1;
                    continue;
                }

                const unlinkedDir = await env.unresolvedImporterDir(modulePath);

                if (unlinkedDir) {
                    env.reportUnresolved(unlinkedDir, "error");
                    process.exitCode = 1;
                    continue;
                }

                const definition = await loadDocumentModule(modulePath);
                results.push(await checkDocument(modulePath, definition, env.hints()));
            }

            // A document that was never generated reads as `unstamped`, which is not a failure for
            // an existing hand-kept file, but a missing output must fail the CI gate built on this.
            const failing = results.filter((result) => !result.exists || VERDICT[result.verdict].fails);

            if (flags.quiet && failing.length === 0) {
                return;
            }

            if (results.length > 0) {
                renderCliHeader("json2md check", `${results.length} document(s)`);
                const table = createBoxTable(["DOCUMENT", "VERDICT", "DATA", "NOTE"]);

                for (const result of results) {
                    const shape = VERDICT[result.verdict];

                    table.push([
                        pc.white(shortPath(result.outPath)),
                        formatDotStatus(shape.dot, shape.label),
                        result.dataChanged ? pc.yellow("changed") : pc.dim("same"),
                        result.message,
                    ]);
                }

                out.println(table.toString());
            }

            for (const result of failing) {
                out.println("");
                out.println(pc.bold(shortPath(result.outPath)));

                for (const line of guidance(result)) {
                    out.println(`  ${line}`);
                }

                if (result.diff) {
                    out.println("");
                    out.println(colourDiff(result.diff));
                }
            }

            if (failing.length > 0) {
                process.exitCode = 1;
            }
        });
}

function registerInit(program: Command, env: DocumentEnvironment): void {
    program
        .command("init")
        .description("Scaffold the three-file pattern: data.json, doc.ts, doc.md")
        .argument("<name>", "base path, for example ./reports/ConversionRegistry")
        .option("--title <text>", "document title")
        .option("--data <json>", "existing JSON file to adopt as the data source")
        .action(async (name: string, flags: { title?: string; data?: string }) => {
            const base = absolute(name).replace(/\.(json|ts|md)$/, "");
            const dataPath = flags.data ? absolute(flags.data) : `${base}.json`;
            const modulePath = `${base}.ts`;
            const title = flags.title ?? basename(base);

            if (await Bun.file(modulePath).exists()) {
                out.log.error(`${shortPath(modulePath)} already exists. Not overwriting it.`);
                process.exitCode = 1;

                return;
            }

            // `--data` ADOPTS an existing file. A typo in it used to create sample data at the
            // mistyped path and carry on, turning a bad path into a valid but unrelated document.
            // Sample data is only for the default `<name>.json`, which the scaffold owns.
            if (flags.data && !(await Bun.file(dataPath).exists())) {
                out.log.error(
                    `--data ${shortPath(dataPath)} does not exist. Pass an existing JSON file, or omit --data for sample data.`
                );
                process.exitCode = 1;

                return;
            }

            // Whether the data is OURS decides which template can be written. The rich sample
            // template names `summary.total` and `items`, which only exist in the sample we
            // write: pointed at real data with `--data`, it scaffolded a module that threw
            // `undefined is not an object` on its very first build.
            if (!(await Bun.file(dataPath).exists())) {
                await Bun.write(dataPath, `${SafeJSON.stringify(JSON_SAMPLE, null, 4)}\n`);
                out.log.success(`Created ${shortPath(dataPath)} with sample data.`);
            }

            const relativeData = relative(dirname(modulePath), dataPath).replace(/\\/g, "/");
            const dataSpecifier = relativeData.startsWith(".") ? relativeData : `./${relativeData}`;

            await Bun.write(
                modulePath,
                template({
                    data: dataSpecifier,
                    title,
                    moduleName: basename(modulePath),
                    specifier: env.scaffoldSpecifier,
                    build: env.hints().rebuildCommand?.(basename(modulePath)),
                    check: env.checkCommand?.(basename(modulePath)),
                })
            );
            out.log.success(`Created ${shortPath(modulePath)}.`);

            // 🛑 Stop before the first build rather than after it. The module is correct and
            // portable, but nothing under this directory can resolve the package yet, so the
            // build would fail with a resolution error that reads like a bug in the document.
            const unresolvedDir = await env.unresolvedImporterDir(modulePath);

            if (unresolvedDir !== null) {
                env.reportUnresolved(unresolvedDir, "warn");

                // The scaffold files were created; not being linked yet is guidance for the
                // next step, not a failure, so this stays exit 0.
                const build = env.hints().rebuildCommand?.(shortPath(modulePath));
                if (build) {
                    out.log.info(`Then: ${build}`);
                }

                return;
            }

            const definition = await loadDocumentModule(modulePath);
            const result = await writeDocument(modulePath, definition, env.hints());

            if (result.outcome === "refused" && result.check) {
                // A markdown file already sits at the output path. It is left alone.
                out.log.error(`${shortPath(result.outPath)}: ${result.check.message} Refusing to overwrite it.`);

                for (const line of guidance(result.check)) {
                    out.log.info(line);
                }

                process.exitCode = 1;

                return;
            }

            out.log.success(`Created ${shortPath(result.outPath)}.`);
            const build = env.hints().rebuildCommand?.(shortPath(modulePath));
            const check = env.checkCommand?.(shortPath(modulePath));
            if (build) {
                out.log.info(`Regenerate with  ${build}`);
            }

            if (check) {
                out.log.info(`Verify with      ${check}`);
            }
        });
}

/**
 * `build`, `check` and `init`. The environment holds everything that depends on the hosting program (the stamp's
 * rebuild command, the transclusion hints, the package resolve check and the scaffold import); the default is this
 * program's own, from the `document-env` seam.
 */
export function registerDocumentCommands(program: Command, env: DocumentEnvironment = documentEnvironment()): void {
    registerBuild(program, env);
    registerCheck(program, env);
    registerInit(program, env);
}
