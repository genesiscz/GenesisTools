import type { AxiosInstance } from "axios";
import { attachStageContext } from "./blue-ocean";

export type StageStatus =
    | "NOT_EXECUTED"
    | "IN_PROGRESS"
    | "PAUSED_PENDING_INPUT"
    | "SUCCESS"
    | "FAILED"
    | "UNSTABLE"
    | "ABORTED";

export type RunStatus = StageStatus | "QUEUED";

export interface FlowNode {
    id: string;
    name: string;
    status: StageStatus;
    durationMillis?: number;
    parameterDescription?: string;
    startTimeMillis?: number;
}

export interface Stage {
    id: string;
    name: string;
    status: StageStatus;
    durationMillis?: number;
    startTimeMillis?: number;
    pauseDurationMillis?: number;
    stageFlowNodes?: FlowNode[];
    /**
     * Ancestor chain including self (consecutive duplicates collapsed), from
     * Blue Ocean `firstParent` — e.g. ["Build affected apps", "fee-web", "Tests"].
     */
    path?: string[];
    /** Parallel-branch / parent scope, e.g. "fee-web". */
    context?: string;
    /** Display name for events/notifications: "fee-web · Tests" (falls back to name). */
    label?: string;
}

export interface PipelineSnapshot {
    name: string;
    status: RunStatus;
    startTimeMillis: number;
    durationMillis: number;
    stages: Stage[];
}

const KNOWN_STAGE_STATUSES = new Set<string>([
    "NOT_EXECUTED",
    "IN_PROGRESS",
    "PAUSED_PENDING_INPUT",
    "SUCCESS",
    "FAILED",
    "UNSTABLE",
    "ABORTED",
]);

const KNOWN_RUN_STATUSES = new Set<string>([...KNOWN_STAGE_STATUSES, "QUEUED"]);

/**
 * Map Jenkins wfapi raw status strings (and null/undefined/unknown) onto our
 * StageStatus union. Declared-but-not-started parallel stages often arrive as
 * null / "QUEUED" / garbage — fold those to NOT_EXECUTED rather than inventing
 * SUCCESS.
 */
export function normalizeStageStatus(raw: unknown): StageStatus {
    if (typeof raw === "string" && KNOWN_STAGE_STATUSES.has(raw)) {
        return raw as StageStatus;
    }

    return "NOT_EXECUTED";
}

export function normalizeRunStatus(raw: unknown): RunStatus {
    if (typeof raw === "string" && KNOWN_RUN_STATUSES.has(raw)) {
        return raw as RunStatus;
    }

    return "IN_PROGRESS";
}

/**
 * Jenkins pipeline-stage-view / wfapi duration quirks:
 * - In-progress nodes sometimes report `durationMillis` as `start - now` (negative,
 *   growing more negative each poll).
 * - Parallel stage shells can be marked SUCCESS while still running, with a
 *   negative duration — treat those as IN_PROGRESS until a real terminal
 *   duration arrives.
 * - Terminal nodes with a negative duration get duration clamped to 0 (status
 *   kept — FAILED etc. is still meaningful).
 */
export function normalizeNodeTiming(opts: {
    status: StageStatus;
    durationMillis?: number;
    startTimeMillis?: number;
    now?: number;
}): { status: StageStatus; durationMillis?: number } {
    let { status } = opts;
    const duration = opts.durationMillis;
    const now = opts.now ?? Date.now();

    // Premature SUCCESS/UNSTABLE with negative duration → still running.
    // Magnitude of the negative value is typically elapsed wall-clock.
    if ((status === "SUCCESS" || status === "UNSTABLE") && duration !== undefined && duration < 0) {
        status = "IN_PROGRESS";
    }

    if (duration === undefined || duration === null || Number.isNaN(duration)) {
        if (status === "IN_PROGRESS" && opts.startTimeMillis !== undefined && opts.startTimeMillis > 0) {
            return { status, durationMillis: Math.max(0, now - opts.startTimeMillis) };
        }

        return { status, durationMillis: undefined };
    }

    if (duration < 0) {
        if (status === "IN_PROGRESS") {
            return { status, durationMillis: Math.abs(duration) };
        }

        // Terminal (FAILED/ABORTED/…) with bogus negative duration — clamp.
        return { status, durationMillis: 0 };
    }

    return { status, durationMillis: duration };
}

function normalizeFlowNode(node: FlowNode, now?: number): FlowNode {
    const status = normalizeStageStatus(node.status);
    const timing = normalizeNodeTiming({
        status,
        durationMillis: node.durationMillis,
        startTimeMillis: node.startTimeMillis,
        now,
    });

    return {
        ...node,
        status: timing.status,
        durationMillis: timing.durationMillis,
    };
}

function normalizeStage(stage: Stage, now?: number): Stage {
    const status = normalizeStageStatus(stage.status);
    const timing = normalizeNodeTiming({
        status,
        durationMillis: stage.durationMillis,
        startTimeMillis: stage.startTimeMillis,
        now,
    });

    return {
        ...stage,
        status: timing.status,
        durationMillis: timing.durationMillis,
        stageFlowNodes: stage.stageFlowNodes?.map((n) => normalizeFlowNode(n, now)),
    };
}

/** Sanitize a raw wfapi/describe payload before any consumer sees it. */
export function normalizeSnapshot(raw: PipelineSnapshot, now?: number): PipelineSnapshot {
    const duration =
        typeof raw.durationMillis === "number" && !Number.isNaN(raw.durationMillis)
            ? Math.max(0, raw.durationMillis)
            : 0;

    return {
        ...raw,
        status: normalizeRunStatus(raw.status),
        durationMillis: duration,
        stages: (raw.stages ?? []).map((s) => normalizeStage(s, now)),
    };
}

export async function getStages(
    client: AxiosInstance,
    jobPath: string,
    buildNumber: string,
    opts: { expand?: boolean; context?: boolean } = {}
): Promise<PipelineSnapshot> {
    const url = opts.expand
        ? `/${jobPath}/${buildNumber}/wfapi/describe?fullStages=true`
        : `/${jobPath}/${buildNumber}/wfapi/describe`;
    const res = await client.get(url);

    if (res.status === 404) {
        throw new Error(`Build ${buildNumber} pipeline data not found (queued, never started, or pruned?)`);
    }

    if (res.status !== 200) {
        throw new Error(`wfapi/describe returned ${res.status}`);
    }

    const snap = normalizeSnapshot(res.data as PipelineSnapshot);

    // Default on: Blue Ocean supplies parallel-branch parent path (fee-web · Tests).
    // Pass context: false to skip the extra request (tests / offline).
    if (opts.context === false) {
        return snap;
    }

    return attachStageContext(client, jobPath, buildNumber, snap);
}

export interface BuildMeta {
    triggeredBy: string[];
    parentBuild: { project: string; build: number } | null;
    parameters: Record<string, unknown>;
    branch?: string;
    sha?: string;
    remoteUrl?: string;
}

interface CauseShape {
    shortDescription?: string;
    upstreamProject?: string;
    upstreamBuild?: number;
}

interface ParamShape {
    name?: string;
    value?: unknown;
}

interface ActionShape {
    causes?: CauseShape[];
    parameters?: ParamShape[];
    lastBuiltRevision?: { branch?: Array<{ name?: string; SHA1?: string }> };
    remoteUrls?: string[];
}

const BRANCH_PARAM_KEYS = ["BRANCH_SPECIFIER", "BRANCH", "GIT_BRANCH", "BRANCH_NAME"];

/**
 * Flatten Jenkins's verbose `actions[]` into a friendlier shape:
 * causes → triggeredBy/parentBuild, parameters → object, SCM → branch/sha/remoteUrl.
 */
export function flattenBuildMeta(actions: unknown[] | undefined): BuildMeta {
    const triggeredBy: string[] = [];
    let parentBuild: BuildMeta["parentBuild"] = null;
    const parameters: Record<string, unknown> = {};
    let branch: string | undefined;
    let sha: string | undefined;
    let remoteUrl: string | undefined;

    for (const raw of actions ?? []) {
        const action = raw as ActionShape;

        for (const cause of action.causes ?? []) {
            if (cause.shortDescription) {
                triggeredBy.push(cause.shortDescription);
            }

            if (cause.upstreamProject && cause.upstreamBuild !== undefined) {
                parentBuild = { project: cause.upstreamProject, build: cause.upstreamBuild };
            }
        }

        for (const param of action.parameters ?? []) {
            if (param.name !== undefined) {
                parameters[param.name] = param.value;
            }
        }

        const firstBranch = action.lastBuiltRevision?.branch?.[0];

        if (firstBranch) {
            branch ??= firstBranch.name;
            sha ??= firstBranch.SHA1;
        }

        if (action.remoteUrls && action.remoteUrls.length > 0) {
            remoteUrl ??= action.remoteUrls[0];
        }
    }

    if (!branch) {
        for (const key of BRANCH_PARAM_KEYS) {
            const value = parameters[key];

            if (typeof value === "string" && value) {
                branch = value;
                break;
            }
        }
    }

    return { triggeredBy, parentBuild, parameters, branch, sha, remoteUrl };
}

export interface FailingLeaf {
    stage: Stage;
    node?: FlowNode;
}

export function findFailingLeaf(snapshot: PipelineSnapshot): FailingLeaf | null {
    for (const stage of snapshot.stages) {
        if (stage.status !== "FAILED") {
            continue;
        }

        const failingFlow = stage.stageFlowNodes?.find((n) => n.status === "FAILED");
        return { stage, node: failingFlow };
    }

    return null;
}
