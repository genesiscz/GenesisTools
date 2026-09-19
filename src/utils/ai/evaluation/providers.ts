import { createTypeSafeAi, type TypeSafeAiProviderSettings } from "@ai-sdk/typesafe-ai";
import { createJevModel, evaluateState } from "./evaluate";
import type { EvaluationOptions, EvaluationProviderId } from "./types";

export type EvaluationResponse = Awaited<ReturnType<typeof evaluateState>>;
export type EvaluationCall = EvaluationOptions & { input: unknown };
export interface EvaluationProvider {
    readonly id: EvaluationProviderId;
    evaluate(options: EvaluationCall): Promise<EvaluationResponse>;
}
export class VercelEvaluationProvider implements EvaluationProvider {
    readonly id = "vercel";
    private readonly model;
    constructor(apiKey: string) {
        this.model = createJevModel(apiKey);
    }
    evaluate(options: EvaluationCall) {
        return evaluateState({ ...options, model: this.model });
    }
}

export class TypeSafeEvaluationProvider implements EvaluationProvider {
    readonly id = "typesafe";
    private readonly model;
    constructor(options: { apiKey: string; fetch?: TypeSafeAiProviderSettings["fetch"] }) {
        this.model = createTypeSafeAi({ ...options, baseURL: "https://api.typesafe.ai/v1" }).evaluationModel(
            "jev-latest"
        );
    }
    async evaluate(options: EvaluationCall): Promise<EvaluationResponse> {
        if (options.zeroDataRetention) {
            throw new Error("Zero Data Retention enforcement is only supported by the Vercel adapter.");
        }
        return evaluateState({ ...options, model: this.model });
    }
}
