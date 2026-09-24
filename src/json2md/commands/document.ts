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

const PACKAGE_SPECIFIER = "@genesiscz/utils/json2md/document-file";

/**
 * The import the scaffolded module should use for `defineDocument`.
 *
 * Inside a repo that maps `@genesiscz/utils` (GenesisTools itself, or a sibling repo with the
 * vendored copy) the package specifier is right. Anywhere else it would not resolve, so the
 * template falls back to an absolute path and the generated document still runs.
 */
function documentFileSpecifier(moduleDir: string): string {
    try {
        Bun.resolveSync(PACKAGE_SPECIFIER, moduleDir);

        return PACKAGE_SPECIFIER;
    } catch (error) {
        logger.debug({ moduleDir, error }, "json2md: package specifier does not resolve, using a relative import");

        // An absolute path, not a relative one. On macOS `/tmp` is a symlink to `/private/tmp`,
        // so a path computed relative to `/tmp/x` resolves from `/private/tmp/x` and misses.
        return resolve(import.meta.dir, "../../utils/json2md/document-file.ts");
    }
}

function template(input: { data: string; title: string; moduleName: string; specifier: string }): string {
    return `import { defineDocument } from ${SafeJSON.stringify(input.specifier)};

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
                    out.log.error(`${short(result.outPath)}: ${result.check.message} Refusing to overwrite it.`);

                    for (const line of guidance(result.check)) {
                        out.log.info(line);
                    }

                    out.log.info(suggestCommand("tools json2md", { replaceCommand: ["build", file, "--force"] }));
                    continue;
                }

                // A dry run reports `unchanged` for everything it did not write, including a file
                // it WOULD write (missing, or stale). Only a `clean` check means up to date.
                if (flags.dryRun && result.outcome === "unchanged" && result.check?.verdict !== "clean") {
                    out.log.info(`${short(result.outPath)} would be written from ${short(result.dataPath)} (dry run).`);
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

            if (!(await Bun.file(dataPath).exists())) {
                await Bun.write(dataPath, `${SafeJSON.stringify(JSON_SAMPLE, null, 4)}\n`);
                out.log.success(`Created ${short(dataPath)} with sample data.`);
            }

            const relativeData = relative(dirname(modulePath), dataPath).replace(/\\/g, "/");
            const dataSpecifier = relativeData.startsWith(".") ? relativeData : `./${relativeData}`;

            await Bun.write(
                modulePath,
                template({
                    data: dataSpecifier,
                    title,
                    moduleName: basename(modulePath),
                    specifier: documentFileSpecifier(dirname(modulePath)),
                })
            );
            out.log.success(`Created ${short(modulePath)}.`);

            const definition = await loadDocumentModule(modulePath);
            const result = await writeDocument(modulePath, definition);

            if (result.outcome === "refused" && result.check) {
                // A markdown file already sits at the output path. It is left alone.
                out.log.error(`${short(result.outPath)}: ${result.check.message} Refusing to overwrite it.`);

                for (const line of guidance(result.check)) {
                    out.log.info(line);
                }

                process.exitCode = 1;

                return;
            }

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
