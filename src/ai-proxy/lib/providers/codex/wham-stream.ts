import { randomUUID } from "node:crypto";
import { mapWhamError } from "@app/ai-proxy/lib/providers/wham-errors";
import { rememberWhamOutputItem } from "@app/ai-proxy/lib/providers/wham-item-store";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";

/** Read a compaction stream with the same 120-second idle limit as response capture. */
export async function readCompactionText(response: Response, idleMs = 120_000): Promise<string> {
    if (!response.body) {
        return "";
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";

    try {
        while (true) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const idle = new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error("Compaction upstream stream timed out.")), idleMs);
            });
            let chunk: Awaited<ReturnType<typeof reader.read>>;

            try {
                chunk = await Promise.race([reader.read(), idle]);
            } finally {
                clearTimeout(timer);
            }

            if (chunk.done) {
                return text + decoder.decode();
            }

            text += decoder.decode(chunk.value, { stream: true });
        }
    } catch (error) {
        // An upstream that already failed rejects cancel() with the same error; the throw below reports it once.
        await reader.cancel(error).catch(() => undefined);
        throw error;
    }
}
/**
 * The stream unchanged, and `onUsage` with the `response.completed` usage when it passes by. Only lines that carry
 * that event are parsed, so the cost stays a substring check per chunk.
 */
export function tapCompletedUsage(
    body: ReadableStream<Uint8Array>,
    onUsage: (usage: Record<string, unknown>) => void
): ReadableStream<Uint8Array> {
    const decoder = new TextDecoder();
    let pending = "";
    let done = false;

    const scan = (text: string) => {
        pending += text;
        let newline = pending.indexOf("\n");

        while (newline >= 0) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            newline = pending.indexOf("\n");

            if (done || !line.startsWith("data: ") || !line.includes('"response.completed"')) {
                continue;
            }

            try {
                const event: unknown = SafeJSON.parse(line.slice("data: ".length), { strict: true });

                if (isObject(event) && isObject(event.response) && isObject(event.response.usage)) {
                    done = true;
                    onUsage(event.response.usage);
                }
            } catch (error) {
                logger.debug({ error }, "ai-proxy: could not read a response.completed frame for its usage");
            }
        }
    };

    return body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                controller.enqueue(chunk);
                scan(decoder.decode(chunk, { stream: true }));
            },
            flush() {
                scan(`${decoder.decode()}\n`);
            },
        })
    );
}
const SSE_LINE_END = /\r\n|\r|\n/;

/**
 * Decode complete SSE frames while retaining only the unfinished frame between reads. A line ends
 * at CRLF, LF or a lone CR, as the SSE grammar allows; a CR that ends a read waits for the next
 * read, which may carry its LF.
 */
export async function* whamSsePayloads(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let data: string[] = [];
    try {
        while (true) {
            const chunk = await reader.read();
            pending += decoder.decode(chunk.value, { stream: !chunk.done });
            let end = SSE_LINE_END.exec(pending);
            while (end && !(end[0] === "\r" && end.index === pending.length - 1 && !chunk.done)) {
                const line = pending.slice(0, end.index);
                pending = pending.slice(end.index + end[0].length);
                if (line === "") {
                    if (data.length > 0) {
                        yield data.join("\n");
                        data = [];
                    }
                } else if (line.startsWith("data:")) {
                    data.push(line.slice(5).replace(/^ /, ""));
                }
                end = SSE_LINE_END.exec(pending);
            }
            if (chunk.done) {
                return;
            }
        }
    } finally {
        try {
            await reader.cancel();
        } finally {
            reader.releaseLock();
        }
    }
}

export async function accumulateResponsesJson(
    stream: ReadableStream<Uint8Array>,
    itemScope: string
): Promise<{ failed: false; body: string } | { failed: true; error: string; errorCode?: string }> {
    let text = "";
    const functionCalls: unknown[] = [];
    const reasoningItems: unknown[] = [];
    // A hosted web search: its calls (query and sources) and the answer's url_citation annotations.
    const searchCalls: unknown[] = [];
    const annotations: unknown[] = [];
    let completed: Record<string, unknown> | undefined;
    let failure: string | undefined;
    let failureCode: string | undefined;

    for await (const payload of whamSsePayloads(stream)) {
        if (payload.length === 0 || payload === "[DONE]") {
            continue;
        }

        let event: unknown;
        try {
            event = SafeJSON.parse(payload, { strict: true });
        } catch (err) {
            logger.debug({ err }, "ai-proxy: WHAM SSE event parse failed");
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

        if (
            event.type === "response.output_item.done" &&
            isObject(event.item) &&
            event.item.type === "web_search_call"
        ) {
            searchCalls.push(event.item);
            continue;
        }

        if (event.type === "response.output_text.annotation.added" && isObject(event.annotation)) {
            annotations.push(event.annotation);
            continue;
        }

        // Reasoning items (summary + encrypted_content) are what a Responses
        // client replays next turn. The rebuild dropped them, so a non-streaming
        // caller could never continue its own reasoning.
        if (event.type === "response.output_item.done" && isObject(event.item) && event.item.type === "reasoning") {
            reasoningItems.push(event.item);
            continue;
        }

        if (event.type === "response.completed" && isObject(event.response) && event.response.status === "completed") {
            completed = event.response;
            continue;
        }

        if (event.type === "response.incomplete") {
            failure = "WHAM response.incomplete";
        }

        if (event.type === "response.failed") {
            const response = isObject(event.response) ? event.response : undefined;
            const error = response && isObject(response.error) ? response.error : undefined;
            failure = error && typeof error.message === "string" ? error.message : "WHAM response.failed";
            failureCode = error && typeof error.code === "string" ? error.code : undefined;
        }
    }

    if (failure) {
        return { failed: true, error: failure, errorCode: failureCode };
    }

    if (!completed) {
        return { failed: true, error: "WHAM stream ended before response.completed" };
    }

    const output: unknown[] = [];

    for (const item of reasoningItems) {
        if (isObject(item) && typeof item.id !== "string") {
            output.push({ ...item, id: `rs_${randomUUID().replace(/-/g, "")}` });
            continue;
        }

        output.push(item);
    }

    output.push(...searchCalls);

    if (text.length > 0) {
        // Responses API clients (Vercel AI SDK) require an id on every output item; WHAM omits it.
        output.push({
            id: `msg_${randomUUID().replace(/-/g, "")}`,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations }],
        });
    }

    for (const call of functionCalls) {
        if (isObject(call) && typeof call.id !== "string") {
            output.push({ ...call, id: `fc_${randomUUID().replace(/-/g, "")}` });
            continue;
        }

        output.push(call);
    }

    for (const item of output) {
        // Responses clients chain the next turn by item_reference id; the proxy
        // is the store those references resolve against.
        rememberWhamOutputItem(itemScope, item);
    }

    return { failed: false, body: SafeJSON.stringify({ ...completed, object: "response", output }) };
}

export function jsonError(status: number, message: string): Response {
    return new Response(SafeJSON.stringify({ error: { message } }), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

/** OpenAI-shaped error response for a failed WHAM request that is not about the account. */
export function whamErrorResponse({ status, bodyText }: { status: number; bodyText: string }): Response {
    return new Response(SafeJSON.stringify(mapWhamError({ status, bodyText })), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}
