import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import {
    canDispatchWake,
    DEFAULT_WAKE_PHRASES,
    detectJevWake,
    isStopUtterance,
    matchWake,
    type TranscriptEvent,
} from "@genesiscz/utils/ai/live-stt";
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
    prefetch?: string;
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
    continuous?: boolean;
    confirmDestructive?: boolean;
}): AsyncGenerator<ListenEvent> {
    const phrases = options.phrases ?? DEFAULT_WAKE_PHRASES;
    let remainder = options.goal ?? "";
    let armed = options.wakeMode === "off";
    const recent: string[] = [];
    for await (const event of options.events) {
        if (event.type === "partial") {
            yield { type: "partial", text: event.text };
            if (/go ba/i.test(event.text)) {
                yield { type: "prefetch", prefetch: "back", text: event.text };
            }
            continue;
        }
        if (event.type !== "final") {
            yield { type: event.type, text: event.text, reason: event.error };
            continue;
        }
        yield { type: "final", text: event.text };
        recent.push(event.text);
        if (recent.length > 8) {
            recent.shift();
        }
        if (isStopUtterance(event.text)) {
            armed = options.wakeMode === "off";
            remainder = options.goal ?? "";
            yield { type: "idle", reason: "stop-phrase", text: event.text };
            continue;
        }
        if (options.wakeMode === "contains") {
            const hit = matchWake(event.text, phrases);
            if (hit) {
                armed = true;
                remainder = hit.remainder || remainder;
                yield { type: "wake", matched: hit.matched, remainder };
            }
        } else if (options.wakeMode === "jev") {
            const detected = await detectJevWake({
                text: event.text,
                recent,
                evaluate: options.evaluate,
                phrases,
            });
            if (!canDispatchWake(detected, options.confirmDestructive)) {
                yield {
                    type: detected.destructive ? "confirm" : "idle",
                    remainder: detected.remainder,
                    reason: detected.woke ? (detected.complete ? "destructive" : "incomplete") : "not-wake",
                };
                continue;
            }
            armed = true;
            remainder = detected.remainder || remainder;
            yield { type: "wake", remainder, matched: "jev" };
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
            limits: {
                maxActions: options.continuous ? 8 : 1,
                maxRequests: options.continuous ? 20 : 4,
                timeoutMs: 30000,
            },
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
        if (!options.continuous) {
            armed = options.wakeMode === "off";
        }
    }
    yield { type: "stop", reason: "stream-ended" };
}
