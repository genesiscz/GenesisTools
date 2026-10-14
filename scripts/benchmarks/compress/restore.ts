#!/usr/bin/env bun
/**
 * The restore cost of a packed folder: `tools compress unpack <x>.zst --into <dir>` against copying the plain folder
 * (`cp -R`, a real copy, and `cp -c -R`, an APFS clone, the cheapest possible restore). Fresh processes, arms
 * interleaved, medians. The folder is a retired GenesisTools.app bundle packed by the app build; the plain arm unpacks
 * it once into the bench root. Every sample writes a new output folder under the bench root (this script never
 * deletes; about 70 MB per sample).
 *
 * Usage: bun scripts/benchmarks/compress/restore.ts [--runs 5] [--baseline] [--json]
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { BaselineMetrics } from "@app/benchmark/lib";
import { unpackArchive } from "@genesiscz/utils/compress/tar";
import { env } from "@genesiscz/utils/env";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader } from "@genesiscz/utils/table";
import { finishBench, median, parseBenchArgs } from "../fs/shared";
import { BENCH_ROOT, REAL_HOME } from "./arms";

const REPO = join(import.meta.dir, "..", "..", "..");
const TOOLS = join(REPO, "tools");
const retired = join(REAL_HOME, "app", "retired.noindex");
const archiveName = readdirSync(retired).find((name) => name.endsWith(".zst"));

if (!archiveName) {
    throw new Error(`no packed bundle in ${retired}; build the app twice first`);
}

const archive = join(retired, archiveName);
const root = join(BENCH_ROOT, "restore");
const plain = join(root, "source");

if (!existsSync(join(plain, archiveName.replace(/\.zst$/, "")))) {
    await unpackArchive({ archive, destination: plain });
}

const folder = join(plain, archiveName.replace(/\.zst$/, ""));
const ARMS = {
    "cp-clone": (dest: string) => ["cp", "-c", "-R", folder, dest],
    "cp-copy": (dest: string) => ["cp", "-R", folder, dest],
    unpack: (dest: string) => [TOOLS, "compress", "unpack", archive, "--into", dest],
} as const;

const args = parseBenchArgs(process.argv.slice(2));
const runs: BaselineMetrics[] = [];
let sampleIndex = 0;

for (let index = 0; index < args.warmup + args.runs; index++) {
    const metrics: BaselineMetrics = {};
    const order = Object.keys(ARMS) as Array<keyof typeof ARMS>;

    for (const arm of index % 2 === 0 ? order : [...order].reverse()) {
        const dest = join(root, `out-${Date.now()}-${sampleIndex++}`);
        mkdirSync(dest, { recursive: true });
        const started = performance.now();
        const proc = Bun.spawn([...ARMS[arm](dest)], {
            stdout: "ignore",
            stderr: "pipe",
            env: { ...env.getProcessEnv(), GENESIS_TOOLS_NO_DAILY_COMPRESS: "1" },
        });
        const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

        if (code !== 0) {
            throw new Error(`${arm} exited ${code}: ${stderr.slice(0, 400)}`);
        }

        const usage = proc.resourceUsage()!;
        metrics[`${arm}.wallMs`] = performance.now() - started;
        metrics[`${arm}.cpuMs`] = (Number(usage.cpuTime.user) + Number(usage.cpuTime.system)) / 1000;
    }

    if (index >= args.warmup) {
        runs.push(metrics);
    }
}

renderCliHeader("Restore a packed folder", `${archiveName} · ${runs.length} sample(s) per arm`);
const table = createBoxTable(["ARM", "WALL MS", "CPU MS"]);

for (const arm of Object.keys(ARMS)) {
    table.push([
        arm,
        median(runs.map((run) => run[`${arm}.wallMs`]!)).toFixed(0),
        median(runs.map((run) => run[`${arm}.cpuMs`]!)).toFixed(0),
    ]);
}

out.println(table.toString());

await finishBench({
    name: "compress-restore",
    title: "Restoring a packed app bundle (median ms)",
    args,
    runs,
    lowerIsBetter: Object.keys(runs[0] ?? {}),
    floor: Object.fromEntries(Object.keys(runs[0] ?? {}).map((key) => [key, 50])),
    notes: `archive ${archive}; fresh processes, arms interleaved and reversed every other run`,
    context: { archive },
});
