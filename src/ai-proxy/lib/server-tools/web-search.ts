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

/** The server tool entry, when the body offers Anthropic's web_search. */
export function parseWebSearchServerTool(body: Record<string, unknown>): WebSearchServerTool | undefined {
    if (!Array.isArray(body.tools)) {
        return undefined;
    }

    for (const tool of body.tools) {
        if (isObject(tool) && typeof tool.type === "string" && tool.type.startsWith("web_search_")) {
            return {
                name: typeof tool.name === "string" ? tool.name : "web_search",
                maxUses: typeof tool.max_uses === "number" && tool.max_uses > 0 ? tool.max_uses : 8,
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
export function domainAllowed(url: string, allowed?: string[], blocked?: string[]): boolean {
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

    if (blocked?.some(matches)) {
        return false;
    }

    return allowed === undefined || allowed.some(matches);
}

export function braveSearchFn(apiKey: string): SearchFn {
    return async (query: string): Promise<WebSearchResult[]> => {
        const params = new URLSearchParams({
            q: query,
            count: "8",
            text_decorations: "false",
            result_filter: "web",
        });
        const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
            headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
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
}): Promise<EmulationOutcome | Response> {
    const { body, tool, search, callUpstream } = options;
    const messages = Array.isArray(body.messages) ? [...body.messages] : [];
    const tools = (Array.isArray(body.tools) ? body.tools : []).map((t) =>
        isObject(t) && typeof t.type === "string" && t.type.startsWith("web_search_") ? customSearchTool(tool) : t
    );

    let searches = 0;
    let outputTokens = 0;
    // One turn past max_uses so the model can conclude after the limit answer.
    const maxTurns = tool.maxUses + 2;

    for (let turn = 0; turn < maxTurns; turn++) {
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
                        domainAllowed(r.url, tool.allowedDomains, tool.blockedDomains)
                    );
                    resultText = formatResults(results);
                } catch (err) {
                    logger.warn({ err, query }, "ai-proxy: emulated web_search failed");
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
export function buildResponsesWebSearchBody(
    body: Record<string, unknown>,
    tool: WebSearchServerTool
): Record<string, unknown> {
    const instructions = systemText(body.system);
    const wsTool: Record<string, unknown> = { type: "web_search" };

    // Both `allowed_domains` (xAI docs spelling) and `filters.allowed_domains`
    // returned 200 and kept every source on-domain in live probes; the
    // unfiltered control hit off-domain sources. Unknown keys are silently
    // ignored by the deserializer, so a wrong spelling would mean NO filter.
    if (tool.allowedDomains !== undefined) {
        wsTool.allowed_domains = tool.allowedDomains;
    }

    if (tool.blockedDomains !== undefined) {
        wsTool.excluded_domains = tool.blockedDomains;
    }

    const out: Record<string, unknown> = {
        model: body.model,
        input: messagesToResponsesInput(body.messages),
        tools: [wsTool],
        stream: false,
    };

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
            id: typeof response.id === "string" ? response.id : undefined,
            type: "message",
            role: "assistant",
            model: typeof response.model === "string" ? response.model : undefined,
            content,
            stop_reason: "end_turn",
            usage: {
                input_tokens: usageNumber(usage, "input_tokens"),
                output_tokens: usageNumber(usage, "output_tokens"),
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
    return responsesToAnthropicMessage(parsed);
}

const PING_INTERVAL_MS = 10_000;

/**
 * Stream that answers the client immediately (Anthropic keeps quiet
 * connections alive with pings) while the loop runs, then plays the final
 * message. A slow multi-search loop otherwise looks like a dead connection.
 */
export function emulationStream(run: () => Promise<EmulationOutcome | Response>): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();

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
                const outcome = await run();

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
                controller.close();
            }
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
