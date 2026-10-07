import { JOB_CATALOG, PIPELINE_RULES } from "./catalog";
import type { JobDefinition, JobType, PipelineRules } from "./types";

export interface JobContext {
    catalog?: JobDefinition[];
    rules?: PipelineRules;
}

export function getJobNameFromPath(jobPath: string): string {
    const parts = jobPath.replace(/\/+$/, "").split("/job/");
    return parts[parts.length - 1]?.replace(/^job\//, "") || jobPath;
}

export function findJobDefinition(jobPath: string, ctx: JobContext = {}): JobDefinition | null {
    return (ctx.catalog ?? JOB_CATALOG).find((job) => job.path === jobPath) ?? null;
}

export function isMasterBuild(jobPath: string, ctx: JobContext = {}): boolean {
    return (ctx.rules ?? PIPELINE_RULES).masters.includes(getJobNameFromPath(jobPath));
}

export function getDownstreamJobs(jobPath: string, ctx: JobContext = {}): string[] {
    return (ctx.rules ?? PIPELINE_RULES).downstream[getJobNameFromPath(jobPath)] ?? [];
}

export function getJobType(jobPath: string, ctx: JobContext = {}): JobType {
    const definition = findJobDefinition(jobPath, ctx);

    if (definition) {
        return definition.type;
    }

    const jobName = getJobNameFromPath(jobPath);
    const hint = (ctx.rules ?? PIPELINE_RULES).typeHints.find((h) => h.match.some((m) => jobName.includes(m)));

    return hint?.type ?? "unknown";
}

/** Sub-jobs of a multibranch orchestrator sit in the folder above it: `.../job/F/job/orch/job/MR-1` gives `.../job/F`. */
export function subJobsFolder(jobPath: string): string {
    return jobPath.replace(/\/job\/[^/]+\/job\/[^/]+\/?$/, "");
}
