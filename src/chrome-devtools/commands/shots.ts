/** shots run | list | check | rehearse: annotated page shots from a shot book (lib/shots/). */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";
import { BROWSER_KINDS, type BrowserKind, loadShotBook, type ShotBook, selectShots } from "../lib/shots/book.ts";
import { rehearseShots, runShots, type ShotResult, todayTag } from "../lib/shots/run.ts";

interface BookOptions {
    only?: string;
    base?: string;
    browser?: string;
    port?: string;
    json?: boolean;
}

function onlyOf(opts: BookOptions): string[] | undefined {
    return opts.only
        ?.split(",")
        .map((name) => name.trim())
        .filter(Boolean);
}

function browserOf(opts: BookOptions): BrowserKind | undefined {
    if (opts.browser === undefined) {
        return undefined;
    }

    const kind = BROWSER_KINDS.find((known) => known === opts.browser);
    if (!kind) {
        throw new Error(`--browser must be ${BROWSER_KINDS.join(" or ")}, got ${opts.browser}`);
    }

    return kind;
}

function portOf(opts: BookOptions): number | undefined {
    const port = opts.port === undefined ? undefined : Number(opts.port);
    if (port !== undefined && !Number.isInteger(port)) {
        throw new Error(`--port must be a port number, got ${opts.port}`);
    }

    return port;
}

async function book(path: string, opts: BookOptions): Promise<ShotBook> {
    return loadShotBook(path, opts.base ? { base: opts.base } : {});
}

function resultLine(
    result: ShotResult | { status: "ok" | "failed"; id: string; stem: string; problems?: string[]; notes?: string[] }
): string {
    const head = `${result.status === "ok" ? pc.green("ok  ") : pc.red("FAIL")} ${result.id.padEnd(4)} ${result.stem}`;
    const detail =
        result.status === "ok"
            ? (result.notes ?? []).map((note) => pc.dim(`       ${note}`))
            : (result.problems ?? []).map((problem) => `       ${problem}`);
    return [head, ...detail].join("\n");
}

/** Runs a command action and turns a thrown error into one red line and exit 1. */
function guarded<A extends unknown[]>(action: (...args: A) => Promise<number>): (...args: A) => Promise<void> {
    return async (...args) => {
        try {
            process.exitCode = await action(...args);
        } catch (error) {
            out.log.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    };
}

function withBookOptions(command: Command): Command {
    return command
        .option("--only <ids>", "comma-separated shot ids or stems (default: all)")
        .option("--base <url>", "the app's base URL (overrides the book's base)");
}

function withBrowserOptions(command: Command): Command {
    return command
        .option(
            "--browser <kind>",
            `headless (a fresh Chrome, cookies copied in memory) or attach (your running browser); default: the book's`
        )
        .option("--port <n>", "the debug port of the browser to attach to, or to copy login cookies from");
}

export function registerShots(program: Command): void {
    const shots = program
        .command("shots")
        .description(
            "annotated page shots from a shot book: boxes and labels drawn into the page in its own font, a raw and an annotated image per shot"
        );

    withBrowserOptions(withBookOptions(shots.command("run <book>")))
        .description(
            "take every shot of the book (or --only some) and write <stem>.<tag>.webp and <stem>.<tag>.original.webp"
        )
        .option("--out <dir>", "output folder (default: a new folder in the temp dir)")
        .option("--tag <tag>", "file tag (default: month and day, 1109 for 9 November)")
        .option("--json", "the run report as JSON on stdout")
        .action(
            guarded(async (path: string, opts: BookOptions & { out?: string; tag?: string }) => {
                const loaded = await book(path, opts);
                const outDir = opts.out ? resolve(opts.out) : mkdtempSync(join(tmpdir(), "shots-"));
                const report = await runShots(loaded, {
                    only: onlyOf(opts),
                    tag: opts.tag ?? todayTag(),
                    out: outDir,
                    use: browserOf(opts),
                    port: portOf(opts),
                    onResult: opts.json ? undefined : (result) => out.println(resultLine(result)),
                });
                const failed = report.results.filter((result) => result.status === "failed").length;
                if (opts.json) {
                    out.result(report);
                } else {
                    out.println(
                        `\n${report.results.length - failed} of ${report.results.length} shots in ${report.out}${report.reproducible ? "" : pc.yellow(" (your own browser: extensions and zoom may show)")}`
                    );
                }

                return failed === 0 ? 0 : 1;
            })
        );

    withBookOptions(shots.command("list <book>"))
        .description("the book's shots: id, stem, parts, first url and note; no browser")
        .option("--json", "the list as JSON")
        .action(
            guarded(async (path: string, opts: BookOptions) => {
                const loaded = await book(path, opts);
                const rows = selectShots(loaded, onlyOf(opts)).map((shot) => ({
                    id: shot.id,
                    stem: shot.stem,
                    parts: shot.parts.length,
                    url: shot.parts[0].url ?? "(current tab)",
                    note: shot.note ?? "",
                }));
                if (opts.json) {
                    out.result(rows);
                    return 0;
                }

                for (const row of rows) {
                    out.println(
                        `${row.id.padEnd(4)} ${row.stem.padEnd(30)} ${row.parts > 1 ? `${row.parts} parts ` : ""}${row.url}  ${pc.dim(row.note)}`
                    );
                }

                return 0;
            })
        );

    withBookOptions(shots.command("check <book>"))
        .description("read the book and parse every locator, mark and part; no browser, nothing changes (safe in CI)")
        .action(
            guarded(async (path: string, opts: BookOptions) => {
                const loaded = await book(path, opts);
                const selected = selectShots(loaded, onlyOf(opts));
                const marks = selected.reduce(
                    (sum, shot) => sum + shot.parts.reduce((parts, part) => parts + part.marks.length, 0),
                    0
                );
                out.println(`${pc.green("ok")} ${selected.length} shots, ${marks} marks in ${loaded.file}`);
                return 0;
            })
        );

    withBrowserOptions(withBookOptions(shots.command("rehearse <book>")))
        .description(
            "visit every part, run its steps, resolve every locator and place every label, but take no image: what run would fail on"
        )
        .action(
            guarded(async (path: string, opts: BookOptions) => {
                const loaded = await book(path, opts);
                const results = await rehearseShots(loaded, {
                    only: onlyOf(opts),
                    use: browserOf(opts),
                    port: portOf(opts),
                });
                for (const result of results) {
                    out.println(resultLine(result));
                }

                const failed = results.filter((result) => result.status === "failed").length;
                out.println(`\n${results.length - failed} of ${results.length} shots would succeed`);
                return failed === 0 ? 0 : 1;
            })
        );
}
