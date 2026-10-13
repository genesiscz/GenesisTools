import { statSync } from "node:fs";
import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { planDailyCompression, runDailyCompression } from "@genesiscz/utils/compress/daily";
import { type LedgerOp, ledgerPath, searchLedger } from "@genesiscz/utils/compress/ledger";
import { sampleFolder } from "@genesiscz/utils/compress/operations";
import { PRESET_NAMES, PRESETS, sampleFile, type TrialGoal, tryPresets } from "@genesiscz/utils/compress/presets";
import { formatLocalDateTimeStamp, parseSince } from "@genesiscz/utils/date";
import { formatBytes } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";

const GOALS: readonly TrialGoal[] = ["balanced", "ratio", "speed"];
const OPS: readonly LedgerOp[] = ["compress", "pack", "decompress", "unpack", "remove"];

interface LedgerOptions {
    path?: string;
    since?: string;
    until?: string;
    preset?: string;
    op?: string;
    caller?: string;
    minSize?: string;
    limit?: string;
    json?: boolean;
}

function runLedger(options: LedgerOptions): void {
    if (options.op && !(OPS as readonly string[]).includes(options.op)) {
        out.printlnErr(suggestEnumFlag(toolCommand("compress"), "--op", OPS, { subcommand: ["ledger"] }));
        process.exitCode = 1;
        return;
    }

    const since = options.since ? parseSince(options.since) : undefined;
    const until = options.until ? parseSince(options.until) : undefined;

    if (since === null || until === null) {
        out.error("--since and --until take a date (2026-10-13), an ISO time or HH:MM.");
        process.exitCode = 1;
        return;
    }

    const records = searchLedger({
        path: options.path,
        since,
        until,
        preset: options.preset,
        op: options.op as LedgerOp | undefined,
        caller: options.caller,
        minBytes: options.minSize ? Number(options.minSize) : undefined,
    }).slice(-(Number(options.limit) || 50));

    if (options.json) {
        out.result(records);
        return;
    }

    renderCliHeader("Compression ledger", ledgerPath());
    const table = createBoxTable(["WHEN", "OP", "CALLER", "SOURCE", "SIZE", "RATIO", "PRESET"]);

    for (const record of records) {
        table.push([
            formatLocalDateTimeStamp(record.startedAt, { seconds: false }),
            record.op,
            record.caller,
            truncateDisplay(record.source, 60),
            `${formatBytes(record.sourceBytes)} → ${formatBytes(record.targetBytes)}`,
            `x${record.ratio.toFixed(1)}`,
            record.preset ? `${record.preset}/${record.level}` : "—",
        ]);
    }

    out.println(table.toString());
    out.println(
        pc.dim(
            `${records.length} record(s); ${toolCommand("compress ledger")} --json for every field (sha256, frames, host, versions)`
        )
    );
}

function runPresets(options: { json?: boolean }): void {
    if (options.json) {
        out.result(PRESETS);
        return;
    }

    renderCliHeader("Compression presets", "auto picks one by sniffing; --try measures them on your data");
    const table = createBoxTable(["PRESET", "LEVEL", "LONG", "FRAME", "THREADS", "FOR"]);

    for (const preset of Object.values(PRESETS)) {
        table.push([
            pc.white(preset.name),
            preset.store ? "store" : String(preset.level),
            preset.long ? "yes" : "no",
            formatBytes(preset.frameBytes),
            String(preset.threads),
            truncateDisplay(preset.description, 70),
        ]);
    }

    out.println(table.toString());
}

async function runTry(path: string, options: { goal?: string | boolean; json?: boolean }): Promise<void> {
    const goal = typeof options.goal === "string" ? options.goal : "balanced";

    if (!(GOALS as readonly string[]).includes(goal)) {
        out.printlnErr(suggestEnumFlag(toolCommand("compress"), "--goal", GOALS, { subcommand: ["try"] }));
        process.exitCode = 1;
        return;
    }

    const sample = statSync(path).isDirectory() ? await sampleFolder(path) : sampleFile(path, 8 * 1024 * 1024);
    const { results, pick } = tryPresets(sample, {
        goal: goal as TrialGoal,
        presets: ["fast", "text", "tree", "binary", "max"],
    });

    if (options.json) {
        out.result({ path, sampleBytes: sample.length, goal, results, pick });
        return;
    }

    renderCliHeader(
        "Compression trial",
        `${path} · ${formatBytes(sample.length)} sample · goal ${goal}; nothing written`
    );
    const table = createBoxTable(["PRESET", "LEVEL", "LONG", "SAVES", "MB/S (1 THREAD)"]);

    for (const result of results) {
        const name = result === pick ? pc.green(`${result.preset} ←`) : result.preset;
        table.push([
            name,
            String(result.level),
            result.long ? "yes" : "no",
            `${(result.saving * 100).toFixed(1)}%`,
            result.mbPerSecond.toFixed(0),
        ]);
    }

    out.println(table.toString());

    if (pick.saving < 0.3) {
        out.log.warn(
            `Best saving is ${(pick.saving * 100).toFixed(1)}%, under the 30% minimum: ${toolCommand("compress pack")} would skip it.`
        );
    }
}

async function runDaily(options: { dryRun?: boolean; json?: boolean }): Promise<void> {
    if (options.dryRun) {
        const plans = planDailyCompression().map(({ target, plan }) => ({
            target: target.name,
            root: target.root,
            firstPlainDay: target.firstPlainDay,
            files: plan.compress.length,
            bytes: plan.compress.reduce((sum, item) => sum + item.bytes, 0),
            finish: plan.finish.length,
        }));

        if (options.json) {
            out.result(plans);
            return;
        }

        for (const plan of plans) {
            out.println(
                `${pc.bold(plan.target)}: ${plan.files} file(s), ${formatBytes(plan.bytes)} older than ${plan.firstPlainDay} in ${plan.root}`
            );
        }

        out.println(pc.dim("dry run, nothing written"));
        return;
    }

    const reports = await runDailyCompression();
    const summary = reports.map(({ target, report }) => ({
        target: target.name,
        compressed: report.compressed.length,
        bytes: report.compressed.reduce((sum, item) => sum + item.bytes, 0),
        compressedBytes: report.compressed.reduce((sum, item) => sum + item.compressedBytes, 0),
        failed: report.failed,
    }));

    if (options.json) {
        out.result(summary);
        return;
    }

    for (const item of summary) {
        out.println(
            `${pc.bold(item.target)}: ${item.compressed} file(s), ${formatBytes(item.bytes)} → ${formatBytes(item.compressedBytes)}, ${item.failed.length} failed`
        );
    }
}

export function registerLedgerCommands(program: Command): void {
    program
        .command("ledger")
        .description("Search every compression and restore: what, when, how, with which preset and level")
        .option("--path <text>", "source or target path contains this")
        .option("--since <when>", "on or after (a date, ISO time or HH:MM)")
        .option("--until <when>", "on or before")
        .option("--preset <name>", `one of: ${PRESET_NAMES.join(", ")}`)
        .option("--op [op]", `one of: ${OPS.join(", ")}`)
        .option("--caller <name>", "cli, logs, ai-proxy-transcripts, codex-migrate-home, app-retired")
        .option("--min-size <bytes>", "source at least this many bytes")
        .option("--limit <n>", "newest N records (default 50)")
        .option("--json", "every field")
        .action(runLedger);

    program
        .command("presets")
        .description("The presets and what each is for")
        .option("--json", "every field")
        .action(runPresets);

    program
        .command("try")
        .description("Compress a sample with several presets and show saving and speed; writes nothing")
        .argument("<path>", "file or folder")
        .option("--goal [goal]", `${GOALS.join(", ")} (default balanced)`)
        .option("--json", "machine-readable result")
        .action(runTry);

    program
        .command("daily")
        .description("Run the daily pass now: day logs and ai-proxy transcripts older than yesterday become .zst")
        .option("--dry-run", "list what it would compress; write nothing")
        .option("--json", "machine-readable result")
        .action(runDaily);
}
