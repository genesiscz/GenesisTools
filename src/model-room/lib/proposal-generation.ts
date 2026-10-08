import { callLLMStructured } from "@genesiscz/utils/ai/core/call";
import { resolveModel } from "@genesiscz/utils/ai/core/resolve";
import { logger } from "@genesiscz/utils/logger";
import { defaultUnits } from "@genesiscz/utils/quantities/units";
import { inspectModelProposal, modelProposalSchema } from "./proposal";

export async function generateModelProposal({
    sourceText,
    model,
    signal,
}: {
    sourceText: string;
    model?: string;
    signal?: AbortSignal;
}) {
    if (!sourceText.trim() || sourceText.length > 16000) {
        throw new Error("Describe the model in 1 to 16,000 characters.");
    }

    const abortSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000);
    abortSignal.throwIfAborted();
    logger.debug(
        { characters: sourceText.length, model: model ?? "app default" },
        "model-room: resolving proposal model"
    );
    const resolved = await resolveModel(model, { app: "model-room", task: "chat" });

    try {
        abortSignal.throwIfAborted();
        const result = await callLLMStructured({
            model: resolved,
            app: "model-room",
            abortSignal,
            schema: modelProposalSchema,
            maxTokens: 12000,
            systemPrompt: [
                "Propose a small causal model for Genesis Model Room. Return only the requested structured proposal.",
                "The proposal is a draft for human review, never a claim that reality follows these equations.",
                "Use at most 24 quantities, preferably 3–8, and 1–8 output IDs.",
                "Every unknown number must have value:null, sourceQuote:null and a precise question for the author.",
                "Only copy a number when it appears literally in an exact sourceQuote from the user's request.",
                "This also applies to duration, time step, stock initial values and history seeds. Do not invent defaults.",
                "Use identifiers of at most 64 ASCII letters/digits/underscores, starting with a letter or underscore.",
                "Reserve time, step, min, max, abs, clamp, lag, constructor, prototype and __proto__.",
                "A formula can contain references, + - * / ^, min/max/abs/clamp, and lag(identifier, positive integer steps).",
                "Only 0 and 1 may appear as numeric literals in a formula. Other coefficients must be named input quantities.",
                "No JavaScript, datasets, scenario edits or external tool instructions.",
                "Inputs have a value, formulas have an expression, stocks have an initial value and derivative.",
                "Every quantity has seed:null unless another expression reads its lag; then seed is a number-evidence object.",
                "Stock derivatives must have units of stock/time. Stocks integrate using Euler steps.",
                `Use these units, with * / and integer powers as needed: ${[...defaultUnits().keys()].join(", ")}`,
                "A unit literal uses brackets, e.g. 0[ticket]. All additions/min/max/clamp arguments require compatible units.",
                "Use time units second/minute/hour/day/week. Duration must be a positive exact multiple of step after review.",
                "Explain major assumptions and interpretation limits in the explanation and quantity descriptions.",
            ].join("\n"),
            userPrompt: sourceText,
        });
        abortSignal.throwIfAborted();
        const review = inspectModelProposal({ input: result.object, sourceText });
        logger.debug(
            { quantities: review.proposal.quantities.length, missing: review.missing.length },
            "model-room: proposal ready for review"
        );
        return review;
    } finally {
        resolved.binding.dispose?.();
    }
}
