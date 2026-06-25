import { isAnthropicShapedBody } from "@app/ai-proxy/lib/translators/formats/anthropic/detect";
import { normalizeAnthropicToOpenAI } from "@app/ai-proxy/lib/translators/formats/anthropic/normalize";
import {
    type CopilotUpstreamRoute,
    resolveCopilotUpstreamRoute,
} from "@app/ai-proxy/lib/translators/providers/github-copilot/upstream-route";
import { SafeJSON } from "@app/utils/json";

export interface PreparedCopilotRequest {
    route: CopilotUpstreamRoute;
    bodyText: string;
}

export function prepareCopilotRequest(bodyText: string, upstreamModel: string): PreparedCopilotRequest {
    const parsed = SafeJSON.parse(bodyText, { strict: true }) as Record<string, unknown>;
    const route = resolveCopilotUpstreamRoute(upstreamModel, parsed);

    if (isAnthropicShapedBody(parsed) && route.api !== "messages") {
        normalizeAnthropicToOpenAI(parsed, /claude/i.test(upstreamModel));
    }

    if (route.api === "responses" && parsed.max_tokens && !parsed.max_completion_tokens) {
        parsed.max_completion_tokens = parsed.max_tokens;
        delete parsed.max_tokens;
    }

    return {
        route,
        bodyText: SafeJSON.stringify(parsed),
    };
}
