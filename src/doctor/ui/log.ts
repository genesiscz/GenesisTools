import { readHistorySince } from "@app/doctor/lib/history";
import { formatBytes } from "@app/doctor/lib/size";
import { formatLocalDate, formatLocalDateTimeStamp } from "@genesiscz/utils/date";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
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
        out.println(SafeJSON.stringify(filtered, null, 2));
        return;
    }

    if (filtered.length === 0) {
        out.println(pc.dim("No history entries in the given window."));
        return;
    }

    out.println(pc.bold(`${filtered.length} actions since ${formatLocalDate(since)}:`));

    for (const entry of filtered.slice(-50).reverse()) {
        const s = entry.action.status;
        const statusColor = s === "ok" ? pc.green : s === "staged" ? pc.yellow : s === "failed" ? pc.red : pc.dim;
        const bytes = entry.action.actualReclaimedBytes
            ? pc.dim(` · ${formatBytes(entry.action.actualReclaimedBytes)}`)
            : "";
        out.println(
            `${pc.dim(formatLocalDateTimeStamp(entry.timestamp))} ${statusColor(s.padEnd(7))} ${entry.action.actionId.padEnd(20)} ${entry.action.findingId}${bytes}`
        );
    }
}
