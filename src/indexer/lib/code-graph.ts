import { dirname, extname, join } from "node:path";
import { getLanguageForExt, LANGUAGE_EXTENSIONS } from "./ast-languages";
import { loadPathAliases, type PathAliases } from "./graph-aliases";
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
    circularDependencies?: number;
}

export interface CircularDependency {
    /** File paths forming the cycle: [A, B, C] means A->B->C->A */
    cycle: string[];
    /** Number of files in the cycle */
    length: number;
}

/** Determine language from file extension */
function getLanguage(filePath: string): string | null {
    return getLanguageForExt(extname(filePath));
}

const TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.jsx"];


/**
 * Try to resolve a relative import specifier to an actual file in the file map.
 * Returns the resolved relative path, or null if not found.
 */
function resolveRelativeImport(
    specifier: string,
    importerPath: string,
    fileSet: Set<string>,
    language?: string
): string | null {
    const importerDir = dirname(importerPath);
    const basePath = join(importerDir, specifier);

    if (fileSet.has(basePath)) {
        return basePath;
    }

    const extensions = language ? (LANGUAGE_EXTENSIONS[language] ?? TS_EXTENSIONS) : TS_EXTENSIONS;

    for (const ext of extensions) {
        const withExt = basePath + ext;

        if (fileSet.has(withExt)) {
            return withExt;
        }
    }

    // Directory index files (TS/JS only)
    if (!language || language === "typescript" || language === "tsx") {
        for (const indexFile of INDEX_FILES) {
            const withIndex = join(basePath, indexFile);

            if (fileSet.has(withIndex)) {
                return withIndex;
            }
        }
    }

    // Python __init__.py
    if (language === "python") {
        const initFile = join(basePath, "__init__.py");

        if (fileSet.has(initFile)) {
            return initFile;
        }
    }

    return null;
}

/**
 * Try to resolve a non-relative import via tsconfig path aliases.
 * Returns resolved relative path, or null if no alias matches.
 */
function resolveAliasImport(
    specifier: string,
    fileSet: Set<string>,
    aliases: PathAliases,
    language?: string
): string | null {
    for (const [prefix, targets] of aliases.entries) {
        const isWildcard = prefix.endsWith("/");
        const matches = isWildcard ? specifier.startsWith(prefix) : specifier === prefix;

        if (!matches) {
            continue;
        }

        const rest = specifier.slice(prefix.length);

        for (const target of targets) {
            const basePath = join(target, rest);

            // Direct match
            if (fileSet.has(basePath)) {
                return basePath;
            }

            // Try with extensions
            const extensions = language ? (LANGUAGE_EXTENSIONS[language] ?? TS_EXTENSIONS) : TS_EXTENSIONS;

            for (const ext of extensions) {
                if (fileSet.has(basePath + ext)) {
                    return basePath + ext;
                }
            }

            // Try index files
            for (const indexFile of INDEX_FILES) {
                const withIndex = join(basePath, indexFile);

                if (fileSet.has(withIndex)) {
                    return withIndex;
                }
            }
        }
    }

    return null;
}

/** Resolve a C/C++ local include to a file path */
function resolveCInclude(specifier: string, importerPath: string, fileSet: Set<string>): string | null {
    const importerDir = dirname(importerPath);
    const candidate = join(importerDir, specifier);

    if (fileSet.has(candidate)) {
        return candidate;
    }

    return null;
}

/** Resolve a Rust mod declaration to a file path */
function resolveRustMod(specifier: string, importerPath: string, fileSet: Set<string>): string | null {
    if (specifier.includes("::")) {
        return null;
    }

    const importerDir = dirname(importerPath);
    const asFile = join(importerDir, `${specifier}.rs`);

    if (fileSet.has(asFile)) {
        return asFile;
    }

    const asDir = join(importerDir, specifier, "mod.rs");

    if (fileSet.has(asDir)) {
        return asDir;
    }

    return null;
}

/** Resolve a JVM (Java/Kotlin/Scala) import to a file path */
function resolveJvmImport(specifier: string, fileSet: Set<string>, language: string): string | null {
    const filePath = specifier.replace(/\./g, "/");
    const exts = language === "java" ? [".java"] : language === "kotlin" ? [".kt", ".kts"] : [".scala"];

    for (const ext of exts) {
        const candidate = `${filePath}${ext}`;

        if (fileSet.has(candidate)) {
            return candidate;
        }
    }

    const srcDirs = [`src/main/${language}`, "src/main", "src"];

    for (const dir of srcDirs) {
        for (const ext of exts) {
            const candidate = join(dir, `${filePath}${ext}`);

            if (fileSet.has(candidate)) {
                return candidate;
            }
        }
    }

    return null;
}

/** Resolve a PHP namespace import to a file path */
function resolvePhpImport(specifier: string, importerPath: string, fileSet: Set<string>): string | null {
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
        const importerDir = dirname(importerPath);
        const candidate = join(importerDir, specifier);

        if (fileSet.has(candidate)) {
            return candidate;
        }

        return null;
    }

    if (specifier.includes("\\")) {
        const fpPath = specifier.replace(/\\/g, "/");
        const exact = `${fpPath}.php`;

        if (fileSet.has(exact)) {
            return exact;
        }

        const segments = fpPath.split("/");

        if (segments.length > 1) {
            segments[0] = segments[0].toLowerCase();
            const lowered = `${segments.join("/")}.php`;

            if (fileSet.has(lowered)) {
                return lowered;
            }
        }

        const withoutRoot = segments.slice(1).join("/");

        if (withoutRoot) {
            const inSrc = `src/${withoutRoot}.php`;

            if (fileSet.has(inSrc)) {
                return inSrc;
            }
        }
    }

    return null;
}

/** Resolve a Ruby require to a file path */
function resolveRubyImport(specifier: string, importerPath: string, fileSet: Set<string>): string | null {
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
        const importerDir = dirname(importerPath);
        const base = join(importerDir, specifier);

        if (fileSet.has(base)) {
            return base;
        }

        const withExt = `${base}.rb`;

        if (fileSet.has(withExt)) {
            return withExt;
        }
    }

    const fromRoot = `${specifier}.rb`;

    if (fileSet.has(fromRoot)) {
        return fromRoot;
    }

    const underLib = `lib/${specifier}.rb`;

    if (fileSet.has(underLib)) {
        return underLib;
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
export function buildCodeGraph(files: Map<string, string>, baseDir: string): CodeGraph {
    const aliases = loadPathAliases(baseDir);
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
                resolved = resolveRelativeImport(imp.specifier, filePath, fileSet, language);
            } else if (language === "python") {
                resolved = resolvePythonImport(imp.specifier, fileSet);
            } else if (language === "c" || language === "cpp") {
                resolved = resolveCInclude(imp.specifier, filePath, fileSet);
            } else if (language === "rust") {
                resolved = resolveRustMod(imp.specifier, filePath, fileSet);
            } else if (language === "java" || language === "kotlin" || language === "scala") {
                resolved = resolveJvmImport(imp.specifier, fileSet, language);
            } else if (language === "php") {
                resolved = resolvePhpImport(imp.specifier, filePath, fileSet);
            } else if (language === "ruby") {
                resolved = resolveRubyImport(imp.specifier, filePath, fileSet);
            }

            // Fallback: try tsconfig/jsconfig path aliases for TS/TSX non-relative imports
            if (!resolved && (language === "typescript" || language === "tsx")) {
                if (!imp.specifier.startsWith(".") && !imp.specifier.startsWith("/")) {
                    resolved = resolveAliasImport(imp.specifier, fileSet, aliases, language);
                }
            }

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
 * Detect circular dependencies in a code graph using DFS cycle detection.
 * Returns deduplicated cycles sorted by length (shortest first).
 */
export function findCircularDependencies(graph: CodeGraph): CircularDependency[] {
    const adj = new Map<string, string[]>();

    for (const edge of graph.edges) {
        if (!adj.has(edge.from)) {
            adj.set(edge.from, []);
        }

        adj.get(edge.from)!.push(edge.to);
    }

    const cycles: CircularDependency[] = [];
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const stack: string[] = [];

    function dfs(node: string): void {
        if (inStack.has(node)) {
            const cycleStart = stack.indexOf(node);

            if (cycleStart >= 0) {
                const cycle = stack.slice(cycleStart);
                cycles.push({ cycle, length: cycle.length });
            }

            return;
        }

        if (visited.has(node)) {
            return;
        }

        visited.add(node);
        inStack.add(node);
        stack.push(node);

        for (const neighbor of adj.get(node) ?? []) {
            dfs(neighbor);
        }

        stack.pop();
        inStack.delete(node);
    }

    for (const node of adj.keys()) {
        dfs(node);
    }

    // Deduplicate: same cycle can be found starting from different nodes
    const seen = new Set<string>();

    return cycles
        .filter((c) => {
            const key = [...c.cycle].sort().join("\u2192");

            if (seen.has(key)) {
                return false;
            }

            seen.add(key);
            return true;
        })
        .sort((a, b) => a.length - b.length);
}

/**
 * Generate a Mermaid diagram from a code graph.
 * For large graphs, only shows the top N most-connected nodes.
 */
const LANG_CLASS_DEFS: Record<string, string> = {
    typescript: "fill:#3178c6,color:#fff",
    tsx: "fill:#3178c6,color:#fff",
    python: "fill:#3776ab,color:#fff",
    go: "fill:#00add8,color:#fff",
    rust: "fill:#dea584,color:#000",
    java: "fill:#b07219,color:#fff",
    kotlin: "fill:#7f52ff,color:#fff",
    scala: "fill:#dc322f,color:#fff",
    csharp: "fill:#178600,color:#fff",
    c: "fill:#555555,color:#fff",
    cpp: "fill:#f34b7d,color:#fff",
    ruby: "fill:#cc342d,color:#fff",
    php: "fill:#4f5d95,color:#fff",
    swift: "fill:#f05138,color:#fff",
};

const LANG_MERMAID_CLASS: Record<string, string> = {
    typescript: "ts",
    tsx: "ts",
    python: "py",
    go: "go",
    rust: "rs",
    java: "java",
    kotlin: "kt",
    scala: "scala",
    csharp: "cs",
    c: "clang",
    cpp: "cpp",
    ruby: "rb",
    php: "php",
    swift: "swift",
};

export function toMermaidDiagram(graph: CodeGraph, opts?: { maxNodes?: number; showDynamic?: boolean }): string {
    const maxNodes = opts?.maxNodes ?? 30;
    const showDynamic = opts?.showDynamic ?? true;

    // Rank nodes by total connections (imports + imported-by)
    const ranked = [...graph.nodes].sort(
        (a, b) => b.importCount + b.importedByCount - (a.importCount + a.importedByCount)
    );

    const topNodes = new Set(ranked.slice(0, maxNodes).map((n) => n.path));

    // Detect cycles and collect cycle edges for highlighting
    const cycles = findCircularDependencies(graph);
    const cycleEdgeKeys = new Set<string>();

    for (const dep of cycles) {
        for (let i = 0; i < dep.cycle.length; i++) {
            const from = dep.cycle[i];
            const to = dep.cycle[(i + 1) % dep.cycle.length];
            cycleEdgeKeys.add(`${from}\0${to}`);
        }
    }

    const lines: string[] = ["graph LR"];

    // Language classDef declarations
    const usedLangs = new Set<string>();

    for (const node of ranked.slice(0, maxNodes)) {
        usedLangs.add(node.language);
    }

    for (const lang of usedLangs) {
        const cls = LANG_MERMAID_CLASS[lang];
        const style = LANG_CLASS_DEFS[lang];

        if (cls && style) {
            lines.push(`    classDef ${cls} ${style}`);
        }
    }

    lines.push(`    classDef default fill:#6c757d,color:#fff`);

    // Node declarations with language class
    for (const node of ranked.slice(0, maxNodes)) {
        const nodeId = sanitizeMermaidId(node.path);
        const label = node.path;
        const cls = LANG_MERMAID_CLASS[node.language];

        if (cls) {
            lines.push(`    ${nodeId}["${label}"]:::${cls}`);
        } else {
            lines.push(`    ${nodeId}["${label}"]`);
        }
    }

    // Edges — track indices for linkStyle on cycle edges
    const edgeIndices: number[] = [];
    let edgeIndex = 0;

    for (const edge of graph.edges) {
        if (!topNodes.has(edge.from) || !topNodes.has(edge.to)) {
            continue;
        }

        const fromId = sanitizeMermaidId(edge.from);
        const toId = sanitizeMermaidId(edge.to);
        const isCycleEdge = cycleEdgeKeys.has(`${edge.from}\0${edge.to}`);

        if (isCycleEdge) {
            lines.push(`    ${fromId} -.->|cycle| ${toId}`);
            edgeIndices.push(edgeIndex);
        } else if (edge.isDynamic && showDynamic) {
            lines.push(`    ${fromId} -.->|dynamic| ${toId}`);
        } else {
            lines.push(`    ${fromId} --> ${toId}`);
        }

        edgeIndex++;
    }

    // Red dashed style for cycle edges
    for (const idx of edgeIndices) {
        lines.push(`    linkStyle ${idx} stroke:#ff0000,stroke-dasharray:5`);
    }

    // Legend subgraph
    const legendLangs = [...usedLangs].filter((l) => LANG_MERMAID_CLASS[l]).sort();

    if (legendLangs.length > 1) {
        lines.push(`    subgraph Legend`);

        for (const lang of legendLangs) {
            const cls = LANG_MERMAID_CLASS[lang]!;
            lines.push(`        legend_${cls}["${lang}"]:::${cls}`);
        }

        lines.push(`    end`);
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

    const circularDeps = findCircularDependencies(graph);

    return {
        totalNodes,
        totalEdges,
        avgImports: Math.round(avgImports * 100) / 100,
        maxImporter: maxImporter?.count ? maxImporter : null,
        maxImported: maxImported?.count ? maxImported : null,
        orphanCount,
        circularDependencies: circularDeps.length,
    };
}
