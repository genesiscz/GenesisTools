import { out } from "@genesiscz/utils/logger";
import { formatTable } from "@genesiscz/utils/table";
import pc from "picocolors";
import type { FunctionCost, ProfileSummary, RepoTreeNode } from "./cpuprofile";
import type { ThreadSampleSummary } from "./threads";

export interface ProfileReport {
    command: string[];
    outDir: string;
    runs: Array<{ exitCode: number; cpuMs: number; wallMs: number; profilePath: string }>;
    summary: ProfileSummary;
    threads?: ThreadSampleSummary & { path: string };
}

export interface RenderOptions {
    top: number;
    depth: number;
    minPct: number;
    tree: RepoTreeNode[];
}

function median(values: number[]): number {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function perRunMs(us: number, runs: number): string {
    return (us / 1000 / Math.max(1, runs)).toFixed(1);
}

function pct(us: number, of: number): string {
    return of > 0 ? `${((us / of) * 100).toFixed(1)}%` : "0%";
}

function costRows(costs: FunctionCost[], summary: ProfileSummary, field: "selfUs" | "totalUs"): string[][] {
    const other = field === "selfUs" ? "totalUs" : "selfUs";
    return costs.map((cost) => [
        perRunMs(cost[field], summary.profiles),
        pct(cost[field], summary.sampledUs),
        perRunMs(cost[other], summary.profiles),
        pct(cost[other], summary.sampledUs),
        cost.fn.name,
        cost.fn.location,
    ]);
}

function treeLines(options: {
    nodes: RepoTreeNode[];
    summary: ProfileSummary;
    depth: number;
    minPct: number;
    level: number;
}): string[] {
    const { nodes, summary } = options;
    const lines: string[] = [];

    if (options.level >= options.depth) {
        return lines;
    }

    for (const node of nodes) {
        const share = summary.sampledUs > 0 ? (node.totalUs / summary.sampledUs) * 100 : 0;

        if (share < options.minPct) {
            continue;
        }

        const indent = "  ".repeat(options.level);
        lines.push(
            `${pc.bold(`${share.toFixed(1).padStart(5)}%`)} ${perRunMs(node.totalUs, summary.profiles).padStart(8)} ms  ${indent}${node.fn.name}  ${pc.dim(node.fn.location)}`
        );
        lines.push(...treeLines({ ...options, nodes: node.children, level: options.level + 1 }));
    }

    return lines;
}

export function renderProfileReport(report: ProfileReport, options: RenderOptions): void {
    const { summary } = report;
    const runs = report.runs.length;
    out.println(pc.bold(`Profiled: ${report.command.join(" ")}`));
    out.println(
        `  ${runs} run${runs === 1 ? "" : "s"} · CPU (all threads) median ${median(report.runs.map((run) => run.cpuMs)).toFixed(0)} ms · wall median ${median(report.runs.map((run) => run.wallMs)).toFixed(0)} ms · sampled on the JS thread ${perRunMs(summary.sampledUs, summary.profiles)} ms per run (+${perRunMs(summary.idleUs, summary.profiles)} ms waiting, cut)`
    );

    const failed = report.runs.filter((run) => run.exitCode !== 0);

    if (failed.length > 0) {
        out.println(
            pc.yellow(`  ${failed.length} run(s) exited non-zero (${failed.map((run) => run.exitCode).join(", ")})`)
        );
    }

    out.println(
        pc.dim(
            "  Profile times are sampled time on the JavaScript thread: a blocked native call (a stat, a file read) counts in full, work on other threads does not. Use --threads to see every thread."
        )
    );
    out.println("");
    out.println(pc.bold("Hot functions (self time, ms per run)"));
    out.println(
        formatTable(
            costRows(summary.functions.slice(0, options.top), summary, "selfUs"),
            ["self", "self%", "total", "total%", "function", "location"],
            { alignRight: [0, 1, 2, 3], maxColWidth: 90 }
        )
    );
    out.println("");
    out.println(pc.bold("Repository functions (total time; 'own' includes the library and native calls they make)"));
    out.println(
        formatTable(
            costRows(summary.repoFunctions.slice(0, options.top), summary, "totalUs"),
            ["total", "total%", "own", "own%", "function", "location"],
            { alignRight: [0, 1, 2, 3], maxColWidth: 90 }
        )
    );
    out.println("");
    out.println(pc.bold(`Repository call tree (≥ ${options.minPct}%, depth ${options.depth})`));

    for (const line of treeLines({
        nodes: options.tree,
        summary,
        depth: options.depth,
        minPct: options.minPct,
        level: 0,
    })) {
        out.println(line);
    }

    if (report.threads) {
        const { threads } = report;
        out.println("");
        out.println(
            pc.bold(
                `All threads, busy top of stack (${threads.busySamples} busy samples of ${threads.busySamples + threads.waitingSamples}, 1 ms each)`
            )
        );
        out.println(
            formatTable(
                threads.hotspots
                    .slice(0, options.top)
                    .map((spot) => [
                        String(spot.samples),
                        pct(spot.samples, threads.busySamples),
                        spot.symbol,
                        spot.library,
                    ]),
                ["samples", "busy%", "symbol", "library"],
                { alignRight: [0, 1] }
            )
        );
    }

    out.println("");
    out.println(pc.dim(`  Profiles: ${report.outDir} (open a .cpuprofile in speedscope.app or Chrome DevTools)`));
}
