import type { AxiosInstance } from "axios";

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
}

export interface PipelineSnapshot {
    name: string;
    status: RunStatus;
    startTimeMillis: number;
    durationMillis: number;
    stages: Stage[];
}

export async function getStages(
    client: AxiosInstance,
    jobPath: string,
    buildNumber: string,
    opts: { expand?: boolean } = {}
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

    return res.data as PipelineSnapshot;
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
