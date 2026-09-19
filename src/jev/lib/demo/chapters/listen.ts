import type { LiveTranscriptEvent } from "@genesiscz/utils/ai/stt";
import { axView, createListenPipeline, type ListenDecision, type ListenSurface } from "../../listen/pipeline";
import type { FixtureScript } from "../fixture-evaluator";
import {
    FIXTURE_SURFACE_NOTE,
    keypadObservation,
    LISTEN_TRANSCRIPT,
    VOICE_TRANSCRIPT,
    VOICE_WAKE_PHRASES,
} from "../fixtures";
import { type Chapter, type ChapterContext, type ChapterOutcome, createEventLog, mismatch } from "./context";

/**
 * `terminal` stays below `LISTEN_TERMINAL_MIN_P` (0.92), so the partial can only ever be "would".
 * A partial that dispatches is exactly the bug this chapter exists to catch.
 */
export const LISTEN_SCRIPT: FixtureScript = {
    choice: [[/^verb$/, /Seven/i]],
    boolean: [
        [/^terminal$/, 0.5],
        [/^correction$/, 0.02],
    ],
};

function fixtureListenSurface(acted: string[]): ListenSurface {
    return {
        async see() {
            return axView(keypadObservation());
        },
        async act(payload) {
            acted.push(`${payload.action}:${payload.element}`);
            return { ok: true };
        },
    };
}

async function runListenChapter(
    context: ChapterContext,
    options: { transcript: LiveTranscriptEvent[]; wakePhrases?: string[]; expected: string[] }
): Promise<ChapterOutcome> {
    const log = createEventLog(context.now);
    const acted: string[] = [];
    const pipeline = createListenPipeline({
        surface: fixtureListenSurface(acted),
        evaluate: context.evaluator(LISTEN_SCRIPT),
        signal: context.signal,
        now: context.now,
        ...(options.wakePhrases ? { wake: { mode: "contains" as const, phrases: options.wakePhrases } } : {}),
    });
    log.add("surface", FIXTURE_SURFACE_NOTE);
    const decisions: ListenDecision[] = [];
    for (const event of options.transcript) {
        const decision = await pipeline.decide(event);
        decisions.push(decision);
        log.add(`${event.kind}:${decision.status}`, `${event.text} → ${decision.reason}`);
    }

    const statuses = decisions.map((decision) => decision.status).join(",");
    const expected = options.expected.join(",");
    const readback = statuses === expected;
    log.add("readback", `statuses ${statuses} vs scripted ${expected}`);
    return {
        readback,
        reason: readback ? "scripted_statuses_matched" : mismatch(expected, statuses),
        events: log.events(),
        result: { decisions, acted, expected: options.expected, surface: FIXTURE_SURFACE_NOTE },
    };
}

/** A partial holds, the final dispatches, a stop phrase disarms. All three through the real pipeline. */
export const listenChapter: Chapter = (context) =>
    runListenChapter(context, { transcript: LISTEN_TRANSCRIPT, expected: ["would", "act", "stop"] });

/** The wake gate: the pre-wake command is refused, only the phrase-prefixed one reaches a target. */
export const voiceChapter: Chapter = (context) =>
    runListenChapter(context, {
        transcript: VOICE_TRANSCRIPT,
        wakePhrases: VOICE_WAKE_PHRASES,
        expected: ["abstain", "act"],
    });
