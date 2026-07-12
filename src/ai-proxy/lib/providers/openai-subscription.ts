import { accountConfigFingerprint } from "@app/ai-proxy/lib/account-config";
import { convertMessagesToInput } from "@app/ai-proxy/lib/chat-to-responses-body";
import { OPENAI_SUB_MODELS, resolveOpenAiSubModel } from "@app/ai-proxy/lib/providers/openai-sub-models";
import { resolveOpenAiSubToken } from "@app/ai-proxy/lib/providers/openai-sub-token";
import type { OpenAiModel, ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import { responsesToChat } from "@app/ai-proxy/lib/translators/responses-to-chat";
import type { AiProxyAccountConfig, UsageSummary } from "@app/ai-proxy/lib/types";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { isObject } from "@app/utils/object";

const WHAM_RESPONSES_URL = "https://chatgpt.com/backend-api/wham/responses";

/**
 * Bills the owner's ChatGPT/Codex subscription. The ChatGPT WHAM backend speaks
 * the OpenAI Responses API (streaming-only), so `responses()` converts an
 * incoming chat- or responses-shaped body into a WHAM Responses request and
 * forwards it; `chatCompletions()` delegates to the shared `responsesToChat`
 * translator (which calls `responses()` and maps the Responses output back to
 * chat.completion / chat.completion.chunk).
 */
export class OpenAiSubscriptionProvider implements ProxyProvider {
    readonly id = "openai-subscription";
    readonly accountFingerprint: string;
    private readonly account: AiProxyAccountConfig;

    constructor(account: AiProxyAccountConfig) {
        this.account = account;
        this.accountFingerprint = accountConfigFingerprint(account);
    }

    static async create(account: AiProxyAccountConfig): Promise<OpenAiSubscriptionProvider> {
        return new OpenAiSubscriptionProvider(account);
    }

    async listModels(): Promise<OpenAiModel[]> {
        return OPENAI_SUB_MODELS.map((id) => ({
            id: `${this.account.name}/${this.account.providerSlug}/${id}`,
            object: "model",
            created: 1_740_960_000,
            owned_by: "openai",
            description: `${id} via ChatGPT/Codex subscription`,
        }));
    }

    async chatCompletions(req: Request, model: string, bodyText: string): Promise<Response> {
        const proxyModel = `${this.account.name}/${this.account.providerSlug}/${model}`;
        const { response } = await responsesToChat({ provider: this, upstreamModel: model, proxyModel, req, bodyText });
        return response;
    }

    async responses(req: Request, model: string, bodyText: string): Promise<Response> {
        const concreteModel = resolveOpenAiSubModel(model);

        let parsed: Record<string, unknown>;
        try {
            const parsedBody = SafeJSON.parse(bodyText, { strict: true });
            if (!isObject(parsedBody)) {
                return jsonError(400, "Invalid JSON body");
            }

            parsed = parsedBody;
        } catch (err) {
            logger.debug({ err }, "ai-proxy: openai-subscription got invalid JSON body");
            return jsonError(400, "Invalid JSON body");
        }

        const wantStream = parsed.stream === true;
        const whamBody = buildWhamResponsesBody(parsed, concreteModel);

        let token: string;
        let accountId: string | undefined;
        try {
            ({ token, accountId } = await resolveOpenAiSubToken(this.account));
        } catch (err) {
            logger.warn({ err, account: this.account.name }, "ai-proxy: openai-subscription token resolution failed");
            return jsonError(
                502,
                `Codex subscription token unavailable: ${err instanceof Error ? err.message : String(err)}`
            );
        }

        const started = performance.now();
        const upstream = await fetch(WHAM_RESPONSES_URL, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "chatgpt-account-id": accountId ?? "",
                "Content-Type": "application/json",
                "OpenAI-Beta": "responses=experimental",
                originator: "codex_cli_rs",
                session_id: crypto.randomUUID(),
                Accept: "text/event-stream",
            },
            body: SafeJSON.stringify(whamBody),
            signal: req.signal,
        });

        const elapsedMs = Math.round(performance.now() - started);

        if (!upstream.ok) {
            const errorText = await upstream.text();
            logger.warn(
                {
                    account: this.account.name,
                    model: concreteModel,
                    status: upstream.status,
                    elapsedMs,
                    body: errorText.slice(0, 500),
                },
                "ai-proxy: WHAM upstream request failed"
            );

            return new Response(errorText, {
                status: upstream.status,
                headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
            });
        }

        logger.debug(
            { account: this.account.name, model: concreteModel, wantStream, elapsedMs },
            "ai-proxy: WHAM upstream request ok"
        );

        if (!upstream.body) {
            return jsonError(502, "WHAM upstream returned no body");
        }

        if (wantStream) {
            return new Response(upstream.body, {
                status: 200,
                headers: {
                    "Content-Type": "text/event-stream; charset=utf-8",
                    "Cache-Control": "no-cache",
                    Connection: "keep-alive",
                },
            });
        }

        // Non-streaming caller: WHAM only streams, so accumulate the SSE into a
        // Responses JSON. The final `response.completed` event carries empty
        // output on WHAM, so text is reassembled from output_text deltas.
        const responsesJson = await accumulateResponsesJson(upstream.body);

        return new Response(responsesJson, {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    }

    async getUsage(): Promise<UsageSummary> {
        return {
            accountName: this.account.name,
            provider: "openai-subscription",
            summary: "subscription (usage not exposed by the ChatGPT backend)",
        };
    }
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

function mapChatToolsToResponses(tools: unknown): unknown[] | undefined {
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
            mapped.push(tool);
            continue;
        }

        const fn = isObject(tool.function) ? tool.function : undefined;

        if (fn && typeof fn.name === "string") {
            mapped.push({
                type: "function",
                name: fn.name,
                description: typeof fn.description === "string" ? fn.description : undefined,
                parameters: fn.parameters ?? { type: "object", properties: {} },
            });
        }
    }

    return mapped.length > 0 ? mapped : undefined;
}

/** Convert a chat- or responses-shaped body into a WHAM Responses request. */
export function buildWhamResponsesBody(parsed: Record<string, unknown>, model: string): Record<string, unknown> {
    const body: Record<string, unknown> = {
        model,
        stream: true,
        store: false,
        include: [],
    };

    if (Array.isArray(parsed.input)) {
        // Already a Responses body.
        body.input = parsed.input;

        if (typeof parsed.instructions === "string") {
            body.instructions = parsed.instructions;
        }

        if (parsed.tools) {
            body.tools = parsed.tools;
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

        const tools = mapChatToolsToResponses(parsed.tools);

        if (tools) {
            body.tools = tools;
        }
    }

    const maxOutput = typeof parsed.max_output_tokens === "number" ? parsed.max_output_tokens : parsed.max_tokens;

    if (typeof maxOutput === "number") {
        body.max_output_tokens = maxOutput;
    }

    if (isObject(parsed.reasoning)) {
        body.reasoning = parsed.reasoning;
    } else {
        body.reasoning = { effort: "low" };
    }

    return body;
}

async function accumulateResponsesJson(stream: ReadableStream<Uint8Array>): Promise<string> {
    const raw = await new Response(stream).text();
    let text = "";
    const functionCalls: unknown[] = [];
    let completed: Record<string, unknown> = {};

    for (const line of raw.split("\n")) {
        const trimmed = line.trimStart();

        if (!trimmed.startsWith("data:")) {
            continue;
        }

        const payload = trimmed.slice("data:".length).trim();

        if (payload.length === 0 || payload === "[DONE]") {
            continue;
        }

        let event: unknown;
        try {
            event = SafeJSON.parse(payload, { strict: true });
        } catch (err) {
            logger.debug({ err, payload }, "ai-proxy: WHAM SSE line parse failed");
            continue;
        }

        if (!isObject(event)) {
            continue;
        }

        if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
            text += event.delta;
            continue;
        }

        if (event.type === "response.output_item.done" && isObject(event.item) && event.item.type === "function_call") {
            functionCalls.push(event.item);
            continue;
        }

        if (event.type === "response.completed" && isObject(event.response)) {
            completed = event.response;
        }
    }

    const output: unknown[] = [];

    if (text.length > 0) {
        output.push({
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
        });
    }

    output.push(...functionCalls);

    return SafeJSON.stringify({ ...completed, object: "response", output });
}

function jsonError(status: number, message: string): Response {
    return new Response(SafeJSON.stringify({ error: { message } }), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}
