import { isAnthropicShapedBody } from "@app/ai-proxy/lib/translators/formats/anthropic/detect";

const RESPONSES_MODEL_RE = /^(?:gpt-5\.(?:[2-9]|\d{2,})(?:-codex)?|o\d+|goldeneye)/i;

export type CopilotUpstreamApi = "chat" | "responses" | "messages";

export interface CopilotUpstreamRoute {
    api: CopilotUpstreamApi;
    path: string;
}

export function needsCopilotResponsesApi(modelId: string): boolean {
    return RESPONSES_MODEL_RE.test(modelId);
}

export function resolveCopilotUpstreamRoute(upstreamModel: string, body: unknown): CopilotUpstreamRoute {
    if (needsCopilotResponsesApi(upstreamModel)) {
        return { api: "responses", path: "/responses" };
    }

    if (isAnthropicShapedBody(body)) {
        return { api: "messages", path: "/v1/messages" };
    }

    return { api: "chat", path: "/chat/completions" };
}
