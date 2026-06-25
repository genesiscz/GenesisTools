import type { ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import { type PipelineResult, pipelineResult } from "@app/ai-proxy/lib/usage/pipeline-result";

export async function identityPipeline({
    provider,
    upstreamModel,
    path,
    req,
    bodyText,
}: {
    provider: ProxyProvider;
    upstreamModel: string;
    path: "chat/completions" | "responses";
    req: Request;
    bodyText: string;
}): Promise<PipelineResult> {
    if (path === "responses") {
        return pipelineResult(await provider.responses(req, upstreamModel, bodyText));
    }

    return pipelineResult(await provider.chatCompletions(req, upstreamModel, bodyText));
}
