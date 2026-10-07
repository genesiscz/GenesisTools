import { formatDuration } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import type { FlowNode, Stage } from "../mcp/pipeline";
import type { JenkinsBackend } from "./client";

export type { FlowNode, Stage };

/** The fields of `wfapi/describe` the REST commands read. */
export interface WfapiRun {
    name: string;
    status: string;
    durationMillis: number;
    stages?: Stage[];
}

export function describeRun(
    backend: JenkinsBackend,
    jobPath: string,
    build: string | number,
    { fullStages = false }: { fullStages?: boolean } = {}
): Promise<WfapiRun | null> {
    return backend.apiOrNull<WfapiRun>(`${jobPath}/${build}/wfapi/describe${fullStages ? "?fullStages=true" : ""}`);
}

export function notFound(build: string | number): void {
    out.println(`#${build}: not found`);
}

/** wfapi durations print as `450ms`, `12.3s`, `1m 15s`; a negative value means still running. */
export function fmtDuration(ms: number | undefined): string {
    if (ms === undefined) {
        return "-";
    }

    if (ms < 0) {
        return "running";
    }

    return formatDuration(ms);
}

/** The first flow node whose step description contains any of the needles. */
export function findNode(stages: Stage[], needles: string[]): FlowNode | undefined {
    for (const stage of stages) {
        for (const node of stage.stageFlowNodes ?? []) {
            const description = node.parameterDescription ?? "";

            if (needles.some((needle) => description.includes(needle))) {
                return node;
            }
        }
    }

    return undefined;
}

export function lastMatch(text: string, re: RegExp): RegExpMatchArray | null {
    const all = [...text.matchAll(re)];
    return all.at(-1) ?? null;
}

export interface Summary {
    mean: number;
    median: number;
    min: number;
    max: number;
    n: number;
}

export function summarize(values: Array<number | null>): Summary | null {
    const nums = values.filter((v): v is number => v !== null && Number.isFinite(v)).sort((a, b) => a - b);

    if (nums.length === 0) {
        return null;
    }

    const mid = Math.floor(nums.length / 2);
    const median = nums.length % 2 === 0 ? (nums[mid - 1] + nums[mid]) / 2 : nums[mid];

    return {
        mean: nums.reduce((a, b) => a + b, 0) / nums.length,
        median,
        min: nums[0],
        max: nums[nums.length - 1],
        n: nums.length,
    };
}

/** `restore   mean 12s  median 11s  min 9.5s  max 20s  (n=4)` for a column of seconds. */
export function formatSummary(label: string, values: Array<number | null>): string {
    const stats = summarize(values);

    if (!stats) {
        return `${label.padEnd(9)} (no data)`;
    }

    const sec = (s: number) => fmtDuration(Math.round(s * 1000));

    return `${label.padEnd(9)} mean ${sec(stats.mean)}  median ${sec(stats.median)}  min ${sec(stats.min)}  max ${sec(stats.max)}  (n=${stats.n})`;
}
