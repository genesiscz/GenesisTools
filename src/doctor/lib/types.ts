export type Severity = "safe" | "cautious" | "dangerous" | "blocked";
export type ConfirmMode = "none" | "yesno" | "typed";
export type AnalyzerCategory = "disk" | "memory" | "processes" | "system" | "network" | "security";
/** How `doctor act` runs an action. `remove-path`: act deletes or trashes `metadata.paths` itself, behind its path
 *  guard. `command`: act calls `execute`. An action without a kind is never run by `doctor act`. */
export type ActionKind = "remove-path" | "command";
export type RemoveMethod = "trash" | "delete";

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
    kind?: ActionKind;
    /** A removal action that only works one way: `stage-trash` is always "trash", `direct-delete` always "delete". */
    method?: RemoveMethod;
    /** Re-create the folder empty after a delete, for app caches whose app expects the folder to exist. */
    recreateEmpty?: boolean;
}

/** The metadata every reclaim finding of `temp-leaks` and `app-bloat` carries (the Disk Manager contract).
 *  `paths` is what `doctor act` removes; the older analyzers carry `paths` too. */
export interface ReclaimMetadataFields {
    kind: string;
    paths: string[];
    allocatedBytes: number | null;
    apparentBytes: number | null;
    freeableFloorBytes?: number;
    ageDays: number | null;
    owner: { pid: number; name: string; startedAt: string } | null;
    requires?: { absentProcesses: string[] };
    regenerates: boolean;
    restoreHint?: string;
    /** False when the scan gate skipped the size walk, or a walk ran out of budget (sizes are then a lower bound). */
    sizeKnown: boolean;
    /** Why `doctor act` must refuse this finding right now (a running owner, an open writer). */
    blockers?: string[];
}

/** {@link ReclaimMetadataFields} plus rule-specific fields (`bundleId`, `prefix`, `guestCommands`, ...). */
export type ReclaimMetadata = ReclaimMetadataFields & Record<string, unknown>;
export type ReclaimMetadataInput = Omit<ReclaimMetadataFields, "owner"> & {
    owner?: ReclaimMetadataFields["owner"];
} & Record<string, unknown>;

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
