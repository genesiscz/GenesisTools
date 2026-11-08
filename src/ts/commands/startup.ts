import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import type { Block } from "@genesiscz/utils/json2md";
import { formatTable } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { DEFAULT_RUNS, DEFAULT_TIMEOUT_MS } from "../lib/analyze";
import { emit, resolveFormat, UsageError } from "../lib/format";
import { labelOf, realPath } from "../lib/import-index";
import { fmtMs } from "../lib/render";
import {
    importFailureOf,
    measureStartup,
    type StartupEntry,
    type StartupReport,
    startupEntryFor,
    summarizeStartup,
    toolEntriesIn,
} from "../lib/startup";
import { addFormatOptions, type FormatCliFlags, numberArg, runUsage } from "./options";

interface StartupCliOptions extends FormatCliFlags {
    tools?: string[];
    runs?: number;
    timeout?: number;
    minMs?: number;
    top?: number;
    concurrency?: number;
    walkPackages?: boolean;
    includeDynamic?: boolean;
}

const DEFAULT_MIN_MS = 20;
const DEFAULT_TOP = 3;

function collect(value: string, previous: string[] = []): string[] {
    return [...previous, value];
}

function noteOf(entry: StartupEntry): string {
    if (entry.error) {
        return `error: ${entry.error}`;
    }

    if (entry.timedOut) {
        return `PARTIAL: timed out, ${entry.unmeasured} module(s) unmeasured`;
    }

    return entry.unmeasured > 0 ? `${entry.unmeasured} module(s) unmeasured` : "";
}

/** A failed or partial entry shows no cold time: the number it has is the time to the failure. */
function coldOf(entry: StartupEntry): string {
    if (entry.error) {
        return "failed";
    }

    return entry.timedOut ? "partial" : fmtMs(entry.coldMs);
}

function topOf(entry: StartupEntry): string {
    return entry.top.map((cost) => `${cost.module} ${Math.round(cost.selfMs)}`).join(" · ");
}

function renderText(report: StartupReport): string[] {
    const lines: string[] = [];

    lines.push("");
    lines.push(
        `${pc.bold("startup")} ${pc.green(`${report.entries.length} entr${report.entries.length === 1 ? "y" : "ies"}`)} ${pc.dim(
            `· fastest of ${report.runs} run(s) per module · recurring threshold ${report.minMs} ms self time`
        )}`
    );
    lines.push("");
    lines.push(
        ...formatTable(
            report.entries.map((entry) => [
                entry.entry,
                coldOf(entry),
                String(entry.modules),
                topOf(entry),
                noteOf(entry),
            ]),
            ["ENTRY", "COLD", "MODULES", "HEAVIEST SELF TIME (ms)", "NOTE"],
            { alignRight: [1, 2], maxColWidth: 90 }
        ).split("\n")
    );
    lines.push("");
    lines.push(
        pc.bold(pc.underline("Recurring heavy modules")) +
            pc.dim(`  (self time of at least ${report.minMs} ms in two or more entries)`)
    );

    if (report.recurring.length === 0) {
        lines.push(pc.dim("  none"));
        return lines;
    }

    lines.push(
        ...formatTable(
            report.recurring.map((row) => [
                row.module,
                String(row.entries),
                fmtMs(row.totalMs),
                fmtMs(row.maxMs),
                row.paidBy.join(", "),
            ]),
            ["MODULE", "ENTRIES", "SUMMED", "MAX", "PAID BY"],
            { alignRight: [1, 2, 3], maxColWidth: 90 }
        ).split("\n")
    );

    return lines;
}

function renderMarkdown(report: StartupReport): Block[] {
    const blocks: Block[] = [
        { h1: "Cold import cost per entry" },
        `${report.entries.length} entries, the fastest of ${report.runs} runs per module.`,
        {
            table: {
                rows: report.entries.map((entry) => ({
                    Entry: entry.entry,
                    "Cold ms": entry.error || entry.timedOut ? coldOf(entry) : entry.coldMs,
                    Modules: entry.modules,
                    "Heaviest self time (ms)": topOf(entry),
                    Note: noteOf(entry),
                })),
            },
        },
        { h2: "Recurring heavy modules" },
        `A module or package whose self time is at least ${report.minMs} ms in two or more entries.`,
    ];

    if (report.recurring.length === 0) {
        blocks.push("None.");
        return blocks;
    }

    blocks.push({
        table: {
            rows: report.recurring.map((row) => ({
                Module: row.module,
                Entries: row.entries,
                "Summed ms": row.totalMs,
                "Max ms": row.maxMs,
                "Paid by": row.paidBy.join(", "),
            })),
        },
    });

    return blocks;
}

function compactOf(report: StartupReport): unknown {
    return {
        runs: report.runs,
        minMs: report.minMs,
        entryCols: ["entry", "coldMs", "modules", "top", "timedOut", "unmeasured", "error"],
        topCols: ["module", "selfMs"],
        entries: report.entries.map((entry) => [
            entry.entry,
            entry.coldMs,
            entry.modules,
            entry.top.map((cost) => [cost.module, cost.selfMs]),
            entry.timedOut,
            entry.unmeasured,
            entry.error ?? null,
        ]),
        recurringCols: ["module", "entries", "totalMs", "maxMs", "paidBy"],
        recurring: report.recurring.map((row) => [row.module, row.entries, row.totalMs, row.maxMs, row.paidBy]),
    };
}

/** TOON tables hold scalars only: the per-entry top list and the payer list become joined text. */
function toonOf(report: StartupReport): unknown {
    return {
        runs: report.runs,
        minMs: report.minMs,
        entries: report.entries.map((entry) => ({
            entry: entry.entry,
            coldMs: entry.coldMs,
            modules: entry.modules,
            top: topOf(entry),
            timedOut: entry.timedOut,
            unmeasured: entry.unmeasured,
            error: entry.error ?? "",
        })),
        recurring: report.recurring.map((row) => ({ ...row, paidBy: row.paidBy.join(", ") })),
    };
}

function entriesFrom(inputs: string[], toolDirs: string[]): string[] {
    const entries: string[] = [];

    for (const input of inputs) {
        const entry = startupEntryFor(input);

        if (!entry) {
            throw new UsageError(`No entry at ${input}. Pass a .ts file or a folder with an index.ts or index.tsx.`);
        }

        entries.push(entry);
    }

    for (const dir of toolDirs) {
        const found = toolEntriesIn(dir);

        if (found.length === 0) {
            throw new UsageError(`--tools ${dir}: no folder in it has an index.ts or index.tsx.`);
        }

        entries.push(...found);
    }

    if (entries.length === 0) {
        throw new UsageError("Pass at least one entry, or --tools <dir>.");
    }

    return [...new Set(entries.map(realPath))];
}

async function runStartupCommand(inputs: string[], options: StartupCliOptions): Promise<void> {
    const format = resolveFormat(options);
    const entries = entriesFrom(inputs, options.tools ?? []);
    const runs = options.runs ?? DEFAULT_RUNS;
    const cwd = realPath(process.cwd());
    let done = 0;

    ui.dim(
        `Measuring ${entries.length} entr${entries.length === 1 ? "y" : "ies"}, ${runs} run(s) each, ` +
            `${options.concurrency ?? 1} at a time`
    );

    const outcomes = await measureStartup(entries, {
        runs,
        timeoutMs: (options.timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000,
        walkPackages: options.walkPackages === true,
        includeDynamic: options.includeDynamic === true,
        concurrency: options.concurrency,
        onEntry: (entry, outcome) => {
            done++;
            const failure = outcome.error ?? (outcome.result ? importFailureOf(outcome.result) : undefined);
            const status = failure
                ? pc.red(failure)
                : `${fmtMs(outcome.result?.coldMs ?? 0)}${outcome.result?.timedOut ? pc.yellow(" (partial)") : ""}`;
            ui.dim(`[${done}/${entries.length}] ${labelOf(entry, cwd)} ${status}`);
        },
    });
    const report = summarizeStartup(
        outcomes.map((outcome) => ({ ...outcome, entry: labelOf(outcome.entry, cwd) })),
        { minMs: options.minMs ?? DEFAULT_MIN_MS, top: options.top ?? DEFAULT_TOP, runs }
    );

    emit(format, {
        text: () => renderText(report),
        md: () => renderMarkdown(report),
        json: () => report,
        compact: () => compactOf(report),
        toon: () => toonOf(report),
    });

    const failed = report.entries.filter((entry) => entry.error || entry.timedOut);

    if (failed.length > 0) {
        ui.raw(`${pc.yellow("●")} ${failed.length} entr${failed.length === 1 ? "y is" : "ies are"} partial or failed`);
        process.exitCode = 1;
    }
}

export function registerStartupCommand(imports: Command): void {
    const command = imports
        .command("startup")
        .description("Cold import cost of many entries in one table, and the heavy modules several of them pay for")
        .argument("[entries...]", "Files, or folders with an index.ts or index.tsx")
        .option(
            "--tools <dir>",
            "Add the index.ts or index.tsx of every folder directly inside this one; repeatable",
            collect,
            [] as string[]
        )
        .option(
            "--runs <n>",
            `Fresh processes per measurement, minimum kept (default ${DEFAULT_RUNS})`,
            numberArg({ min: 1, integer: true })
        )
        .option(
            "--timeout <seconds>",
            `Kill a measure worker after this long; its entry is marked partial (default ${DEFAULT_TIMEOUT_MS / 1000})`,
            numberArg({ min: 1 })
        )
        .option(
            "--min-ms <ms>",
            `A module recurs when its self time is at least this in two or more entries (default ${DEFAULT_MIN_MS})`,
            numberArg({ min: 0 })
        )
        .option(
            "--top <n>",
            `Heaviest modules listed per entry (default ${DEFAULT_TOP})`,
            numberArg({ min: 1, integer: true })
        )
        .option(
            "--concurrency <n>",
            "Entries measured at once (default 1; more is faster and less accurate)",
            numberArg({ min: 1, integer: true })
        )
        .option("--walk-packages", "Parse and walk into node_modules too, instead of one leaf per package")
        .option("--include-dynamic", "Walk and measure dynamic import() targets too");

    addFormatOptions(command);

    command.addHelpText(
        "after",
        [
            "",
            `Each entry is measured like \`${toolCommand("ts imports analyze")}\`: a fresh process imports every module`,
            "with its children cached, so a module's self time is its own evaluation. A package counts as",
            "one module (`pkg:<name>`). The second table is the point: a dependency whose self time shows",
            "up in many entries leaks its cost into every tool that loads it.",
            "Exit 1 when an entry failed (a module threw, imported a missing file or never settled) or timed out.",
            "",
            "Examples:",
            `  ${toolCommand("ts imports startup", "--tools", "src")}`,
            `  ${toolCommand("ts imports startup", "src/hub", "src/question/index.ts", "--runs", "2", "--json")}`,
            `  ${toolCommand("ts imports startup", "--tools", "src", "--min-ms", "50", "--md")}`,
        ].join("\n")
    );

    command.action(async (inputs: string[], options: StartupCliOptions) => {
        await runUsage(command, () => runStartupCommand(inputs, options));
    });
}
