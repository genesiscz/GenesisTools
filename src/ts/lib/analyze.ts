import { profiler } from "@genesiscz/utils/profile";
import { attribute } from "./attribute";
import { findCycles } from "./cycles";
import { buildGraph, postOrder, reachableFrom } from "./graph";
import { measureGraph, type WorkerSample } from "./measure";
import type { AnalysisResult, AnalyzedModule, ImportGraph, MeasuredModule } from "./types";

const prof = profiler.scope("ts");

export interface AnalyzeOptions {
    entry: string;
    root: string;
    runs?: number;
    timeoutMs?: number;
    walkPackages?: boolean;
    includeDynamic?: boolean;
    /** Self time at or above which a module gets explained. Default 1 ms. */
    slowMs?: number;
}

export const DEFAULT_RUNS = 3;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_SLOW_MS = 1;

function importErrorOf(sample: WorkerSample | undefined): string | undefined {
    if (!sample || sample.status === "ok") {
        return undefined;
    }

    if (sample.status === "exit") {
        return `exit ${sample.message ?? "0"}`;
    }

    if (sample.status === "hang") {
        return `hang: ${sample.message ?? "never settled"}`;
    }

    return sample.message ?? "error";
}

/**
 * Self time comes from the worker; total time is the sum of self over the static subtree,
 * which is what a fresh process would pay to import this module first. Cycle members that
 * were pulled in by a sibling measure ~0 self, and their time sits on the member imported first.
 */
export function computeTotals(
    graph: ImportGraph,
    self: Map<string, WorkerSample>,
    order: string[]
): Map<string, MeasuredModule> {
    const totals = new Map<string, MeasuredModule>();
    const cycleOf = new Map<string, { size: number; paidBy: string }>();
    const position = new Map(order.map((id, index) => [id, index]));

    for (const cycle of findCycles(graph)) {
        // `members` are labels; map back to ids through the graph so the lookup is by id.
        const ids = [...graph.nodes.values()]
            .filter((node) => cycle.members.includes(node.label))
            .map((node) => node.id);
        const first = ids.reduce((best, id) =>
            (position.get(id) ?? Infinity) < (position.get(best) ?? Infinity) ? id : best
        );
        const paidBy = graph.nodes.get(first)?.label ?? first;

        for (const id of ids) {
            cycleOf.set(id, { size: ids.length, paidBy });
        }
    }

    for (const id of graph.nodes.keys()) {
        const sample = self.get(id);
        const descendants = reachableFrom(graph, id);
        let totalMs = sample?.ms ?? 0;

        for (const child of descendants) {
            totalMs += self.get(child)?.ms ?? 0;
        }

        totals.set(id, {
            id,
            selfMs: sample?.ms ?? 0,
            totalMs,
            descendants: descendants.size,
            importError: importErrorOf(sample),
            measured: sample !== undefined,
            cycle: cycleOf.get(id),
        });
    }

    return totals;
}

/** The serialisable result plus the graph and raw samples the companion analyses reuse. */
export interface AnalysisSession {
    graph: ImportGraph;
    self: Map<string, WorkerSample>;
    result: AnalysisResult;
}

export async function analyzeEntry(options: AnalyzeOptions): Promise<AnalysisSession> {
    const runs = options.runs ?? DEFAULT_RUNS;
    const slowMs = options.slowMs ?? DEFAULT_SLOW_MS;
    const graph = prof.measure("build graph", () =>
        buildGraph({
            entry: options.entry,
            root: options.root,
            walkPackages: options.walkPackages,
            includeDynamic: options.includeDynamic,
        })
    );
    const order = postOrder(graph, graph.entry);
    // The plan the worker is given. Only these can be "missing a sample": a dynamic-import
    // target is a graph node and never a plan line, so counting graph nodes reported a
    // permanent 16 on dev-dashboard and would have made the partial-run warning noise.
    const planned = order.filter((id) => {
        const kind = graph.nodes.get(id)?.kind;

        return kind === "file" || kind === "package";
    });
    const measured = await measureGraph({
        graph,
        order,
        runs,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        cwd: options.root,
    });
    const totals = prof.measure("totals", () => computeTotals(graph, measured.self, order));
    const largeSubtreeMs = Math.max(slowMs * 5, 5);
    const modules: AnalyzedModule[] = [];

    prof.measure("attribute", () => {
        for (const node of graph.nodes.values()) {
            const timing = totals.get(node.id);

            if (!timing) {
                continue;
            }

            modules.push({
                ...timing,
                label: node.label,
                kind: node.kind,
                bytes: node.parsed?.bytes ?? 0,
                findings: attribute({ node, measured: timing, slowMs, largeSubtreeMs }),
            });
        }
    });

    modules.sort((a, b) => b.selfMs - a.selfMs);
    let sumSelfMs = 0;

    for (const sample of measured.self.values()) {
        sumSelfMs += sample.ms;
    }

    const edges: AnalysisResult["edges"] = [];

    for (const list of graph.edges.values()) {
        for (const edge of list) {
            edges.push({
                from: graph.nodes.get(edge.from)?.label ?? edge.from,
                to: graph.nodes.get(edge.to)?.label ?? edge.to,
                kind: edge.site.kind,
                names: edge.site.names,
                line: edge.site.line,
            });
        }
    }

    prof.summary("tools ts imports");
    return {
        graph,
        self: measured.self,
        result: {
            entry: graph.nodes.get(graph.entry)?.label ?? graph.entry,
            root: graph.root,
            runs,
            coldMs: measured.cold?.ms ?? 0,
            sumSelfMs,
            modules,
            edges,
            unresolved: graph.unresolved,
            workerStderr: measured.stderr,
            // A killed worker leaves whatever it had already written, and a ranking built from
            // that looks exactly like a complete one. The renderer says so out loud rather than
            // letting a partial table be read as the answer.
            timedOut: measured.timedOut,
            unmeasured: planned.filter((id) => !measured.self.has(id)).length,
            planned: planned.length,
        },
    };
}
