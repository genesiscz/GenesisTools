export type ImportKind = "static" | "dynamic" | "require" | "reexport" | "side-effect";

/** One import statement (or require / import() call) found in a source file. */
export interface ImportSite {
    specifier: string;
    kind: ImportKind;
    /** `import type` or every specifier marked `type`: erased at runtime, no edge. */
    typeOnly: boolean;
    /**
     * Imported binding names. `"*"` for a namespace import, `"default"` for the default
     * import, an empty array for a side-effect import. `export * from` reports `["*"]`.
     */
    names: string[];
    /** Local binding names, matched against identifiers later (alias-aware). */
    locals: string[];
    line: number;
    /**
     * `import()` under a module-scope `await`. That call blocks evaluation, so it is a load-time
     * edge even though `kind` stays `"dynamic"`.
     */
    awaited?: boolean;
}

export type SideEffectKind =
    | "await"
    | "timer"
    | "fs"
    | "spawn"
    | "native"
    | "db"
    | "network"
    | "hook"
    | "construct"
    | "call"
    | "assign";

/** A statement that runs work at module evaluation time. */
export interface SideEffect {
    kind: SideEffectKind;
    line: number;
    text: string;
}

/** Static facts about one source file, before any timing. */
export interface ParsedModule {
    imports: ImportSite[];
    /** `export * from` and `export { a } from` sites (a subset of `imports`). */
    reexports: ImportSite[];
    /** Count of exported declarations that live in this file (functions, consts, classes...). */
    localExports: number;
    /** Runtime export names this file declares itself (not re-exported). `default` included. */
    exportNames: Set<string>;
    sideEffects: SideEffect[];
    /** Local names bound by imports that are referenced at module scope (not inside a function). */
    moduleScopeUses: Set<string>;
    /** Local names bound by imports that are re-exported (`export { x }`, `export default x`). */
    reexportedLocals: Set<string>;
    bytes: number;
}

export type NodeKind = "file" | "package" | "builtin" | "asset";

export interface GraphNode {
    id: string;
    /** Absolute path for files and packages, the specifier for builtins. */
    path: string;
    /** Repo-relative path, or `pkg:@scope/name` for a package. */
    label: string;
    kind: NodeKind;
    /** Package name when `kind === "package"`. */
    packageName?: string;
    parsed?: ParsedModule;
    /** Set when the walk could not read or parse the module. */
    error?: string;
}

export interface GraphEdge {
    from: string;
    to: string;
    site: ImportSite;
}

export interface ImportGraph {
    root: string;
    entry: string;
    /** Dynamic `import()` edges are walked and measured like static ones (`--include-dynamic`). */
    includeDynamic: boolean;
    nodes: Map<string, GraphNode>;
    /** Outgoing edges per node, in source order. Only runtime edges (type-only ones are dropped). */
    edges: Map<string, GraphEdge[]>;
    /** Specifiers that did not resolve, with the importing file. */
    unresolved: Array<{ from: string; specifier: string; line: number }>;
}

export interface MeasuredModule {
    id: string;
    /** Milliseconds the module's own evaluation took once every static child was already cached. */
    selfMs: number;
    /** Milliseconds a fresh process needs to import this module and everything under it. */
    totalMs: number;
    /** Number of distinct modules reachable through static edges, this one excluded. */
    descendants: number;
    /** The import rejected. The time still counts: it is what the caller pays before the throw. */
    importError?: string;
    /** The module could not be imported in isolation (an asset, a builtin), so no self time. */
    measured: boolean;
    /**
     * Set when the module sits in an import cycle. The whole cycle evaluates when its first
     * member is imported, so that member's self time is really the cycle's and the others read
     * near zero. `paidBy` names the member that carried it.
     */
    cycle?: { size: number; paidBy: string };
}

export type FindingSeverity = "high" | "medium" | "low";

export interface Finding {
    kind:
        | "native-addon"
        | "top-level-await"
        | "side-effects"
        | "large-subtree"
        | "barrel"
        | "exits-on-import"
        | "import-error"
        | "cycle";
    severity: FindingSeverity;
    /** One line, terminal-ready. */
    summary: string;
    /** Extra lines with anchors (`file:line`) when there is something to point at. */
    details: string[];
    /** Milliseconds this finding accounts for, when the analysis can say. */
    ms?: number;
}

export interface AnalyzedModule extends MeasuredModule {
    label: string;
    kind: NodeKind;
    bytes: number;
    findings: Finding[];
}

export interface AnalysisResult {
    entry: string;
    root: string;
    runs: number;
    /** Wall time a fresh `bun` process spent inside `await import(entry)`. */
    coldMs: number;
    /** Sum of every self time, which is what the cold import should approximate. */
    sumSelfMs: number;
    modules: AnalyzedModule[];
    edges: Array<{ from: string; to: string; kind: ImportKind; names: string[]; line: number }>;
    unresolved: ImportGraph["unresolved"];
    workerStderr: string;
    /** A worker was killed at `--timeout`. Every number below is from a PARTIAL run. */
    timedOut: boolean;
    /** Modules in the worker's plan that came back with no sample. Zero on a healthy run. */
    unmeasured: number;
    /** How many modules the worker was asked to import. Dynamic targets are not among them. */
    planned: number;
}
