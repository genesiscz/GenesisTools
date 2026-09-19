import { compactSession } from "@genesiscz/utils/ai/compact";
import type { FixtureScript } from "../fixture-evaluator";
import { compactFixtureSession } from "../fixtures";
import { type Chapter, createEventLog, mismatch } from "./context";

const THRESHOLD = 0.1;

/**
 * Layer 2 asks one boolean triple per tool call. Keeping the call and dropping the oversized
 * result is what makes the reduction real rather than a rounding artefact.
 */
export const COMPACT_SCRIPT: FixtureScript = {
    boolean: [
        [/^keep_call_/, 0.95],
        [/^keep_result_/, 0.02],
        [/^summarizable_/, 0.02],
    ],
};

/** Layer 1 and layer 2 over a fixture session, with the reduction as the readback. */
export const compactChapter: Chapter = async (context) => {
    const log = createEventLog(context.now);
    const text = compactFixtureSession();
    log.add("input", `${Buffer.byteLength(text, "utf8")} bytes of generic JSONL`);
    const result = await compactSession({
        text,
        llm: true,
        evaluate: context.evaluator(COMPACT_SCRIPT),
        keep: 0.5,
        pin: 2,
        maxResult: 120,
        threshold: THRESHOLD,
        signal: context.signal,
    });
    log.add(
        "compact",
        `${result.stats.inBytes} → ${result.stats.outBytes} bytes (${(result.stats.reduction * 100).toFixed(1)}%), ` +
            `${result.layer2.jevRequests} Jev requests`
    );
    const readback =
        !result.stats.unchanged &&
        result.stats.reduction >= THRESHOLD &&
        result.layer2.used &&
        result.layer2.jevRequests > 0;
    log.add("readback", `reduction ${result.stats.reduction.toFixed(3)} vs threshold ${THRESHOLD}`);
    return {
        readback,
        reason: readback
            ? "reduction_reached_the_threshold"
            : mismatch(
                  `reduction >= ${THRESHOLD} with layer 2`,
                  `${result.stats.reduction.toFixed(3)} (${result.reason ?? "changed"})`
              ),
        events: log.events(),
        result,
    };
};
