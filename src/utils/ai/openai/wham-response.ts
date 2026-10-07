import { randomUUID } from "node:crypto";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { jsonSchema, parseJsonEventStream } from "ai";

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_ITEMS = 1024;

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** WHAM may omit item ids; an id, when present, must still be a string. */
function isOutputItem(value: unknown): value is Record<string, unknown> {
    return (
        isObject(value) && typeof value.type === "string" && (value.id === undefined || typeof value.id === "string")
    );
}

const SYNTHETIC_ID_PREFIX: Record<string, string> = { message: "msg", reasoning: "rs", function_call: "fc" };

/** Responses clients (the Vercel AI SDK) require an id on every output item; WHAM omits some. */
function withItemId(item: Record<string, unknown>): Record<string, unknown> {
    if (typeof item.id === "string") {
        return item;
    }

    const prefix = SYNTHETIC_ID_PREFIX[String(item.type)] ?? "item";
    return { ...item, id: `${prefix}_${randomUUID().replace(/-/g, "")}` };
}

/** A custom fetch or stream must not turn a caller's cancellation into an unbounded wait. */
export async function awaitWhamOperation<T>({
    operation,
    signal,
}: {
    operation: Promise<T>;
    signal: AbortSignal;
}): Promise<T> {
    let onAbort = () => {};
    const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);

        if (signal.aborted) {
            onAbort();
        } else {
            signal.addEventListener("abort", onAbort, { once: true });
        }
    });

    try {
        const result = await Promise.race([operation, aborted]);
        signal.throwIfAborted();
        return result;
    } finally {
        signal.removeEventListener("abort", onAbort);
    }
}

/** WHAM may omit all output from its terminal envelope; completed items are authoritative too. */
export async function collectWhamResponse({
    response,
    signal,
    onProgress,
}: {
    response: Response;
    signal: AbortSignal;
    /** Called for every received chunk; the caller's idle deadline restarts on it. */
    onProgress?: () => void;
}): Promise<Response> {
    if (!response.body) {
        throw new Error("OpenAI subscription returned an empty event stream");
    }

    let bytes = 0;
    let eventCount = 0;
    const bounded = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                bytes += chunk.byteLength;
                onProgress?.();

                if (bytes > MAX_RESPONSE_BYTES) {
                    throw new Error("OpenAI subscription event stream exceeds the 16 MiB limit");
                }

                controller.enqueue(chunk);
            },
        })
    );
    const reader = parseJsonEventStream({ stream: bounded, schema: jsonSchema<unknown>({}) }).getReader();
    const items = new Map<number, Record<string, unknown>>();
    const observedIndices = new Set<number>();
    let responseId: string | undefined;

    try {
        while (true) {
            const next = await awaitWhamOperation({ operation: reader.read(), signal });

            if (next.done) {
                throw new Error("OpenAI subscription stream ended without a completed response");
            }

            eventCount++;

            if (!next.value.success || !isObject(next.value.value) || typeof next.value.value.type !== "string") {
                // Parser errors contain raw response text; never attach them to diagnostics.
                throw new Error("OpenAI subscription returned a malformed response event");
            }

            const event = next.value.value;

            if (event.type === "error" || event.type === "response.failed" || event.type === "response.incomplete") {
                throw new Error("OpenAI subscription response failed or was incomplete");
            }

            if (isObject(event.response) && typeof event.response.id === "string") {
                if (responseId !== undefined && responseId !== event.response.id) {
                    throw new Error("OpenAI subscription stream changed response identity");
                }

                responseId = event.response.id;
            }

            if (event.output_index !== undefined) {
                const index = event.output_index;

                if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= MAX_OUTPUT_ITEMS) {
                    throw new Error("OpenAI subscription returned an invalid output index");
                }

                observedIndices.add(index);

                if (event.type === "response.output_item.done") {
                    const item = event.item;

                    if (!isOutputItem(item)) {
                        throw new Error("OpenAI subscription returned an invalid completed output item");
                    }

                    const previous = items.get(index);

                    if (previous && SafeJSON.stringify(previous) !== SafeJSON.stringify(item)) {
                        throw new Error("OpenAI subscription returned conflicting completed output items");
                    }

                    items.set(index, item);
                }
            } else if (event.type === "response.output_item.done") {
                throw new Error("OpenAI subscription completed output item is missing its index");
            }

            if (event.type !== "response.completed") {
                continue;
            }

            const terminal = event.response;

            if (!isObject(terminal) || terminal.status !== "completed" || terminal.error != null) {
                throw new Error("OpenAI subscription terminal response was not completed");
            }

            const terminalOutput = terminal.output ?? [];

            if (!Array.isArray(terminalOutput) || terminalOutput.length > MAX_OUTPUT_ITEMS) {
                throw new Error("OpenAI subscription returned invalid terminal output");
            }

            for (const [index, item] of terminalOutput.entries()) {
                if (!isOutputItem(item)) {
                    throw new Error("OpenAI subscription returned an invalid terminal output item");
                }

                const previous = items.get(index);
                const bothIds = typeof previous?.id === "string" && typeof item.id === "string";

                if (previous && (previous.type !== item.type || (bothIds && previous.id !== item.id))) {
                    throw new Error("OpenAI subscription terminal output changed item identity");
                }

                items.set(
                    index,
                    typeof item.id !== "string" && typeof previous?.id === "string"
                        ? { ...item, id: previous.id }
                        : item
                );
            }

            const output: Record<string, unknown>[] = [];

            const lastIndex = Math.max(-1, ...observedIndices, ...items.keys());

            for (let index = 0; index <= lastIndex; index++) {
                const item = items.get(index);

                if (!item) {
                    throw new Error("OpenAI subscription response is missing a completed output item");
                }

                output.push(withItemId(item));
            }

            const headers = new Headers(response.headers);

            for (const name of ["content-length", "content-encoding", "transfer-encoding", "connection"]) {
                headers.delete(name);
            }

            headers.set("content-type", "application/json");
            logger.debug(
                { bytes, eventCount, outputItems: output.length },
                "Collected subscription response for JSON caller"
            );
            return new Response(SafeJSON.stringify({ ...terminal, output }), {
                status: response.status,
                statusText: response.statusText,
                headers,
            });
        }
    } finally {
        // Cancellation can itself wait on a broken underlying source. Release locally without awaiting it.
        void reader.cancel().catch(() => logger.debug("Subscription response reader cancellation failed"));
        reader.releaseLock();
    }
}

/** Some successful WHAM streams omit Content-Type. Peek through a cancellable, bounded clone. */
export async function isWhamEventStream({
    response,
    signal,
    onProgress,
}: {
    response: Response;
    signal: AbortSignal;
    /** Called for every inspected chunk; the caller's idle deadline restarts on it. */
    onProgress?: () => void;
}): Promise<boolean> {
    const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();

    if (contentType === "text/event-stream") {
        return true;
    }

    if (contentType === "application/json" || contentType?.endsWith("+json") || !response.body) {
        return false;
    }

    const reader = response.clone().body!.getReader();
    const decoder = new TextDecoder();
    let prefix = "";
    let inspected = 0;

    try {
        while (inspected < 8192) {
            const next = await awaitWhamOperation({ operation: reader.read(), signal });

            if (next.done) {
                return false;
            }

            onProgress?.();
            const chunk = next.value.subarray(0, 8192 - inspected);
            inspected += chunk.length;
            prefix += decoder.decode(chunk, { stream: true });
            const leading = prefix.trimStart();

            if (/^(?:data|event|id|retry):|^:/.test(leading)) {
                return true;
            }

            if (leading && !["data:", "event:", "id:", "retry:"].some((field) => field.startsWith(leading))) {
                return false;
            }
        }

        return false;
    } finally {
        void reader.cancel().catch(() => logger.debug("Subscription prefix reader cancellation failed"));
        reader.releaseLock();

        if (signal.aborted) {
            void response.body.cancel().catch(() => logger.debug("Aborted subscription response cancellation failed"));
        }
    }
}
