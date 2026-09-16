import { isBarrel } from "./attribute";
import { reachableFrom, resolveSpecifier, startupEdges } from "./graph";
import type { WorkerSample } from "./measure";
import type { GraphNode, ImportGraph } from "./types";

export interface BarrelWaste {
    /** The importing file (repo-relative label). */
    importer: string;
    importerLine: number;
    barrel: string;
    /** Names the importer takes from the barrel. */
    used: string[];
    /** Re-export targets that provide those names. */
    usedTargets: string[];
    /** Re-export targets nothing in `used` needs. */
    unusedTargets: string[];
    /** Modules that would drop off the startup path if the importer imported the used targets directly. */
    wastedModules: number;
    wastedMs: number;
}

const MAX_STAR_DEPTH = 6;

/** Runtime export names of a module, following `export * from` up to a fixed depth. */
function exportNamesOf(graph: ImportGraph, id: string, depth: number, seen: Set<string>): Set<string> {
    const names = new Set<string>();
    const node = graph.nodes.get(id);

    if (!node?.parsed || seen.has(id) || depth > MAX_STAR_DEPTH) {
        return names;
    }

    seen.add(id);

    for (const name of node.parsed.exportNames) {
        names.add(name);
    }

    for (const site of node.parsed.reexports) {
        if (site.typeOnly) {
            continue;
        }

        const target = resolveSpecifier(site.specifier, node.path);

        if (!target) {
            continue;
        }

        if (site.names.includes("*")) {
            for (const name of exportNamesOf(graph, target, depth + 1, seen)) {
                names.add(name);
            }
        } else {
            for (const name of site.names) {
                names.add(name);
            }
        }
    }

    return names;
}

/** Which re-export targets of `barrel` supply `names`; `undefined` when a name is not a re-export at all. */
function targetsFor(graph: ImportGraph, barrel: GraphNode, names: string[]): Map<string, string | undefined> {
    const parsed = barrel.parsed;
    const result = new Map<string, string | undefined>();

    if (!parsed) {
        return result;
    }

    const explicit = new Map<string, string>();
    const stars: string[] = [];

    for (const site of parsed.reexports) {
        if (site.typeOnly) {
            continue;
        }

        const target = resolveSpecifier(site.specifier, barrel.path);

        if (!target) {
            continue;
        }

        if (site.names.includes("*")) {
            stars.push(target);
            continue;
        }

        for (const name of site.names) {
            explicit.set(name, target);
        }
    }

    for (const name of names) {
        if (parsed.exportNames.has(name)) {
            result.set(name, undefined);
            continue;
        }

        const direct = explicit.get(name);

        if (direct) {
            result.set(name, direct);
            continue;
        }

        const star = stars.find((target) => exportNamesOf(graph, target, 0, new Set()).has(name));
        result.set(name, star);
    }

    return result;
}

/**
 * For every `import { a, b } from "<barrel>"` on the startup path: which re-export targets the
 * names actually need, and how much of the barrel's subtree is on the startup path only because
 * of this import. Modules reachable from the entry some other way are not counted as waste,
 * so the ms is a real saving, not a gross.
 */
export function findBarrelWaste(graph: ImportGraph, self: Map<string, WorkerSample>): BarrelWaste[] {
    const results: BarrelWaste[] = [];
    const onPath = reachableFrom(graph, graph.entry);
    onPath.add(graph.entry);

    for (const importer of onPath) {
        const importerNode = graph.nodes.get(importer);

        if (!importerNode?.parsed) {
            continue;
        }

        for (const edge of startupEdges(graph, importer)) {
            const barrel = graph.nodes.get(edge.to);

            if (!barrel?.parsed || !isBarrel(barrel)) {
                continue;
            }

            if (edge.site.names.length === 0 || edge.site.names.includes("*")) {
                continue;
            }

            const targets = targetsFor(graph, barrel, edge.site.names);
            const usedTargets = new Set<string>();

            for (const target of targets.values()) {
                if (target) {
                    usedTargets.add(target);
                }
            }

            const allTargets = new Set<string>();

            for (const site of barrel.parsed.reexports) {
                if (!site.typeOnly) {
                    const target = resolveSpecifier(site.specifier, barrel.path);

                    if (target) {
                        allTargets.add(target);
                    }
                }
            }

            const unusedTargets = [...allTargets].filter((target) => !usedTargets.has(target));

            if (unusedTargets.length === 0) {
                continue;
            }

            const needed = new Set<string>();

            for (const target of usedTargets) {
                needed.add(target);

                for (const id of reachableFrom(graph, target)) {
                    needed.add(id);
                }
            }

            // Whatever the barrel's own code (not its re-exports) imports still runs when the
            // importer bypasses the barrel only if that code is used; a pure barrel has none.
            const withoutThisImport = reachableFrom(graph, graph.entry, { from: importer, to: edge.to });
            let wastedMs = 0;
            let wastedModules = 0;

            for (const id of [edge.to, ...reachableFrom(graph, edge.to)]) {
                if (needed.has(id) || withoutThisImport.has(id)) {
                    continue;
                }

                wastedModules++;
                wastedMs += self.get(id)?.ms ?? 0;
            }

            results.push({
                importer: importerNode.label,
                importerLine: edge.site.line,
                barrel: barrel.label,
                used: edge.site.names,
                usedTargets: [...usedTargets].map((id) => graph.nodes.get(id)?.label ?? id),
                unusedTargets: unusedTargets.map((id) => graph.nodes.get(id)?.label ?? id),
                wastedModules,
                wastedMs,
            });
        }
    }

    results.sort((a, b) => b.wastedMs - a.wastedMs || b.wastedModules - a.wastedModules);
    return results;
}
