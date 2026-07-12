import type { ResolvedRoute } from "@app/ai-proxy/lib/types";
import { recordClientUsage } from "@app/ai-proxy/lib/usage/client-ledger";
import { bodyWantsStream, extractLatestUsageFromSse, extractUsageFromJsonBody } from "@app/ai-proxy/lib/usage/extract";
import { recordUsageRequest } from "@app/ai-proxy/lib/usage/store";
import { logger } from "@app/logger";

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
}): void {
    const stream = input.stream ?? bodyWantsStream(input.bodyText);
    const usage = stream ? extractLatestUsageFromSse(input.responseBody) : extractUsageFromJsonBody(input.responseBody);

    const record = {
        ts: new Date().toISOString(),
        account: input.route.accountName,
        client: input.client,
        provider: input.route.account.provider,
        proxyModel: input.proxyModel,
        upstreamModel: input.route.upstreamId,
        path: input.path,
        status: input.status,
        elapsedMs: input.elapsedMs,
        stream,
        translate: input.translate,
        thinking: input.thinking,
        usage,
        rateLimited: input.status === 429,
        error: input.status >= 400,
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
    translate?: string;
    thinking?: string;
}): void {
    void input.responseBody
        .then((responseBody) => {
            try {
                trackCompletedRequest({
                    ...input,
                    responseBody,
                });
            } catch (err) {
                logger.warn(
                    { err, path: input.path, model: input.proxyModel },
                    "ai-proxy usage: failed to track request"
                );
            }
        })
        .catch((err) => {
            logger.warn(
                { err, path: input.path, model: input.proxyModel },
                "ai-proxy usage: failed to capture response body"
            );
        });
}
