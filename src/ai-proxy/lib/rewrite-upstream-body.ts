import { ensureResponsesInput } from "@app/ai-proxy/lib/chat-to-responses-body";
import { inlineResponsesItemReferences } from "@app/ai-proxy/lib/providers/wham-item-store";
import { extractFoldedThinking } from "@app/ai-proxy/lib/thinking-folded";
import { inferModelThinking } from "@genesiscz/utils/ai/grok/models";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";

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

    // AI SDK file parts carrying an image (only when the image payload is
    // actually extractable — non-image file parts must stay untouched).
    if (part.type === "file") {
        return fileImageDataUrl(part) !== null;
    }

    return false;
}

const IMAGE_MEDIA_TYPE_KEYS = ["mediaType", "media_type", "mimeType", "mime_type"] as const;

function imageMediaTypeFromPart(part: JsonObject): string | null {
    for (const key of IMAGE_MEDIA_TYPE_KEYS) {
        const value = part[key];

        if (typeof value === "string" && value.startsWith("image/")) {
            return value;
        }
    }

    return null;
}

/**
 * Inline payload of an AI SDK `file` part. Covers the plain-string `data`
 * form, UI-message `url`, and ai@7's V4 tagged objects
 * ({type:'data', data} / {type:'url', url}) — when a client serializes the V4
 * prompt shape straight to JSON, the base64 is still recoverable here.
 */
function filePartInlineData(part: JsonObject): string | null {
    if (typeof part.data === "string") {
        return part.data;
    }

    if (isObject(part.data)) {
        if (part.data.type === "data" && typeof part.data.data === "string") {
            return part.data.data;
        }

        if (part.data.type === "url" && typeof part.data.url === "string") {
            return part.data.url;
        }
    }

    if (typeof part.url === "string") {
        return part.url;
    }

    return null;
}

/** Data/remote URL of a `file` part when it carries an image; null otherwise. */
function fileImageDataUrl(part: JsonObject): string | null {
    if (part.type !== "file") {
        return null;
    }

    const mediaType = imageMediaTypeFromPart(part);
    const raw = filePartInlineData(part);

    if (!raw) {
        return null;
    }

    if (raw.startsWith("data:")) {
        return raw.startsWith("data:image/") || mediaType ? raw : null;
    }

    if (/^https?:/.test(raw)) {
        return mediaType ? raw : null;
    }

    // Raw base64 — only an image when the part declares an image media type.
    return mediaType ? `data:${mediaType};base64,${raw}` : null;
}

/** Data/remote URL of an AI SDK core image part ({type:'image', image: …}). */
function imageFieldDataUrl(part: JsonObject): string | null {
    const image = part.image;
    const raw = typeof image === "string" ? image : isObject(image) && typeof image.url === "string" ? image.url : null;

    if (!raw) {
        return null;
    }

    if (raw.startsWith("data:") || /^https?:/.test(raw)) {
        return raw;
    }

    // Raw base64 with no declared media type — jpeg is the pragmatic default
    // (matches AI SDK's own image/* fallback behavior).
    return `data:${imageMediaTypeFromPart(part) ?? "image/jpeg"};base64,${raw}`;
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

    if (part.type === "image") {
        return imageFieldDataUrl(part);
    }

    if (part.type === "file") {
        return fileImageDataUrl(part);
    }

    return null;
}

const BASE64_MARKER = ";base64,";

/**
 * Returns the (truncated) offending payload when an image part carries a
 * base64 data URL whose payload cannot be base64 — e.g. a client stringified
 * an object into the data slot ("[object Object]", seen from ai@7 running
 * @ai-sdk/openai v2 in compatibility mode). The image bytes never reached the
 * proxy in that case, so rejecting early with a clear message beats burning an
 * upstream call on a cryptic 400.
 */
export function findInvalidImageDataPayload(body: JsonObject): string | null {
    const partsToCheck: JsonObject[] = [];

    if (Array.isArray(body.messages)) {
        for (const message of body.messages) {
            if (isObject(message) && Array.isArray(message.content)) {
                for (const part of message.content) {
                    if (isObject(part) && isImageContentPart(part)) {
                        partsToCheck.push(part);
                    }
                }
            }
        }
    }

    if (Array.isArray(body.input)) {
        for (const item of body.input) {
            if (!isObject(item)) {
                continue;
            }

            if (isImageContentPart(item)) {
                partsToCheck.push(item);
            } else if (Array.isArray(item.content)) {
                for (const part of item.content) {
                    if (isObject(part) && isImageContentPart(part)) {
                        partsToCheck.push(part);
                    }
                }
            }
        }
    }

    for (const part of partsToCheck) {
        const dataUrl = imageDataUrlFromPart(part);

        if (!dataUrl?.startsWith("data:")) {
            continue;
        }

        const markerIndex = dataUrl.indexOf(BASE64_MARKER);

        if (markerIndex === -1) {
            continue;
        }

        const payload = dataUrl.slice(markerIndex + BASE64_MARKER.length);
        const stripped = payload.replace(/\s+/g, "");

        if (stripped.length === 0 || /[^A-Za-z0-9+/=_-]/.test(stripped)) {
            return payload.slice(0, 100);
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

// Folded mode writes reasoning into assistant `content`; replaying that verbatim
// makes the model imitate the <details> wrapper in its answers. The old fix
// deleted it — erasing the model's own reasoning from history every turn. Now the
// reasoning is moved to `reasoning_content`, the request slot Grok already
// accepts (see patchGrokAssistantReasoningForToolCalls), so continuity survives.
function reclaimMirroredThinkingFromMessages(body: JsonObject): void {
    if (!Array.isArray(body.messages)) {
        return;
    }

    for (const message of body.messages) {
        if (!isObject(message) || message.role !== "assistant") {
            continue;
        }

        const reclaimed: string[] = [];

        if (typeof message.content === "string") {
            const { content, reasoning } = extractFoldedThinking(message.content);

            if (reasoning) {
                message.content = content;
                reclaimed.push(reasoning);
            }
        } else if (Array.isArray(message.content)) {
            for (const part of message.content) {
                if (isObject(part) && part.type === "text" && typeof part.text === "string") {
                    const { content, reasoning } = extractFoldedThinking(part.text);

                    if (reasoning) {
                        part.text = content;
                        reclaimed.push(reasoning);
                    }
                }
            }
        }

        const hasReasoning = typeof message.reasoning_content === "string" && message.reasoning_content.trim();

        if (reclaimed.length > 0 && !hasReasoning) {
            message.reasoning_content = reclaimed.join("\n\n");
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

/** Read-only partition: no code path writes items under this name. */
const UNSCOPED_ITEM_SCOPE = "unscoped";

export function prepareGrokUpstreamBody(
    bodyText: string,
    upstreamModel: string,
    target: "chat" | "responses" = "chat",
    /**
     * Store partition of the presenting client, from `whamItemScope(req)`.
     * The default names a partition nothing ever writes to (every store WRITE
     * takes a required scope), so a caller that forgets it resolves NOTHING
     * rather than reading every other client's items.
     */
    itemScope: string = UNSCOPED_ITEM_SCOPE
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
        // Reclaim BEFORE the patch: real reasoning must fill reasoning_content
        // first, so the patch's " " placeholder only covers turns with none.
        reclaimMirroredThinkingFromMessages(next);
        patchGrokAssistantReasoningForToolCalls(next);

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

        // Grok honours `stream_options.include_usage` (verified raw 2026-08-19:
        // the final chunk carries real usage including reasoning_tokens,
        // cached_tokens and cost_in_usd_ticks). This line used to DELETE the
        // field, which silenced usage on every streamed call and forced 72% of
        // ledger rows onto char-count estimates. The Responses API has no
        // stream_options, so it is still stripped on that target.
        if (target === "responses") {
            if ("stream_options" in next) {
                delete next.stream_options;
            }
        } else if (next.stream === true) {
            const streamOptions = isObject(next.stream_options) ? { ...next.stream_options } : {};
            // ??=, not =: a client that explicitly asked for false meant it —
            // the trailing usage-only frame (empty choices[]) breaks consumers
            // that index choices[0] without a length check. The ledger falls
            // back to its estimate for such calls.
            streamOptions.include_usage ??= true;
            next.stream_options = streamOptions;
        }

        if ("n" in next) {
            delete next.n;
        }

        applyGrokImageTurnPolicy(next, target, currentTurnHasImages);

        const prepared =
            target === "responses" ? inlineResponsesItemReferences(itemScope, ensureResponsesInput(next)) : next;

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

/** An effort slot the suffix may fill: absent, or a blank string. Anything else is the client's explicit answer. */
function isEffortGap(value: unknown): boolean {
    return value === undefined || (typeof value === "string" && !value.trim());
}

/**
 * Stamp `reasoning_effort` (and `reasoning.effort` when that object exists)
 * from a `:<effort>` model-id suffix. An explicit body field wins.
 */
export function applyReasoningEffortToBody(bodyText: string, effort?: string): string {
    if (!effort) {
        return bodyText;
    }

    try {
        const parsed = SafeJSON.parse(bodyText, { strict: true });

        if (!isObject(parsed)) {
            return bodyText;
        }

        const next: JsonObject = { ...parsed };
        let changed = false;

        // An explicit nested `reasoning.effort` is the client's answer for the
        // whole request — README says it beats the suffix. Stamping the
        // top-level field anyway would ship two conflicting efforts upstream.
        const nestedEffortSet = isObject(next.reasoning) && next.reasoning.effort !== undefined;

        // An explicit body field wins, whatever its type — a client that sent
        // `reasoning_effort: null` meant it (`reasoning: { effort: null }` is a
        // client explicitly disabling effort on the Responses door). Only a gap
        // per isEffortGap may be filled, same rule for both documented fields
        // or they would disagree.
        if (!nestedEffortSet && isEffortGap(next.reasoning_effort)) {
            next.reasoning_effort = effort;
            changed = true;
        }

        if (isObject(next.reasoning) && isEffortGap(next.reasoning.effort)) {
            next.reasoning = { ...next.reasoning, effort };
            changed = true;
        }

        return changed ? SafeJSON.stringify(next) : bodyText;
    } catch (err) {
        logger.debug({ err, effort }, "ai-proxy: reasoning-effort stamp skipped — body was not parseable JSON");
        return bodyText;
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
