import type { ResolvedRoute } from "@app/ai-proxy/lib/types";
import type { CallTimeline } from "@app/ai-proxy/lib/usage/call-timeline";
import { recordClientUsage } from "@app/ai-proxy/lib/usage/client-ledger";
import {
    bodyWantsStream,
    estimateUsageFromExchange,
    extractLatestUsageFromSse,
    extractUsageFromJsonBody,
} from "@app/ai-proxy/lib/usage/extract";
import { recordUsageRequest } from "@app/ai-proxy/lib/usage/store";
import { writeTranscript } from "@app/ai-proxy/lib/usage/transcripts";
import type { RequestTags } from "@app/ai-proxy/lib/usage/types";
import { logger } from "@genesiscz/utils/logger";

export function trackCompletedRequest(input: {
    route: ResolvedRoute;
    client: string;
    proxyModel: string;
    path: string;
    status: number;
    elapsedMs: number;
    bodyText: string;
    responseBody: string;
    stream?: boolean;
    translate?: string;
    thinking?: string;
    tags?: RequestTags;
    timeline?: CallTimeline;
    /** Set when the exchange never completed — the row is recorded anyway. */
    failure?: string;
}): void {
    const stream = input.stream ?? bodyWantsStream(input.bodyText);
    let usage = stream ? extractLatestUsageFromSse(input.responseBody) : extractUsageFromJsonBody(input.responseBody);

    // Upstream sent no usage on a successful exchange — record a local estimate,
    // explicitly tagged so it is never mistaken for upstream-reported numbers.
    if (!usage && input.status < 400 && input.responseBody.length > 0) {
        usage = estimateUsageFromExchange({
            bodyText: input.bodyText,
            responseBody: input.responseBody,
            stream,
        });
        logger.debug(
            { model: input.proxyModel, usage },
            "ai-proxy usage: upstream omitted usage — recorded local estimate"
        );
    }

    // For a streamed reply the caller's elapsedMs stops at response headers, which
    // is ~0.4s regardless of how long generation actually took. The timeline knows
    // when the last byte landed — prefer it so usage rows reflect real duration.
    const elapsedMs = Math.max(input.elapsedMs, input.timeline?.completedMs ?? 0);
    const ts = new Date().toISOString();
    const transcript = writeTranscript({
        ts,
        account: input.route.accountName,
        provider: input.route.account.provider,
        proxyModel: input.proxyModel,
        upstreamModel: input.route.upstreamId,
        path: input.path,
        status: input.status,
        elapsedMs,
        stream,
        requestBody: input.bodyText,
        responseBody: input.responseBody,
        tags: input.tags,
        timeline: input.timeline,
    });

    const record = {
        ts,
        account: input.route.accountName,
        client: input.client,
        provider: input.route.account.provider,
        proxyModel: input.proxyModel,
        upstreamModel: input.route.upstreamId,
        path: input.path,
        status: input.status,
        elapsedMs,
        stream,
        translate: input.translate,
        thinking: input.thinking,
        usage,
        rateLimited: input.status === 429,
        error: input.status >= 400 || Boolean(input.failure),
        failure: input.failure,
        tags: input.tags,
        transcript,
        timeline: input.timeline,
    };

    recordUsageRequest(record);

    recordClientUsage({
        client: input.client,
        ts: record.ts,
        upstreamModel: record.upstreamModel,
        usage: record.usage,
    });

    logger.debug(
        {
            account: record.account,
            model: record.proxyModel,
            status: record.status,
            usage: record.usage,
        },
        "ai-proxy usage: tracked completed request"
    );
}

export function scheduleUsageTracking(input: {
    route: ResolvedRoute;
    client: string;
    proxyModel: string;
    path: string;
    status: number;
    elapsedMs: number;
    bodyText: string;
    responseBody: Promise<string>;
    timeline?: Promise<CallTimeline>;
    captureFailure?: Promise<string | undefined>;
    translate?: string;
    thinking?: string;
    tags?: RequestTags;
}): void {
    void input.responseBody
        .then(async (responseBody) => {
            try {
                trackCompletedRequest({
                    ...input,
                    responseBody,
                    timeline: await input.timeline,
                    // a stream that never ended still gets a row, with the reason
                    failure: await input.captureFailure,
                });
            } catch (err) {
                logger.warn(
                    { err, path: input.path, model: input.proxyModel },
                    "ai-proxy usage: failed to track request"
                );
            }
        })
        .catch(async (err) => {
            logger.warn(
                { err, path: input.path, model: input.proxyModel },
                "ai-proxy usage: failed to capture response body"
            );

            // Record the row anyway. Dropping it meant an aborted or reset call left
            // NO trace in the usage index, so `tools ai-proxy calls` was blind to
            // exactly the failures worth investigating — 17 stalled filter calls were
            // invisible there while the client-side log had every one of them.
            try {
                trackCompletedRequest({
                    ...input,
                    responseBody: "",
                    timeline: await input.timeline,
                    failure: err instanceof Error ? err.message : String(err),
                });
            } catch (trackErr) {
                logger.warn(
                    { err: trackErr, path: input.path, model: input.proxyModel },
                    "ai-proxy usage: failed to record the incomplete request"
                );
            }
        });
}
