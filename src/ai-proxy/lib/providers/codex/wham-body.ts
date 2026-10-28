import { createHash } from "node:crypto";
import { convertMessagesToInput } from "@app/ai-proxy/lib/chat-to-responses-body";
import { resolveWhamItemReferences } from "@app/ai-proxy/lib/providers/wham-item-store";
import { effortRange } from "@genesiscz/utils/ai/catalog/efforts";
import { type CodexModelInfo, resolveCodexEffort } from "@genesiscz/utils/ai/openai/codex-models";
import { type PromptCacheKey, resolvePromptCacheKey } from "@genesiscz/utils/ai/prompt-cache-key";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";

/**
 * A function tool the proxy built from a non-strict shape (a chat tool, an Anthropic tool), with `strict: false` unless
 * the client chose. WHAM treats a function tool without `strict` as strict, and the model then fills every optional
 * field: Claude Code's Agent tool came back with `isolation: "worktree"` and a `team_name` in 3 of 3 trials, against
 * `prompt` only with `strict: false` (2026-10-25). codex-rs sends `strict: false` on every function tool. A
 * `/v1/responses` client's tools pass as sent: its own API has the same default.
 */
export function nonStrictByDefault(tool: Record<string, unknown>): Record<string, unknown> {
    return typeof tool.strict === "boolean" ? tool : { ...tool, strict: false };
}

export function mapChatToolsToResponses(tools: unknown, dropped?: string[]): unknown[] | undefined {
    if (!Array.isArray(tools)) {
        return undefined;
    }

    const mapped: unknown[] = [];

    for (const tool of tools) {
        if (!isObject(tool)) {
            continue;
        }

        // Already Responses-shaped (flat function tool).
        if (tool.type === "function" && typeof tool.name === "string") {
            mapped.push(nonStrictByDefault(tool));
            continue;
        }

        const fn = isObject(tool.function) ? tool.function : undefined;

        if (fn && typeof fn.name === "string") {
            mapped.push(
                nonStrictByDefault({
                    type: "function",
                    name: fn.name,
                    description: typeof fn.description === "string" ? fn.description : undefined,
                    parameters: fn.parameters ?? { type: "object", properties: {} },
                    ...(typeof fn.strict === "boolean" ? { strict: fn.strict } : {}),
                })
            );
            continue;
        }

        // WHAM only accepts flat function tools — anything else is stripped.
        dropped?.push(`tools[type=${typeof tool.type === "string" ? tool.type : "unknown"}]`);
    }

    return mapped.length > 0 ? mapped : undefined;
}

/** Filter an already-Responses-shaped tools array down to what WHAM accepts. */
export function mapResponsesTools(tools: unknown, dropped: string[]): unknown[] | undefined {
    if (!Array.isArray(tools)) {
        return undefined;
    }

    const kept: unknown[] = [];

    for (const tool of tools) {
        // `web_search` is OpenAI's hosted search, sent the way codex-rs sends it; WHAM runs it server-side.
        if (isObject(tool) && (tool.type === "function" || tool.type === "web_search")) {
            kept.push(tool);
            continue;
        }

        dropped.push(`tools[type=${isObject(tool) && typeof tool.type === "string" ? tool.type : "unknown"}]`);
    }

    return kept.length > 0 ? kept : undefined;
}

export const WHAM_REASONING_EFFORTS = new Set<string>(effortRange("minimal", "xhigh"));

export interface WhamBodyBuildResult {
    body: Record<string, unknown>;
    /** Client-sent parameters WHAM cannot enforce, silently stripped from the upstream body. */
    dropped: string[];
    /** Set when the catalog says the model has no such effort: the caller answers 400 with this text. */
    effortError?: string;
    /** The conversation's cache key, sent as `prompt_cache_key` and as the session headers. */
    cacheKey?: PromptCacheKey;
}

const warnedDroppedParams = new Set<string>();

/** Log each dropped-parameter name once per process so agent traffic doesn't spam the log. */
export function warnDroppedParamsOnce(dropped: string[]): void {
    for (const param of dropped) {
        if (warnedDroppedParams.has(param)) {
            continue;
        }

        warnedDroppedParams.add(param);
        logger.warn({ param }, "ai-proxy: WHAM does not accept this parameter — dropped (logged once per process)");
    }
}

/** Convert a chat- or responses-shaped body into a WHAM Responses request. */
export function buildWhamResponsesBody(
    parsed: Record<string, unknown>,
    model: string,
    // `itemScope` is required, not optional: a caller that forgot it would share
    // one store partition with every other client, which is the bug this fixes.
    options: {
        defaultReasoningEffort?: "none" | "low" | "medium" | "high";
        itemScope: string;
        /**
         * The model's catalog record. With efforts listed, the effort is checked against the model's own list: `max`
         * passes, `ultra` resolves like codex-rs, anything else is refused. Without one (an unknown model), the
         * older fixed allowlist and its `max` to `xhigh` clamp apply.
         */
        catalog?: CodexModelInfo;
        /** A `session-id` / `session_id` header the client sent (a native Codex client keys its cache by it). */
        clientSessionHeader?: string;
    }
): WhamBodyBuildResult {
    const body: Record<string, unknown> = {
        model,
        stream: true,
        store: false,
        // With store:false, encrypted reasoning is the ONLY way a client can
        // replay its reasoning next turn — `include: []` made cross-turn
        // continuity structurally impossible. Codex CLI itself requests exactly
        // this include alongside store:false.
        include: ["reasoning.encrypted_content"],
    };
    const dropped: string[] = [];

    if (Array.isArray(parsed.input)) {
        // Already a Responses body. Inline any item_reference pointers — WHAM
        // has no store to resolve them against (see wham-item-store.ts).
        const resolved = resolveWhamItemReferences(options.itemScope, parsed.input);
        body.input = resolved.input;

        if (resolved.unresolved.length > 0) {
            dropped.push("item_reference");
            logger.warn(
                { unresolved: resolved.unresolved, orphanedOutputs: resolved.orphanedOutputs },
                "ai-proxy: dropped item_reference input items with no stored record (proxy restarted mid-conversation?)"
            );
        }

        if (typeof parsed.instructions === "string") {
            body.instructions = parsed.instructions;
        }

        if (Array.isArray(parsed.tools)) {
            const kept = mapResponsesTools(parsed.tools, dropped);

            if (kept) {
                body.tools = kept;
            }
        } else if (parsed.tools) {
            body.tools = parsed.tools;
        }

        // Forwarded as sent. Dropping them ran every request as "auto": Claude Code's compaction turn needs "none",
        // and a client that turned parallel calls off meant it.
        if (parsed.tool_choice !== undefined) {
            body.tool_choice = parsed.tool_choice;
        }

        if (typeof parsed.parallel_tool_calls === "boolean") {
            body.parallel_tool_calls = parsed.parallel_tool_calls;
        }
    } else {
        const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
        const instructions: string[] = [];
        const rest: unknown[] = [];

        for (const message of messages) {
            if (isObject(message) && (message.role === "system" || message.role === "developer")) {
                instructions.push(extractText(message.content));
                continue;
            }

            rest.push(message);
        }

        body.input = convertMessagesToInput(rest);

        if (instructions.length > 0) {
            body.instructions = instructions.join("\n\n");
        }

        const tools = mapChatToolsToResponses(parsed.tools, dropped);

        if (tools) {
            body.tools = tools;
        }
    }

    // WHAM allowlist probed live 2026-07-19 (Plus plan): max_output_tokens,
    // temperature, top_p, previous_response_id all 400 "Unsupported parameter";
    // store must stay false ("Store must be set to false"). Dropped rather than
    // forwarded — recorded in `dropped` so callers can surface it honestly.
    if (parsed.max_tokens != null || parsed.max_output_tokens != null) {
        dropped.push("max_tokens");
    }

    for (const param of ["temperature", "top_p", "previous_response_id"] as const) {
        if (parsed[param] != null) {
            dropped.push(param);
        }
    }

    if (parsed.store === true) {
        dropped.push("store");
    }

    // A hosted search names the pages it read only when asked (probed on WHAM 2026-10-26); Claude Code lists them.
    if (Array.isArray(body.tools) && body.tools.some((tool) => isObject(tool) && tool.type === "web_search")) {
        body.include = ["reasoning.encrypted_content", "web_search_call.action.sources"];
    }

    const cacheKey = resolveWhamCacheKey(parsed, body, model, options.clientSessionHeader);

    if (cacheKey) {
        body.prompt_cache_key = cacheKey.key;
    }

    if (options.catalog && options.catalog.efforts.length > 0) {
        const effortError = applyCatalogEffort({ parsed, body, model, catalog: options.catalog, options });
        return { body, dropped, effortError, cacheKey };
    }

    if (isObject(parsed.reasoning)) {
        // Pass the client's reasoning through, clamping unknown efforts. The
        // `:max` suffix lands HERE when the client already sent a reasoning
        // object (applyReasoningEffortToBody fills the nested slot), so it
        // needs the same strongest-accepted mapping as the else-branch —
        // clamping it to "low" ran the user's `:max` ask at the WEAKEST effort.
        const reasoning = { ...parsed.reasoning };

        if (reasoning.effort === "max") {
            logger.debug({ model }, "ai-proxy: WHAM has no 'max' effort — using xhigh, the strongest it accepts");
            reasoning.effort = "xhigh";
        }

        if (typeof reasoning.effort === "string" && !WHAM_REASONING_EFFORTS.has(reasoning.effort)) {
            logger.debug({ effort: reasoning.effort }, "ai-proxy: clamped unknown reasoning effort to low");
            reasoning.effort = "low";
        }

        body.reasoning = reasoning;
    } else {
        // A `:<effort>` model-id suffix arrives here as a top-level
        // `reasoning_effort` (applyReasoningEffortToBody only fills
        // `reasoning.effort` when the client already sent that object). Reading
        // it is what makes `account/openai/gpt-5.6-sol:xhigh` actually run at xhigh
        // instead of silently falling back to the account default.
        //
        // `max` is a documented proxy suffix that WHAM does not accept. Dropping
        // it to the account default would make `:max` quieter than `:xhigh`,
        // which is the opposite of what the user asked for, so it maps to the
        // strongest effort WHAM does accept.
        const stamped = typeof parsed.reasoning_effort === "string" ? parsed.reasoning_effort : undefined;
        const requested = stamped === "max" ? "xhigh" : stamped;

        if (stamped === "max") {
            logger.debug({ model }, "ai-proxy: WHAM has no 'max' effort — using xhigh, the strongest it accepts");
        }

        const effort =
            requested && WHAM_REASONING_EFFORTS.has(requested) ? requested : (options.defaultReasoningEffort ?? "low");

        if (effort !== "none") {
            body.reasoning = { effort };
        }
    }

    return { body, dropped, cacheKey };
}

/**
 * The key the client chose (its `prompt_cache_key`, else its session header) wins and is forwarded unchanged. A
 * `/v1/messages` request arrives with Claude Code's session id already stamped as `prompt_cache_key` by the
 * Anthropic translation. Any other client gets a key from the model, the instructions and the first input item,
 * which every later turn of the same conversation repeats.
 */
function resolveWhamCacheKey(
    parsed: Record<string, unknown>,
    body: Record<string, unknown>,
    model: string,
    clientSessionHeader: string | undefined
): PromptCacheKey | undefined {
    const clientKey = typeof parsed.prompt_cache_key === "string" ? parsed.prompt_cache_key : clientSessionHeader;
    const first = Array.isArray(body.input) ? body.input[0] : undefined;

    if (!clientKey && body.instructions === undefined && first === undefined) {
        return undefined;
    }

    return resolvePromptCacheKey({ clientKey, content: { model, system: body.instructions ?? "", first } });
}

/**
 * Effort for a model the catalog knows. The nested `reasoning.effort` wins over a stamped top-level
 * `reasoning_effort` (a `:effort` model-id suffix), as before. With none, the account default applies, then the
 * model's own default (codex-rs sends `default_reasoning_level`), then `low`. Returns the refusal text, if any.
 */
function applyCatalogEffort({
    parsed,
    body,
    model,
    catalog,
    options,
}: {
    parsed: Record<string, unknown>;
    body: Record<string, unknown>;
    model: string;
    catalog: CodexModelInfo;
    options: { defaultReasoningEffort?: "none" | "low" | "medium" | "high" };
}): string | undefined {
    const nested = isObject(parsed.reasoning) ? { ...parsed.reasoning } : undefined;
    const requested =
        nested && typeof nested.effort === "string"
            ? nested.effort
            : typeof parsed.reasoning_effort === "string"
              ? parsed.reasoning_effort
              : undefined;

    if (requested === undefined) {
        const fallback = options.defaultReasoningEffort ?? catalog.defaultEffort ?? "low";

        if (fallback === "none") {
            if (nested) {
                body.reasoning = nested;
            }

            return undefined;
        }

        // A configured default goes through the same check as a requested effort: `ultra` is mapped, and an effort
        // the model lacks is refused here instead of by WHAM.
        const resolvedDefault = resolveCodexEffort(catalog, fallback);

        if (!resolvedDefault.ok) {
            return `${resolvedDefault.message} (the default effort for ${model})`;
        }

        body.reasoning = { ...nested, effort: resolvedDefault.effort };
        return undefined;
    }

    const resolved = resolveCodexEffort(catalog, requested);

    if (!resolved.ok) {
        return resolved.message;
    }

    if (resolved.mappedFrom) {
        logger.debug({ model, from: resolved.mappedFrom, to: resolved.effort }, "ai-proxy: resolved Codex effort");
    }

    body.reasoning = { ...nested, effort: resolved.effort };
    return undefined;
}

export function hasReasoningInput(body: Record<string, unknown>): boolean {
    return Array.isArray(body.input) && body.input.some((item) => isObject(item) && item.type === "reasoning");
}

/** The first 12 hex of a SHA-256: enough to match a blob across turns in a log, nothing of its content. */
export function contentHash(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/**
 * The `reasoning` options of a `/v1/messages` request. A summary shows the model's reasoning as Claude Code
 * thinking text (the default where the model takes the parameter). A Responses Lite model keeps the reasoning of every
 * turn (`context: "all_turns"`), as codex-rs sends it; WHAM accepts it with classic tools (2026-10-25 probe b).
 */
export function reasoningOptions(
    catalog: CodexModelInfo | undefined,
    summary: "none" | "auto" | "detailed" = "auto"
): Record<string, unknown> {
    const reasoning: Record<string, unknown> = {};

    if (summary !== "none" && catalog?.supportsReasoningSummaryParameter !== false) {
        reasoning.summary = summary;
    }

    if (catalog?.useResponsesLite && env.aiProxy.getCodexAllTurns()) {
        reasoning.context = "all_turns";
    }

    return reasoning;
}

function extractText(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }

    if (Array.isArray(content)) {
        return content.map((part) => (isObject(part) && typeof part.text === "string" ? part.text : "")).join("");
    }

    return "";
}
