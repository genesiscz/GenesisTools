import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { booleanProbability } from "@genesiscz/utils/ai/live-stt/answers";
import { z } from "zod";

export const messageSchema = z.object({
    role: z.enum(["user", "assistant", "system", "tool"]),
    content: z.string(),
    toolCalls: z
        .array(
            z.object({
                id: z.string(),
                name: z.string(),
                input: z.string().optional(),
                result: z.string().optional(),
            })
        )
        .optional(),
});
export type CompactMessage = z.infer<typeof messageSchema>;

export interface CompactDecision {
    id: string;
    keepCall: number;
    keepResult: number;
    action: "keep" | "truncate" | "drop";
}

export interface CompactResult {
    messages: CompactMessage[];
    decisions: CompactDecision[];
    stats: { beforeChars: number; afterChars: number; reduction: number; fellBack: boolean };
    layer2: { used: boolean; replaced: number };
}

function chars(messages: CompactMessage[]): number {
    return messages.reduce((total, message) => {
        const tools = (message.toolCalls ?? []).reduce(
            (sum, call) =>
                sum + call.id.length + call.name.length + (call.input?.length ?? 0) + (call.result?.length ?? 0),
            0
        );
        return total + message.content.length + tools;
    }, 0);
}

function note(result: string, head: number): string {
    return `${result.slice(0, head)}\n… [${result.length} chars, truncated]`;
}

export function pinIndexes(messages: CompactMessage[]): Set<number> {
    const pins = new Set<number>();
    const lastUser = messages.findLastIndex((message) => message.role === "user");
    if (lastUser >= 0) {
        pins.add(lastUser);
    }
    const lastFailed = messages.findLastIndex((message) =>
        (message.toolCalls ?? []).some((call) => /error|failed|exit 1/i.test(call.result ?? ""))
    );
    if (lastFailed >= 0) {
        pins.add(lastFailed);
    }
    messages.forEach((message, index) => {
        if (
            message.content.includes("#pin") ||
            (message.toolCalls ?? []).some((call) => call.result?.includes("#pin"))
        ) {
            pins.add(index);
        }
    });
    return pins;
}

export async function compactMessages(options: {
    messages: CompactMessage[];
    evaluate: Evaluator;
    keep?: number;
    preserveRecent?: number;
    headChars?: number;
    minReduction?: number;
    llm?: boolean;
    signal?: AbortSignal;
    pins?: Set<number>;
}): Promise<CompactResult> {
    const messages = z.array(messageSchema).min(1).parse(options.messages);
    const keep = options.keep ?? 0.5;
    const preserveRecent = options.preserveRecent ?? 4;
    const headChars = options.headChars ?? 300;
    const minReduction = options.minReduction ?? 0.25;
    const pins = options.pins ?? pinIndexes(messages);
    const beforeChars = chars(messages);
    const toolCalls = messages.flatMap((message, index) =>
        (message.toolCalls ?? []).map((call) => ({ ...call, messageIndex: index }))
    );
    const recentStart = Math.max(0, toolCalls.length - preserveRecent);
    const eligible = toolCalls.filter((call, index) => index < recentStart && !pins.has(call.messageIndex));
    const questions = Object.fromEntries(
        eligible.flatMap((call) => [
            [
                `keep_call_${call.id}`,
                {
                    type: "boolean" as const,
                    instructions: `Keep the ${call.name} tool call (id ${call.id}) given the conversation?`,
                },
            ],
            [
                `keep_result_${call.id}`,
                {
                    type: "boolean" as const,
                    instructions: `Keep the ${call.name} result verbatim?`,
                },
            ],
        ])
    );
    const state = messages.map((message) => ({
        role: message.role,
        content: message.content,
        toolCalls: (message.toolCalls ?? []).map((call) => ({
            id: call.id,
            name: call.name,
            input: (call.input ?? "").slice(0, 200),
            result: call.result ? `${call.result.length} chars (omitted)` : "ok",
        })),
    }));
    const evaluation =
        eligible.length === 0
            ? undefined
            : await options.evaluate({
                  signal: options.signal,
                  input: { state, questions },
              });
    const decisions: CompactDecision[] = [];
    const drop = new Set<string>();
    const truncate = new Set<string>();
    for (const call of eligible) {
        const keepCall = evaluation ? (booleanProbability(evaluation, `keep_call_${call.id}`) ?? 0) : 1;
        const keepResult = evaluation ? (booleanProbability(evaluation, `keep_result_${call.id}`) ?? 0) : 1;
        const action = keepResult >= keep ? "keep" : keepCall >= keep ? "truncate" : "drop";
        decisions.push({ id: call.id, keepCall, keepResult, action });
        if (action === "drop") {
            drop.add(call.id);
        } else if (action === "truncate") {
            truncate.add(call.id);
        }
    }
    const next = messages.map((message, index) => {
        if (pins.has(index)) {
            return message;
        }
        return {
            ...message,
            toolCalls: message.toolCalls
                ?.filter((call) => !drop.has(call.id))
                .map((call) =>
                    truncate.has(call.id) && call.result ? { ...call, result: note(call.result, headChars) } : call
                ),
        };
    });
    const afterChars = chars(next);
    const reduction = beforeChars === 0 ? 0 : (beforeChars - afterChars) / beforeChars;
    if (reduction < minReduction) {
        return {
            messages,
            decisions,
            stats: { beforeChars, afterChars: beforeChars, reduction: 0, fellBack: true },
            layer2: { used: false, replaced: 0 },
        };
    }
    let replaced = 0;
    if (options.llm) {
        for (const message of next) {
            for (const call of message.toolCalls ?? []) {
                if (!truncate.has(call.id) || !call.result) {
                    continue;
                }
                const faithful = await options.evaluate({
                    signal: options.signal,
                    input: {
                        state: { original_head: call.result, proposed: "summary skipped in tests" },
                        questions: {
                            faithful: {
                                type: "boolean",
                                instructions: "Is the proposed summary faithful to the truncated original?",
                            },
                        },
                    },
                });
                if ((booleanProbability(faithful, "faithful") ?? 0) >= 0.8) {
                    replaced++;
                }
            }
        }
    }
    return {
        messages: next,
        decisions,
        stats: { beforeChars, afterChars, reduction, fellBack: false },
        layer2: { used: Boolean(options.llm), replaced },
    };
}

export async function compactStream(options: {
    batches: CompactMessage[][];
    evaluate: Evaluator;
    keep?: number;
    minReduction?: number;
}): Promise<CompactResult> {
    let messages: CompactMessage[] = [];
    let last: CompactResult | undefined;
    for (const batch of options.batches) {
        messages = [...messages, ...batch];
        last = await compactMessages({
            messages,
            evaluate: options.evaluate,
            keep: options.keep,
            minReduction: options.minReduction ?? 0.01,
            pins: pinIndexes(messages),
        });
        messages = last.messages;
    }
    if (!last) {
        throw new Error("compactStream needs at least one batch");
    }
    return last;
}
