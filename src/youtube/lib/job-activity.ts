import { AsyncLocalStorage } from "node:async_hooks";
import type { YoutubeDatabase } from "@app/youtube/lib/db";
import type { JobStage } from "@app/youtube/lib/jobs.types";

/**
 * Per-async-context info that lets AI helpers (callLLM/Embedder/Transcriber)
 * record their work against the pipeline job currently executing on this stack.
 *
 * `Pipeline.runJob` wraps each stage handler in `withJobActivity({...}, () => handler(ctx))`
 * so that any code reachable from the handler can call `getJobActivityContext()` to find
 * out which job/stage it's running under, without threading the value through every signature.
 */
export interface JobActivityContext {
    jobId: number;
    stage: JobStage;
    db: YoutubeDatabase;
}

const jobActivityStorage = new AsyncLocalStorage<JobActivityContext>();

export function getJobActivityContext(): JobActivityContext | undefined {
    return jobActivityStorage.getStore();
}

export function withJobActivity<T>(ctx: JobActivityContext, fn: () => Promise<T>): Promise<T> {
    return jobActivityStorage.run(ctx, fn);
}
