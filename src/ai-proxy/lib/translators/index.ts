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
    // anthropic-subscription has no Responses upstream — its chatCompletions is the
    // only supported path, so never route it through the /responses translation.
    if (providerId === "grok-subscription" || providerId === "anthropic-subscription") {
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
}: {
    mode: CursorTranslationMode;
    thinkingMode: ThinkingPresentationMode;
    provider: ProxyProvider;
    upstreamModel: string;
    proxyModel: string;
    req: Request;
    bodyText: string;
}): Promise<PipelineResult> {
    if (shouldTranslateChatRequest({ mode, req, bodyText, providerId: provider.id })) {
        return responsesToChat({
            provider,
            upstreamModel,
            proxyModel,
            req,
            bodyText,
            thinkingMode,
        });
    }

    return identityPipeline({
        provider,
        upstreamModel,
        proxyModel,
        thinkingMode,
        path: "chat/completions",
        req,
        bodyText,
    });
}
