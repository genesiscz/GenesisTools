import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { suggestCommand } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    checkDocument,
    type DocumentCheck,
    loadDocumentModule,
    writeDocument,
} from "@genesiscz/utils/json2md/document-file";
import { type CheckResult, stripStamp, type Verdict } from "@genesiscz/utils/json2md/integrity";
import { logger, out } from "@genesiscz/utils/logger";
import { PACKAGE_NAME, packageResolvesFrom, shadowedByFor } from "@genesiscz/utils/package-link";
import { createBoxTable, formatDotStatus, renderCliHeader } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";

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

/** The shorter of the repo-relative and absolute forms, so a `/tmp` path is not `../../../..`. */
function short(path: string): string {
    const rel = relative(process.cwd(), path);

    if (rel === "") {
        return path;
    }

    return rel.length < path.length ? rel : path;
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
            "Generating it once starts the tracking.",
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

const PACKAGE_SPECIFIER = "@genesiscz/utils/json2md/document-file";

/**
 * The scaffolded module ALWAYS carries the package specifier, wherever it lands.
 *
 * An earlier version wrote an absolute path when the package did not resolve. That produced a
 * module that ran on exactly one machine and committed a home directory into whatever repo
 * the document lived in. The portable import plus a one-time `tools link install` is the
 * better trade: the file is the same everywhere, and the setup is visible and reversible.
 */
function template(input: { data: string; title: string; moduleName: string }): string {
    return `import { defineDocument } from ${SafeJSON.stringify(PACKAGE_SPECIFIER)};

/**
 * Generated document. Three files work together:
 *
 *   ${input.data}   the data
 *   ${input.moduleName}   this file, the only place a shape decision lives
 *   ${input.moduleName.replace(/\.ts$/, ".md")}   the output, never edited by hand
 *
 * Regenerate:  tools json2md build ${input.moduleName}
 * Verify:      tools json2md check ${input.moduleName}
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

function registerBuild(program: Command): void {
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
                const definition = await loadDocumentModule(modulePath);
                const result = await writeDocument(modulePath, definition, {
                    force: flags.force,
                    dryRun: flags.dryRun,
                });

                logger.debug({ file: modulePath, outcome: result.outcome, out: result.outPath }, "json2md: build");

                if (result.outcome === "refused" && result.check) {
                    refused += 1;
                    out.log.error(`${short(result.outPath)} was edited by hand. Refusing to overwrite it.`);

                    for (const line of guidance(result.check)) {
                        out.log.info(line);
                    }

                    out.log.info(suggestCommand("tools json2md", { replaceCommand: ["build", file, "--force"] }));
                    continue;
                }

                if (result.outcome === "unchanged") {
                    out.log.info(`${short(result.outPath)} is already up to date.`);
                    continue;
                }

                out.log.success(`${short(result.outPath)} written from ${short(result.dataPath)}.`);
            }

            if (refused > 0) {
                process.exitCode = 1;
            }
        });
}

function registerCheck(program: Command): void {
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
                    out.log.error(`${short(given)} has no stamp naming its generator, so it cannot be checked.`);
                    process.exitCode = 1;
                    continue;
                }

                const definition = await loadDocumentModule(modulePath);
                results.push(await checkDocument(modulePath, definition));
            }

            const failing = results.filter((result) => VERDICT[result.verdict].fails);

            if (flags.quiet && failing.length === 0) {
                return;
            }

            if (results.length > 0) {
                renderCliHeader("json2md check", `${results.length} document(s)`);
                const table = createBoxTable(["DOCUMENT", "VERDICT", "DATA", "NOTE"]);

                for (const result of results) {
                    const shape = VERDICT[result.verdict];

                    table.push([
                        pc.white(short(result.outPath)),
                        formatDotStatus(shape.dot, shape.label),
                        result.dataChanged ? pc.yellow("changed") : pc.dim("same"),
                        result.message,
                    ]);
                }

                out.println(table.toString());
            }

            for (const result of failing) {
                out.println("");
                out.println(pc.bold(short(result.outPath)));

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

function registerInit(program: Command): void {
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
                out.log.error(`${short(modulePath)} already exists. Not overwriting it.`);
                process.exitCode = 1;

                return;
            }

            // Whether the data is OURS decides which template can be written. The rich sample
            // template names `summary.total` and `items`, which only exist in the sample we
            // write: pointed at real data with `--data`, it scaffolded a module that threw
            // `undefined is not an object` on its very first build.
            if (!(await Bun.file(dataPath).exists())) {
                await Bun.write(dataPath, `${SafeJSON.stringify(JSON_SAMPLE, null, 4)}\n`);
                out.log.success(`Created ${short(dataPath)} with sample data.`);
            }

            const relativeData = relative(dirname(modulePath), dataPath).replace(/\\/g, "/");
            const dataSpecifier = relativeData.startsWith(".") ? relativeData : `./${relativeData}`;

            await Bun.write(modulePath, template({ data: dataSpecifier, title, moduleName: basename(modulePath) }));
            out.log.success(`Created ${short(modulePath)}.`);

            // 🛑 Stop before the first build rather than after it. The module is correct and
            // portable, but nothing under this directory can resolve the package yet, so the
            // build would fail with a resolution error that reads like a bug in the document.
            if (!packageResolvesFrom(dirname(modulePath))) {
                out.log.warn(`${PACKAGE_NAME} does not resolve from ${short(dirname(modulePath))} yet.`);

                // 🛑 Two different causes, two different fixes. A home-directory install cannot
                // reach a folder whose own tsconfig shadows it, so suggesting one there sends
                // the user to a command that will report success and change nothing.
                const shadowedBy = shadowedByFor(dirname(modulePath));

                if (shadowedBy === null) {
                    out.log.info("One command fixes it for every file under your home directory:");
                    out.log.info(suggestCommand("tools link", { replaceCommand: ["install"] }));
                } else {
                    // Absolute, not `short()`: this names a place the user has to go and act
                    // on, and a cwd-relative form renders it as `../../..`, which tells them
                    // nothing. The same reasoning governs every path `tools link` prints.
                    out.log.info(`${shadowedBy} is nearer, and Bun reads only the nearest tsconfig.`);
                    out.log.info("So it hides any mapping above it. Install into that project instead:");
                    out.log.info(
                        suggestCommand("tools link", {
                            replaceCommand: ["install", "--root", dirname(shadowedBy)],
                        })
                    );
                }

                out.log.info(`Then: tools json2md build ${short(modulePath)}`);
                process.exitCode = 1;

                return;
            }

            const definition = await loadDocumentModule(modulePath);
            const result = await writeDocument(modulePath, definition);

            out.log.success(`Created ${short(result.outPath)}.`);
            out.log.info(`Regenerate with  tools json2md build ${short(modulePath)}`);
            out.log.info(`Verify with      tools json2md check ${short(modulePath)}`);
        });
}

export function registerDocumentCommands(program: Command): void {
    registerBuild(program);
    registerCheck(program);
    registerInit(program);
}
