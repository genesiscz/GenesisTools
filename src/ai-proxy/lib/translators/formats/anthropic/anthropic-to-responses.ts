import { createHash } from "node:crypto";
import { grokReasoningCodec } from "@app/ai-proxy/lib/translators/formats/anthropic/reasoning-codec";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";

type JsonRecord = Record<string, unknown>;

/**
 * Anthropic Messages request → xAI Responses request. Grok's native
 * `/v1/messages` shim merges parallel tool calls into one block and keeps only
 * the first name (raw wire capture 2026-08-21, nine request variants tried);
 * its `/responses` wire names every call. This translator is how the Anthropic
 * door reaches that reliable wire without losing reasoning continuity.
 *
 * Reasoning continuity: with `store: false` + `include:
 * ["reasoning.encrypted_content"]` grok returns reasoning items whose
 * `encrypted_content` it decrypts and consumes on replay (verified: a tampered
 * blob is rejected with a decrypt error, so replay is real, not tolerated).
 * The Anthropic wire has no slot for it, so it rides inside the thinking
 * block's `signature`, which Anthropic clients replay verbatim and never
 * inspect. Thinking blocks without a packed signature (another provider's
 * history, the shim's `signature: ""`) are dropped, exactly as the OpenAI
 * translation drops them.
 */

/** What differs per upstream when an Anthropic request becomes a Responses request. */
export interface ResponsesTranslationHooks {
    /**
     * The Responses `reasoning` item a thinking block replays, or undefined to drop the block (another provider's
     * history, a stale or foreign signature). Items are replayed whole and in their original order.
     */
    reasoningItem: (thinking: JsonRecord) => JsonRecord | undefined;
    /**
     * A tool result's images go up inside `function_call_output.output` as `input_image` items, the form codex-rs sends
     * and WHAM accepts (probed 2026-10-26: the model described the image). Off: each image becomes "[Image Omitted]".
     */
    toolResultImages?: boolean;
    /**
     * A tool that Claude Code's tool search loaded (`defer_loading: true`) stays out of `tools` and goes in as an
     * `additional_tools` input item right after the search result that loaded it. WHAM reads 0% of its prompt cache
     * after any change of `tools`, also an append (probed 2026-10-28); an `additional_tools` item kept 41,088 of
     * 42,227 tokens cached and the model called the tool. Off: loaded tools join `tools` (`stableToolOrder`).
     */
    deferredToolsAsInput?: boolean;
    /** Account, client and conversation scope for remembered compaction introductions. */
    deferredRecoveryScope?: string;
    /**
     * The items an assistant message produced earlier, when Claude Code sent it with its thinking. Asked only for a
     * message that carries no thinking now; a returned list replaces the message's own translation.
     */
    restoreAssistantItems?: (content: unknown[]) => JsonRecord[] | undefined;
    /** Told the items an assistant message produced while it carried its thinking. */
    rememberAssistantItems?: (content: unknown[], items: JsonRecord[]) => void;
}

/** Deferred tools by name, and the ones already given to the model as an `additional_tools` item. */
interface DeferredTools {
    byName: Map<string, JsonRecord>;
    sent: Set<string>;
}

/** Grok: the signature carries the item id and its encrypted content; the thinking text is the summary. */
export const GROK_RESPONSES_HOOKS: ResponsesTranslationHooks = {
    reasoningItem: (thinking) => {
        const opened = grokReasoningCodec.open(thinking);
        return opened.ok ? opened.item : undefined;
    },
};

function systemToInstructions(system: unknown): string | undefined {
    if (typeof system === "string" && system.length > 0) {
        return system;
    }

    if (!Array.isArray(system)) {
        return undefined;
    }

    const parts: string[] = [];

    for (const entry of system) {
        if (typeof entry === "string") {
            parts.push(entry);
        } else if (isObject(entry) && typeof entry.text === "string") {
            parts.push(entry.text);
        }
    }

    return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** Same flattening the OpenAI translation applies to `tool_result.content`. */
function flattenToolResult(result: JsonRecord): string {
    const failedPrefix = result.is_error === true ? "[Tool call failed] " : "";
    const content = result.content;

    if (typeof content === "string") {
        return `${failedPrefix}${content}`;
    }

    if (!Array.isArray(content)) {
        return `${failedPrefix}${content === undefined ? "" : SafeJSON.stringify(content)}`;
    }

    const flattened = content
        .map((part) => {
            if (!isObject(part)) {
                return "";
            }

            if (part.type === "text") {
                return String(part.text ?? "");
            }

            if (part.type === "image" || (isObject(part.source) && part.source.type === "base64")) {
                return "[Image Omitted]";
            }

            return SafeJSON.stringify(part);
        })
        .join("\n");

    return `${failedPrefix}${flattened}`;
}

/** A tool result as Responses content items, images included; undefined when it has no image (it stays a string). */
function toolResultItems(result: JsonRecord): JsonRecord[] | undefined {
    if (!Array.isArray(result.content) || !result.content.some((part) => isObject(part) && part.type === "image")) {
        return undefined;
    }

    const items: JsonRecord[] = result.is_error === true ? [{ type: "input_text", text: "[Tool call failed]" }] : [];

    for (const part of result.content) {
        if (isObject(part)) {
            const mapped = userContentPart(part);

            if (mapped !== null) {
                items.push(mapped);
            }
        }
    }

    return items;
}

function userContentPart(part: JsonRecord): JsonRecord | null {
    if (part.type === "text" && typeof part.text === "string") {
        return { type: "input_text", text: part.text };
    }

    if (part.type === "image" && isObject(part.source)) {
        const source = part.source;

        if (source.type === "base64") {
            return { type: "input_image", image_url: `data:${source.media_type};base64,${source.data}` };
        }

        if (source.type === "url" && typeof source.url === "string") {
            return { type: "input_image", image_url: source.url };
        }
    }

    if (part.type === "tool_use" || part.type === "thinking" || part.type === "redacted_thinking") {
        return null;
    }

    return { type: "input_text", text: SafeJSON.stringify(part) };
}

function pushUserMessage(input: JsonRecord[], parts: JsonRecord[]): void {
    if (parts.length > 0) {
        input.push({ role: "user", content: parts.splice(0) });
    }
}

function pushAssistantText(input: JsonRecord[], parts: string[]): void {
    if (parts.length > 0) {
        input.push({
            role: "assistant",
            content: [{ type: "output_text", text: parts.splice(0).join("\n") }],
        });
    }
}

/** The tools a search result loaded, as one `additional_tools` item; undefined when it loaded none not sent before. */
function loadedToolsItem(result: JsonRecord, deferred: DeferredTools | undefined): JsonRecord | undefined {
    if (!deferred) {
        return undefined;
    }

    const tools = referencedToolNames(result.content)
        .filter((name) => deferred.byName.has(name) && !deferred.sent.has(name))
        .map((name) => {
            deferred.sent.add(name);
            return responsesTool(deferred.byName.get(name) as JsonRecord);
        });

    return tools.length > 0 ? { type: "additional_tools", role: "developer", tools } : undefined;
}

/** Introduce an offered deferred tool immediately before its first surviving call. */
function introduceUsedTools(input: JsonRecord[], content: unknown, deferred: DeferredTools | undefined): void {
    if (!deferred || !Array.isArray(content)) {
        return;
    }

    for (const part of content) {
        if (!isObject(part) || part.type !== "tool_use" || typeof part.name !== "string") {
            continue;
        }
        const tool = deferred.byName.get(part.name);
        if (!tool || deferred.sent.has(part.name)) {
            continue;
        }
        deferred.sent.add(part.name);
        input.push({ type: "additional_tools", role: "developer", tools: [responsesTool(tool)] });
    }
}

function appendUserMessage(
    input: JsonRecord[],
    content: unknown,
    hooks: ResponsesTranslationHooks,
    deferred: DeferredTools | undefined
): void {
    if (typeof content === "string") {
        if (content.length > 0) {
            input.push({ role: "user", content: [{ type: "input_text", text: content }] });
        }

        return;
    }

    if (!Array.isArray(content)) {
        return;
    }

    // Tool outputs become their own top-level items; everything else stays one
    // user message. Claude Code orders results before commentary, so emitting
    // the outputs first preserves the conversation order.
    const parts: JsonRecord[] = [];

    for (const part of content) {
        if (!isObject(part)) {
            continue;
        }

        if (part.type === "tool_result") {
            input.push({
                type: "function_call_output",
                call_id: part.tool_use_id,
                output: (hooks.toolResultImages ? toolResultItems(part) : undefined) ?? flattenToolResult(part),
            });
            const loaded = loadedToolsItem(part, deferred);

            if (loaded) {
                input.push(loaded);
            }

            continue;
        }

        const mapped = userContentPart(part);

        if (mapped !== null) {
            parts.push(mapped);
        }
    }

    pushUserMessage(input, parts);
}

function appendAssistantMessage(
    input: JsonRecord[],
    content: unknown,
    dropped: { thinking: number },
    hooks: ResponsesTranslationHooks
): void {
    if (typeof content === "string") {
        if (content.length > 0) {
            input.push({ role: "assistant", content: [{ type: "output_text", text: content }] });
        }

        return;
    }

    if (!Array.isArray(content)) {
        return;
    }

    const thinking = content.some((part) => isObject(part) && part.type === "thinking");
    const restored = thinking ? undefined : hooks.restoreAssistantItems?.(content);

    if (restored) {
        input.push(...restored);
        return;
    }

    const start = input.length;
    const textParts: string[] = [];

    for (const part of content) {
        if (!isObject(part)) {
            continue;
        }

        if (part.type === "thinking") {
            const item = hooks.reasoningItem(part);

            if (item === undefined) {
                dropped.thinking += 1;
                continue;
            }

            pushAssistantText(input, textParts);
            input.push(item);
            continue;
        }

        if (part.type === "tool_use") {
            pushAssistantText(input, textParts);
            input.push({
                type: "function_call",
                call_id: part.id,
                name: part.name,
                arguments: typeof part.input === "string" ? part.input : SafeJSON.stringify(part.input ?? {}),
            });
            continue;
        }

        if (part.type === "text" && typeof part.text === "string") {
            textParts.push(part.text);
        }
    }

    pushAssistantText(input, textParts);

    if (thinking) {
        hooks.rememberAssistantItems?.(content, input.slice(start));
    }
}

/** Tool names in the order their ToolSearch `tool_reference` blocks first appear in the conversation. */
function referencedToolNames(value: unknown, names: string[] = []): string[] {
    if (Array.isArray(value)) {
        for (const item of value) {
            referencedToolNames(item, names);
        }
    } else if (isObject(value)) {
        if (value.type === "tool_reference" && typeof value.tool_name === "string") {
            if (!names.includes(value.tool_name)) {
                names.push(value.tool_name);
            }
        } else {
            referencedToolNames(value.content, names);
        }
    }

    return names;
}

/**
 * Claude Code's tool search adds each tool it loads (`defer_loading: true`) to
 * `tools` in name order, so a new one lands in the middle of the list.
 * Anthropic keeps deferred tools out of the cached prefix. A Responses upstream
 * caches the tools as sent, so the insertion sent the whole prompt uncached
 * (0% on the next request, codex-content cache run 2026-10-26). Regular tools
 * keep the client's order. Deferred tools follow, and the ones the conversation
 * loaded come last in the order they were loaded, so the list only grows.
 */
function stableToolOrder(tools: unknown[], messages: unknown): unknown[] {
    const isDeferred = (tool: unknown) => isObject(tool) && tool.defer_loading === true;

    if (!tools.some(isDeferred)) {
        return tools;
    }

    const loaded = referencedToolNames(messages);
    const loadIndex = (tool: unknown) => (isObject(tool) ? loaded.indexOf(String(tool.name)) : -1);
    const deferred = tools.filter(isDeferred);

    return [
        ...tools.filter((tool) => !isDeferred(tool)),
        ...deferred.filter((tool) => loadIndex(tool) < 0),
        ...deferred.filter((tool) => loadIndex(tool) >= 0).sort((a, b) => loadIndex(a) - loadIndex(b)),
    ];
}

function responsesTool(tool: JsonRecord): JsonRecord {
    return {
        type: "function",
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.input_schema ?? { type: "object", properties: {}, required: [] },
    };
}

function isDeferredTool(tool: unknown): tool is JsonRecord {
    return isObject(tool) && tool.defer_loading === true && typeof tool.name === "string";
}

function compactedHistoryText(messages: unknown): string | undefined {
    if (!Array.isArray(messages)) {
        return undefined;
    }
    const first = messages.find((message) => isObject(message) && message.role === "user");
    if (!isObject(first)) {
        return undefined;
    }
    const text =
        typeof first.content === "string"
            ? first.content
            : Array.isArray(first.content)
              ? first.content
                    .filter(isObject)
                    .map((block) => (typeof block.text === "string" ? block.text : ""))
                    .join("\n")
              : "";
    return text.startsWith("This session is being continued") || text.includes("[codex-compaction ") ? text : undefined;
}

// A first observation fixes the compacted prefix. New tool references belong at their later search result.
const recoveredByHistory = new Map<string, string[]>();
const MAX_RECOVERED_HISTORIES = 1024;
const MAX_RECOVERED_TOOLS = 512;

function recoveredToolNames(
    scope: string | undefined,
    summary: string,
    deferred: DeferredTools,
    messages: unknown
): string[] {
    const key = scope
        ? createHash("sha256")
              .update(SafeJSON.stringify([scope, summary]))
              .digest("hex")
        : undefined;
    let names = key ? recoveredByHistory.get(key) : undefined;
    if (!names) {
        const referenced = new Set(referencedToolNames(messages));
        names = [...deferred.byName.keys()].filter((name) => !referenced.has(name));
        if (names.length > MAX_RECOVERED_TOOLS) {
            logger.warn({ count: names.length }, "ai-proxy: too many recovered tools to remember their cache prefix");
            return names;
        }
    }
    if (!key) {
        return names;
    }
    recoveredByHistory.delete(key);
    recoveredByHistory.set(key, names);
    while (recoveredByHistory.size > MAX_RECOVERED_HISTORIES) {
        const oldest = recoveredByHistory.keys().next().value;
        if (oldest === undefined) {
            break;
        }
        recoveredByHistory.delete(oldest);
    }
    return names;
}

function deferredTools(tools: unknown): DeferredTools {
    const byName = new Map<string, JsonRecord>();

    for (const tool of Array.isArray(tools) ? tools : []) {
        if (isDeferredTool(tool)) {
            byName.set(String(tool.name), tool);
        }
    }

    return { byName, sent: new Set() };
}

function responsesTools(tools: unknown, messages: unknown, deferredAsInput: boolean): JsonRecord[] | undefined {
    if (!Array.isArray(tools)) {
        return undefined;
    }

    const mapped: JsonRecord[] = [];
    const ordered = deferredAsInput ? tools.filter((tool) => !isDeferredTool(tool)) : stableToolOrder(tools, messages);

    for (const tool of ordered) {
        if (!isObject(tool) || typeof tool.name !== "string") {
            continue;
        }

        mapped.push(responsesTool(tool));
    }

    return mapped.length > 0 ? mapped : undefined;
}

function responsesToolChoice(choice: unknown): unknown {
    if (!isObject(choice)) {
        return undefined;
    }

    if (choice.type === "auto") {
        return "auto";
    }

    if (choice.type === "none") {
        return "none";
    }

    if (choice.type === "any") {
        return "required";
    }

    if (choice.type === "tool" && typeof choice.name === "string") {
        return { type: "function", name: choice.name };
    }

    return undefined;
}

/**
 * The decrypt-failure retry: a signature packed by a different conversation
 * (or truncated by a client) fails upstream decryption for the WHOLE request,
 * so the retry replays the same body minus every reasoning item.
 */
export function stripReasoningInput(body: JsonRecord): JsonRecord {
    if (!Array.isArray(body.input)) {
        return body;
    }

    return {
        ...body,
        input: body.input.filter((item) => !(isObject(item) && item.type === "reasoning")),
    };
}

export function anthropicToGrokResponses(body: JsonRecord, model: string): JsonRecord {
    return anthropicToResponses(body, model, GROK_RESPONSES_HOOKS);
}

/**
 * A `role: "system"` message in `messages[]`, kept at its place as a developer message (codex-rs sends instructions
 * that arrive mid-conversation the same way). Claude Code 2.1.296 sends hook output this way: SessionStart output
 * after the first prompt, UserPromptSubmit and tool hook output later. Hoisted into `instructions`, each new one
 * changed the instructions, and WHAM's prompt cache (tools, then instructions, then input) kept only the tools.
 * The Grok agent still hoists before it translates.
 */
function appendDeveloperMessage(input: JsonRecord[], content: unknown): void {
    const parts =
        typeof content === "string"
            ? [content]
            : Array.isArray(content)
              ? content.flatMap((block) => (isObject(block) && typeof block.text === "string" ? [block.text] : []))
              : [];

    if (parts.length > 0) {
        input.push({ role: "developer", content: parts.map((text) => ({ type: "input_text", text })) });
    }
}

/** Anthropic Messages request → Responses request, shared by the Grok and Codex agents (hooks: what differs). */
export function anthropicToResponses(body: JsonRecord, model: string, hooks: ResponsesTranslationHooks): JsonRecord {
    const input: JsonRecord[] = [];
    const dropped = { thinking: 0 };
    const deferred = hooks.deferredToolsAsInput ? deferredTools(body.tools) : undefined;

    const summary = deferred ? compactedHistoryText(body.messages) : undefined;
    if (deferred && summary !== undefined) {
        const names = recoveredToolNames(hooks.deferredRecoveryScope, summary, deferred, body.messages);
        const tools: JsonRecord[] = [];
        for (const name of names) {
            const tool = deferred.byName.get(name);
            if (tool) {
                tools.push(responsesTool(tool));
                deferred.sent.add(name);
            }
        }
        if (tools.length > 0) {
            input.push({ type: "additional_tools", role: "developer", tools });
        }
    }

    if (Array.isArray(body.messages)) {
        for (const message of body.messages) {
            if (!isObject(message)) {
                continue;
            }

            if (message.role === "assistant") {
                introduceUsedTools(input, message.content, deferred);
                appendAssistantMessage(input, message.content, dropped, hooks);
            } else if (message.role === "system") {
                appendDeveloperMessage(input, message.content);
            } else {
                appendUserMessage(input, message.content, hooks, deferred);
            }
        }
    }

    if (dropped.thinking > 0) {
        logger.debug(
            { dropped: dropped.thinking, model },
            "ai-proxy: dropped thinking blocks without a replayable reasoning signature"
        );
    }

    const out: JsonRecord = {
        model,
        input,
        store: false,
        include: ["reasoning.encrypted_content"],
    };

    const instructions = systemToInstructions(body.system);

    if (instructions !== undefined) {
        out.instructions = instructions;
    }

    const tools = responsesTools(body.tools, body.messages, hooks.deferredToolsAsInput === true);

    if (tools !== undefined) {
        out.tools = tools;
    }

    const toolChoice = responsesToolChoice(body.tool_choice);

    if (toolChoice !== undefined) {
        out.tool_choice = toolChoice;
    }

    if (isObject(body.tool_choice) && body.tool_choice.disable_parallel_tool_use === true) {
        out.parallel_tool_calls = false;
    }

    if (typeof body.max_tokens === "number") {
        out.max_output_tokens = body.max_tokens;
    }

    for (const field of ["stream", "temperature", "top_p", "reasoning_effort"] as const) {
        if (body[field] !== undefined) {
            out[field] = body[field];
        }
    }

    return out;
}
