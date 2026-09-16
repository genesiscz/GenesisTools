import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, extname, relative, sep } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { languageFor, parseModule } from "./parse";
import type { GraphEdge, ImportGraph, ImportSite, NodeKind } from "./types";

const ASSET_EXTENSIONS = new Set([".json", ".node", ".wasm", ".css", ".txt", ".md", ".html", ".svg", ".png"]);

export interface BuildGraphOptions {
    entry: string;
    root: string;
    /**
     * Parse and walk into files under `node_modules` too. Off by default: a package is one leaf
     * node whose self time is the whole package, which is the number a caller can act on.
     */
    walkPackages?: boolean;
    /** Follow and measure dynamic `import()` targets too, marked as lazy in the output. */
    includeDynamic?: boolean;
}

/** `node_modules/@scope/name/...` and `node_modules/name/...` both name the package. */
export function packageNameOf(file: string): string | undefined {
    const parts = file.split(sep);
    const index = parts.lastIndexOf("node_modules");

    if (index === -1 || index + 1 >= parts.length) {
        return undefined;
    }

    const first = parts[index + 1];

    if (first.startsWith("@") && index + 2 < parts.length) {
        return `${first}/${parts[index + 2]}`;
    }

    return first;
}

export function isBuiltinSpecifier(specifier: string): boolean {
    return specifier.startsWith("node:") || specifier.startsWith("bun:") || specifier === "bun";
}

function kindOf(file: string): NodeKind {
    if (ASSET_EXTENSIONS.has(extname(file)) || languageFor(file) === undefined) {
        return "asset";
    }

    return packageNameOf(file) ? "package" : "file";
}

export function labelFor(file: string, root: string): string {
    const pkg = packageNameOf(file);

    if (pkg) {
        const inside = file.slice(file.lastIndexOf(`node_modules${sep}${pkg}`) + `node_modules${sep}${pkg}`.length);
        const entryName = basename(inside);
        return entryName === "index.js" || entryName === "index.mjs" || entryName === "index.cjs"
            ? `pkg:${pkg}`
            : `pkg:${pkg}${inside.replace(/\\/g, "/")}`;
    }

    const rel = relative(root, file);
    return rel.startsWith("..") ? file : rel;
}

export function resolveSpecifier(specifier: string, fromFile: string): string | undefined {
    try {
        return Bun.resolveSync(specifier, dirname(fromFile));
    } catch (error) {
        logger.debug({ specifier, fromFile, error }, "ts: specifier did not resolve");
        return undefined;
    }
}

/**
 * Runs when the importer is evaluated: static/require/re-export/side-effect, plus module-scope
 * `await import()`. Deferred `import()` inside a function is not load-time.
 */
export function isLoadTimeEdge(site: ImportSite): boolean {
    if (site.typeOnly) {
        return false;
    }

    return site.kind !== "dynamic" || site.awaited === true;
}

/** Load-time edges, plus deferred `import()` when `--include-dynamic` asked us to measure them. */
export function isMeasuredEdge(site: ImportSite, includeDynamic: boolean): boolean {
    return isLoadTimeEdge(site) || (includeDynamic && !site.typeOnly);
}

/**
 * Walk the import graph from `entry`. Repo files are parsed; a package (anything under
 * `node_modules`) is a leaf unless `walkPackages` is set; builtins (`node:`, `bun:`) are
 * recorded as nodes but never walked. Load-time edges (including module-scope `await import()`)
 * are followed; deferred `import()` is recorded but not walked unless `includeDynamic`.
 */
export function buildGraph(options: BuildGraphOptions): ImportGraph {
    // Bun.resolveSync answers with REAL paths (macOS /var → /private/var, every tmp dir with it),
    // so the entry and root are realpath'd too or the entry never matches its own node id.
    const entry = realpathSync(options.entry);
    const root = realpathSync(options.root);
    const graph: ImportGraph = {
        root,
        entry,
        includeDynamic: options.includeDynamic === true,
        nodes: new Map(),
        edges: new Map(),
        unresolved: [],
    };
    const queue: string[] = [entry];
    const walked = new Set<string>();

    while (queue.length > 0) {
        const file = queue.shift();

        if (!file || walked.has(file)) {
            continue;
        }

        walked.add(file);
        const kind = kindOf(file);
        const node = graph.nodes.get(file) ?? {
            id: file,
            path: file,
            label: labelFor(file, root),
            kind,
            packageName: packageNameOf(file),
        };
        node.kind = kind;
        node.packageName = packageNameOf(file);
        graph.nodes.set(file, node);
        const edges = graph.edges.get(file) ?? [];
        graph.edges.set(file, edges);

        if (kind === "asset" || (kind === "package" && !options.walkPackages)) {
            continue;
        }

        let source: string;

        try {
            source = readFileSync(file, "utf8");
        } catch (error) {
            node.error = error instanceof Error ? error.message : String(error);
            logger.warn({ file, error }, "ts: could not read module");
            continue;
        }

        try {
            node.parsed = parseModule(source, file);
        } catch (error) {
            node.error = error instanceof Error ? error.message : String(error);
            logger.warn({ file, error }, "ts: could not parse module");
            continue;
        }

        for (const site of node.parsed.imports) {
            if (site.typeOnly) {
                continue;
            }

            if (isBuiltinSpecifier(site.specifier)) {
                if (!graph.nodes.has(site.specifier)) {
                    graph.nodes.set(site.specifier, {
                        id: site.specifier,
                        path: site.specifier,
                        label: site.specifier,
                        kind: "builtin",
                    });
                    graph.edges.set(site.specifier, []);
                }

                edges.push({ from: file, to: site.specifier, site });
                continue;
            }

            const resolved = resolveSpecifier(site.specifier, file);

            if (!resolved) {
                graph.unresolved.push({ from: labelFor(file, root), specifier: site.specifier, line: site.line });
                continue;
            }

            edges.push({ from: file, to: resolved, site });

            if (isMeasuredEdge(site, graph.includeDynamic)) {
                queue.push(resolved);
            } else if (!graph.nodes.has(resolved)) {
                // A deferred dynamic target gets a node so `lazy` and `cycles` can name it, but it
                // is not walked: nothing under it runs at startup. Registration is not walking —
                // a later static import of the same file still parses it.
                graph.nodes.set(resolved, {
                    id: resolved,
                    path: resolved,
                    label: labelFor(resolved, root),
                    kind: kindOf(resolved),
                    packageName: packageNameOf(resolved),
                });
                graph.edges.set(resolved, []);
            }
        }
    }

    logger.debug({ entry, nodes: graph.nodes.size, unresolved: graph.unresolved.length }, "ts: import graph built");
    return graph;
}

/** Outgoing edges that run when this module is evaluated. */
export function loadTimeEdges(graph: ImportGraph, id: string): GraphEdge[] {
    return (graph.edges.get(id) ?? []).filter((edge) => isLoadTimeEdge(edge.site));
}

/** Outgoing edges the worker should import: load-time, plus deferred `import()` when requested. */
export function measuredEdges(graph: ImportGraph, id: string): GraphEdge[] {
    return (graph.edges.get(id) ?? []).filter((edge) => isMeasuredEdge(edge.site, graph.includeDynamic));
}

export interface ReachOptions {
    /** Walk measured edges instead of load-time (used by the worker plan). */
    measured?: boolean;
    /** Skip `export … from` edges so a mixed barrel's own code can be kept without its re-exports. */
    skipReexports?: boolean;
}

function outgoingEdges(graph: ImportGraph, id: string, options?: ReachOptions): GraphEdge[] {
    const edges = options?.measured ? measuredEdges(graph, id) : loadTimeEdges(graph, id);

    if (!options?.skipReexports) {
        return edges;
    }

    return edges.filter((edge) => edge.site.kind !== "reexport");
}

/**
 * Every node reachable from `start` through load-time edges, `start` excluded. `skipEdge` removes
 * one edge from the walk, which is how the exclusive cost of an import is computed.
 */
export function reachableFrom(
    graph: ImportGraph,
    start: string,
    skipEdge?: { from: string; to: string },
    options?: ReachOptions
): Set<string> {
    const seen = new Set<string>();
    const stack = [start];

    while (stack.length > 0) {
        const id = stack.pop();

        if (id === undefined) {
            continue;
        }

        for (const edge of outgoingEdges(graph, id, options)) {
            if (skipEdge && edge.from === skipEdge.from && edge.to === skipEdge.to) {
                continue;
            }

            if (!seen.has(edge.to) && edge.to !== start) {
                seen.add(edge.to);
                stack.push(edge.to);
            }
        }
    }

    return seen;
}

/**
 * Modules on the load-time path through `skipEdge` and through nothing else. `keep` is extra
 * ids that still run if the importer bypasses that one edge (used re-export targets, or a mixed
 * barrel the importer still needs for a local name).
 */
export function exclusiveFrom(
    graph: ImportGraph,
    start: string,
    skipEdge: { from: string; to: string },
    keep: Iterable<string> = []
): Set<string> {
    const kept = new Set(keep);
    const without = reachableFrom(graph, start, skipEdge);
    const exclusive = new Set<string>();

    for (const id of [skipEdge.to, ...reachableFrom(graph, skipEdge.to)]) {
        if (kept.has(id) || without.has(id)) {
            continue;
        }

        exclusive.add(id);
    }

    return exclusive;
}

/**
 * Children before parents, over measured edges. Importing modules in this order inside ONE
 * process means every `await import()` finds its children already cached, so the time it takes
 * is the module's own evaluation and nothing else. Cycles are broken at the back edge; the
 * first member imported pays for the whole cycle.
 */
export function postOrder(graph: ImportGraph, entry: string): string[] {
    const order: string[] = [];
    const state = new Map<string, "open" | "done">();
    const stack: Array<{ id: string; edges: GraphEdge[]; next: number }> = [
        { id: entry, edges: measuredEdges(graph, entry), next: 0 },
    ];
    state.set(entry, "open");

    while (stack.length > 0) {
        const frame = stack[stack.length - 1];

        if (frame.next < frame.edges.length) {
            const child = frame.edges[frame.next].to;
            frame.next++;

            if (!state.has(child)) {
                state.set(child, "open");
                stack.push({ id: child, edges: measuredEdges(graph, child), next: 0 });
            }

            continue;
        }

        state.set(frame.id, "done");
        order.push(frame.id);
        stack.pop();
    }

    return order;
}
