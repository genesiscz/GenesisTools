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
    endTimeMillis?: number;
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

export async function getNodeDetails(
    client: AxiosInstance,
    jobPath: string,
    buildNumber: string,
    nodeId: string
): Promise<{ id: string; name: string; status: StageStatus; stageFlowNodes?: FlowNode[] }> {
    const res = await client.get(`/${jobPath}/${buildNumber}/execution/node/${nodeId}/wfapi/describe`);

    if (res.status === 404) {
        throw new Error(`Node ${nodeId} not found on build ${buildNumber}`);
    }

    if (res.status !== 200) {
        throw new Error(`wfapi/describe for node ${nodeId} returned ${res.status}`);
    }

    return res.data;
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
