/**
 * Per-call timeline. Every phase of one proxied turn is timed at the point the
 * bytes actually move, so "the call took 48s" becomes answerable: was the proxy
 * slow to dispatch, was upstream slow to respond at all (TTFB), did the model
 * spend the time thinking, or did it stream an enormous answer slowly?
 *
 * All numbers are milliseconds relative to the moment the proxy received the
 * request, so they can be read as a sequence without any further arithmetic.
 */
import { SafeJSON } from "@genesiscz/utils/json";

export interface CallTimeline {
    /** Proxy received the client request (always 0; the anchor for the rest). */
    receivedMs: number;
    /** Upstream response headers arrived — dispatch + queue + model warm-up. */
    upstreamHeadersMs?: number;
    /** First byte of the response body (TTFB measured from receipt). */
    firstByteMs?: number;
    /** First token of visible reasoning, and the last one. */
    firstThinkingMs?: number;
    lastThinkingMs?: number;
    thinkingChars?: number;
    /** First token of the answer text, and the last one. */
    firstTextMs?: number;
    lastTextMs?: number;
    textChars?: number;
    /** Tool calls seen in the stream, each with the time it first appeared. */
    toolCalls?: { name?: string; atMs: number }[];
    /** Stream finished (or the whole body was read for a non-streamed reply). */
    completedMs?: number;
    /** Time spent thinking, i.e. last thinking token minus first. */
    thinkingMs?: number;
    /** Time spent producing the answer text. */
    textMs?: number;
}

interface StreamDelta {
    content?: string;
    reasoning_content?: string;
    reasoning?: string;
    thinking?: string;
    tool_calls?: { function?: { name?: string } }[];
}

/**
 * Feed raw SSE (or plain-JSON) chunk text in as it arrives; the collector marks
 * the first/last time each kind of content appeared.
 */
export class TimelineCollector {
    private readonly timeline: CallTimeline = { receivedMs: 0 };
    private carry = "";

    constructor(private readonly startedAt: number) {}

    private now(): number {
        return Math.round(performance.now() - this.startedAt);
    }

    markUpstreamHeaders(): void {
        this.timeline.upstreamHeadersMs ??= this.now();
    }

    /** Called for every decoded chunk of the response body. */
    push(chunk: string): void {
        this.timeline.firstByteMs ??= this.now();
        this.carry += chunk;

        const lines = this.carry.split("\n");
        this.carry = lines.pop() ?? "";

        for (const line of lines) {
            if (!line.startsWith("data:")) {
                continue;
            }

            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") {
                continue;
            }

            this.consumeFrame(data);
        }
    }

    private consumeFrame(data: string): void {
        let delta: StreamDelta | undefined;
        try {
            const payload = SafeJSON.parse(data, { strict: true }) as { choices?: { delta?: StreamDelta }[] };
            delta = payload.choices?.[0]?.delta;
        } catch {
            return; // partial or non-JSON frame — timing only needs the ones that parse
        }

        if (!delta) {
            return;
        }

        const at = this.now();
        const thinking = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
        if (thinking) {
            this.timeline.firstThinkingMs ??= at;
            this.timeline.lastThinkingMs = at;
            this.timeline.thinkingChars = (this.timeline.thinkingChars ?? 0) + thinking.length;
        }

        if (delta.content) {
            this.timeline.firstTextMs ??= at;
            this.timeline.lastTextMs = at;
            this.timeline.textChars = (this.timeline.textChars ?? 0) + delta.content.length;
        }

        for (const call of delta.tool_calls ?? []) {
            this.timeline.toolCalls = [...(this.timeline.toolCalls ?? []), { name: call.function?.name, atMs: at }];
        }
    }

    /** Close the timeline and derive the span durations. */
    finish(): CallTimeline {
        this.timeline.completedMs = this.now();

        if (this.timeline.firstThinkingMs !== undefined && this.timeline.lastThinkingMs !== undefined) {
            this.timeline.thinkingMs = this.timeline.lastThinkingMs - this.timeline.firstThinkingMs;
        }

        if (this.timeline.firstTextMs !== undefined && this.timeline.lastTextMs !== undefined) {
            this.timeline.textMs = this.timeline.lastTextMs - this.timeline.firstTextMs;
        }

        return this.timeline;
    }
}

/** One-line human summary, e.g. for `tools ai-proxy calls`. */
export function formatTimeline(timeline: CallTimeline): string {
    const parts = [
        timeline.upstreamHeadersMs !== undefined ? `dispatch ${timeline.upstreamHeadersMs}ms` : undefined,
        timeline.firstByteMs !== undefined ? `ttfb ${timeline.firstByteMs}ms` : undefined,
        timeline.firstThinkingMs !== undefined
            ? `thinking ${timeline.firstThinkingMs}→${timeline.lastThinkingMs}ms (${timeline.thinkingChars ?? 0} chars)`
            : undefined,
        timeline.firstTextMs !== undefined
            ? `text ${timeline.firstTextMs}→${timeline.lastTextMs}ms (${timeline.textChars ?? 0} chars)`
            : undefined,
        timeline.toolCalls?.length ? `tools ${timeline.toolCalls.length}` : undefined,
        timeline.completedMs !== undefined ? `done ${timeline.completedMs}ms` : undefined,
    ];

    return parts.filter(Boolean).join(" · ");
}
