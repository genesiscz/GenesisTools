import { readHistorySince } from "@app/doctor/lib/history";
import { formatBytes } from "@app/doctor/lib/size";
import { SafeJSON } from "@app/utils/json";
import pc from "picocolors";

export interface LogOpts {
    since?: string;
    analyzer?: string;
    json?: boolean;
}

function parseSinceDays(since: string): Date {
    const m = since.match(/^(\d+)([dwhm])$/);

    if (!m) {
        return new Date(Date.now() - 7 * 86400 * 1000);
    }

    const n = Number.parseInt(m[1], 10);
    const unit = m[2];
    const ms = unit === "d" ? 86400_000 : unit === "w" ? 7 * 86400_000 : unit === "h" ? 3600_000 : 60_000;
    return new Date(Date.now() - n * ms);
}

export async function runLog(opts: LogOpts): Promise<void> {
    const since = opts.since ? parseSinceDays(opts.since) : new Date(Date.now() - 7 * 86400_000);
    const entries = await readHistorySince(since);
    const filtered = opts.analyzer ? entries.filter((e) => e.action.findingId.includes(opts.analyzer ?? "")) : entries;

    if (opts.json) {
        console.log(SafeJSON.stringify(filtered, null, 2));
        return;
    }

    if (filtered.length === 0) {
        console.log(pc.dim("No history entries in the given window."));
        return;
    }

    console.log(pc.bold(`${filtered.length} actions since ${since.toISOString().slice(0, 10)}:`));

    for (const entry of filtered.slice(-50).reverse()) {
        const s = entry.action.status;
        const statusColor = s === "ok" ? pc.green : s === "staged" ? pc.yellow : s === "failed" ? pc.red : pc.dim;
        const bytes = entry.action.actualReclaimedBytes
            ? pc.dim(` · ${formatBytes(entry.action.actualReclaimedBytes)}`)
            : "";
        console.log(
            `${pc.dim(entry.timestamp.slice(0, 19).replace("T", " "))} ${statusColor(s.padEnd(7))} ${entry.action.actionId.padEnd(20)} ${entry.action.findingId}${bytes}`
        );
    }
}
