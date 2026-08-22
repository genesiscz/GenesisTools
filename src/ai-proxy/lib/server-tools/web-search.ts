import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";

/**
 * Emulation of Anthropic's `web_search_20250305` server tool for upstreams
 * that cannot run it (grok). Anthropic executes the search inside its API
 * during sampling; here the proxy plays that part: the server tool is
 * rewritten into a custom tool, the upstream's tool calls are answered with
 * Brave results, and only the final turn is returned to the client.
 */

export interface WebSearchServerTool {
    name: string;
    maxUses: number;
    allowedDomains?: string[];
    blockedDomains?: string[];
}

export interface WebSearchResult {
    title: string;
    url: string;
    snippet: string;
}

export type SearchFn = (query: string) => Promise<WebSearchResult[]>;

/** Server-side cap: max_uses is client-controlled and each search is a paid call. */
const MAX_USES_CEILING = 20;

/** The server tool entry, when the body offers Anthropic's web_search. */
export function parseWebSearchServerTool(body: Record<string, unknown>): WebSearchServerTool | undefined {
    if (!Array.isArray(body.tools)) {
        return undefined;
    }

    for (const tool of body.tools) {
        if (isObject(tool) && typeof tool.type === "string" && tool.type.startsWith("web_search_")) {
            const requested = tool.max_uses;
            const maxUses =
                typeof requested === "number" && Number.isInteger(requested) && requested > 0
                    ? Math.min(requested, MAX_USES_CEILING)
                    : 8;

            return {
                name: typeof tool.name === "string" ? tool.name : "web_search",
                maxUses,
                allowedDomains: stringArray(tool.allowed_domains),
                blockedDomains: stringArray(tool.blocked_domains),
            };
        }
    }

    return undefined;
}

function stringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const strings = value.filter((v): v is string => typeof v === "string");
    return strings.length > 0 ? strings : undefined;
}

/** Suffix match per Anthropic's domain filters: `github.com` covers `gist.github.com`. */
export function domainAllowed(url: string, filters: { allowed?: string[]; blocked?: string[] }): boolean {
    let host: string;
    try {
        host = new URL(url).hostname.toLowerCase();
    } catch {
        return false;
    }

    const matches = (domain: string): boolean => {
        const d = domain.toLowerCase();
        return host === d || host.endsWith(`.${d}`);
    };

    if (filters.blocked?.some(matches)) {
        return false;
    }

    return filters.allowed === undefined || filters.allowed.some(matches);
}

/** A Brave call that never answers would stall the loop behind SSE pings forever. */
const BRAVE_TIMEOUT_MS = 15_000;

export function braveSearchFn(apiKey: string, signal?: AbortSignal): SearchFn {
    return async (query: string): Promise<WebSearchResult[]> => {
        const params = new URLSearchParams({
            q: query,
            count: "8",
            text_decorations: "false",
            result_filter: "web",
        });
        const timeout = AbortSignal.timeout(BRAVE_TIMEOUT_MS);
        const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
            headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
            signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
        });

        if (!response.ok) {
            throw new Error(`Brave Search API error: ${response.status} ${await response.text().catch(() => "")}`);
        }

        const data = (await response.json()) as { web?: { results?: unknown[] } };
        return (data.web?.results ?? []).flatMap((result) => {
            if (!isObject(result) || typeof result.url !== "string") {
                return [];
            }

            return [
                {
                    title: typeof result.title === "string" ? result.title : "",
                    url: result.url,
                    snippet: typeof result.description === "string" ? result.description : "",
                },
            ];
        });
    };
}

function formatResults(results: WebSearchResult[]): string {
    if (results.length === 0) {
        return "No search results found.";
    }

    return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
}

/** The custom tool the upstream actually sees in place of the server tool. */
function customSearchTool(tool: WebSearchServerTool): Record<string, unknown> {
    return {
        name: tool.name,
        description:
            "Search the web. Returns numbered results with title, URL and snippet. Use the results to answer; cite URLs.",
        input_schema: {
            type: "object",
            properties: { query: { type: "string", description: "The search query" } },
            required: ["query"],
        },
    };
}

interface AnthropicMessage {
    content?: unknown[];
    stop_reason?: string;
    usage?: Record<string, unknown>;
    model?: string;
    [key: string]: unknown;
}

export interface EmulationOutcome {
    message: AnthropicMessage;
    searches: number;
}

/**
 * Run the search loop against a non-streaming upstream. `callUpstream`
 * receives a complete Anthropic body (stream:false) and returns the upstream
 * Response; a non-OK response aborts the loop and is returned as-is for the
 * caller's error envelope to handle.
 */
export async function emulateWebSearch(options: {
    body: Record<string, unknown>;
    tool: WebSearchServerTool;
    search: SearchFn;
    callUpstream: (body: Record<string, unknown>) => Promise<Response>;
    /** Aborted when the client goes away — stops the loop between calls. */
    signal?: AbortSignal;
}): Promise<EmulationOutcome | Response> {
    const { body, tool, search, callUpstream, signal } = options;
    const messages = Array.isArray(body.messages) ? [...body.messages] : [];
    const tools = (Array.isArray(body.tools) ? body.tools : []).map((t) =>
        isObject(t) && typeof t.type === "string" && t.type.startsWith("web_search_") ? customSearchTool(tool) : t
    );

    let searches = 0;
    let outputTokens = 0;
    // One turn past max_uses so the model can conclude after the limit answer.
    const maxTurns = tool.maxUses + 2;

    for (let turn = 0; turn < maxTurns; turn++) {
        if (signal?.aborted) {
            throw new DOMException("web_search emulation aborted — client went away", "AbortError");
        }

        const upstreamBody = { ...body, stream: false, messages, tools };
        const response = await callUpstream(upstreamBody);

        if (!response.ok) {
            return response;
        }

        const message = (await response.json()) as AnthropicMessage;
        const content = Array.isArray(message.content) ? message.content : [];
        outputTokens += usageNumber(message.usage, "output_tokens");

        const calls = content.filter(
            (block): block is Record<string, unknown> =>
                isObject(block) && block.type === "tool_use" && block.name === tool.name
        );

        if (calls.length === 0 || message.stop_reason !== "tool_use") {
            return {
                message: { ...message, usage: { ...message.usage, output_tokens: outputTokens } },
                searches,
            };
        }

        const toolResults: Record<string, unknown>[] = [];
        for (const call of calls) {
            const query = isObject(call.input) && typeof call.input.query === "string" ? call.input.query : "";
            let resultText: string;

            if (searches >= tool.maxUses) {
                resultText = `Web search limit reached (max_uses=${tool.maxUses}). Answer from the results you already have.`;
            } else if (query.length === 0) {
                resultText = "Invalid search call: input.query must be a non-empty string.";
            } else {
                searches += 1;
                try {
                    const results = (await search(query)).filter((r) =>
                        domainAllowed(r.url, { allowed: tool.allowedDomains, blocked: tool.blockedDomains })
                    );
                    resultText = formatResults(results);
                } catch (err) {
                    // The query is model-generated request material — log its
                    // size, never its content (it can carry prompts/secrets).
                    logger.warn({ err, queryLength: query.length }, "ai-proxy: emulated web_search failed");
                    resultText = `Search failed: ${err instanceof Error ? err.message : String(err)}`;
                }
            }

            toolResults.push({ type: "tool_result", tool_use_id: call.id, content: resultText });
        }

        messages.push({ role: "assistant", content }, { role: "user", content: toolResults });
    }

    // The hard cap tripped: the model never stopped calling. Fail loudly.
    return new Response(
        SafeJSON.stringify({
            type: "error",
            error: {
                type: "api_error",
                message: `Emulated web_search did not converge within ${maxTurns} turns.`,
            },
        }),
        { status: 502, headers: { "Content-Type": "application/json" } }
    );
}

function usageNumber(usage: unknown, key: string): number {
    return isObject(usage) && typeof usage[key] === "number" ? usage[key] : 0;
}

/**
 * A complete Anthropic message as a spec-shaped SSE body. Used when the
 * client asked to stream but the emulation loop produced a full message.
 */
export function messageToAnthropicSse(message: AnthropicMessage): string {
    const frames: string[] = [];
    const usage = isObject(message.usage) ? message.usage : {};
    const emit = (type: string, data: Record<string, unknown>): void => {
        frames.push(`event: ${type}\ndata: ${SafeJSON.stringify({ type, ...data })}`);
    };

    emit("message_start", {
        message: {
            id: message.id ?? `msg_${crypto.randomUUID()}`,
            type: "message",
            role: "assistant",
            model: message.model ?? "",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { ...usage, output_tokens: 0 },
        },
    });

    const content = Array.isArray(message.content) ? message.content : [];
    content.forEach((block, index) => {
        if (!isObject(block)) {
            return;
        }

        if (block.type === "text" && typeof block.text === "string") {
            emit("content_block_start", { index, content_block: { type: "text", text: "" } });
            emit("content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
            emit("content_block_start", { index, content_block: { type: "thinking", thinking: "" } });
            emit("content_block_delta", { index, delta: { type: "thinking_delta", thinking: block.thinking } });
            emit("content_block_delta", {
                index,
                delta: {
                    type: "signature_delta",
                    signature: typeof block.signature === "string" ? block.signature : "",
                },
            });
        } else if (block.type === "tool_use") {
            emit("content_block_start", {
                index,
                content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
            });
            emit("content_block_delta", {
                index,
                delta: { type: "input_json_delta", partial_json: SafeJSON.stringify(block.input ?? {}) ?? "{}" },
            });
        } else {
            emit("content_block_start", { index, content_block: block });
        }

        emit("content_block_stop", { index });
    });

    emit("message_delta", {
        delta: { stop_reason: message.stop_reason ?? "end_turn", stop_sequence: null },
        usage: { output_tokens: usageNumber(usage, "output_tokens") },
    });
    emit("message_stop", {});

    return `${frames.join("\n\n")}\n\n`;
}

/**
 * xAI's /responses endpoint runs web search SERVER-SIDE: `tools:
 * [{type:"web_search"}]` made the upstream itself execute searches and
 * open_page fetches (usage reported `num_server_side_tools_used: 7`), with
 * url_citation annotations. Verified live 2026-08-20 against
 * cli-chat-proxy.grok.com. This is the native path for Anthropic's
 * web_search server tool; the Brave loop above is the fallback.
 */
const MAX_FILTER_DOMAINS = 5;

/**
 * Why the native path would lose part of the request, or undefined when it
 * carries it faithfully. The /responses translation below sends text only and
 * the web_search tool only, so a body offering client-executed tools or
 * carrying tool_use / tool_result / image blocks must take the Brave loop,
 * which keeps the original Anthropic body intact. Dropping them silently
 * would answer a search using context the model never saw.
 */
export function nativeTranslationLoss(body: Record<string, unknown>, tool?: WebSearchServerTool): string | undefined {
    // Domain filters the upstream cannot express. It takes ONE list of at most
    // five domains, so a request pairing an allow-list with exclusions, or
    // excluding more than five domains, would come back with sources it asked
    // to avoid. Slicing an over-long ALLOW list only tightens the request, so
    // that case stays on the native path.
    if (tool?.allowedDomains !== undefined && tool.blockedDomains !== undefined) {
        return "both allowed_domains and blocked_domains";
    }

    if ((tool?.blockedDomains?.length ?? 0) > MAX_FILTER_DOMAINS) {
        return `${tool?.blockedDomains?.length} blocked_domains (the upstream takes ${MAX_FILTER_DOMAINS})`;
    }

    const custom = Array.isArray(body.tools)
        ? body.tools.filter((tool) => isObject(tool) && (tool.type === undefined || tool.type === "custom")).length
        : 0;

    if (custom > 0) {
        return `${custom} client tool${custom === 1 ? "" : "s"}`;
    }

    const kinds = new Set<string>();

    for (const message of Array.isArray(body.messages) ? body.messages : []) {
        if (!isObject(message) || !Array.isArray(message.content)) {
            continue;
        }

        for (const block of message.content) {
            if (isObject(block) && typeof block.type === "string" && typeof block.text !== "string") {
                kinds.add(block.type);
            }
        }
    }

    return kinds.size > 0 ? `${[...kinds].sort().join(", ")} content blocks` : undefined;
}

export function buildResponsesWebSearchBody(
    body: Record<string, unknown>,
    tool: WebSearchServerTool
): Record<string, unknown> {
    const instructions = systemText(body.system);
    const wsTool: Record<string, unknown> = { type: "web_search" };

    // max_uses is deliberately NOT sent: the upstream decides how many
    // searches to run and offers no cap. Probed live 2026-08-20 —
    // `max_tool_calls: 1` was accepted (HTTP 200) and ignored, the reply still
    // carried 9 web_search_call items against the uncapped control's 10. Only
    // the Brave loop can honour max_uses; here it bounds nothing, so
    // nativeWebSearch logs when the upstream exceeds what the client asked.

    // Official spellings per docs.x.ai/developers/tools/web-search (verified
    // live: filtered probes stayed on-domain, the control did not). The docs
    // add two constraints: max 5 domains per list, and the lists cannot be
    // combined. Allowed wins when both are present — clamping an allow-list
    // only tightens it, while dropping exclusions would loosen a filter.
    if (tool.allowedDomains !== undefined) {
        if (tool.allowedDomains.length > MAX_FILTER_DOMAINS) {
            logger.debug(
                { count: tool.allowedDomains.length },
                "ai-proxy: web_search allowed_domains clamped to the upstream max of 5"
            );
        }

        wsTool.allowed_domains = tool.allowedDomains.slice(0, MAX_FILTER_DOMAINS);
    } else if (tool.blockedDomains !== undefined) {
        if (tool.blockedDomains.length > MAX_FILTER_DOMAINS) {
            logger.warn(
                { count: tool.blockedDomains.length },
                "ai-proxy: web_search excluded_domains clamped to 5 — exclusions beyond that are NOT enforced upstream"
            );
        }

        wsTool.excluded_domains = tool.blockedDomains.slice(0, MAX_FILTER_DOMAINS);
    }

    // tool_choice `none` forbids tool calls. Offering the server tool anyway
    // would run a billed search the caller explicitly ruled out, so the turn
    // goes up with no tools at all.
    const forbidden = isObject(body.tool_choice) && body.tool_choice.type === "none";
    const out: Record<string, unknown> = {
        model: body.model,
        input: messagesToResponsesInput(body.messages),
        tools: forbidden ? [] : [wsTool],
        stream: false,
    };

    if (forbidden) {
        logger.debug({}, "ai-proxy: web_search offered with tool_choice none — answering without searching");
    }

    // `any` and `tool` naming this tool both mean "you must call it". The
    // upstream defaults to auto, which may skip the only offered tool.
    const mandatory =
        isObject(body.tool_choice) &&
        (body.tool_choice.type === "any" || (body.tool_choice.type === "tool" && body.tool_choice.name === tool.name));

    if (mandatory) {
        out.tool_choice = "required";
    }

    // The caller's output cap, in the name /responses uses. Forwarded because
    // it is the caller's stated limit, but do NOT rely on it here: probed live
    // 2026-08-20, three runs per arm, same prompt and max_output_tokens of 48.
    // With NO tools every run came back "incomplete" (reason
    // max_output_tokens); with the web_search tool every run came back
    // "completed" at 5.4k-6.2k output tokens. The upstream drops the cap once
    // a server tool is in play, exactly like max_tool_calls above.
    if (typeof body.max_tokens === "number") {
        out.max_output_tokens = body.max_tokens;
    }

    if (instructions.length > 0) {
        out.instructions = instructions;
    }

    return out;
}

function systemText(system: unknown): string {
    if (typeof system === "string") {
        return system;
    }

    if (!Array.isArray(system)) {
        return "";
    }

    return system
        .flatMap((block) => (isObject(block) && typeof block.text === "string" ? [block.text] : []))
        .join("\n");
}

function messagesToResponsesInput(messages: unknown): { role: string; content: string }[] {
    if (!Array.isArray(messages)) {
        return [];
    }

    return messages.flatMap((message) => {
        if (!isObject(message) || typeof message.role !== "string") {
            return [];
        }

        const content = message.content;

        if (typeof content === "string") {
            return [{ role: message.role, content }];
        }

        if (!Array.isArray(content)) {
            return [];
        }

        const text = content
            .flatMap((block) => (isObject(block) && typeof block.text === "string" ? [block.text] : []))
            .join("\n");
        return text.length > 0 ? [{ role: message.role, content: text }] : [];
    });
}

function truncatedByCap(response: Record<string, unknown>): boolean {
    if (response.status !== "incomplete") {
        return false;
    }

    const details = response.incomplete_details;
    return isObject(details) && details.reason === "max_output_tokens";
}

/** The completed /responses JSON as an Anthropic message, citations appended. */
export function responsesToAnthropicMessage(response: Record<string, unknown>): EmulationOutcome {
    let text = "";
    let thinking = "";
    let searches = 0;
    const citations = new Set<string>();

    for (const item of Array.isArray(response.output) ? response.output : []) {
        if (!isObject(item)) {
            continue;
        }

        if (item.type === "web_search_call") {
            searches += 1;
        } else if (item.type === "reasoning" && Array.isArray(item.summary)) {
            for (const part of item.summary) {
                if (isObject(part) && typeof part.text === "string") {
                    thinking += part.text;
                }
            }
        } else if (item.type === "message" && Array.isArray(item.content)) {
            for (const part of item.content) {
                if (!isObject(part) || typeof part.text !== "string") {
                    continue;
                }

                text += part.text;

                for (const ann of Array.isArray(part.annotations) ? part.annotations : []) {
                    if (isObject(ann) && ann.type === "url_citation" && typeof ann.url === "string") {
                        citations.add(ann.url);
                    }
                }
            }
        }
    }

    if (citations.size > 0) {
        text += `\n\nSources:\n${[...citations].map((url) => `- ${url}`).join("\n")}`;
    }

    const usage = isObject(response.usage) ? response.usage : {};
    const content: Record<string, unknown>[] = [];

    if (thinking.length > 0) {
        content.push({ type: "thinking", thinking, signature: "" });
    }

    content.push({ type: "text", text });

    return {
        message: {
            // Anthropic SDKs read id and model as required; SafeJSON drops
            // undefined keys, so the non-streaming path must not leave holes.
            id: typeof response.id === "string" ? response.id : `msg_${crypto.randomUUID()}`,
            type: "message",
            role: "assistant",
            model: typeof response.model === "string" ? response.model : "",
            content,
            // A reply cut short by the output cap must not read as a finished
            // one. Verified live 2026-08-20: the upstream honours
            // max_output_tokens by answering status "incomplete" with
            // incomplete_details.reason "max_output_tokens".
            stop_reason: truncatedByCap(response) ? "max_tokens" : "end_turn",
            usage: {
                input_tokens: usageNumber(usage, "input_tokens"),
                output_tokens: usageNumber(usage, "output_tokens"),
                // What the upstream actually spent. max_uses cannot bound it
                // (see buildResponsesWebSearchBody), so the caller at least
                // sees the count in the field Anthropic reports it in.
                server_tool_use: { web_search_requests: searches },
            },
        },
        searches,
    };
}

/** Native path: one /responses call, the upstream does all the searching. */
export async function nativeWebSearch(options: {
    body: Record<string, unknown>;
    tool: WebSearchServerTool;
    callResponses: (body: Record<string, unknown>) => Promise<Response>;
}): Promise<EmulationOutcome | Response> {
    const response = await options.callResponses(buildResponsesWebSearchBody(options.body, options.tool));

    if (!response.ok) {
        return response;
    }

    const parsed = (await response.json()) as Record<string, unknown>;
    const outcome = responsesToAnthropicMessage(parsed);

    if (outcome.searches > options.tool.maxUses) {
        logger.warn(
            { searches: outcome.searches, maxUses: options.tool.maxUses },
            "ai-proxy: native web_search ran more searches than max_uses — the upstream enforces no cap, each search is billed"
        );
    }

    return outcome;
}

const PING_INTERVAL_MS = 10_000;

/**
 * Stream that answers the client immediately (Anthropic keeps quiet
 * connections alive with pings) while the loop runs, then plays the final
 * message. A slow multi-search loop otherwise looks like a dead connection.
 * The signal handed to `run` aborts when the client cancels the stream, so
 * the loop stops burning upstream and Brave calls nobody will receive.
 */
export function emulationStream(
    run: (signal: AbortSignal) => Promise<EmulationOutcome | Response>
): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const abort = new AbortController();

    return new ReadableStream<Uint8Array>({
        async start(controller) {
            const ping = setInterval(() => {
                try {
                    controller.enqueue(encoder.encode('event: ping\ndata: {"type":"ping"}\n\n'));
                } catch (err) {
                    logger.debug({ err }, "ai-proxy: web_search emulation ping enqueue failed (stream closed)");
                    clearInterval(ping);
                }
            }, PING_INTERVAL_MS);

            try {
                const outcome = await run(abort.signal);

                if (abort.signal.aborted) {
                    return;
                }

                if (outcome instanceof Response) {
                    const text = await outcome.text();
                    controller.enqueue(
                        encoder.encode(
                            `event: error\ndata: ${SafeJSON.stringify(anthropicErrorPayload(text, outcome.status))}\n\n`
                        )
                    );
                } else {
                    controller.enqueue(encoder.encode(messageToAnthropicSse(outcome.message)));
                }
            } catch (err) {
                if (abort.signal.aborted) {
                    logger.debug({ err }, "ai-proxy: web_search emulation aborted by client cancel");
                    return;
                }

                logger.warn({ err }, "ai-proxy: web_search emulation failed mid-stream");
                controller.enqueue(
                    encoder.encode(
                        `event: error\ndata: ${SafeJSON.stringify({
                            type: "error",
                            error: { type: "api_error", message: err instanceof Error ? err.message : String(err) },
                        })}\n\n`
                    )
                );
            } finally {
                clearInterval(ping);

                if (!abort.signal.aborted) {
                    controller.close();
                }
            }
        },
        cancel(reason) {
            abort.abort(reason);
        },
    });
}

function anthropicErrorPayload(text: string, status: number): Record<string, unknown> {
    try {
        const parsed = SafeJSON.parse(text, { strict: true });

        if (isObject(parsed) && parsed.type === "error") {
            return parsed;
        }

        if (isObject(parsed) && isObject(parsed.error) && typeof parsed.error.message === "string") {
            return { type: "error", error: { type: "api_error", message: parsed.error.message } };
        }
    } catch (err) {
        logger.debug({ err }, "ai-proxy: web_search emulation upstream error body was not JSON");
    }

    return { type: "error", error: { type: "api_error", message: `Upstream ${status}: ${text.slice(0, 300)}` } };
}
