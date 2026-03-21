import { dirname, extname, join } from "node:path";
import { extractImports } from "./graph-imports";

export interface CodeGraphNode {
    /** File path (relative to index base dir) */
    path: string;
    /** Language detected */
    language: string;
    /** Number of outgoing edges (imports) */
    importCount: number;
    /** Number of incoming edges (imported by) */
    importedByCount: number;
}

export interface CodeGraphEdge {
    /** Importing file path */
    from: string;
    /** Imported file path (resolved) */
    to: string;
    /** Whether this is a dynamic import */
    isDynamic: boolean;
}

export interface CodeGraph {
    nodes: CodeGraphNode[];
    edges: CodeGraphEdge[];
    /** When the graph was last built */
    builtAt: number;
}

interface GraphStats {
    totalNodes: number;
    totalEdges: number;
    avgImports: number;
    maxImporter: { path: string; count: number } | null;
    maxImported: { path: string; count: number } | null;
    orphanCount: number;
}

/** Determine language from file extension */
function getLanguage(filePath: string): string | null {
    const ext = extname(filePath).toLowerCase();

    switch (ext) {
        case ".ts":
        case ".js":
        case ".mjs":
        case ".cjs":
            return "typescript";
        case ".tsx":
            return "tsx";
        case ".jsx":
            return "typescript";
        case ".py":
            return "python";
        case ".go":
            return "go";
        default:
            return null;
    }
}

const TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.jsx"];

/**
 * Try to resolve a relative import specifier to an actual file in the file map.
 * Returns the resolved relative path, or null if not found.
 */
function resolveRelativeImport(specifier: string, importerPath: string, fileSet: Set<string>): string | null {
    const importerDir = dirname(importerPath);
    const basePath = join(importerDir, specifier);

    // Direct match (e.g., "./foo.ts")
    if (fileSet.has(basePath)) {
        return basePath;
    }

    // Try adding extensions
    for (const ext of TS_EXTENSIONS) {
        const withExt = basePath + ext;

        if (fileSet.has(withExt)) {
            return withExt;
        }
    }

    // Try as directory with index file
    for (const indexFile of INDEX_FILES) {
        const withIndex = join(basePath, indexFile);

        if (fileSet.has(withIndex)) {
            return withIndex;
        }
    }

    return null;
}

/**
 * Try to resolve a Python import to an actual file path.
 * Converts dotted module names to paths.
 */
function resolvePythonImport(specifier: string, fileSet: Set<string>): string | null {
    // Convert dots to path separators
    const pathParts = specifier.replace(/\./g, "/");

    // Try as .py file
    const asPy = `${pathParts}.py`;

    if (fileSet.has(asPy)) {
        return asPy;
    }

    // Try as package (__init__.py)
    const asInit = join(pathParts, "__init__.py");

    if (fileSet.has(asInit)) {
        return asInit;
    }

    return null;
}

/**
 * Build a dependency graph from indexed file content.
 *
 * @param files - Map of filePath -> content
 * @param baseDir - Base directory for resolving relative imports
 * @returns CodeGraph with nodes and edges
 */
export function buildCodeGraph(files: Map<string, string>, _baseDir: string): CodeGraph {
    const fileSet = new Set(files.keys());
    const edges: CodeGraphEdge[] = [];
    const importCounts = new Map<string, number>();
    const importedByCounts = new Map<string, number>();
    const nodeLanguages = new Map<string, string>();

    for (const [filePath, content] of files) {
        const language = getLanguage(filePath);

        if (!language) {
            continue;
        }

        nodeLanguages.set(filePath, language);
        const imports = extractImports(content, language);

        for (const imp of imports) {
            let resolved: string | null = null;

            if (imp.specifier.startsWith(".") || imp.specifier.startsWith("/")) {
                // Relative import
                resolved = resolveRelativeImport(imp.specifier, filePath, fileSet);
            } else if (language === "python") {
                resolved = resolvePythonImport(imp.specifier, fileSet);
            }

            // Skip unresolvable (external packages)
            if (!resolved) {
                continue;
            }

            edges.push({
                from: filePath,
                to: resolved,
                isDynamic: imp.isDynamic,
            });

            importCounts.set(filePath, (importCounts.get(filePath) ?? 0) + 1);
            importedByCounts.set(resolved, (importedByCounts.get(resolved) ?? 0) + 1);
        }
    }

    // Build nodes from all files that have any connection or have a known language
    const allNodePaths = new Set<string>([...importCounts.keys(), ...importedByCounts.keys(), ...nodeLanguages.keys()]);

    const nodes: CodeGraphNode[] = [];

    for (const path of allNodePaths) {
        nodes.push({
            path,
            language: nodeLanguages.get(path) ?? "unknown",
            importCount: importCounts.get(path) ?? 0,
            importedByCount: importedByCounts.get(path) ?? 0,
        });
    }

    return {
        nodes,
        edges,
        builtAt: Date.now(),
    };
}

/**
 * Generate a Mermaid diagram from a code graph.
 * For large graphs, only shows the top N most-connected nodes.
 */
export function toMermaidDiagram(graph: CodeGraph, opts?: { maxNodes?: number; showDynamic?: boolean }): string {
    const maxNodes = opts?.maxNodes ?? 30;
    const showDynamic = opts?.showDynamic ?? true;

    // Rank nodes by total connections (imports + imported-by)
    const ranked = [...graph.nodes].sort(
        (a, b) => b.importCount + b.importedByCount - (a.importCount + a.importedByCount)
    );

    const topNodes = new Set(ranked.slice(0, maxNodes).map((n) => n.path));

    const lines: string[] = ["graph LR"];

    // Node declarations
    for (const node of ranked.slice(0, maxNodes)) {
        const nodeId = sanitizeMermaidId(node.path);
        const label = node.path;
        lines.push(`    ${nodeId}["${label}"]`);
    }

    // Edges
    for (const edge of graph.edges) {
        if (!topNodes.has(edge.from) || !topNodes.has(edge.to)) {
            continue;
        }

        const fromId = sanitizeMermaidId(edge.from);
        const toId = sanitizeMermaidId(edge.to);

        if (edge.isDynamic && showDynamic) {
            lines.push(`    ${fromId} -.->|dynamic| ${toId}`);
        } else {
            lines.push(`    ${fromId} --> ${toId}`);
        }
    }

    return lines.join("\n");
}

function sanitizeMermaidId(path: string): string {
    return path.replace(/[/.\-@]/g, "_");
}

/**
 * Get basic statistics about the graph.
 */
export function getGraphStats(graph: CodeGraph): GraphStats {
    const totalNodes = graph.nodes.length;
    const totalEdges = graph.edges.length;
    const avgImports = totalNodes > 0 ? totalEdges / totalNodes : 0;

    let maxImporter: { path: string; count: number } | null = null;
    let maxImported: { path: string; count: number } | null = null;
    let orphanCount = 0;

    for (const node of graph.nodes) {
        if (node.importCount === 0 && node.importedByCount === 0) {
            orphanCount++;
        }

        if (!maxImporter || node.importCount > maxImporter.count) {
            maxImporter = { path: node.path, count: node.importCount };
        }

        if (!maxImported || node.importedByCount > maxImported.count) {
            maxImported = { path: node.path, count: node.importedByCount };
        }
    }

    return {
        totalNodes,
        totalEdges,
        avgImports: Math.round(avgImports * 100) / 100,
        maxImporter: maxImporter?.count ? maxImporter : null,
        maxImported: maxImported?.count ? maxImported : null,
        orphanCount,
    };
}
