import { AsyncLocalStorage } from "node:async_hooks";
import type { YoutubeDatabase } from "@app/youtube/lib/db";

/**
 * Per-HTTP-request attribution so deep lib code (usage recording) can tie AI
 * work to the requesting user without threading userId through every
 * signature. Mirrors the job-activity ALS pattern (`job-activity.ts`) — the
 * two coexist: job context wins for queue work, request context covers
 * synchronous routes.
 */
export interface YtRequestContext {
    userId: number | null;
    db: YoutubeDatabase;
}

const requestStorage = new AsyncLocalStorage<YtRequestContext>();

export function getRequestContext(): YtRequestContext | undefined {
    return requestStorage.getStore();
}

export function withRequestContext<T>(ctx: YtRequestContext, fn: () => Promise<T>): Promise<T> {
    return requestStorage.run(ctx, fn);
}
