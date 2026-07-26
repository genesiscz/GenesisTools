import { type CallTimeline, TimelineCollector } from "@app/ai-proxy/lib/usage/call-timeline";

export interface CapturedResponse {
    response: Response;
    responseBody: Promise<string>;
    /** Phase timings observed while the body streamed through. */
    timeline: Promise<CallTimeline>;
    /** Resolves to a reason when capture gave up on a stream that never ended. */
    captureFailure: Promise<string | undefined>;
}

/**
 * Give up on a stream that has sent nothing for this long.
 *
 * An upstream that answers 200 at the header and then never emits a frame (and
 * never closes) left the capture promise PENDING FOREVER, so the usage row was
 * never written and `tools ai-proxy calls` could not see the call at all —
 * observed 2026-07-25 on claude-sub/opus-5, where the client gave up at 90s and
 * the proxy kept holding an invisible request. 120s is generous: the same model
 * answers a 24k-token prompt in 3s.
 */
const CAPTURE_IDLE_MS = 120_000;

async function readStreamToText(
    stream: ReadableStream<Uint8Array>,
    collector: TimelineCollector,
    onIdle: (reason: string) => void
): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";

    while (true) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const idle = new Promise<"idle">((resolve) => {
            timer = setTimeout(() => resolve("idle"), CAPTURE_IDLE_MS);
        });

        const next = await Promise.race([reader.read(), idle]);
        clearTimeout(timer);

        if (next === "idle") {
            onIdle(`upstream sent nothing for ${CAPTURE_IDLE_MS}ms and never closed the stream`);
            await reader.cancel().catch(() => {
                // the stream is already broken; nothing to salvage
            });
            break;
        }

        if (next.done) {
            break;
        }

        const chunk = decoder.decode(next.value, { stream: true });
        text += chunk;
        collector.push(chunk);
    }

    const tail = decoder.decode();
    if (tail) {
        text += tail;
        collector.push(tail);
    }

    return text;
}

/**
 * Tee the upstream body: the client gets one branch untouched, we read the other
 * to capture the full text and time each phase of the turn.
 *
 * `startedAt` is a `performance.now()` taken when the proxy received the request,
 * so every timeline number is relative to that single anchor.
 */
export function captureResponseBody(response: Response, startedAt = performance.now()): CapturedResponse {
    const collector = new TimelineCollector(startedAt);
    collector.markUpstreamHeaders();

    if (!response.body) {
        return {
            response,
            responseBody: Promise.resolve(""),
            timeline: Promise.resolve(collector.finish()),
            captureFailure: Promise.resolve(undefined),
        };
    }

    let idleReason: string | undefined;
    const [clientStream, captureStream] = response.body.tee();
    const responseBody = readStreamToText(captureStream, collector, (reason) => {
        idleReason = reason;
    });

    return {
        response: new Response(clientStream, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        }),
        responseBody,
        // Resolve the timeline even when the body capture fails: a stream that was
        // reset or abandoned still produced real phase timings, and those are the
        // most interesting ones to keep.
        timeline: responseBody.then(
            () => collector.finish(),
            () => collector.finish()
        ),
        captureFailure: responseBody.then(
            () => idleReason,
            (err) => (err instanceof Error ? err.message : String(err))
        ),
    };
}
