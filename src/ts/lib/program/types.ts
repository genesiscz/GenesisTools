/** What `tools ts program` measures. The check worker writes these as JSON; it imports this file for types only. */

export type ProgramMode = "phases" | "files" | "own" | "graph" | "sites";

export interface PhaseSample {
    phase: "start" | "parse" | "bind" | "check";
    /** Heap after a full collection when the runtime allows one (`gcForced`), else the raw heap in use. */
    heapMiB: number;
    rssMiB: number;
    ms: number;
}

export interface CheckerCounts {
    types: number;
    instantiations: number;
    symbols: number;
}

export interface ProgramSize {
    files: number;
    declarationFiles: number;
    nodeModulesFiles: number;
    nodeModulesBytes: number;
    sourceBytes: number;
}

interface WorkerBase {
    typescript: string;
    runtime: string;
    config: string;
    gcForced: boolean;
}

export interface PhasesResult extends WorkerBase, CheckerCounts {
    mode: "phases";
    size: ProgramSize;
    phases: PhaseSample[];
    diagnostics: number;
    firstDiagnostics: string[];
}

/** What checking one file created; the first file to touch a shared library type pays for it. */
export interface FileCost {
    file: string;
    types: number;
    instantiations: number;
    symbols: number;
    ms: number;
    bytes: number;
}

export interface FilesResult extends WorkerBase, CheckerCounts {
    mode: "files";
    size: ProgramSize;
    rows: FileCost[];
}

export interface OwnCost extends FileCost {
    diagnostics: string[];
}

export interface OwnResult extends WorkerBase {
    mode: "own";
    rows: OwnCost[];
}

export interface GraphFile {
    /** Relative to the tsconfig's folder, or absolute when outside it. */
    path: string;
    bytes: number;
    /** Named by the tsconfig's include or files. */
    root: boolean;
    /** Loaded by every program of these options: a default library, or a package named in `types`. */
    base: boolean;
    declaration: boolean;
    /** Indexes into `files` of what this file imports or references. */
    imports: number[];
}

export interface GraphResult extends WorkerBase {
    mode: "graph";
    files: GraphFile[];
}

/** What one call, `new`, JSX element or type reference created when it was resolved on its own, during the first check. */
export interface SiteCost {
    file: string;
    line: number;
    kind: "call" | "new" | "jsx" | "type";
    /** What it calls or references: `name @ declaring file` (a package file is named from its package folder). */
    key: string;
    /** The key's declaration is in a package or a default library, not in the project. */
    external: boolean;
    instantiations: number;
    types: number;
    symbols: number;
    ms: number;
}

export interface SitesResult extends WorkerBase, CheckerCounts {
    mode: "sites";
    /** Sites under `minInstantiations` are left out; their work stays in the program totals. */
    minInstantiations: number;
    sites: SiteCost[];
}

export type WorkerResult = PhasesResult | FilesResult | OwnResult | GraphResult | SitesResult;
