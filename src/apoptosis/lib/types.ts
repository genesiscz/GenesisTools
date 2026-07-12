export interface SurvivalSignals {
    churnCount: number;
    inboundImports: number;
    hasCoverage: boolean;
}

export interface ScoredSurvival extends SurvivalSignals {
    isCandidate: boolean;
}

export type LifecycleStatus = "alive" | "dying" | "dead" | "rescued";

export interface FileReport {
    path: string;
    survival: ScoredSurvival;
    status: LifecycleStatus;
    firstMarked: string | null;
    daysMarked: number | null;
    daysLeft: number | null;
}

export interface ScanReport {
    dir: string;
    scannedAt: string;
    churnDays: number;
    graceDays: number;
    counts: { scanned: number; candidates: number; rescued: number; ready: number };
    files: FileReport[];
}

/** Persisted per scan dir: absolute file path -> mark metadata. */
export interface ApoptosisState {
    [scanDir: string]: {
        [filePath: string]: { firstMarked: string };
    };
}

/** tsconfig path-alias map, used to resolve non-relative imports (`@app/*`, …)
 *  when building the inbound-import graph. */
export interface AliasConfig {
    /** Absolute directory that path templates resolve against (tsconfig baseUrl). */
    baseDir: string;
    /** compilerOptions.paths, e.g. `{ "@app/*": ["./src/*"] }`. */
    paths: Record<string, string[]>;
}
