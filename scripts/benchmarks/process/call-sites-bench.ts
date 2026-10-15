#!/usr/bin/env bun
/**
 * Every ps / lsof / pgrep call site outside `src/utils/process/`, measured from the function that reaches it, so the
 * migration to kernel reads is checkable site by site. Each sample is a fresh process (`call-site-child.ts`) that
 * runs the site cold and warm; sites are interleaved across runs. CPU includes the spawned children.
 *
 * Record before the migration, compare after it:
 *   bun scripts/benchmarks/process/call-sites-bench.ts --runs 3 --baseline
 *   bun scripts/benchmarks/process/call-sites-bench.ts --runs 3 --compare
 * One site, or a few:
 *   bun scripts/benchmarks/process/call-sites-bench.ts --site say-caller-chain,port-scanner-listeners --runs 5
 * A sample that does not answer in 60 s is killed and shown as that site's error (`--deadline-ms` changes it).
 * The registry:
 *   bun scripts/benchmarks/process/call-sites-bench.ts --list
 */
import { join } from "node:path";
import { type BaselineMetrics, compareToBaseline, readBaseline, recordBaseline } from "@app/benchmark/lib";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, renderCliSection } from "@genesiscz/utils/table";
import pc from "picocolors";
import { baselineNotes, median } from "../fs/shared";
import { CALL_SITES, type CallSite, runsHere, SAMPLE_MARKER } from "./call-sites";

const BASELINE_NAME = "process-call-sites";
const REPO = join(import.meta.dir, "..", "..", "..");
/** A site's CPU has to move by more than this many ms, as well as by 15%, to count as a regression. */
const CPU_FLOOR_MS = 3;

interface Sample {
    coldCpuMs: number;
    warmCpuMs: number;
    coldWallMs: number;
    toolSpawns: number;
    spawns: number;
    check: number;
}

interface SiteResult {
    site: CallSite;
    samples: Sample[];
    error: string | null;
}

function flag(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    return index === -1 ? undefined : process.argv[index + 1];
}

const runs = Math.max(1, Number(flag("--runs") ?? 3));
/** The slowest site answers in under 2 s; a sample past this is a wedged reader, killed and recorded as an error. */
const deadlineMs = Math.max(1, Number(flag("--deadline-ms") ?? 60_000));
const only = flag("--site")
    ?.split(",")
    .map((id) => id.trim());
const wantBaseline = process.argv.includes("--baseline");
const wantCompare = process.argv.includes("--compare");
const wantJson = process.argv.includes("--json");

if (only) {
    const unknown = only.filter((id) => !CALL_SITES.some((site) => site.id === id));

    if (unknown.length > 0) {
        out.log.error(`unknown site(s): ${unknown.join(", ")}. See --list.`);
        process.exit(2);
    }
}

if (process.argv.includes("--list")) {
    const table = createBoxTable(["SITE", "WHEN", "FILE", "SPAWN"]);

    for (const site of CALL_SITES) {
        table.push([site.id, site.frequency, site.file, site.spawn]);
    }

    renderCliHeader("ps / lsof / pgrep call sites", `${CALL_SITES.length} registered`);
    out.println(table.toString());
    process.exit(0);
}

const sites = CALL_SITES.filter((site) => runsHere(site) && (!only || only.includes(site.id)));

async function sample(site: CallSite): Promise<Sample> {
    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "call-site-child.ts"), site.id], {
        cwd: REPO,
        stdout: "pipe",
        stderr: "pipe",
        timeout: deadlineMs,
        killSignal: "SIGKILL",
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    const line = stdout
        .split("\n")
        .reverse()
        .find((candidate) => candidate.startsWith(SAMPLE_MARKER));

    if (proc.signalCode === "SIGKILL" && !line) {
        throw new Error(`no answer within ${deadlineMs} ms`);
    }

    if (code !== 0 || !line) {
        const reason = stderr.trim().split("\n").find(Boolean) ?? `exit ${code}`;
        throw new Error(reason.slice(0, 160));
    }

    return SafeJSON.parse(line.slice(SAMPLE_MARKER.length), { strict: true }) as Sample;
}

const results = new Map<string, SiteResult>(sites.map((site) => [site.id, { site, samples: [], error: null }]));
const tty = process.stderr.isTTY === true;

for (let run = 0; run < runs; run++) {
    // Rotate the start so no site always runs first (cold disk caches) or last (a warm machine).
    const order = sites.map((_, index) => sites[(index + run * 7) % sites.length]);

    for (const [index, site] of order.entries()) {
        const result = results.get(site.id);

        if (!result || result.error) {
            continue;
        }

        const progress = `run ${run + 1}/${runs} · ${index + 1}/${order.length} · ${site.id}`;
        process.stderr.write(tty ? `\r\x1b[2K${progress}` : `${progress}\n`);

        try {
            result.samples.push(await sample(site));
        } catch (err) {
            result.error = err instanceof Error ? err.message : String(err);
        }
    }
}

if (tty) {
    process.stderr.write("\r\x1b[2K");
}

const metrics: BaselineMetrics = {};

for (const { site, samples } of results.values()) {
    if (samples.length === 0) {
        continue;
    }

    metrics[`${site.id}.coldCpuMs`] = median(samples.map((s) => s.coldCpuMs));
    metrics[`${site.id}.warmCpuMs`] = median(samples.map((s) => s.warmCpuMs));
    metrics[`${site.id}.coldWallMs`] = median(samples.map((s) => s.coldWallMs));
    metrics[`${site.id}.toolSpawns`] = Math.max(...samples.map((s) => s.toolSpawns));
    metrics[`${site.id}.check`] = median(samples.map((s) => s.check));
}

const before = wantCompare ? await readBaseline(BASELINE_NAME) : null;

if (wantCompare && !before) {
    out.log.error(`no baseline '${BASELINE_NAME}' yet: run with --baseline on the commit before the migration`);
    process.exit(2);
}

function ms(value: number | undefined): string {
    return value === undefined ? "—" : value.toFixed(1);
}

function delta(after: number | undefined, base: number | undefined): string {
    if (after === undefined || base === undefined) {
        return "—";
    }

    const pct = base === 0 ? 0 : ((after - base) / base) * 100;
    const text = `${pct > 0 ? "+" : ""}${pct.toFixed(0)}%`;
    return pct <= -15 ? pc.green(text) : pct >= 15 && after - base > CPU_FLOOR_MS ? pc.red(text) : text;
}

const FREQUENCY_ORDER = ["per-tool-call", "per-poll", "per-command", "one-off"];
const rows = [...results.values()].sort(
    (a, b) =>
        FREQUENCY_ORDER.indexOf(a.site.frequency) - FREQUENCY_ORDER.indexOf(b.site.frequency) ||
        (metrics[`${b.site.id}.coldCpuMs`] ?? 0) - (metrics[`${a.site.id}.coldCpuMs`] ?? 0)
);
const headers = ["SITE", "WHEN", "PS/LSOF", "COLD CPU ms", "WARM CPU ms", "COLD WALL ms", "CHECK"];
const table = createBoxTable(before ? [...headers, "BEFORE COLD", "Δ COLD", "BEFORE SPAWNS"] : headers);

for (const { site, error } of rows) {
    const m = (name: string) => metrics[`${site.id}.${name}`];
    const b = (name: string) => before?.metrics[`${site.id}.${name}`];

    if (error) {
        table.push([
            site.id,
            site.frequency,
            pc.red("error"),
            pc.red(error.slice(0, 60)),
            "",
            "",
            "",
            ...(before ? ["", "", ""] : []),
        ]);
        continue;
    }

    const spawns = m("toolSpawns") ?? 0;
    const cells = [
        site.id,
        site.frequency,
        spawns === 0 ? pc.green("0") : pc.yellow(String(spawns)),
        ms(m("coldCpuMs")),
        ms(m("warmCpuMs")),
        ms(m("coldWallMs")),
        String(m("check") ?? "—"),
    ];
    table.push(
        before
            ? [...cells, ms(b("coldCpuMs")), delta(m("coldCpuMs"), b("coldCpuMs")), String(b("toolSpawns") ?? "—")]
            : cells
    );
}

const total = (name: string, source: BaselineMetrics | undefined) =>
    rows.reduce((sum, { site }) => sum + (source?.[`${site.id}.${name}`] ?? 0), 0);
const spawning = rows.filter(({ site }) => (metrics[`${site.id}.toolSpawns`] ?? 0) > 0).length;

renderCliHeader(
    "ps / lsof / pgrep call sites",
    `${rows.length} site(s) · ${runs} run(s) each · medians · CPU includes spawned children`
);
out.println(table.toString());
out.println(
    `Total cold CPU ${ms(total("coldCpuMs", metrics))} ms` +
        (before ? ` (before ${ms(total("coldCpuMs", before.metrics))} ms)` : "") +
        ` · cold wall ${ms(total("coldWallMs", metrics))} ms` +
        (before ? ` (before ${ms(total("coldWallMs", before.metrics))} ms)` : "") +
        ` · ${spawning} of ${rows.length} site(s) still spawn ps, lsof or pgrep` +
        ` · ${rows.filter((r) => r.error).length} error(s)`
);

if (wantBaseline) {
    const recorded = await recordBaseline({
        name: BASELINE_NAME,
        metrics,
        notes: await baselineNotes(`${rows.length} sites, ${runs} runs`),
    });
    renderCliSection("Baseline recorded");
    out.println(`${BASELINE_NAME} @ ${recorded.commit} — ${recorded.capturedAt}`);
}

if (wantCompare && before) {
    const cpuKeys = Object.keys(metrics).filter((key) => key.endsWith("CpuMs"));
    const comparison = await compareToBaseline({
        name: BASELINE_NAME,
        metrics: Object.fromEntries(cpuKeys.map((key) => [key, metrics[key]])),
        tolerancePct: 15,
        lowerIsBetter: cpuKeys,
        floor: Object.fromEntries(cpuKeys.map((key) => [key, CPU_FLOOR_MS])),
    });
    const regressed = Object.entries(comparison.deltas).filter(([, d]) => !d.ok);
    renderCliSection(`Compared with ${before.commit} (${before.capturedAt})`);
    out.println(
        regressed.length === 0
            ? pc.green("no site got slower")
            : regressed.map(([key, d]) => pc.red(`${key}: ${ms(d.before)} → ${ms(d.after)} ms`)).join("\n")
    );

    if (!comparison.ok) {
        process.exitCode = 1;
    }
}

if (wantJson) {
    out.result({
        name: BASELINE_NAME,
        runs,
        metrics,
        baseline: before ? { commit: before.commit, capturedAt: before.capturedAt, metrics: before.metrics } : null,
        errors: Object.fromEntries(rows.filter((r) => r.error).map((r) => [r.site.id, r.error])),
    });
}
