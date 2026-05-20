import { readHistorySince } from "@app/doctor/lib/history";
import { formatBytes } from "@app/doctor/lib/size";
import { aggregate } from "@app/doctor/lib/stats";
import { out } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import pc from "picocolors";

export interface StatsOpts {
    since?: string;
    json?: boolean;
}

function sinceDate(since: string | undefined): Date {
    if (since === "all") {
        return new Date(0);
    }

    if (!since) {
        return new Date(Date.now() - 7 * 86400_000);
    }

    const m = since.match(/^(\d+)([dwhm])$/);

    if (!m) {
        return new Date(Date.now() - 7 * 86400_000);
    }

    const n = Number.parseInt(m[1], 10);
    const unit = m[2];
    const ms = unit === "d" ? 86400_000 : unit === "w" ? 7 * 86400_000 : unit === "h" ? 3600_000 : 60_000;
    return new Date(Date.now() - n * ms);
}

export async function runStats(opts: StatsOpts): Promise<void> {
    const since = sinceDate(opts.since);
    const entries = await readHistorySince(since);
    const stats = aggregate(entries);

    if (opts.json) {
        out.println(SafeJSON.stringify(stats, null, 2));
        return;
    }

    out.println(pc.bold(`Doctor stats — since ${since.toISOString().slice(0, 10)}`));
    out.println(`  ${pc.cyan("Reclaimed:")}   ${pc.green(formatBytes(stats.totalReclaimedBytes))}`);
    out.println(`  ${pc.cyan("Actions:")}     ${stats.totalActions}`);
    out.println(`  ${pc.cyan("Runs:")}        ${stats.runsCount}`);
    out.println();
    out.println(pc.bold("By action type:"));

    for (const [name, count] of Object.entries(stats.actionCounts).sort((a, b) => b[1] - a[1])) {
        out.println(`  ${name.padEnd(22)} ${count}`);
    }
}
