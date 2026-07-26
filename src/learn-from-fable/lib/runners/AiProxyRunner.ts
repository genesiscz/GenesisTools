import { AiProxyClient } from "@genesiscz/utils/ai/proxy/AiProxyClient";
import { logger } from "@genesiscz/utils/logger";
import { currentStageTags } from "../stage-context";
import type { ReasoningEffort, Runner, RunnerCall, RunnerResult } from "./types";

/** Abort a call that goes quiet for this long once it HAS started emitting (see attempt()). */
const DEFAULT_STALL_MS = 60_000;

/**
 * Budget for the very first byte of output, wider than the stall budget because
 * some providers stream nothing at all while they reason (claude-sub sonnet-5
 * emits no thinking frames).
 *
 * Sized from measurement, not taste: across 55 completed filter calls on
 * 2026-07-25 the first token arrived at p50 2.0s, p90 11.2s, max 14.7s. 90s is
 * six times the worst healthy case, and a call that is still silent at 90s has
 * always turned out to be dead rather than slow — the earlier 150s just meant a
 * dead call held its concurrency slot for two and a half minutes.
 */
const DEFAULT_FIRST_OUTPUT_MS = 90_000;

/** A call that produced nothing at all before its watchdog fired. Retryable. */
export class NoOutputError extends Error {}

/**
 * Default runner: everything goes through the local ai-proxy (which owns usage
 * accounting). Calls are STREAMED even though the pipeline only wants the final
 * text — a non-streamed request withholds upstream headers until generation is
 * finished, which collapses the proxy's whole timeline into one opaque wait
 * (measured 2026-07-24: dispatch == TTFB == total on every mine call). Streaming
 * costs nothing here and yields real TTFB and thinking spans per call.
 */
export class AiProxyRunner implements Runner {
    readonly id: string;
    private readonly client: AiProxyClient;

    private readonly effort?: ReasoningEffort;

    constructor(
        private readonly model: string,
        options: { client?: AiProxyClient; effort?: ReasoningEffort } = {}
    ) {
        this.client = options.client ?? new AiProxyClient();
        this.effort = options.effort;
        this.id = `ai-proxy:${model}${options.effort ? `:${options.effort}` : ""}`;
    }

    async call(input: RunnerCall): Promise<RunnerResult> {
        let first: RunnerResult;
        try {
            first = await this.attempt(input);
        } catch (err) {
            if (!(err instanceof NoOutputError)) {
                throw err;
            }

            // A silent claude-sub call is usually transient: an isolated probe of the
            // identical trivial prompt answered in 1.3s and 1.5s and then hung past
            // 110s on the third try. Losing the episode to that is worse than paying
            // for one more call.
            logger.warn({ model: this.model, label: input.label, error: err }, "no output — retrying once");
            return this.attempt(input);
        }

        if (first.text.trim()) {
            return first;
        }

        // Upstream can also finish CLEANLY with zero content: observed 2026-07-25 on
        // claude-sub/opus-5, a consolidate vote came back in 1.2s as an opening role
        // delta then finish_reason=stop with no text (proxy transcript
        // a575be6d-f5fa-45c6-84c2-9eaa3a825052). Callers read that as a drifted reply
        // and drop the whole batch, so buy one retry — it is one cheap call against
        // losing a batch of work.
        logger.warn({ model: this.model, label: input.label }, "empty completion from upstream — retrying once");
        return this.attempt(input);
    }

    private async attempt(input: RunnerCall): Promise<RunnerResult> {
        // Stall watchdog: a provider can accept the request, emit the opening
        // frame, then go silent indefinitely (observed 2026-07-24 on claude-sub:
        // zero content frames for 100s+ on a prompt grok answered in 3.5s).
        // Waiting the full timeout wastes minutes per call, so abort on silence
        // and let the caller retry smaller / elsewhere. Two budgets: a wide one
        // until the first byte (silent reasoning is not a hang), a tight one for
        // gaps after the stream has proven itself alive.
        const stallMs = input.stallMs ?? DEFAULT_STALL_MS;
        const firstOutputMs = input.firstOutputMs ?? DEFAULT_FIRST_OUTPUT_MS;
        const controller = new AbortController();
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        const arm = (ms: number) => {
            clearTimeout(watchdog);
            watchdog = setTimeout(() => controller.abort(new Error(`no output for ${ms}ms`)), ms);
        };

        arm(firstOutputMs);

        try {
            return await this.stream(input, controller, {
                // text has started, so a gap now really is a stall
                onText: () => arm(stallMs),
                // still thinking: keep the wide budget, it has not started answering yet
                onReasoning: () => arm(firstOutputMs),
            });
        } finally {
            clearTimeout(watchdog);
        }
    }

    private async stream(
        input: RunnerCall,
        controller: AbortController,
        onProgress: { onText: () => void; onReasoning: () => void }
    ): Promise<RunnerResult> {
        const result = await this.client.chatStream(
            {
                model: this.model,
                messages: [
                    { role: "system", content: input.system },
                    { role: "user", content: input.user },
                ],
                maxTokens: input.maxTokens,
                timeoutMs: input.timeoutMs,
                jsonSchema: input.jsonSchema,
                // prompt mode works on every provider; native response_format is dropped
                // by the anthropic-subscription translator (probed 2026-07-24)
                schemaMode: "prompt",
                reasoningEffort: input.effort ?? this.effort,
                tags: { ...currentStageTags(), ...(input.label ? { label: input.label } : {}) },
                signal: controller.signal,
            },
            { onDelta: onProgress.onText, onReasoningDelta: onProgress.onReasoning }
        );

        // A stalled call comes back as an abort, sometimes carrying part of an
        // answer. Every abort is an incomplete answer and must surface as an
        // error: half a JSON verdict parses just as happily as a whole one, and
        // scoring it would defeat the watchdog that caught the stall.
        if (result.aborted) {
            // Name the budget that fired — "never started" and "died mid-stream"
            // are different upstream faults and the log has to tell them apart.
            const reason = controller.signal.reason;
            const why = reason instanceof Error ? reason.message : "aborted";
            const label = input.label ?? "call";

            if (!result.text.trim()) {
                throw new NoOutputError(`model produced no output: ${why} (${label})`);
            }

            throw new Error(`model stalled after ${result.text.length} chars: ${why} (${label})`);
        }

        return {
            text: result.text,
            parsed: result.parsed,
            parseError: result.parseError,
            elapsedMs: result.elapsedMs,
            usage: result.usage,
        };
    }
}
