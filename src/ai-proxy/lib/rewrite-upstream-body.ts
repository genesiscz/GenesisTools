import { ensureResponsesInput } from "@app/ai-proxy/lib/chat-to-responses-body";
import { stripCursorThinkingBlocks } from "@app/ai-proxy/lib/thinking-folded";
import { logger } from "@app/logger";
import { inferModelThinking } from "@app/utils/ai/grok/models";
import { SafeJSON } from "@app/utils/json";
import { isObject } from "@app/utils/object";

type JsonObject = Record<string, unknown>;

const IMAGE_CONTENT_TYPES = new Set(["image", "image_url", "input_image"]);
export const GROK_IMAGE_FALLBACK_MODEL = "grok-build";
const IMAGE_REFERENCE_TEXT =
    "[Image attachment from an earlier turn — visual content omitted; refer to prior assistant messages for what was seen.]";

export function grokModelSupportsImages(modelId: string): boolean {
    return /grok-build|vision/i.test(modelId);
}

export function requestHasImageContent(body: JsonObject): boolean {
    if (Array.isArray(body.messages)) {
        for (const message of body.messages) {
            if (!isObject(message)) {
                continue;
            }

            if (contentHasImage(message.content)) {
                return true;
            }
        }
    }

    if (Array.isArray(body.input) && inputHasImage(body.input)) {
        return true;
    }

    return false;
}

function findLastUserMessageIndex(messages: unknown[]): number {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];

        if (isObject(message) && message.role === "user") {
            return index;
        }
    }

    return -1;
}

function findLastUserInputIndex(input: unknown[]): number {
    for (let index = input.length - 1; index >= 0; index -= 1) {
        const item = input[index];

        if (isObject(item) && item.role === "user") {
            return index;
        }
    }

    return -1;
}

export function latestUserTurnHasImages(body: JsonObject): boolean {
    if (Array.isArray(body.messages)) {
        const lastUserIndex = findLastUserMessageIndex(body.messages);

        if (lastUserIndex >= 0) {
            const message = body.messages[lastUserIndex];

            if (isObject(message) && contentHasImage(message.content)) {
                return true;
            }
        }
    }

    if (Array.isArray(body.input)) {
        const lastUserIndex = findLastUserInputIndex(body.input);

        if (lastUserIndex >= 0) {
            const item = body.input[lastUserIndex];

            if (isObject(item) && (isImageContentPart(item) || contentHasImage(item.content))) {
                return true;
            }
        }

        if (lastUserIndex === -1 && inputHasImage(body.input)) {
            return true;
        }
    }

    return false;
}

export function resolveGrokUpstreamModelForImages(upstreamModel: string, body: JsonObject): string {
    if (!latestUserTurnHasImages(body)) {
        return upstreamModel;
    }

    if (grokModelSupportsImages(upstreamModel)) {
        return upstreamModel;
    }

    return GROK_IMAGE_FALLBACK_MODEL;
}

function contentHasImage(content: unknown): boolean {
    if (!Array.isArray(content)) {
        return false;
    }

    return content.some((part) => isImageContentPart(part));
}

function inputHasImage(input: unknown[]): boolean {
    for (const item of input) {
        if (!isObject(item)) {
            continue;
        }

        if (isImageContentPart(item)) {
            return true;
        }

        if (contentHasImage(item.content)) {
            return true;
        }
    }

    return false;
}

function isImageContentPart(part: unknown): boolean {
    if (!isObject(part)) {
        return false;
    }

    if (typeof part.type === "string" && IMAGE_CONTENT_TYPES.has(part.type)) {
        return true;
    }

    if (part.image_url !== undefined || part.input_image !== undefined) {
        return true;
    }

    if (part.type === "image" && isObject(part.source)) {
        return true;
    }

    return false;
}

function imageDataUrlFromPart(part: JsonObject): string | null {
    if (part.type === "input_image") {
        if (typeof part.image_url === "string") {
            return part.image_url;
        }

        if (isObject(part.image_url) && typeof part.image_url.url === "string") {
            return part.image_url.url;
        }
    }

    if (part.type === "image_url") {
        if (isObject(part.image_url) && typeof part.image_url.url === "string") {
            return part.image_url.url;
        }

        if (typeof part.image_url === "string") {
            return part.image_url;
        }
    }

    if (part.type === "image" && isObject(part.source) && part.source.type === "base64") {
        const mediaType = typeof part.source.media_type === "string" ? part.source.media_type : "image/png";
        const data = typeof part.source.data === "string" ? part.source.data : "";

        if (data) {
            return `data:${mediaType};base64,${data}`;
        }
    }

    return null;
}

function normalizeImagePartForChat(part: JsonObject): JsonObject {
    const dataUrl = imageDataUrlFromPart(part);

    if (dataUrl) {
        return {
            type: "image_url",
            image_url: { url: dataUrl },
        };
    }

    return part;
}

function normalizeImagePartForResponses(part: JsonObject): JsonObject {
    const dataUrl = imageDataUrlFromPart(part);

    if (dataUrl) {
        return {
            type: "input_image",
            image_url: dataUrl,
        };
    }

    if (part.type === "text" && typeof part.text === "string") {
        return { type: "input_text", text: part.text };
    }

    return part;
}

function imageReferenceTextPart(target: "chat" | "responses"): JsonObject {
    if (target === "responses") {
        return { type: "input_text", text: IMAGE_REFERENCE_TEXT };
    }

    return { type: "text", text: IMAGE_REFERENCE_TEXT };
}

function processMessageContentImages(content: unknown, target: "chat" | "responses", replaceImages: boolean): unknown {
    if (typeof content === "string" || content == null) {
        return content;
    }

    if (!Array.isArray(content)) {
        return content;
    }

    return content.map((part) => {
        if (!isObject(part)) {
            return part;
        }

        if (isImageContentPart(part)) {
            if (replaceImages) {
                return imageReferenceTextPart(target);
            }

            if (target === "chat") {
                return normalizeImagePartForChat(part);
            }

            return normalizeImagePartForResponses(part);
        }

        if (target === "responses" && part.type === "text" && typeof part.text === "string") {
            return { type: "input_text", text: part.text };
        }

        return part;
    });
}

function applyGrokImageTurnPolicy(
    body: JsonObject,
    target: "chat" | "responses",
    routeCurrentTurnToBuild: boolean
): void {
    if (Array.isArray(body.messages)) {
        const lastUserIndex = findLastUserMessageIndex(body.messages);

        for (let index = 0; index < body.messages.length; index += 1) {
            const message = body.messages[index];

            if (!isObject(message) || message.content === undefined) {
                continue;
            }

            const keepImages = routeCurrentTurnToBuild && index === lastUserIndex;
            message.content = processMessageContentImages(message.content, target, !keepImages);
        }
    }

    if (Array.isArray(body.input)) {
        const lastUserIndex = findLastUserInputIndex(body.input);
        const keepUnscopedInputImages = routeCurrentTurnToBuild && lastUserIndex === -1;

        for (let index = 0; index < body.input.length; index += 1) {
            const item = body.input[index];

            if (!isObject(item)) {
                continue;
            }

            if (isImageContentPart(item)) {
                const keepImages = routeCurrentTurnToBuild && (index === lastUserIndex || keepUnscopedInputImages);

                if (keepImages) {
                    body.input[index] = normalizeImagePartForResponses(item);
                } else {
                    body.input[index] = {
                        type: "input_text",
                        text: IMAGE_REFERENCE_TEXT,
                    };
                }

                continue;
            }

            if (item.content === undefined) {
                continue;
            }

            const keepImages = routeCurrentTurnToBuild && (index === lastUserIndex || keepUnscopedInputImages);
            item.content = processMessageContentImages(item.content, "responses", !keepImages);
        }
    }
}

export interface PreparedGrokUpstreamBody {
    bodyText: string;
    upstreamModel: string;
    imageRouted: boolean;
}

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

export function normalizeGrokToolForChat(tool: unknown): JsonObject | null {
    if (!isObject(tool)) {
        return null;
    }

    if (tool.type === "function" && isObject(tool.function)) {
        const fn = tool.function;
        if (typeof fn.name !== "string") {
            return null;
        }

        return {
            type: "function",
            function: {
                name: fn.name,
                description: fn.description ?? "",
                parameters: fn.parameters ?? { type: "object", properties: {} },
                ...(fn.strict !== undefined ? { strict: fn.strict } : {}),
            },
        };
    }

    if (tool.type === "function" && typeof tool.name === "string") {
        return {
            type: "function",
            function: {
                name: tool.name,
                description: tool.description ?? "",
                parameters: tool.parameters ?? { type: "object", properties: {} },
                ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
            },
        };
    }

    if (tool.type === "custom") {
        const name = typeof tool.name === "string" ? tool.name : "custom_tool";

        return {
            type: "function",
            function: {
                name,
                description: typeof tool.description === "string" ? tool.description : "Custom Cursor tool",
                parameters: { type: "object", properties: {} },
            },
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

export function normalizeGrokToolsForChat(tools: unknown): JsonObject[] | undefined {
    if (!Array.isArray(tools)) {
        return undefined;
    }

    const normalized = tools.map(normalizeGrokToolForChat).filter((tool): tool is JsonObject => tool !== null);

    if (normalized.length === 0) {
        return undefined;
    }

    return normalized;
}

function ensureGrokThinkingEnabled(body: JsonObject, upstreamModel: string): void {
    if (inferModelThinking(upstreamModel) !== "reasoning") {
        return;
    }

    if (body.enable_thinking === true) {
        return;
    }

    body.enable_thinking = true;
}

function stripMirroredThinkingFromMessages(body: JsonObject): void {
    if (!Array.isArray(body.messages)) {
        return;
    }

    for (const message of body.messages) {
        if (!isObject(message) || message.role !== "assistant") {
            continue;
        }

        if (typeof message.content === "string") {
            message.content = stripCursorThinkingBlocks(message.content);
        } else if (Array.isArray(message.content)) {
            for (const part of message.content) {
                if (isObject(part) && part.type === "text" && typeof part.text === "string") {
                    part.text = stripCursorThinkingBlocks(part.text);
                }
            }
        }
    }
}

function patchGrokAssistantReasoningForToolCalls(body: JsonObject): void {
    if (!Array.isArray(body.messages)) {
        return;
    }

    for (const message of body.messages) {
        if (!isObject(message) || message.role !== "assistant") {
            continue;
        }

        if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
            continue;
        }

        if (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) {
            continue;
        }

        message.reasoning_content = " ";
    }
}

export function prepareGrokUpstreamBody(
    bodyText: string,
    upstreamModel: string,
    target: "chat" | "responses" = "chat"
): PreparedGrokUpstreamBody {
    try {
        const parsed = SafeJSON.parse(bodyText, { strict: true });

        if (!isObject(parsed)) {
            return { bodyText, upstreamModel, imageRouted: false };
        }

        const next: JsonObject = { ...parsed };
        const currentTurnHasImages = latestUserTurnHasImages(next);
        const resolvedModel = resolveGrokUpstreamModelForImages(upstreamModel, next);
        const imageRouted = resolvedModel !== upstreamModel;

        if (imageRouted) {
            logger.debug(
                { from: upstreamModel, to: resolvedModel, target },
                "ai-proxy: routing current Grok turn with images to vision-capable model"
            );
        }

        if ("model" in next) {
            next.model = resolvedModel;
        }

        ensureGrokThinkingEnabled(next, resolvedModel);
        patchGrokAssistantReasoningForToolCalls(next);
        stripMirroredThinkingFromMessages(next);

        if (target === "responses") {
            if ("max_tokens" in next && !("max_output_tokens" in next)) {
                next.max_output_tokens = next.max_tokens;
                delete next.max_tokens;
            }
        }

        const normalizedTools =
            target === "responses" ? normalizeGrokTools(next.tools) : normalizeGrokToolsForChat(next.tools);
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

        applyGrokImageTurnPolicy(next, target, currentTurnHasImages);

        const prepared = target === "responses" ? ensureResponsesInput(next) : next;

        return {
            bodyText: SafeJSON.stringify(prepared),
            upstreamModel: resolvedModel,
            imageRouted,
        };
    } catch (err) {
        logger.debug({ err, upstreamModel, target }, "ai-proxy: prepareGrokUpstreamBody fallback");
        return { bodyText: rewriteBodyModel(bodyText, upstreamModel), upstreamModel, imageRouted: false };
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
