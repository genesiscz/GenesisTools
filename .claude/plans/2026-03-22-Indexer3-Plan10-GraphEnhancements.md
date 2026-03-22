# Indexer v3 — Plan 10: Graph Enhancements

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add circular dependency detection, tsconfig path alias resolution, graph persistence to SQLite, and auto-watcher start after indexing.

**Architecture:** Extend existing `code-graph.ts` with cycle detection (DFS), add `graph-aliases.ts` for tsconfig resolution, persist graph in the existing index SQLite DB, wire watcher auto-start into sync completion.

**Tech Stack:** TypeScript/Bun, @ast-grep/napi, existing SQLite store, bun:test

---

## Task 1 — Circular dependency detection

**Files:**
- `src/indexer/lib/code-graph.ts`

**What:** Add a `findCircularDependencies(graph)` function using iterative DFS with back-edge detection. The function operates on the existing `CodeGraph` type (where edges use `from`/`to` string pairs and nodes carry `importCount`/`importedByCount` counters). Returns an array of cycles, where each cycle is an array of file paths forming the loop (last element equals first to close the cycle).

**Why iterative DFS:** Avoids stack overflow on large graphs with deep dependency chains. SC's version uses recursive DFS, which works but risks blowing the call stack on deeply nested monorepos.

**Code:**

```typescript
// Append to src/indexer/lib/code-graph.ts

export interface CircularDependency {
    /** Ordered list of file paths forming the cycle (last === first) */
    cycle: string[];
    /** Number of files involved (cycle.length - 1) */
    length: number;
}

/**
 * Find all circular dependencies in the code graph using iterative DFS
 * with back-edge detection. Returns deduplicated cycles.
 */
export function findCircularDependencies(graph: CodeGraph): CircularDependency[] {
    // Build adjacency list from edges
    const adjacency = new Map<string, string[]>();

    for (const edge of graph.edges) {
        const existing = adjacency.get(edge.from);

        if (existing) {
            existing.push(edge.to);
        } else {
            adjacency.set(edge.from, [edge.to]);
        }
    }

    const visited = new Set<string>();
    const cycles: CircularDependency[] = [];
    const seen = new Set<string>(); // dedup by sorted cycle signature

    for (const node of graph.nodes) {
        if (visited.has(node.path)) {
            continue;
        }

        // Iterative DFS with explicit stack
        // Each frame: [node, pathSoFar, inStack, neighborIndex]
        const stack: Array<{
            node: string;
            pathSoFar: string[];
            inStack: Set<string>;
            neighborIdx: number;
        }> = [];

        const startInStack = new Set<string>([node.path]);
        stack.push({
            node: node.path,
            pathSoFar: [node.path],
            inStack: startInStack,
            neighborIdx: 0,
        });
        visited.add(node.path);

        while (stack.length > 0) {
            const frame = stack[stack.length - 1];
            const neighbors = adjacency.get(frame.node) ?? [];

            if (frame.neighborIdx >= neighbors.length) {
                // Done with this node — backtrack
                frame.inStack.delete(frame.node);
                stack.pop();
                continue;
            }

            const neighbor = neighbors[frame.neighborIdx];
            frame.neighborIdx++;

            if (frame.inStack.has(neighbor)) {
                // Back edge found — extract cycle
                const cycleStart = frame.pathSoFar.indexOf(neighbor);

                if (cycleStart >= 0) {
                    const cyclePath = [...frame.pathSoFar.slice(cycleStart), neighbor];
                    // Dedup: normalize by sorting the inner nodes and creating a signature
                    const signature = [...cyclePath.slice(0, -1)].sort().join("\0");

                    if (!seen.has(signature)) {
                        seen.add(signature);
                        cycles.push({
                            cycle: cyclePath,
                            length: cyclePath.length - 1,
                        });
                    }
                }
            } else if (!visited.has(neighbor)) {
                visited.add(neighbor);
                const newInStack = new Set(frame.inStack);
                newInStack.add(neighbor);
                stack.push({
                    node: neighbor,
                    pathSoFar: [...frame.pathSoFar, neighbor],
                    inStack: newInStack,
                    neighborIdx: 0,
                });
            }
        }
    }

    // Sort by cycle length (shortest first — most actionable)
    cycles.sort((a, b) => a.length - b.length);

    return cycles;
}
```

**Tests:** See Task 7.

**Commit:** `feat(indexer): add circular dependency detection via iterative DFS`

---

## Task 2 — Add `tools indexer graph circular <name>` CLI command

**Files:**
- `src/indexer/commands/graph.ts`

**What:** Extend the existing `graph` command with a `--format circular` option that runs `findCircularDependencies()` and displays the results. Shows each cycle with its file path chain, colored to highlight the loop-back edge.

**Code:**

```typescript
// In src/indexer/commands/graph.ts — update the format option and switch:

// 1. Update the option description line:
.option("--format <format>", "Output format: mermaid | stats | circular | json", "stats")

// 2. Import findCircularDependencies:
import { buildCodeGraph, findCircularDependencies, getGraphStats, toMermaidDiagram } from "../lib/code-graph";
import type { CircularDependency } from "../lib/code-graph";

// 3. Add case to the switch:
case "circular":
    showCircularDependencies(graph);
    break;

// 4. Add the display function:
function showCircularDependencies(graph: ReturnType<typeof buildCodeGraph>): void {
    const cycles = findCircularDependencies(graph);

    if (cycles.length === 0) {
        p.log.success("No circular dependencies found");
        return;
    }

    p.log.warn(`Found ${cycles.length} circular ${cycles.length === 1 ? "dependency" : "dependencies"}`);
    console.log("");

    for (let i = 0; i < cycles.length; i++) {
        const { cycle, length } = cycles[i];
        p.log.step(`${pc.bold(`Cycle ${i + 1}`)} (${length} files):`);

        for (let j = 0; j < cycle.length; j++) {
            const isLast = j === cycle.length - 1;
            const prefix = isLast ? pc.red("  \u21ba ") : "  \u2192 ";
            const label = isLast ? pc.red(cycle[j]) : cycle[j];
            p.log.step(`${prefix}${label}`);
        }

        console.log("");
    }
}
```

**Commit:** `feat(indexer): add circular dependency detection to graph command`

---

## Task 3 — tsconfig.json path alias resolution

**Files:**
- `src/indexer/lib/graph-aliases.ts` (new file)
- `src/indexer/lib/code-graph.ts`

**What:** Create `graph-aliases.ts` that reads `compilerOptions.paths` with full `extends` chain support, converting path patterns to a prefix-to-directories map. Wire it into `buildCodeGraph` so non-relative TS/JS imports (e.g., `@app/utils/format`) get resolved via tsconfig aliases. This mirrors what SC's `graph-aliases.ts` does but adapted to our simpler `CodeGraph` shape.

**Design decisions:**
- Follows `extends` chains up to 10 levels (matches SC)
- Handles both wildcard (`@app/*`) and exact (`~`) alias patterns
- Strips JSON comments (tsconfig allows `//` and `/* */`)
- Gracefully returns empty aliases if no tsconfig found (no errors)

**Code for `src/indexer/lib/graph-aliases.ts`:**

```typescript
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export interface PathAliases {
    /** Map of alias prefix -> target directories (relative to project root) */
    entries: Map<string, string[]>;
}

const EMPTY_ALIASES: PathAliases = { entries: new Map() };
const MAX_EXTENDS_DEPTH = 10;

/**
 * Load path aliases from tsconfig.json or jsconfig.json.
 * Follows `extends` chains to find `compilerOptions.paths`.
 * Returns empty aliases if no config found (graceful degradation).
 */
export function loadPathAliases(baseDir: string): PathAliases {
    const configNames = ["tsconfig.json", "jsconfig.json"];

    for (const name of configNames) {
        const configPath = join(baseDir, name);

        try {
            const raw = readFileSync(configPath, "utf-8");
            const aliases = parsePathAliases(raw, baseDir);

            if (aliases.entries.size > 0) {
                return aliases;
            }

            // No paths in this file — follow extends chain
            const extended = followExtendsChain(configPath, baseDir);

            if (extended.entries.size > 0) {
                return extended;
            }
        } catch {
            // File not found — try next config name
        }
    }

    return EMPTY_ALIASES;
}

/** Strip JSON comments (// and /* */) that tsconfig allows */
function stripJsonComments(json: string): string {
    return json.replace(
        /"(?:[^"\\]|\\.)*"|\/\/.*$|\/\*[\s\S]*?\*\//gm,
        (match) => (match.startsWith('"') ? match : ""),
    );
}

/** Parse tsconfig JSON with comment stripping. Returns null on failure. */
function parseTsconfigJson(content: string): Record<string, unknown> | null {
    try {
        return JSON.parse(stripJsonComments(content));
    } catch {
        return null;
    }
}

/** Parse path aliases from tsconfig/jsconfig JSON content. */
export function parsePathAliases(jsonContent: string, projectDir: string): PathAliases {
    const config = parseTsconfigJson(jsonContent);

    if (!config) {
        return EMPTY_ALIASES;
    }

    const compilerOptions = config.compilerOptions as Record<string, unknown> | undefined;

    if (!compilerOptions?.paths) {
        return EMPTY_ALIASES;
    }

    const baseUrl = (compilerOptions.baseUrl as string) ?? ".";
    const baseDir = resolve(projectDir, baseUrl);
    const paths = compilerOptions.paths as Record<string, string[]>;
    const entries = new Map<string, string[]>();

    for (const [pattern, targets] of Object.entries(paths)) {
        if (!Array.isArray(targets) || targets.length === 0) {
            continue;
        }

        // "$lib/*" -> prefix "$lib/", exact "~" -> prefix "~"
        const prefix = pattern.endsWith("/*") ? pattern.slice(0, -1) : pattern;
        const resolvedTargets: string[] = [];

        for (const target of targets) {
            if (typeof target !== "string") {
                continue;
            }

            const targetPath = target.endsWith("/*") ? target.slice(0, -1) : target;
            const absolute = resolve(baseDir, targetPath);
            resolvedTargets.push(relative(projectDir, absolute));
        }

        if (resolvedTargets.length > 0) {
            entries.set(prefix, resolvedTargets);
        }
    }

    return { entries };
}

/** Follow the `extends` chain looking for `compilerOptions.paths`. */
function followExtendsChain(configPath: string, projectDir: string): PathAliases {
    const visited = new Set<string>();
    let currentPath = configPath;

    for (let depth = 0; depth < MAX_EXTENDS_DEPTH; depth++) {
        const resolved = resolve(currentPath);

        if (visited.has(resolved)) {
            break;
        }

        visited.add(resolved);

        let raw: string;

        try {
            raw = readFileSync(resolved, "utf-8");
        } catch {
            break;
        }

        const config = parseTsconfigJson(raw);

        if (!config) {
            break;
        }

        const co = config.compilerOptions as Record<string, unknown> | undefined;

        if (co?.paths) {
            return parsePathAliases(raw, dirname(resolved));
        }

        const extendsValue = config.extends;

        if (!extendsValue || typeof extendsValue !== "string") {
            break;
        }

        const configDir = dirname(resolved);

        if (extendsValue.startsWith(".")) {
            currentPath = resolve(configDir, extendsValue);

            if (!currentPath.endsWith(".json")) {
                currentPath += ".json";
            }
        } else {
            // Package reference — resolve from node_modules
            currentPath = resolve(configDir, "node_modules", extendsValue);

            if (!currentPath.endsWith(".json")) {
                currentPath += ".json";
            }
        }
    }

    return EMPTY_ALIASES;
}
```

**Wiring into `code-graph.ts` — update `resolveRelativeImport` and `buildCodeGraph`:**

```typescript
// 1. Add import at top of code-graph.ts:
import { loadPathAliases, type PathAliases } from "./graph-aliases";

// 2. Add alias resolution function after resolveRelativeImport:
/**
 * Try to resolve a non-relative import via tsconfig path aliases.
 * Returns resolved relative path, or null if no alias matches.
 */
function resolveAliasImport(
    specifier: string,
    fileSet: Set<string>,
    aliases: PathAliases,
    language?: string,
): string | null {
    for (const [prefix, targets] of aliases.entries) {
        const isWildcard = prefix.endsWith("/");
        const matches = isWildcard
            ? specifier.startsWith(prefix)
            : specifier === prefix;

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
            const extensions = language
                ? (LANGUAGE_EXTENSIONS[language] ?? TS_EXTENSIONS)
                : TS_EXTENSIONS;

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

// 3. Update buildCodeGraph to load aliases and use them:
// - Remove `void baseDir;` line
// - Add: `const aliases = loadPathAliases(baseDir);`
// - In the import resolution loop, after the relative/language-specific checks
//   and before `if (!resolved) continue;`, add the alias fallback:
if (!resolved && (language === "typescript" || language === "tsx")) {
    if (!imp.specifier.startsWith(".") && !imp.specifier.startsWith("/")) {
        resolved = resolveAliasImport(imp.specifier, fileSet, aliases, language);
    }
}
```

**Tests:** See Task 7.

**Commit:** `feat(indexer): add tsconfig path alias resolution for graph imports`

---

## Task 4 — Graph persistence to SQLite

**Files:**
- `src/indexer/lib/store.ts`
- `src/indexer/commands/graph.ts`

**What:** Persist the `CodeGraph` as a serialized JSON blob in the existing index SQLite database. Add a `code_graph` table with a single row. This avoids rebuilding the graph from scratch on every `tools indexer graph` call — just rebuild when the index has been updated (track via a `builtAt` timestamp comparison against `lastSyncAt`).

**Schema:**

```sql
CREATE TABLE IF NOT EXISTS code_graph (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    graph_json TEXT NOT NULL,
    built_at INTEGER NOT NULL
)
```

**Code additions to `store.ts`:**

```typescript
// 1. Add to the IndexStore interface:
/** Save a serialized code graph */
saveCodeGraph(graphJson: string, builtAt: number): void;
/** Load the persisted code graph, or null if not present / stale */
loadCodeGraph(): { graphJson: string; builtAt: number } | null;

// 2. Add table creation after the existing CREATE TABLE statements:
db.run(`CREATE TABLE IF NOT EXISTS code_graph (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    graph_json TEXT NOT NULL,
    built_at INTEGER NOT NULL
)`);

// 3. Implement in the store object:
saveCodeGraph(graphJson: string, builtAt: number): void {
    db.run(
        "INSERT OR REPLACE INTO code_graph (id, graph_json, built_at) VALUES (1, ?, ?)",
        [graphJson, builtAt],
    );
},

loadCodeGraph(): { graphJson: string; builtAt: number } | null {
    const row = db.query("SELECT graph_json, built_at FROM code_graph WHERE id = 1").get() as {
        graph_json: string;
        built_at: number;
    } | null;

    if (!row) {
        return null;
    }

    return { graphJson: row.graph_json, builtAt: row.built_at };
},
```

**Code changes to `graph.ts` command — use cached graph when fresh:**

```typescript
const store = indexer.getStore();
const config = indexer.getConfig();
const meta = store.getMeta();

// Try loading cached graph first
let graph: ReturnType<typeof buildCodeGraph>;
const cached = store.loadCodeGraph();
const lastSync = meta.lastSyncAt ?? 0;

if (cached && cached.builtAt >= lastSync) {
    p.log.info("Using cached graph");
    graph = SafeJSON.parse(cached.graphJson);
} else {
    p.log.step("Building code graph...");
    const startTime = performance.now();
    const fileContents = store.getAllFileContents();
    graph = buildCodeGraph(fileContents, config.baseDir);
    const buildMs = performance.now() - startTime;
    p.log.info(`Graph built in ${Math.round(buildMs)}ms`);

    // Persist for next time
    store.saveCodeGraph(SafeJSON.stringify(graph), graph.builtAt);
}
```

**Tests:** See Task 7.

**Commit:** `feat(indexer): persist code graph to SQLite for faster reloads`

---

## Task 5 — Auto-watcher start after sync

**Files:**
- `src/indexer/lib/types.ts`
- `src/indexer/commands/sync.ts`

**What:** After `sync` completes successfully, optionally auto-start the native file watcher so the index stays current without the user running `tools indexer watch` separately. This is controlled by a new `watch.autoStart` boolean in `IndexConfig` (default: `false`).

**Changes to `types.ts`:**

```typescript
// In the watch section of IndexConfig, add:
watch?: {
    enabled?: boolean;
    strategy?: "native" | "polling" | "git" | "merkle" | "git+merkle" | "chokidar";
    interval?: number;
    /** Debounce for native watcher in ms. Default: 2000 */
    debounceMs?: number;
    /** Auto-start watcher after sync completes. Default: false */
    autoStart?: boolean;
};
```

**Changes to `sync.ts`:**

```typescript
// After the sync loop (after the for-of that syncs each index), before p.outro:

// Auto-start watchers for indexes that opt in
const watchStarted: string[] = [];

for (const indexName of names) {
    try {
        const indexer = await manager.getIndex(indexName);
        const watchConfig = indexer.getConfig().watch;

        if (watchConfig?.autoStart) {
            await indexer.startWatch();
            watchStarted.push(indexName);
        }
    } catch {
        // Watcher start failure should not block sync completion
    }
}

if (watchStarted.length > 0) {
    p.log.info(
        `Auto-started watcher for: ${watchStarted.map((n) => pc.bold(n)).join(", ")}`
    );
    p.log.info(pc.dim("Press Ctrl+C to stop watching"));

    process.on("SIGINT", async () => {
        await manager.close();
        process.exit(0);
    });

    // Keep process alive
    await new Promise(() => {});
} else {
    p.outro("Done");
}
```

**Important:** When `autoStart` is true and sync is run from CLI, the process needs to stay alive (like `watch` command). The code above handles this by entering an infinite promise when watchers are active.

**Tests:** Manual testing only for CLI behavior. Unit test for config parsing in Task 7.

**Commit:** `feat(indexer): add autoStart watcher option after sync`

---

## Task 6 — Mermaid circular dependency highlighting

**Files:**
- `src/indexer/lib/code-graph.ts`

**What:** Enhance `toMermaidDiagram()` to detect circular dependencies in the graph and render those edges as dashed red lines with a "cycle" label. This gives visual feedback in the Mermaid output about problematic import chains.

**Code:**

```typescript
// Update toMermaidDiagram in code-graph.ts:

export function toMermaidDiagram(graph: CodeGraph, opts?: { maxNodes?: number; showDynamic?: boolean }): string {
    const maxNodes = opts?.maxNodes ?? 30;
    const showDynamic = opts?.showDynamic ?? true;

    // Rank nodes by total connections (imports + imported-by)
    const ranked = [...graph.nodes].sort(
        (a, b) => b.importCount + b.importedByCount - (a.importCount + a.importedByCount),
    );

    const topNodes = new Set(ranked.slice(0, maxNodes).map((n) => n.path));
    const lines: string[] = ["graph LR"];

    // Detect circular dependency edges
    const cycles = findCircularDependencies(graph);
    const cyclicEdges = new Set<string>();

    for (const { cycle } of cycles) {
        for (let i = 0; i < cycle.length - 1; i++) {
            cyclicEdges.add(`${cycle[i]}\0${cycle[i + 1]}`);
        }
    }

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
        const edgeKey = `${edge.from}\0${edge.to}`;

        if (cyclicEdges.has(edgeKey)) {
            // Dashed red line for circular dependencies
            lines.push(`    ${fromId} -.->|cycle| ${toId}`);
        } else if (edge.isDynamic && showDynamic) {
            lines.push(`    ${fromId} -.->|dynamic| ${toId}`);
        } else {
            lines.push(`    ${fromId} --> ${toId}`);
        }
    }

    // Style circular dependency nodes with red dashed border
    const cyclicNodes = new Set<string>();

    for (const { cycle } of cycles) {
        for (const nodePath of cycle) {
            if (topNodes.has(nodePath)) {
                cyclicNodes.add(nodePath);
            }
        }
    }

    if (cyclicNodes.size > 0) {
        lines.push("");

        for (const nodePath of cyclicNodes) {
            const nodeId = sanitizeMermaidId(nodePath);
            lines.push(`    style ${nodeId} stroke:#e74c3c,stroke-width:2px,stroke-dasharray:5`);
        }
    }

    return lines.join("\n");
}
```

**Tests:** See Task 7.

**Commit:** `feat(indexer): highlight circular deps in Mermaid diagrams with dashed red edges`

---

## Task 7 — Tests for all new features

**Files:**
- `src/indexer/lib/code-graph.test.ts`

**What:** Add test cases covering circular dependency detection, tsconfig alias resolution, graph persistence round-trip, and Mermaid circular highlighting. These use the existing `bun:test` setup.

**Code:**

```typescript
// Append to code-graph.test.ts

import { loadPathAliases, parsePathAliases } from "./graph-aliases";
import { findCircularDependencies } from "./code-graph";

describe("findCircularDependencies", () => {
    test("detects simple A -> B -> A cycle", () => {
        const files = new Map<string, string>([
            ["src/a.ts", `import { b } from "./b";`],
            ["src/b.ts", `import { a } from "./a";`],
        ]);

        const graph = buildCodeGraph(files, "/project");
        const cycles = findCircularDependencies(graph);

        expect(cycles.length).toBeGreaterThanOrEqual(1);
        const cyclePaths = cycles[0].cycle;
        expect(cyclePaths[0]).toBe(cyclePaths[cyclePaths.length - 1]); // closed loop
        expect(cycles[0].length).toBe(2);
    });

    test("detects A -> B -> C -> A cycle", () => {
        const files = new Map<string, string>([
            ["src/a.ts", `import { b } from "./b";`],
            ["src/b.ts", `import { c } from "./c";`],
            ["src/c.ts", `import { a } from "./a";`],
        ]);

        const graph = buildCodeGraph(files, "/project");
        const cycles = findCircularDependencies(graph);

        expect(cycles.length).toBeGreaterThanOrEqual(1);
        expect(cycles[0].length).toBe(3);
    });

    test("returns empty array when no cycles exist", () => {
        const files = new Map<string, string>([
            ["src/a.ts", `import { b } from "./b";`],
            ["src/b.ts", `import { c } from "./c";`],
            ["src/c.ts", `export const c = 1;`],
        ]);

        const graph = buildCodeGraph(files, "/project");
        const cycles = findCircularDependencies(graph);
        expect(cycles).toHaveLength(0);
    });

    test("handles self-import as a cycle", () => {
        const files = new Map<string, string>([
            ["src/self.ts", `import { x } from "./self";`],
        ]);

        const graph = buildCodeGraph(files, "/project");
        const cycles = findCircularDependencies(graph);
        expect(cycles.length).toBeGreaterThanOrEqual(1);
    });

    test("handles graph with no edges", () => {
        const files = new Map<string, string>([
            ["src/a.ts", `export const a = 1;`],
            ["src/b.ts", `export const b = 2;`],
        ]);

        const graph = buildCodeGraph(files, "/project");
        const cycles = findCircularDependencies(graph);
        expect(cycles).toHaveLength(0);
    });
});

describe("toMermaidDiagram with circular deps", () => {
    test("marks circular edges with cycle label", () => {
        const files = new Map<string, string>([
            ["src/a.ts", `import { b } from "./b";`],
            ["src/b.ts", `import { a } from "./a";`],
        ]);

        const graph = buildCodeGraph(files, "/project");
        const mermaid = toMermaidDiagram(graph);

        expect(mermaid).toContain("-.->|cycle|");
    });

    test("adds dashed red style to cyclic nodes", () => {
        const files = new Map<string, string>([
            ["src/a.ts", `import { b } from "./b";`],
            ["src/b.ts", `import { a } from "./a";`],
        ]);

        const graph = buildCodeGraph(files, "/project");
        const mermaid = toMermaidDiagram(graph);

        expect(mermaid).toContain("stroke:#e74c3c");
        expect(mermaid).toContain("stroke-dasharray:5");
    });

    test("does not add cycle styling when no cycles exist", () => {
        const files = new Map<string, string>([
            ["src/a.ts", `import { b } from "./b";`],
            ["src/b.ts", `export const b = 1;`],
        ]);

        const graph = buildCodeGraph(files, "/project");
        const mermaid = toMermaidDiagram(graph);

        expect(mermaid).not.toContain("-.->|cycle|");
        expect(mermaid).not.toContain("stroke:#e74c3c");
    });
});

describe("graph persistence round-trip", () => {
    test("serialized graph preserves structure", () => {
        const files = new Map<string, string>([
            ["src/a.ts", `import { b } from "./b";`],
            ["src/b.ts", `export const b = 1;`],
        ]);

        const graph = buildCodeGraph(files, "/project");
        const json = JSON.stringify(graph);
        const restored = JSON.parse(json) as typeof graph;

        expect(restored.nodes.length).toBe(graph.nodes.length);
        expect(restored.edges.length).toBe(graph.edges.length);
        expect(restored.builtAt).toBe(graph.builtAt);
        expect(restored.edges[0].from).toBe(graph.edges[0].from);
        expect(restored.edges[0].to).toBe(graph.edges[0].to);
    });
});

describe("parsePathAliases", () => {
    test("parses wildcard aliases", () => {
        const tsconfig = JSON.stringify({
            compilerOptions: {
                baseUrl: ".",
                paths: {
                    "@app/*": ["src/*"],
                    "@utils/*": ["src/utils/*"],
                },
            },
        });

        const aliases = parsePathAliases(tsconfig, "/project");
        expect(aliases.entries.size).toBe(2);
        expect(aliases.entries.get("@app/")).toEqual(["src/"]);
        expect(aliases.entries.get("@utils/")).toEqual(["src/utils/"]);
    });

    test("parses exact aliases", () => {
        const tsconfig = JSON.stringify({
            compilerOptions: {
                baseUrl: ".",
                paths: { "~": ["./src"] },
            },
        });

        const aliases = parsePathAliases(tsconfig, "/project");
        expect(aliases.entries.size).toBe(1);
        expect(aliases.entries.get("~")).toEqual(["src"]);
    });

    test("strips JSON comments", () => {
        const tsconfig = `{
            // This is a comment
            "compilerOptions": {
                "baseUrl": ".",
                /* block comment */
                "paths": { "@app/*": ["src/*"] }
            }
        }`;

        const aliases = parsePathAliases(tsconfig, "/project");
        expect(aliases.entries.size).toBe(1);
    });

    test("returns empty for missing compilerOptions", () => {
        const tsconfig = JSON.stringify({});
        const aliases = parsePathAliases(tsconfig, "/project");
        expect(aliases.entries.size).toBe(0);
    });

    test("returns empty for invalid JSON", () => {
        const aliases = parsePathAliases("not json", "/project");
        expect(aliases.entries.size).toBe(0);
    });
});

describe("loadPathAliases", () => {
    test("returns empty aliases for directory without tsconfig", () => {
        const aliases = loadPathAliases("/nonexistent/path");
        expect(aliases.entries.size).toBe(0);
    });
});
```

**Run:** `bun test src/indexer/lib/code-graph.test.ts`

**Commit:** `test(indexer): add tests for circular deps, mermaid highlighting, graph persistence, alias parsing`

---

## Task 8 — Simplify

**Files:** All files touched in Tasks 1-7.

**Review checklist:**
1. **Dedup:** Check if `findCircularDependencies` and `toMermaidDiagram` share any cycle-detection logic that should be extracted into a shared helper (e.g., `buildAdjacencyList` from edges).
2. **Consistency:** Verify that `CircularDependency.cycle` format (last === first) is consistent everywhere it's used (CLI display, Mermaid rendering, tests).
3. **Graph aliases:** Compare the new `graph-aliases.ts` with SC's version at `.worktrees/socraticode/src/services/graph-aliases.ts` — ensure we didn't duplicate logic unnecessarily. Our version is synchronous (uses `readFileSync`) since graph building is already a batch operation; SC's is async. This is intentional.
4. **Store interface:** Make sure `saveCodeGraph`/`loadCodeGraph` are added to the `IndexStore` interface declaration (at top of store.ts), not just the implementation object.
5. **Type exports:** Ensure `CircularDependency` and `PathAliases` are properly exported and importable by consumers.
6. **Performance:** Review the iterative DFS — it currently copies `inStack` per frame (`new Set(frame.inStack)`). This is O(n) per frame. For graphs under 10k nodes this is fine. For larger graphs, consider switching to a single mutable `Set` with add/delete on backtrack (like SC's recursive version). If you optimize, add a comment explaining the tradeoff.
7. **Dead code:** Remove the `void baseDir;` line from `buildCodeGraph` since we now actually use `baseDir` for alias loading.
8. **Test coverage:** Ensure all public functions have at least one test. Check edge cases: empty graph, single-node graph, disconnected components with no cycles.
9. **Import tidiness:** Verify no unused imports were left behind in any modified file.

**Commit:** `refactor(indexer): simplify graph enhancements — dedup, consistency, dead code`
