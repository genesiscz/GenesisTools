/**
 * Client for the local ai-proxy (`tools ai-proxy serve`, OpenAI-compatible,
 * default port 8317 — see src/utils/ui/dashboards.ts WEB_SERVICES).
 *
 * General-purpose: non-stream and SSE streaming chat, tool calls (definition,
 * accumulation across stream deltas, tool-result turns, agentic loop),
 * multi-turn sessions with mid-stream steering (abort + interject), and
 * structured output via OpenAI `response_format: json_schema` with a
 * prompt-injection fallback for providers whose translator drops it.
 *
 * Auth + base URL resolve from ~/.genesis-tools/ai-proxy/config.json
 * (`proxyApiKey`, `port`) with explicit options taking precedence. The client
 * never persists usage or audit data — usage accounting is the proxy server's
 * job (usage/requests.jsonl); this client only surfaces what the server returns.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { repairJson } from "@genesiscz/utils/json/repair";
import { logger } from "@genesiscz/utils/logger";

export interface AiProxyClientOptions {
    baseUrl?: string;
    apiKey?: string;
    /** Default per-request timeout (ms). */
    timeoutMs?: number;
    /** Tags applied to every call this client makes (per-call `tags` merge on top). */
    tags?: RequestTags;
}

export interface ToolCall {
    id: string;
    name: string;
    /** Raw JSON string of arguments as sent by the model. */
    argumentsJson: string;
    /** Parsed arguments (undefined when argumentsJson is invalid JSON). */
    arguments?: unknown;
}

export type ChatMessage =
    | { role: "system" | "user"; content: string }
    | { role: "assistant"; content: string; tool_calls?: OpenAiToolCall[] }
    | { role: "tool"; content: string; tool_call_id: string };

interface OpenAiToolCall {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
}

export interface ToolDefinition {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
}

export interface JsonSchemaSpec {
    name: string;
    schema: Record<string, unknown>;
}

export type SchemaMode = "response_format" | "prompt" | "auto";

/**
 * Job tags forwarded to the proxy as `x-gt-*` headers. The proxy groups
 * transcripts by `session` and records all four on the usage record, which is
 * what makes "which call was the slow one?" answerable after the fact.
 */
export interface RequestTags {
    session?: string;
    stage?: string;
    run?: string;
    label?: string;
}

export interface ChatOptions {
    model: string;
    messages: ChatMessage[];
    maxTokens?: number;
    temperature?: number;
    timeoutMs?: number;
    /** OpenAI reasoning_effort passthrough (e.g. "high" for grok-4.5-high behavior). */
    reasoningEffort?: "low" | "medium" | "high";
    tools?: ToolDefinition[];
    toolChoice?: "auto" | "none" | "required";
    jsonSchema?: JsonSchemaSpec;
    /** Job tags sent as `x-gt-*` headers (session/stage/run/label). */
    tags?: RequestTags;
    /**
     * How to request schema-shaped output. "response_format" = native OpenAI
     * json_schema only; "prompt" = inject schema instructions into the prompt;
     * "auto" (default) = send response_format AND tolerate providers that
     * ignore it by extracting the outermost JSON value from the text.
     */
    schemaMode?: SchemaMode;
    /** Abort mid-request (steering/interject). Composed with the timeout. */
    signal?: AbortSignal;
}

export interface StreamCallbacks {
    onDelta?: (textDelta: string) => void;
    /** Thinking tokens. Fires long before the first content delta on reasoning models. */
    onReasoningDelta?: (reasoningDelta: string) => void;
    onToolCallDelta?: (partial: { index: number; id?: string; name?: string; argumentsDelta?: string }) => void;
}

export interface ChatUsage {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
}

export interface ChatResult {
    text: string;
    toolCalls: ToolCall[];
    finishReason?: string;
    /** Present when jsonSchema was requested and the reply parsed. */
    parsed?: unknown;
    parseError?: string;
    usage?: ChatUsage;
    model: string;
    elapsedMs: number;
    /** True when the request was aborted via options.signal (partial text kept). */
    aborted?: boolean;
    raw: unknown;
}

const CONFIG_PATH = join(homedir(), ".genesis-tools", "ai-proxy", "config.json");
const DEFAULT_PORT = 8317;

interface LocalProxyConfig {
    proxyApiKey?: string;
    port?: number;
}

export function loadLocalProxyConfig(): { baseUrl: string; apiKey?: string } {
    let parsed: LocalProxyConfig = {};

    if (existsSync(CONFIG_PATH)) {
        try {
            parsed = SafeJSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as LocalProxyConfig;
        } catch (err) {
            logger.warn({ path: CONFIG_PATH, error: err }, "ai-proxy config unreadable; using defaults");
        }
    }

    return {
        baseUrl: `http://127.0.0.1:${parsed.port ?? DEFAULT_PORT}/v1`,
        apiKey: parsed.proxyApiKey,
    };
}

/**
 * Extract the outermost JSON value from a text reply: fences/prose stripped,
 * strict parse first, `jsonrepair` as the fallback (src/utils/json/repair).
 */
export function extractJsonValue(text: string): { value?: unknown; error?: string } {
    const { value, error } = repairJson(text);
    return { value, error };
}

function toToolCalls(raw: OpenAiToolCall[] | undefined): ToolCall[] {
    return (raw ?? []).map((tc) => {
        let parsed: unknown;
        try {
            parsed = SafeJSON.parse(tc.function.arguments, { strict: true });
        } catch (err) {
            // Callers still get the raw string; without this line a malformed
            // tool call just shows up as `arguments: undefined` with no trace.
            logger.debug({ err, tool: tc.function.name }, "tool call arguments were not valid JSON");
            parsed = undefined;
        }

        return { id: tc.id, name: tc.function.name, argumentsJson: tc.function.arguments, arguments: parsed };
    });
}

export class AiProxyClient {
    readonly baseUrl: string;
    private readonly apiKey?: string;
    private readonly timeoutMs: number;
    private readonly defaultTags: RequestTags;

    constructor(options: AiProxyClientOptions = {}) {
        const local = options.baseUrl && options.apiKey ? undefined : loadLocalProxyConfig();
        this.baseUrl = (options.baseUrl ?? local?.baseUrl ?? `http://127.0.0.1:${DEFAULT_PORT}/v1`).replace(/\/$/, "");
        this.apiKey = options.apiKey ?? local?.apiKey;
        this.timeoutMs = options.timeoutMs ?? 240_000;
        this.defaultTags = options.tags ?? {};
    }

    private headers(tags?: RequestTags): Record<string, string> {
        // accept-encoding identity: defensive vs stale Content-Encoding relays
        // (root-fixed in the proxy via relayHeaders, 2026-07-24).
        const merged = { ...this.defaultTags, ...tags };
        const tagHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(merged)) {
            if (value) {
                tagHeaders[`x-gt-${key}`] = value;
            }
        }

        return {
            "content-type": "application/json",
            "accept-encoding": "identity",
            ...tagHeaders,
            ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        };
    }

    private composeSignal(options: ChatOptions): AbortSignal {
        const timeout = AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs);
        return options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    }

    private buildBody(options: ChatOptions, stream: boolean): Record<string, unknown> {
        const schemaMode = options.schemaMode ?? "auto";
        const messages = [...options.messages];

        if (options.jsonSchema && schemaMode === "prompt") {
            const instruction =
                `Respond ONLY with a JSON value valid against this JSON Schema (no prose, no code fences):\n` +
                SafeJSON.stringify(options.jsonSchema.schema, { strict: true });
            const last = messages.at(-1);
            if (last?.role === "user") {
                messages[messages.length - 1] = { role: "user", content: `${last.content}\n\n${instruction}` };
            } else {
                messages.push({ role: "user", content: instruction });
            }
        }

        const body: Record<string, unknown> = { model: options.model, messages, stream };

        if (stream) {
            // ask upstreams that support it to emit usage in the final chunk
            body.stream_options = { include_usage: true };
        }

        if (options.maxTokens !== undefined) {
            body.max_tokens = options.maxTokens;
        }

        if (options.temperature !== undefined) {
            body.temperature = options.temperature;
        }

        if (options.reasoningEffort) {
            body.reasoning_effort = options.reasoningEffort;
        }

        if (options.tools?.length) {
            body.tools = options.tools.map((t) => ({
                type: "function",
                function: { name: t.name, description: t.description, parameters: t.parameters },
            }));
            if (options.toolChoice) {
                body.tool_choice = options.toolChoice;
            }
        }

        if (options.jsonSchema && (schemaMode === "response_format" || schemaMode === "auto")) {
            body.response_format = {
                type: "json_schema",
                json_schema: { name: options.jsonSchema.name, strict: true, schema: options.jsonSchema.schema },
            };
        }

        return body;
    }

    private finalize(options: ChatOptions, result: ChatResult): ChatResult {
        if (options.jsonSchema && !result.toolCalls.length) {
            const { value, error } = extractJsonValue(result.text);
            result.parsed = value;
            result.parseError = error;
        }

        logger.debug(
            {
                model: options.model,
                elapsedMs: result.elapsedMs,
                usage: result.usage,
                toolCalls: result.toolCalls.length,
                finishReason: result.finishReason,
                parseError: result.parseError,
                aborted: result.aborted,
            },
            "ai-proxy chat completed"
        );
        return result;
    }

    async health(): Promise<boolean> {
        try {
            const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
            return res.ok;
        } catch (err) {
            logger.debug({ err, baseUrl: this.baseUrl }, "ai-proxy health check failed");
            return false;
        }
    }

    async models(): Promise<string[]> {
        const res = await fetch(`${this.baseUrl}/models`, {
            headers: this.headers(),
            signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
            throw new Error(`GET /models failed: ${res.status} ${await res.text()}`);
        }

        const body = SafeJSON.parse(await res.text(), { strict: true }) as { data?: { id?: string }[] };
        return (body.data ?? []).map((m) => m.id ?? "").filter(Boolean);
    }

    /** Non-streaming completion. */
    async chat(options: ChatOptions): Promise<ChatResult> {
        const started = performance.now();
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
            method: "POST",
            headers: this.headers(options.tags),
            body: SafeJSON.stringify(this.buildBody(options, false), { strict: true }),
            signal: this.composeSignal(options),
        });
        const elapsedMs = Math.round(performance.now() - started);

        const rawText = await res.text();
        if (!res.ok) {
            throw new Error(`POST /chat/completions ${res.status} (model=${options.model}): ${rawText.slice(0, 500)}`);
        }

        let raw: {
            choices?: { message?: { content?: string; tool_calls?: OpenAiToolCall[] }; finish_reason?: string }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
            model?: string;
        };
        try {
            raw = SafeJSON.parse(rawText, { strict: true });
        } catch {
            throw new Error(`ai-proxy returned unparseable body (model=${options.model}): ${rawText.slice(0, 300)}`);
        }

        const choice = raw.choices?.[0];
        return this.finalize(options, {
            text: choice?.message?.content ?? "",
            toolCalls: toToolCalls(choice?.message?.tool_calls),
            finishReason: choice?.finish_reason,
            model: raw.model ?? options.model,
            elapsedMs,
            usage: raw.usage
                ? {
                      promptTokens: raw.usage.prompt_tokens,
                      completionTokens: raw.usage.completion_tokens,
                      totalTokens: raw.usage.total_tokens,
                  }
                : undefined,
            raw,
        });
    }

    /**
     * Streaming completion (SSE). Accumulates content and tool-call fragments
     * across deltas; delivers text deltas via callbacks. An abort through
     * options.signal returns the partial result with `aborted: true` instead of
     * throwing — that is the steering/interject path.
     */
    async chatStream(options: ChatOptions, callbacks: StreamCallbacks = {}): Promise<ChatResult> {
        const started = performance.now();
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
            method: "POST",
            headers: { ...this.headers(options.tags), accept: "text/event-stream" },
            body: SafeJSON.stringify(this.buildBody(options, true), { strict: true }),
            signal: this.composeSignal(options),
        });

        if (!res.ok || !res.body) {
            const text = await res.text().catch(() => "");
            throw new Error(`POST /chat/completions ${res.status} (model=${options.model}): ${text.slice(0, 500)}`);
        }

        let text = "";
        let finishReason: string | undefined;
        let usage: ChatUsage | undefined;
        let model = options.model;
        let aborted = false;
        const toolAcc = new Map<number, { id?: string; name?: string; args: string }>();
        const chunks: unknown[] = [];

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        try {
            while (true) {
                const { done, value } = await reader.read();

                // On the last read, flush the decoder and terminate a tail frame
                // that arrived without its trailing newline. Providers routinely
                // end with the usage / finish_reason chunk unterminated, and
                // breaking out here dropped both.
                buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
                if (done && buffer.length > 0 && !buffer.endsWith("\n")) {
                    buffer += "\n";
                }

                let nl = buffer.indexOf("\n");
                while (nl !== -1) {
                    const line = buffer.slice(0, nl).trim();
                    buffer = buffer.slice(nl + 1);
                    nl = buffer.indexOf("\n");

                    if (!line.startsWith("data:")) {
                        continue;
                    }

                    const payload = line.slice(5).trim();
                    if (!payload || payload === "[DONE]") {
                        continue;
                    }

                    let chunk: {
                        model?: string;
                        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
                        choices?: {
                            delta?: {
                                content?: string;
                                // A reasoning model streams these for minutes before its
                                // first content token; providers disagree on the name.
                                reasoning_content?: string;
                                reasoning?: string;
                                thinking?: string;
                                tool_calls?: {
                                    index?: number;
                                    id?: string;
                                    function?: { name?: string; arguments?: string };
                                }[];
                            };
                            finish_reason?: string | null;
                        }[];
                    };
                    try {
                        chunk = SafeJSON.parse(payload, { strict: true });
                    } catch (err) {
                        logger.debug({ payload: payload.slice(0, 200), error: err }, "unparseable SSE chunk skipped");
                        continue;
                    }

                    chunks.push(chunk);
                    model = chunk.model ?? model;

                    if (chunk.usage) {
                        usage = {
                            promptTokens: chunk.usage.prompt_tokens,
                            completionTokens: chunk.usage.completion_tokens,
                            totalTokens: chunk.usage.total_tokens,
                        };
                    }

                    const choice = chunk.choices?.[0];
                    if (!choice) {
                        continue;
                    }

                    if (choice.finish_reason) {
                        finishReason = choice.finish_reason;
                    }

                    const delta = choice.delta;
                    if (delta?.content) {
                        text += delta.content;
                        callbacks.onDelta?.(delta.content);
                    }

                    // Reasoning is progress. Callers that time out on silence were
                    // abandoning calls that were streaming thinking tokens the whole
                    // time — grok spent >90s reasoning about a 5KB prompt and the
                    // watchdog, which only ever saw content deltas, killed a healthy
                    // stream (observed 2026-07-25, reproduced deterministically).
                    const reasoning = delta?.reasoning_content ?? delta?.reasoning ?? delta?.thinking;
                    if (reasoning) {
                        callbacks.onReasoningDelta?.(reasoning);
                    }

                    for (const tc of delta?.tool_calls ?? []) {
                        const index = tc.index ?? 0;
                        const acc = toolAcc.get(index) ?? { args: "" };
                        acc.id = tc.id ?? acc.id;
                        acc.name = tc.function?.name ?? acc.name;
                        if (tc.function?.arguments) {
                            acc.args += tc.function.arguments;
                        }

                        toolAcc.set(index, acc);
                        callbacks.onToolCallDelta?.({
                            index,
                            id: tc.id,
                            name: tc.function?.name,
                            argumentsDelta: tc.function?.arguments,
                        });
                    }
                }

                if (done) {
                    break;
                }
            }
        } catch (err) {
            if (options.signal?.aborted) {
                aborted = true;
                logger.debug({ model: options.model }, "stream aborted by caller (steering)");
            } else {
                throw err;
            }
        } finally {
            reader.releaseLock();
        }

        const toolCalls = [...toolAcc.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, acc]) => {
                let parsed: unknown;
                try {
                    parsed = SafeJSON.parse(acc.args, { strict: true });
                } catch {
                    parsed = undefined;
                }

                return { id: acc.id ?? "", name: acc.name ?? "", argumentsJson: acc.args, arguments: parsed };
            });

        return this.finalize(options, {
            text,
            toolCalls,
            finishReason,
            model,
            elapsedMs: Math.round(performance.now() - started),
            usage,
            aborted,
            raw: chunks,
        });
    }

    /** Multi-turn conversation container (client-side history; the proxy is stateless). */
    session(model: string, system?: string): AiProxySession {
        return new AiProxySession(this, model, system);
    }
}

export type ToolHandler = (call: ToolCall) => Promise<string> | string;

export class AiProxySession {
    readonly messages: ChatMessage[] = [];
    private inflight?: AbortController;

    constructor(
        private readonly client: AiProxyClient,
        private readonly model: string,
        system?: string
    ) {
        if (system) {
            this.messages.push({ role: "system", content: system });
        }
    }

    /** True while a streamed turn is running (interject() can steer it). */
    get busy(): boolean {
        return this.inflight !== undefined;
    }

    /**
     * Send a user turn. With callbacks, streams; without, plain completion.
     * The assistant reply (including tool_calls) is appended to history.
     */
    async send(
        content: string,
        options: Omit<ChatOptions, "model" | "messages" | "signal"> = {},
        callbacks?: StreamCallbacks
    ): Promise<ChatResult> {
        this.messages.push({ role: "user", content });
        return this.complete(options, callbacks);
    }

    /** Provide a tool result for a previous assistant tool_call, then continue the turn. */
    async toolResult(
        call: ToolCall,
        result: string,
        options: Omit<ChatOptions, "model" | "messages" | "signal"> = {},
        callbacks?: StreamCallbacks
    ): Promise<ChatResult> {
        this.messages.push({ role: "tool", content: result, tool_call_id: call.id });
        return this.complete(options, callbacks);
    }

    /**
     * Steering: abort the in-flight streamed turn (its partial text stays in
     * history, marked aborted) and immediately send a new user message.
     */
    async interject(
        content: string,
        options: Omit<ChatOptions, "model" | "messages" | "signal"> = {},
        callbacks?: StreamCallbacks
    ): Promise<ChatResult> {
        this.inflight?.abort();
        return this.send(content, options, callbacks);
    }

    /**
     * Agentic loop: send a user turn, execute every requested tool via
     * `handler`, feed results back, repeat until the model stops calling tools
     * (or maxRounds). Returns the final result.
     */
    async runTools(
        content: string,
        handler: ToolHandler,
        options: Omit<ChatOptions, "model" | "messages" | "signal"> & { maxRounds?: number },
        callbacks?: StreamCallbacks
    ): Promise<ChatResult> {
        const { maxRounds = 8, ...chatOptions } = options;
        let result = await this.send(content, chatOptions, callbacks);

        for (let round = 0; round < maxRounds && result.toolCalls.length; round++) {
            for (const call of result.toolCalls) {
                const output = await handler(call);
                this.messages.push({ role: "tool", content: output, tool_call_id: call.id });
            }

            result = await this.complete(chatOptions, callbacks);
        }

        return result;
    }

    private async complete(
        options: Omit<ChatOptions, "model" | "messages" | "signal">,
        callbacks?: StreamCallbacks
    ): Promise<ChatResult> {
        this.inflight?.abort();
        const controller = new AbortController();
        this.inflight = controller;

        try {
            const chatOptions: ChatOptions = {
                ...options,
                model: this.model,
                messages: this.messages,
                signal: controller.signal,
            };
            const result = callbacks
                ? await this.client.chatStream(chatOptions, callbacks)
                : await this.client.chat(chatOptions);

            this.messages.push({
                role: "assistant",
                content: result.text,
                tool_calls: result.toolCalls.length
                    ? result.toolCalls.map((tc) => ({
                          id: tc.id,
                          type: "function" as const,
                          function: { name: tc.name, arguments: tc.argumentsJson },
                      }))
                    : undefined,
            });
            return result;
        } finally {
            if (this.inflight === controller) {
                this.inflight = undefined;
            }
        }
    }
}
