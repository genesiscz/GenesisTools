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

    // Grok subscription chat/completions already streams Cursor-native reasoning_content.
    // Re-encoding via /responses drops role coalescing and breaks the thinking UI.
    // anthropic-subscription and openrouter have no Responses upstream — their
    // chatCompletions is the only supported path, so never route them through the
    // /responses translation. Without this, a Cursor-detected /v1/chat/completions
    // request against an openrouter model is silently rerouted into
    // provider.responses(), which openrouter declines with an explicit 501 that
    // then surfaces to the client as a chat/completions failure.
    if (providerId === "grok-subscription" || providerId === "anthropic-subscription" || providerId === "openrouter") {
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
