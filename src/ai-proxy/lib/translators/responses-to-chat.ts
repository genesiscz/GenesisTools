import type { ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import { responsesToChatJson } from "@app/ai-proxy/lib/translators/responses-to-chat-json";
import { responsesToChatSse } from "@app/ai-proxy/lib/translators/responses-to-chat-sse";
import type { ThinkingPresentationMode } from "@app/ai-proxy/lib/types";
import { bodyWantsStream } from "@app/ai-proxy/lib/usage/extract";
import type { PipelineResult } from "@app/ai-proxy/lib/usage/pipeline-result";

export async function responsesToChat({
    provider,
    upstreamModel,
    proxyModel,
    req,
    bodyText,
    thinkingMode = "raw",
}: {
    provider: ProxyProvider;
    upstreamModel: string;
    proxyModel: string;
    req: Request;
    bodyText: string;
    thinkingMode?: ThinkingPresentationMode;
}): Promise<PipelineResult> {
    if (bodyWantsStream(bodyText)) {
        return responsesToChatSse({
            provider,
            upstreamModel,
            proxyModel,
            req,
            bodyText,
            thinkingMode,
        });
    }

    return responsesToChatJson({
        provider,
        upstreamModel,
        proxyModel,
        req,
        bodyText,
        thinkingMode,
    });
}
