#!/usr/bin/env bun
/**
 * What one Widget roster tick costs the hub (`refreshWidgetIndex` in the resident roster worker): a refresh for one
 * changed Claude transcript, one changed sub-agent transcript, the periodic full refresh, and one transcript's
 * metadata read after it grew by 64 KB (a copy under and one above the reader's 10 MB full-read bound).
 *
 * Each run is a fresh process (`widget-refresh-child.ts`) under a scratch `GENESIS_TOOLS_HOME` that holds a copy of
 * the live history index (`VACUUM INTO` through a read-only connection), so the live index, its freshness markers
 * and the fold stores are never written. The session roots are the live ones, read only, so the numbers move as
 * sessions accumulate: record the baseline and the comparison close together.
 *
 * Usage:
 *   bun scripts/benchmarks/agent-sessions/widget-refresh.ts --baseline
 *   bun scripts/benchmarks/agent-sessions/widget-refresh.ts --compare
 */
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BaselineMetrics } from "@app/benchmark/lib";
import { historyDatabasePath } from "@genesiscz/utils/agent-sessions/database";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { genesisToolsDirIn } from "@genesiscz/utils/storage/root";
import { finishBench, parseBenchArgs } from "../fs/shared";

const BASELINE_NAME = "agent-sessions-widget-refresh";
const REPO = join(import.meta.dir, "..", "..", "..");
const CHILD = join(import.meta.dir, "widget-refresh-child.ts");
const args = parseBenchArgs(process.argv.slice(2));
const scratch = mkdtempSync(join(tmpdir(), "gt-bench-widget-refresh-"));
const home = join(scratch, "home");
const copy = genesisToolsDirIn(home, "claude-history", "index.db");

function copyIndex(): void {
    mkdirSync(dirname(copy), { recursive: true });
    const live = new Database(historyDatabasePath(), { readonly: true });
    try {
        live.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
    } finally {
        live.close();
    }
}

async function sample(run: number): Promise<BaselineMetrics> {
    const proc = Bun.spawn(["bun", "run", CHILD, join(scratch, `run-${run}`), "5"], {
        cwd: REPO,
        env: { ...env.getProcessEnv(), GENESIS_TOOLS_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    if (code !== 0) {
        throw new Error(`widget-refresh-child exited ${code}: ${stderr.slice(-2000)}`);
    }

    const parsed: unknown = SafeJSON.parse(stdout.trim().split("\n").at(-1) ?? "", { strict: true });

    if (typeof parsed !== "object" || parsed === null) {
        throw new Error(`widget-refresh-child printed no metrics: ${stdout.slice(-500)}`);
    }

    return Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number")
    );
}

const runs: BaselineMetrics[] = [];

try {
    copyIndex();

    for (let i = 0; i < args.warmup + args.runs; i++) {
        const metrics = await sample(i);

        if (i >= args.warmup) {
            runs.push(metrics);
        }
    }
} finally {
    rmSync(scratch, { recursive: true, force: true });
}

const timed = Object.keys(runs[0] ?? {}).filter((key) => key.endsWith("Ms"));
await finishBench({
    name: BASELINE_NAME,
    title: "Widget roster tick: CPU ms per refresh (median of warm passes, median of runs)",
    args,
    runs,
    lowerIsBetter: timed,
    floor: Object.fromEntries(Object.keys(runs[0] ?? {}).map((key) => [key, key.endsWith("Ms") ? 5 : 0])),
    notes: "scratch copy of the live history index; live session roots read only; liveMainBytes is context",
    context: { child: "widget-refresh-child.ts" },
});
