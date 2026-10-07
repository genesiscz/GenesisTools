import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import pc from "picocolors";
import { parseJenkinsInput } from "../mcp/url";
import type { JenkinsBackend, PostResult } from "./client";
import { getJobNameFromPath } from "./jobs";

export interface JenkinsParameter {
    _class: string;
    name: string;
    value: string | number | boolean | null;
}

export interface RebuildOptions {
    wait?: boolean;
    dryRun?: boolean;
    queueTimeoutMs?: number;
    queuePollMs?: number;
}

export interface RebuildResult {
    jobPath: string;
    sourceBuildNumber: number | "lastBuild";
    parameters: JenkinsParameter[];
    triggered: boolean;
    queueUrl?: string;
    newBuildNumber?: number;
    newBuildUrl?: string;
}

export type RebuildTarget = { url: string } | { jobPath: string; buildNumber: number | "latest" | "lastBuild" };

export function buildParamsForm(parameters: JenkinsParameter[]): URLSearchParams {
    const form = new URLSearchParams();

    for (const p of parameters) {
        if (p.value === null || p.value === undefined) {
            continue;
        }

        form.append(p.name, String(p.value));
    }

    return form;
}

export function deriveQueueApiUrl(queueLocationHeader: string): string {
    return `${queueLocationHeader.replace(/\/$/, "")}/api/json`;
}

/** A build URL must carry its build number; a job path takes `latest` or `lastBuild` as the last build. */
export function resolveRebuildTarget(target: RebuildTarget): { jobPath: string; buildNumber: number | "lastBuild" } {
    if ("url" in target) {
        const ref = parseJenkinsInput(target.url);

        if (!ref.jobPath) {
            throw new Error(`Could not parse Jenkins URL: ${target.url}`);
        }

        if (!ref.buildNumber) {
            throw new Error("URL must point to a specific build (e.g. /.../123/)");
        }

        return { jobPath: ref.jobPath, buildNumber: Number(ref.buildNumber) };
    }

    return {
        jobPath: target.jobPath,
        buildNumber: target.buildNumber === "latest" ? "lastBuild" : target.buildNumber,
    };
}

interface ParametersJson {
    actions?: Array<{ _class?: string; parameters?: JenkinsParameter[] } | null>;
}

export async function fetchBuildParameters(
    backend: JenkinsBackend,
    jobPath: string,
    buildNumber: number | "lastBuild"
): Promise<JenkinsParameter[]> {
    const body = await backend.api<ParametersJson>(
        `${jobPath}/${buildNumber}/api/json?tree=actions[parameters[_class,name,value]]`
    );
    const paramsAction = body.actions?.find((a) => Array.isArray(a?.parameters));

    return paramsAction?.parameters ?? [];
}

const QUEUE_ITEM = /\/queue\/item\/\d+\/?$/;

/**
 * Whether Jenkins accepted a build trigger: 201 Created, or another answer below 400 whose
 * `Location` is a queue item. The POST follows no redirect, so a 302 to a login page or anywhere
 * else is a refusal, not a queued build.
 */
export function triggerAccepted(res: PostResult): boolean {
    if (res.status === 201) {
        return true;
    }

    return res.status < 400 && res.location !== undefined && QUEUE_ITEM.test(res.location);
}

export async function triggerRebuild(
    backend: JenkinsBackend,
    jobPath: string,
    parameters: JenkinsParameter[]
): Promise<{ queueUrl?: string }> {
    const endpoint = parameters.length > 0 ? "buildWithParameters" : "build";
    const res = await backend.post(
        `${jobPath}/${endpoint}`,
        parameters.length > 0 ? buildParamsForm(parameters) : undefined
    );

    if (!triggerAccepted(res)) {
        const where = res.location ? ` -> ${res.location}` : "";
        throw new Error(`Trigger failed (${res.status}${where}): ${backend.fullUrl(`${jobPath}/${endpoint}`)}`);
    }

    return { queueUrl: res.location };
}

export async function resolveQueueToBuild(
    backend: JenkinsBackend,
    queueUrl: string,
    { timeoutMs = 30_000, pollMs = 1500 }: { timeoutMs?: number; pollMs?: number } = {}
): Promise<number | undefined> {
    const apiUrl = deriveQueueApiUrl(queueUrl);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const item = await backend.apiOrNull<{ executable?: { number?: number } }>(apiUrl);

        if (item?.executable?.number) {
            return item.executable.number;
        }

        await Bun.sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }

    return undefined;
}

export async function rebuild(
    backend: JenkinsBackend,
    target: RebuildTarget,
    options: RebuildOptions = {}
): Promise<RebuildResult> {
    const { jobPath, buildNumber } = resolveRebuildTarget(target);
    const wait = options.wait ?? true;
    const queueTimeoutMs = options.queueTimeoutMs ?? 30_000;

    out.println(pc.blue(`# Rebuild: ${getJobNameFromPath(jobPath)} (source: #${buildNumber})`));

    const parameters = await fetchBuildParameters(backend, jobPath, buildNumber);

    if (parameters.length > 0) {
        out.println(pc.gray(`# Parameters (${parameters.length}):`));

        for (const p of parameters) {
            out.println(pc.gray(`#   ${p.name} = ${SafeJSON.stringify(p.value)}`));
        }
    } else {
        out.println(pc.gray("# No parameters, will POST to /build"));
    }

    if (options.dryRun) {
        out.println(pc.yellow("# Dry run, not triggering"));
        return { jobPath, sourceBuildNumber: buildNumber, parameters, triggered: false };
    }

    const { queueUrl } = await triggerRebuild(backend, jobPath, parameters);
    out.println(pc.green("# Build queued"));

    let newBuildNumber: number | undefined;
    let newBuildUrl: string | undefined;

    if (queueUrl) {
        out.println(pc.gray(`# Queue: ${queueUrl}`));

        if (wait) {
            newBuildNumber = await resolveQueueToBuild(backend, queueUrl, {
                timeoutMs: queueTimeoutMs,
                pollMs: options.queuePollMs,
            });

            if (newBuildNumber) {
                newBuildUrl = `${backend.baseUrl}/${jobPath}/${newBuildNumber}/`;
                out.println(pc.green(`# New build: #${newBuildNumber}`));
                out.println(pc.gray(`# URL: ${newBuildUrl}`));
            } else {
                out.println(pc.yellow(`# Still queued (no build number after ${queueTimeoutMs}ms)`));
            }
        }
    }

    return {
        jobPath,
        sourceBuildNumber: buildNumber,
        parameters,
        triggered: true,
        queueUrl,
        newBuildNumber,
        newBuildUrl,
    };
}
