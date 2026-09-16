import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, extname, relative, sep } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { languageFor, parseModule } from "./parse";
import type { GraphEdge, GraphNode, ImportGraph, ImportSite, NodeKind } from "./types";

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

/** Runtime edges only: type-only sites are erased and dynamic ones do not run at import time. */
export function isStartupEdge(site: ImportSite, includeDynamic = false): boolean {
    return !site.typeOnly && (includeDynamic || site.kind !== "dynamic");
}

/**
 * Walk the static import graph from `entry`. Repo files are parsed; a package (anything under
 * `node_modules`) is a leaf unless `walkPackages` is set; builtins (`node:`, `bun:`) are
 * recorded as nodes but never walked. Dynamic imports are kept as edges (they matter for
 * `lazy` and `cycles`) but are not followed, so the graph is the startup graph.
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

    while (queue.length > 0) {
        const file = queue.shift();

        if (!file || graph.nodes.has(file)) {
            continue;
        }

        const kind = kindOf(file);
        const node: GraphNode = {
            id: file,
            path: file,
            label: labelFor(file, root),
            kind,
            packageName: packageNameOf(file),
        };
        graph.nodes.set(file, node);
        graph.edges.set(file, []);

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

        const edges = graph.edges.get(file) ?? [];

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
                graph.unresolved.push({ from: file, specifier: site.specifier, line: site.line });
                continue;
            }

            edges.push({ from: file, to: resolved, site });

            if (isStartupEdge(site, graph.includeDynamic)) {
                queue.push(resolved);
            } else if (!graph.nodes.has(resolved)) {
                // A dynamic target gets a node so `lazy` and `cycles` can name it, but it is not
                // walked: nothing under it runs at startup.
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

/** Outgoing startup edges of a node (type-only and dynamic edges excluded). */
export function startupEdges(graph: ImportGraph, id: string): GraphEdge[] {
    return (graph.edges.get(id) ?? []).filter((edge) => isStartupEdge(edge.site, graph.includeDynamic));
}

/**
 * Every node reachable from `start` through startup edges, `start` excluded. `skipEdge` removes
 * one edge from the walk, which is how the exclusive cost of an import is computed.
 */
export function reachableFrom(graph: ImportGraph, start: string, skipEdge?: { from: string; to: string }): Set<string> {
    const seen = new Set<string>();
    const stack = [start];

    while (stack.length > 0) {
        const id = stack.pop();

        if (id === undefined) {
            continue;
        }

        for (const edge of startupEdges(graph, id)) {
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
 * Children before parents, over startup edges. Importing modules in this order inside ONE
 * process means every `await import()` finds its children already cached, so the time it takes
 * is the module's own evaluation and nothing else. Cycles are broken at the back edge; the
 * first member imported pays for the whole cycle.
 */
export function postOrder(graph: ImportGraph, entry: string): string[] {
    const order: string[] = [];
    const state = new Map<string, "open" | "done">();
    const stack: Array<{ id: string; edges: GraphEdge[]; next: number }> = [
        { id: entry, edges: startupEdges(graph, entry), next: 0 },
    ];
    state.set(entry, "open");

    while (stack.length > 0) {
        const frame = stack[stack.length - 1];

        if (frame.next < frame.edges.length) {
            const child = frame.edges[frame.next].to;
            frame.next++;

            if (!state.has(child)) {
                state.set(child, "open");
                stack.push({ id: child, edges: startupEdges(graph, child), next: 0 });
            }

            continue;
        }

        state.set(frame.id, "done");
        order.push(frame.id);
        stack.pop();
    }

    return order;
}
