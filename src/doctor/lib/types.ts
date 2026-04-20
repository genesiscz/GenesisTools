export type Severity = "safe" | "cautious" | "dangerous" | "blocked";
export type ConfirmMode = "none" | "yesno" | "typed";
export type AnalyzerCategory = "disk" | "memory" | "processes" | "system" | "network" | "security";

export interface Finding {
    id: string;
    analyzerId: string;
    title: string;
    detail?: string;
    severity: Severity;
    reclaimableBytes?: number;
    actions: Action[];
    metadata?: Record<string, unknown>;
    blacklistReason?: string;
}

export interface Action {
    id: string;
    label: string;
    confirm: ConfirmMode;
    confirmPhrase?: string;
    execute(ctx: ExecutorContext, finding: Finding): Promise<ActionResult>;
    followUp?: (result: ActionResult) => Action[] | null;
    staged?: boolean;
}

export interface ActionResult {
    findingId: string;
    actionId: string;
    status: "ok" | "skipped" | "failed" | "staged";
    actualReclaimedBytes?: number;
    error?: string;
    metadata?: Record<string, unknown>;
}

export interface AnalyzerContext {
    runId: string;
    opts: AnalyzerOpts;
    emit: (event: EngineEvent) => void;
}

export interface AnalyzerOpts {
    thorough: boolean;
    fresh: boolean;
    dryRun: boolean;
}

export interface ExecutorContext {
    runId: string;
    dryRun: boolean;
}

export interface AnalyzerResult {
    analyzerId: string;
    findings: Finding[];
    durationMs: number;
    error: unknown;
    fromCache: boolean;
    timestamp: string;
}

export type EngineEvent =
    | { type: "analyzer-start"; analyzerId: string; startedAt: string }
    | {
          type: "progress";
          analyzerId: string;
          phase: "scanning" | "scoring" | "done";
          percent?: number;
          currentItem?: string;
          findingsCount: number;
          bytesFoundSoFar?: number;
      }
    | { type: "finding"; analyzerId: string; finding: Finding; fromCache?: boolean }
    | { type: "analyzer-done"; analyzerId: string; durationMs: number; findingsCount: number; error?: unknown }
    | { type: "all-done"; totalDurationMs: number };
