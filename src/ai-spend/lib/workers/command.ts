import { homedir } from "node:os";
import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { formatDuration, formatTokens } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliSection } from "@genesiscz/utils/table";
import type { WorkerBackend } from "@genesiscz/utils/worker/capabilities";
import type { Command } from "commander";
import pc from "picocolors";
import { isValidTimeZone, parseDayArg, resolveRelativeSince, systemTimeZone } from "../reports/dates";
import { planWorkerBackfill } from "./backfill";
import { formatUsd } from "./cost";
import { appendWorkerCostRows, readWorkerCostRows, workerCostLedgerPath } from "./ledger";
import {
    buildWorkerStats,
    WORKER_STATS_DIMENSIONS,
    type WorkerStatsDimension,
    type WorkerStatsReport,
    type WorkerStatsTotals,
} from "./stats";

const TOOL = "tools ai-spend workers";
const BACKENDS: readonly WorkerBackend[] = ["codex", "grok", "claude"];
const DEFAULT_DIMENSIONS: readonly WorkerStatsDimension[] = ["backend", "model"];

interface WorkersFlags {
    since?: string;
    json?: boolean;
    until?: string;
    timezone?: string;
    by?: string | boolean;
    backend?: string;
    label?: string;
    backfill?: boolean;
    dryRun?: boolean;
}

/** A comma list of known values; undefined when any entry is not one of them. */
function parseList<T extends string>(raw: string, values: readonly T[]): T[] | undefined {
    const picked = raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);

    return picked.every((value): value is T => (values as readonly string[]).includes(value)) && picked.length > 0
        ? picked
        : undefined;
}

function usd(value: number, unknownCount: number): string {
    return unknownCount > 0 ? `${formatUsd(value)} +?` : formatUsd(value);
}

function totalsCells(totals: WorkerStatsTotals): string[] {
    const tokens = totals.tokens;

    return [
        String(totals.sessions),
        String(totals.turns),
        `${formatTokens(tokens.input)} / ${formatTokens(tokens.cacheRead)} / ${formatTokens(tokens.output)}`,
        usd(totals.apiEquivalentUsd, totals.unpricedRequests),
        usd(totals.billedUsd, totals.unbilledRequests),
        `≈${formatUsd(totals.claudeOpusUsd)}`,
        `≈${formatUsd(totals.claudeSonnetUsd)}`,
        totals.durationMs > 0 ? formatDuration(totals.durationMs, "ms") : "—",
    ];
}

function renderStats(report: WorkerStatsReport): void {
    if (report.groups.length === 0) {
        out.printlnErr(pc.dim("No worker spend in that window."));
        out.printlnErr(pc.dim(`Past sessions reach the ledger with: ${TOOL} --backfill --dry-run`));
        return;
    }

    const headers = [
        ...report.dimensions.map((dim) => dim.toUpperCase()),
        "SESS",
        "TURNS",
        "IN / CACHED / OUT",
        "API-EQ",
        "BILLED",
        "AS OPUS",
        "AS SONNET",
        "TIME",
    ];
    const table = createBoxTable(headers);

    for (const group of report.groups) {
        table.push([...report.dimensions.map((dim) => group.key[dim] || "—"), ...totalsCells(group)]);
    }

    table.push([
        pc.bold("TOTAL"),
        ...report.dimensions.slice(1).map(() => ""),
        ...totalsCells(report.total).map((cell) => pc.bold(cell)),
    ]);
    out.println(table.toString());

    renderCliSection("Reading it");
    out.println(
        pc.dim(
            [
                "API-EQ: the worker model's list price, request by request, as ai-spend prices it (grok: its own recorded cost).",
                "BILLED: $0 on a subscription login, the API-equivalent on an API key. '+?' = some amounts are unknown, not zero.",
                `AS OPUS / AS SONNET: the same tokens at ${report.claudeEquivalent.opusModel} / ${report.claudeEquivalent.sonnetModel}. ESTIMATES: tokenizers and agent behaviour differ.`,
                "TURNS and TIME come from the worker ledger; a session from before it shows 0 until --backfill.",
            ].join("\n")
        )
    );

    for (const note of report.notes) {
        out.printlnErr(pc.yellow(note));
    }
}

function runBackfill(flags: WorkersFlags): void {
    const plan = planWorkerBackfill(readWorkerCostRows());
    const summary = {
        ledger: workerCostLedgerPath(),
        dryRun: flags.dryRun === true,
        rows: plan.rows.length,
        alreadyBooked: plan.skipped,
        byBackend: Object.fromEntries(
            BACKENDS.map((backend) => [backend, plan.rows.filter((row) => row.backend === backend).length])
        ),
        notes: plan.notes,
    };

    if (!flags.dryRun) {
        appendWorkerCostRows(plan.rows);
    }

    if (flags.json) {
        out.result(flags.dryRun ? { ...summary, preview: plan.rows } : summary);
        return;
    }

    const table = createBoxTable(["BACKEND", "NAME", "TURN", "DAY", "MODEL", "API-EQ", "AS OPUS"]);

    for (const row of plan.rows) {
        table.push([
            row.backend,
            row.name,
            row.turn === null ? "all" : String(row.turn),
            row.ts.slice(0, 10),
            row.model ?? "?",
            row.cost.apiEquivalentUsd === null ? "?" : formatUsd(row.cost.apiEquivalentUsd),
            row.cost.claudeEquivalent.opusUsd === null ? "?" : `≈${formatUsd(row.cost.claudeEquivalent.opusUsd)}`,
        ]);
    }

    if (plan.rows.length > 0) {
        out.println(table.toString());
    }

    for (const note of plan.notes) {
        out.printlnErr(pc.dim(note));
    }

    out.printlnErr(
        flags.dryRun
            ? pc.yellow(
                  `dry run: ${plan.rows.length} row(s) would be booked into ${summary.ledger} (${plan.skipped} already there). Run again without --dry-run to write them.`
              )
            : pc.green(`booked ${plan.rows.length} row(s) into ${summary.ledger} (${plan.skipped} were already there)`)
    );
}

export function registerWorkersCommand(program: Command): Command {
    return program
        .command("workers")
        .description("Spend of headless workers (tools codex / grok / claude worker), with a Claude estimate")
        .option(
            "--by [dims]",
            `Group by a comma list of: ${WORKER_STATS_DIMENSIONS.join(", ")} (default: backend,model)`
        )
        .option("--backend <list>", `Only these backends: ${BACKENDS.join(", ")}`)
        .option("--label <substr>", "Only sessions whose spawn --label contains this")
        .option("--until <day>", "Last day included (YYYY-MM-DD)")
        .option("--timezone <tz>", "IANA zone for the day buckets (default: this machine's)")
        .option("--backfill", "Book ledger rows for worker turns that ran before the ledger (read-only on their files)")
        .option("--dry-run", "With --backfill: show what would be booked, write nothing")
        .action((_opts: WorkersFlags, cmd: Command) => {
            // `--since` and `--json` are the tool's own options, which commander resolves on the parent.
            const flags = cmd.optsWithGlobals() as WorkersFlags;

            if (flags.backfill) {
                runBackfill(flags);
                return;
            }

            const timezone = flags.timezone ?? systemTimeZone();

            if (!isValidTimeZone(timezone)) {
                out.error(`--timezone ${timezone} is not an IANA zone (e.g. Europe/Prague).`);
                process.exitCode = 1;
                return;
            }

            const now = new Date();
            const since = flags.since ?? "30d";
            const sinceDay = resolveRelativeSince(since, now, timezone) ?? parseDayArg(since);
            const untilDay = flags.until ? parseDayArg(flags.until) : undefined;

            if (!sinceDay || (flags.until && !untilDay)) {
                out.error(
                    `--since takes Nd or YYYY-MM-DD, --until takes YYYY-MM-DD (got ${since}${flags.until ? `, ${flags.until}` : ""}).`
                );
                process.exitCode = 1;
                return;
            }

            const dimensions =
                flags.by === undefined
                    ? DEFAULT_DIMENSIONS
                    : typeof flags.by === "string"
                      ? parseList(flags.by, WORKER_STATS_DIMENSIONS)
                      : undefined;

            if (!dimensions) {
                out.printlnErr(suggestEnumFlag(TOOL, "--by", WORKER_STATS_DIMENSIONS, { given: String(flags.by) }));
                process.exitCode = 1;
                return;
            }

            const backends = flags.backend ? parseList(flags.backend, BACKENDS) : undefined;

            if (flags.backend && !backends) {
                out.printlnErr(suggestEnumFlag(TOOL, "--backend", BACKENDS, { given: flags.backend }));
                process.exitCode = 1;
                return;
            }

            const report = buildWorkerStats({
                home: homedir(),
                timezone,
                sinceDay,
                untilDay,
                dimensions,
                ...(backends ? { backends } : {}),
                ...(flags.label ? { label: flags.label } : {}),
            });

            if (flags.json) {
                out.result(report);
                return;
            }

            renderStats(report);
        });
}
