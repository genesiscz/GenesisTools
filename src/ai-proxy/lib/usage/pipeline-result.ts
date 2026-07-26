import { withSseKeepalive } from "@app/ai-proxy/lib/sse-keepalive";
import type { CallTimeline } from "@app/ai-proxy/lib/usage/call-timeline";
import { captureResponseBody } from "@app/ai-proxy/lib/usage/capture-response";

export interface PipelineResult {
    response: Response;
    responseBody: Promise<string>;
    /** Phase timings for the turn; absent when nobody timed the bytes. */
    timeline?: Promise<CallTimeline>;
    /** Why the capture gave up, when the upstream stream never ended. */
    captureFailure?: Promise<string | undefined>;
}

/**
 * `timeline` is for callers that own the stream themselves (the translators build
 * their outbound frames, so they time those); without it a supplied body would
 * leave the usage row with headers-only `elapsedMs` and no phase breakdown.
 */
export function pipelineResult(
    response: Response,
    responseBody?: Promise<string> | string,
    startedAt?: number,
    timeline?: Promise<CallTimeline>
): PipelineResult {
    if (responseBody !== undefined) {
        return {
            response,
            responseBody: typeof responseBody === "string" ? Promise.resolve(responseBody) : responseBody,
            timeline,
        };
    }

    const captured = captureResponseBody(response, startedAt);

    return {
        // keepalive on the client-facing branch only; the capture branch is ours
        response: withSseKeepalive(captured.response),
        responseBody: captured.responseBody,
        timeline: captured.timeline,
        captureFailure: captured.captureFailure,
    };
}
