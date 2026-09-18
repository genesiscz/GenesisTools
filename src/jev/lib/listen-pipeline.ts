import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { DEFAULT_WAKE_PHRASES, matchWake, type TranscriptEvent } from "@genesiscz/utils/ai/live-stt";
import { runBrowserGoal } from "./browser/goal";
import type { BrowserDriver } from "./browser/types";

export type WakeMode = "off" | "contains" | "jev";

export interface ListenEvent {
    type: string;
    text?: string;
    matched?: string;
    remainder?: string;
    admitted?: boolean;
    reason?: string;
}

export async function* runListenPipeline(options: {
    events: AsyncIterable<TranscriptEvent>;
    evaluate: Evaluator;
    driver: BrowserDriver;
    wakeMode: WakeMode;
    phrases?: string[];
    goal?: string;
    inputs?: Record<string, string>;
    dispatchPartials?: boolean;
}): AsyncGenerator<ListenEvent> {
    if (options.wakeMode === "jev") {
        throw new Error("wake-mode jev is v2");
    }
    const phrases = options.phrases ?? DEFAULT_WAKE_PHRASES;
    let remainder = options.goal ?? "";
    let armed = options.wakeMode === "off";
    for await (const event of options.events) {
        if (event.type === "partial") {
            yield { type: "partial", text: event.text };
            continue;
        }
        if (event.type !== "final") {
            yield { type: event.type, text: event.text, reason: event.error };
            continue;
        }
        yield { type: "final", text: event.text };
        if (options.wakeMode === "contains") {
            const hit = matchWake(event.text, phrases);
            if (hit) {
                armed = true;
                remainder = hit.remainder || remainder;
                yield { type: "wake", matched: hit.matched, remainder };
            }
        } else {
            remainder = event.text || remainder;
        }
        if (!armed || !remainder) {
            continue;
        }
        const result = await runBrowserGoal({
            goal: remainder,
            driver: options.driver,
            evaluate: options.evaluate,
            inputs: options.inputs,
            limits: { maxActions: 1, maxRequests: 4, timeoutMs: 30000 },
        });
        const last = result.steps.at(-1);
        yield {
            type: "decision",
            text: last?.label,
            admitted:
                result.status === "completed" ||
                (last?.action !== "stop" && result.steps.some((step) => step.action !== "stop")),
            reason: result.reason,
        };
        if (!options.dispatchPartials) {
            armed = options.wakeMode === "off";
        }
    }
    yield { type: "stop", reason: "stream-ended" };
}
