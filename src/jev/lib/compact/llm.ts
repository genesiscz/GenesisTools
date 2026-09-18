import { admittedChoice } from "@app/control/lib/decision/decisions";
import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import type { CompactDecision, CompactMessage, compactDecisionKinds } from "./schema";
import { compactStructural, type StructuralCompactOptions } from "./structural";

const allowed = ["keep_both", "keep_call_truncate_result", "drop"] as const;

export async function compactWithJev(options: {
    messages: CompactMessage[];
    evaluate: Evaluator;
    signal?: AbortSignal;
    structural: StructuralCompactOptions;
}): Promise<ReturnType<typeof compactStructural>> {
    const structural = compactStructural(options.messages, options.structural);
    const candidates = structural.decisions.filter((decision) => {
        const message = options.messages.find((item) => item.index === decision.index);
        return message && !message.pinned && (message.roleKind === "tool" || decision.toolName);
    });
    if (!candidates.length) {
        return structural;
    }

    const batch = candidates.slice(0, 40);
    const evaluation = await options.evaluate({
        input: {
            state: {
                keep: options.structural.keep,
                calls: batch.map((decision) => ({
                    id: decision.index,
                    name: decision.toolName,
                    reason: decision.reason,
                })),
            },
            questions: Object.fromEntries(
                batch.map((decision) => [
                    `t${decision.index}`,
                    {
                        type: "choice",
                        instructions:
                            "Choose keep_both, keep_call_truncate_result, or drop for this tool result. Never rewrite user or assistant text.",
                        criteria: {
                            keep_both: "Keep the tool call and its full result.",
                            keep_call_truncate_result: "Keep the call and truncate the result.",
                            drop: "Drop this tool call and result.",
                        },
                    },
                ])
            ),
        },
        signal: options.signal,
    });

    const overlay = new Map<number, CompactDecision>();
    for (const decision of batch) {
        const admitted = admittedChoice({
            result: evaluation,
            id: `t${decision.index}`,
            allowed: [...allowed],
        });
        if (!admitted.admitted) {
            continue;
        }

        overlay.set(decision.index, {
            index: decision.index,
            kind: admitted.choice as (typeof compactDecisionKinds)[number],
            reason: "jev",
            toolName: decision.toolName,
        });
    }

    if (!overlay.size) {
        return structural;
    }

    const rewritten = structural.decisions.map((decision) => overlay.get(decision.index) ?? decision);
    return { ...structural, decisions: rewritten };
}
