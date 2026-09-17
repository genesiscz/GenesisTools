import { SafeJSON } from "@genesiscz/utils/json";
import { experimentRequestSchema, type ProgramState } from "./experiment-contract";
import { generationMode } from "./generation";
import { languages } from "./languages";
import type { EvaluationResponse } from "./service";
import { evaluateRequest } from "./service";

export interface ExperimentDecision {
    step: number;
    token: string;
    probability?: number;
    confidence?: number;
    doneProbability: number;
    candidates: Array<{ token: string; probability?: number }>;
    usage: EvaluationResponse["usage"];
}

export interface ExperimentStep extends ProgramState {
    decision: ExperimentDecision;
}

type Evaluate = typeof evaluateRequest;

export async function stepExperiment({
    input,
    signal,
    evaluate = evaluateRequest,
}: {
    input: unknown;
    signal?: AbortSignal;
    evaluate?: Evaluate;
}): Promise<ExperimentStep> {
    signal?.throwIfAborted();
    const request = experimentRequestSchema.parse(input);
    const language = languages.get(request.language);
    const mode = generationMode(request.mode);
    const current = mode.state(language, request);
    if (current.complete) {
        throw new Error("This program is complete. Reset to start another experiment.");
    }

    if (request.tokens.length >= request.maxSteps) {
        throw new Error(`Stopped at the ${request.maxSteps}-step limit. Increase the limit or reset.`);
    }

    const candidatesById: Record<string, string> = Object.fromEntries(
        current.candidates.map((token, index) => [`t${index}`, token])
    );
    const criteria = Object.fromEntries(
        Object.entries(candidatesById).map(([id, token]) => [
            id,
            request.mode === "characters" ? SafeJSON.stringify(token) : token,
        ])
    );
    const result = await evaluate({
        input: {
            state: {
                goal: request.goal,
                language: language.name,
                source: current.source,
                grammarSlot: current.slot,
                legalNextTokens: criteria,
                sampleStdin: request.stdin,
            },
            questions: {
                next: {
                    type: "choice",
                    instructions: mode.instruction(language),
                    criteria,
                },
                done: {
                    type: "boolean",
                    instructions: "Does the current program implement the requested goal?",
                },
            },
        },
        signal,
        zeroDataRetention: request.zeroDataRetention,
    });
    signal?.throwIfAborted();
    const next = result.answers.next;
    const done = result.answers.done;
    if (next?.type !== "choice" || done?.type !== "boolean") {
        throw new Error("Jev did not return the expected choice and boolean answers.");
    }

    const token = candidatesById[next.choice];
    if (token === undefined) {
        throw new Error("Jev selected a token outside the legal set.");
    }

    const confidence = result.providerMetadata?.typesafe?.confidence;
    const nextConfidence =
        confidence && typeof confidence === "object" && "next" in confidence ? confidence.next : undefined;
    return {
        ...mode.state(language, { ...request, tokens: [...request.tokens, token] }),
        decision: {
            step: request.tokens.length + 1,
            token,
            probability: next.probabilities?.[next.choice],
            confidence: typeof nextConfidence === "number" ? nextConfidence : undefined,
            doneProbability: done.probability,
            candidates: current.candidates.map((candidate, index) => ({
                token: candidate,
                probability: next.probabilities?.[`t${index}`],
            })),
            usage: result.usage,
        },
    };
}

export async function* runExperiment({ input, signal }: { input: unknown; signal?: AbortSignal }) {
    let request = experimentRequestSchema.parse(input);
    const deadline = AbortSignal.timeout(300000);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    while (
        !generationMode(request.mode).state(languages.get(request.language), request).complete &&
        request.tokens.length < request.maxSteps
    ) {
        combined.throwIfAborted();
        const step = await stepExperiment({ input: request, signal: combined });
        yield step;
        request = { ...request, tokens: step.tokens };
    }
}
