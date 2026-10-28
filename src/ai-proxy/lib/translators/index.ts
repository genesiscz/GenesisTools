import { providerDefinition } from "@app/ai-proxy/lib/providers/registry";
import type { ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import { detectCursorRequest } from "@app/ai-proxy/lib/translators/detect-request";
import { identityPipeline } from "@app/ai-proxy/lib/translators/identity-pipeline";
import { responsesToChat } from "@app/ai-proxy/lib/translators/responses-to-chat";
import type { CursorTranslationMode, ThinkingPresentationMode } from "@app/ai-proxy/lib/types";
import type { PipelineResult } from "@app/ai-proxy/lib/usage/pipeline-result";

export function shouldTranslateChatRequest({
    mode,
    req,
    bodyText,
    providerId,
}: {
    mode: CursorTranslationMode;
    req: Request;
    bodyText: string;
    providerId?: string;
}): boolean {
    if (mode === "off") {
        return false;
    }

    if (providerId && providerDefinition(providerId)?.routes.chatViaResponses === false) {
        return false;
    }

    if (mode === "on") {
        return true;
    }

    return detectCursorRequest(req, bodyText);
}

export async function handleChatCompletions({
    mode,
    thinkingMode,
    provider,
    upstreamModel,
    proxyModel,
    req,
    bodyText,
    startedAt,
}: {
    mode: CursorTranslationMode;
    thinkingMode: ThinkingPresentationMode;
    provider: ProxyProvider;
    upstreamModel: string;
    proxyModel: string;
    req: Request;
    bodyText: string;
    /** performance.now() taken when the proxy received the request (timeline anchor). */
    startedAt?: number;
}): Promise<PipelineResult> {
    if (shouldTranslateChatRequest({ mode, req, bodyText, providerId: provider.id })) {
        return responsesToChat({
            provider,
            upstreamModel,
            proxyModel,
            req,
            bodyText,
            thinkingMode,
            startedAt,
        });
    }

    return identityPipeline({
        startedAt,
        provider,
        upstreamModel,
        proxyModel,
        thinkingMode,
        path: "chat/completions",
        req,
        bodyText,
    });
}
