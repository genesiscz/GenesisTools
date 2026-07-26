/**
 * SSE keepalive. A reasoning model can go many seconds — sometimes minutes —
 * without emitting a token while it thinks. To the socket that is an idle
 * connection, and `Bun.serve`'s `idleTimeout` will close it (observed
 * 2026-07-24: judge calls dying with ECONNRESET at ~120s, which the pipeline
 * then reported as "JSON drift" because the reply arrived empty).
 *
 * Injecting SSE comment frames (`: keepalive`) while upstream is quiet keeps the
 * connection alive. Comment frames carry no data and every SSE client ignores
 * them, so this is invisible to callers.
 */
import { logger } from "@genesiscz/utils/logger";

const KEEPALIVE_FRAME = ": keepalive\n\n";

/**
 * Wrap an event-stream response so that a gap longer than `everyMs` emits a
 * comment frame. Non-streaming responses are returned untouched.
 */
export function withSseKeepalive(response: Response, everyMs = 15_000): Response {
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.body || !contentType.includes("text/event-stream")) {
        return response;
    }

    const reader = response.body.getReader();
    const encoder = new TextEncoder();
    let lastWrite = Date.now();
    let timer: ReturnType<typeof setInterval> | undefined;

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            timer = setInterval(
                () => {
                    if (Date.now() - lastWrite < everyMs) {
                        return;
                    }

                    try {
                        controller.enqueue(encoder.encode(KEEPALIVE_FRAME));
                        lastWrite = Date.now();
                    } catch (err) {
                        logger.debug({ err }, "ai-proxy: keepalive enqueue failed (stream already closed)");
                    }
                },
                Math.max(1_000, Math.floor(everyMs / 2))
            );

            void (async () => {
                try {
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) {
                            break;
                        }

                        lastWrite = Date.now();
                        controller.enqueue(value);
                    }

                    controller.close();
                } catch (err) {
                    controller.error(err);
                } finally {
                    clearInterval(timer);
                }
            })();
        },
        cancel(reason) {
            clearInterval(timer);
            void reader.cancel(reason);
        },
    });

    return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    });
}
