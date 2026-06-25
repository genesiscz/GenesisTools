import { ensureResponsesInput } from "@app/ai-proxy/lib/chat-to-responses-body";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { isObject } from "@app/utils/object";

type JsonObject = Record<string, unknown>;

export function normalizeGrokTool(tool: unknown): JsonObject | null {
    if (!isObject(tool)) {
        return null;
    }

    if (tool.type === "function" && typeof tool.name === "string") {
        return {
            type: "function",
            name: tool.name,
            description: tool.description ?? "",
            parameters: tool.parameters ?? { type: "object", properties: {} },
            ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
        };
    }

    if (tool.type === "function" && isObject(tool.function)) {
        const fn = tool.function;
        if (typeof fn.name !== "string") {
            return null;
        }

        return {
            type: "function",
            name: fn.name,
            description: fn.description ?? "",
            parameters: fn.parameters ?? { type: "object", properties: {} },
            ...(fn.strict !== undefined ? { strict: fn.strict } : {}),
        };
    }

    if (tool.type === "custom") {
        const name = typeof tool.name === "string" ? tool.name : "custom_tool";

        return {
            type: "function",
            name,
            description: typeof tool.description === "string" ? tool.description : "Custom Cursor tool",
            parameters: { type: "object", properties: {} },
        };
    }

    return null;
}

export function normalizeGrokTools(tools: unknown): JsonObject[] | undefined {
    if (!Array.isArray(tools)) {
        return undefined;
    }

    const normalized = tools.map(normalizeGrokTool).filter((tool): tool is JsonObject => tool !== null);

    if (normalized.length === 0) {
        return undefined;
    }

    return normalized;
}

export function prepareGrokUpstreamBody(
    bodyText: string,
    upstreamModel: string,
    target: "chat" | "responses" = "chat"
): string {
    try {
        const parsed = SafeJSON.parse(bodyText, { strict: true });

        if (!isObject(parsed)) {
            return bodyText;
        }

        const next: JsonObject = { ...parsed };

        if ("model" in next) {
            next.model = upstreamModel;
        }

        if ("max_tokens" in next && !("max_output_tokens" in next)) {
            next.max_output_tokens = next.max_tokens;
            delete next.max_tokens;
        }

        const normalizedTools = normalizeGrokTools(next.tools);
        if (normalizedTools) {
            next.tools = normalizedTools;
        } else if ("tools" in next) {
            delete next.tools;
        }

        if ("stream_options" in next) {
            delete next.stream_options;
        }

        if ("n" in next) {
            delete next.n;
        }

        const prepared = target === "responses" ? ensureResponsesInput(next) : next;

        return SafeJSON.stringify(prepared);
    } catch (err) {
        logger.debug({ err, upstreamModel, target }, "ai-proxy: prepareGrokUpstreamBody fallback");
        return rewriteBodyModel(bodyText, upstreamModel);
    }
}

export function rewriteBodyModel(bodyText: string, upstreamModel: string): string {
    try {
        const parsed = SafeJSON.parse(bodyText, { strict: true });

        if (!isObject(parsed)) {
            return bodyText;
        }

        if (!("model" in parsed)) {
            return bodyText;
        }

        return SafeJSON.stringify({
            ...parsed,
            model: upstreamModel,
        });
    } catch (err) {
        logger.debug({ err, upstreamModel }, "ai-proxy: rewriteBodyModel fallback");
        return bodyText;
    }
}
