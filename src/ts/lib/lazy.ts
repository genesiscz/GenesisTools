import { reachableFrom, startupEdges } from "./graph";
import type { WorkerSample } from "./measure";
import type { ImportGraph } from "./types";

export interface LazyCandidate {
    importer: string;
    line: number;
    target: string;
    /** Local binding names the importer would have to load on demand. */
    locals: string[];
    /** Modules that leave the startup path when this one edge becomes `await import()`. */
    exclusiveModules: number;
    /** Self time of those modules: the saving on every start. */
    savingMs: number;
    /** Module-scope statements in the target that would run later than they do now. */
    caveats: string[];
}

/**
 * Static imports whose bindings the importer only touches inside functions. Turning such an
 * edge into `await import()` at the use site is behaviour-preserving as far as the importer's
 * own module scope goes, and the saving is exactly the self time of everything that is on the
 * startup path through this edge and through nothing else.
 */
export function findLazyCandidates(graph: ImportGraph, self: Map<string, WorkerSample>): LazyCandidate[] {
    const candidates: LazyCandidate[] = [];
    const onPath = reachableFrom(graph, graph.entry);
    onPath.add(graph.entry);

    for (const importer of onPath) {
        const node = graph.nodes.get(importer);

        if (!node?.parsed || node.kind !== "file") {
            continue;
        }

        for (const edge of startupEdges(graph, importer)) {
            const site = edge.site;

            if (site.kind !== "static" || site.locals.length === 0) {
                continue;
            }

            const usedAtScope = site.locals.some(
                (local) => node.parsed?.moduleScopeUses.has(local) || node.parsed?.reexportedLocals.has(local)
            );

            if (usedAtScope) {
                continue;
            }

            const withoutEdge = reachableFrom(graph, graph.entry, { from: importer, to: edge.to });
            let exclusiveModules = 0;
            let savingMs = 0;

            for (const id of [edge.to, ...reachableFrom(graph, edge.to)]) {
                if (withoutEdge.has(id)) {
                    continue;
                }

                exclusiveModules++;
                savingMs += self.get(id)?.ms ?? 0;
            }

            if (exclusiveModules === 0) {
                continue;
            }

            const target = graph.nodes.get(edge.to);
            const caveats: string[] = [];

            for (const effect of target?.parsed?.sideEffects ?? []) {
                if (effect.kind === "hook" || effect.kind === "timer" || effect.kind === "assign") {
                    caveats.push(`${target?.label}:${effect.line}  ${effect.text}`);
                }
            }

            candidates.push({
                importer: node.label,
                line: site.line,
                target: target?.label ?? edge.to,
                locals: site.locals,
                exclusiveModules,
                savingMs,
                caveats,
            });
        }
    }

    candidates.sort((a, b) => b.savingMs - a.savingMs || b.exclusiveModules - a.exclusiveModules);
    return candidates;
}
