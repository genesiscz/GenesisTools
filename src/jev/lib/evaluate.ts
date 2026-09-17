import { logger } from "@genesiscz/utils/logger";
import { createGateway, type Experimental_EvaluationModel, experimental_evaluate as evaluate } from "ai";
import { z } from "zod";

export const JEV_MODEL = "typesafe-ai/jev";

const inputSchema = z.union([z.string().trim().min(1), z.record(z.string(), z.json()), z.array(z.json())]);
const criteriaSchema = inputSchema.nullable();
const questionSchema = z.discriminatedUnion("type", [
    z
        .object({
            type: z.literal("boolean"),
            instructions: inputSchema,
            criteria: z
                .object({ true: criteriaSchema.optional(), false: criteriaSchema.optional() })
                .strict()
                .optional(),
        })
        .strict(),
    z
        .object({
            type: z.literal("choice"),
            instructions: inputSchema,
            criteria: z.record(z.string().min(1), criteriaSchema).refine((value) => Object.keys(value).length > 0, {
                message: "Choice needs at least one option",
            }),
        })
        .strict(),
    z
        .object({
            type: z.literal("score"),
            instructions: inputSchema,
            criteria: z.array(criteriaSchema).min(2),
        })
        .strict(),
]);

export const evaluationSchema = z
    .object({
        state: inputSchema,
        questions: z.record(z.string().min(1), questionSchema).refine((value) => Object.keys(value).length > 0, {
            message: "At least one question is required",
        }),
    })
    .strict();

export type EvaluationInput = z.infer<typeof evaluationSchema>;

export const demoInput: EvaluationInput = {
    state: "My card was charged twice for one order. Please refund the duplicate charge. Delivery was fine.",
    questions: {
        refundRequested: { type: "boolean", instructions: "Is the customer asking for a refund?" },
        route: {
            type: "choice",
            instructions: "Which team should handle this ticket?",
            criteria: { billing: "payments and charges", shipping: "delivery problems", technical: "application bugs" },
        },
        urgency: {
            type: "score",
            instructions: "Rate the urgency of this support ticket.",
            criteria: ["low: informational", "medium: a customer needs help", "high: immediate harm or outage"],
        },
    },
};

export async function evaluateState({
    input,
    model,
    timeoutMs = 30_000,
    zeroDataRetention = false,
    signal,
}: {
    input: unknown;
    model: Experimental_EvaluationModel;
    timeoutMs?: number;
    zeroDataRetention?: boolean;
    signal?: AbortSignal;
}) {
    const request = evaluationSchema.parse(input);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
        throw new Error("Timeout must be an integer from 1 to 300000 milliseconds.");
    }

    logger.debug(
        { model: JEV_MODEL, questionCount: Object.keys(request.questions).length, zeroDataRetention },
        "Evaluating Jev questions"
    );
    const result = await evaluate({
        model,
        ...request,
        maxRetries: 0,
        abortSignal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
            : AbortSignal.timeout(timeoutMs),
        providerOptions: zeroDataRetention ? { gateway: { zeroDataRetention: true } } : undefined,
    });
    logger.debug({ model: JEV_MODEL, usage: result.usage }, "Jev evaluation complete");
    return {
        model: JEV_MODEL,
        answers: result.answers,
        usage: result.usage,
        providerMetadata: result.providerMetadata,
        warnings: result.warnings,
        rounding: result.rounding,
    };
}

export function createJevModel(apiKey: string) {
    logger.debug({ url: "https://ai-gateway.vercel.sh/v4/ai/evaluation-model" }, "Using Vercel AI Gateway for Jev");
    return createGateway({ apiKey }).evaluationModel(JEV_MODEL);
}
