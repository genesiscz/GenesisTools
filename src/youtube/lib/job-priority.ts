import type { JobStage } from "@app/youtube/lib/jobs.types";

export interface PriorityForStagesOpts {
    /** Set for child jobs spawned by a bulk/discover fan-out — deprioritized behind user-facing work. */
    bulkChild?: boolean;
}

/** Higher runs first. Interactive stages (qa/summarize) outrank background ingestion. */
export function priorityForStages(stages: JobStage[], opts?: PriorityForStagesOpts): number {
    if (stages.includes("qa") || stages.includes("summarize")) {
        return 100;
    }

    if (stages.includes("comments") || stages.includes("captions") || stages.includes("transcribe")) {
        return 80;
    }

    if (stages.includes("discover")) {
        return 50;
    }

    if (opts?.bulkChild) {
        return 10;
    }

    return 50;
}
