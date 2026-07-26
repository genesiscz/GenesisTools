import { enrichGrokChatResponse } from "@app/ai-proxy/lib/grok-chat-sse-enricher";
import type { ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import type { ThinkingPresentationMode } from "@app/ai-proxy/lib/types";
import { type PipelineResult, pipelineResult } from "@app/ai-proxy/lib/usage/pipeline-result";

export async function identityPipeline({
    provider,
    upstreamModel,
    proxyModel,
    thinkingMode = "cursor",
    path,
    req,
    bodyText,
    startedAt,
}: {
    provider: ProxyProvider;
    upstreamModel: string;
    proxyModel?: string;
    thinkingMode?: ThinkingPresentationMode;
    path: "chat/completions" | "responses";
    req: Request;
    bodyText: string;
    /** performance.now() at request receipt — anchors the call timeline. */
    startedAt?: number;
}): Promise<PipelineResult> {
    if (path === "responses") {
        return pipelineResult(await provider.responses(req, upstreamModel, bodyText), undefined, startedAt);
    }

    const upstream = await provider.chatCompletions(req, upstreamModel, bodyText);

    if (!proxyModel || provider.id !== "grok-subscription") {
        return pipelineResult(upstream, undefined, startedAt);
    }

    return pipelineResult(await enrichGrokChatResponse(upstream, proxyModel, thinkingMode), undefined, startedAt);
}
