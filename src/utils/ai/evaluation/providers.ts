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

/** The alias listen, watch, route and verify evaluate against. */
export const TYPESAFE_DEFAULT_MODEL = "jev-latest";

export class TypeSafeEvaluationProvider implements EvaluationProvider {
    readonly id = "typesafe";
    private readonly model;
    /**
     * `model` is a pin, passed only by `tools jev grep` (`jev-1.13.0`): its cache keys on the model
     * id, and an alias that moves would keep serving old answers as fresh. Every other caller omits
     * it and stays on `jev-latest`.
     */
    constructor(options: { apiKey: string; fetch?: TypeSafeAiProviderSettings["fetch"]; model?: string }) {
        const { model, ...settings } = options;
        this.model = createTypeSafeAi({ ...settings, baseURL: "https://api.typesafe.ai/v1" }).evaluationModel(
            model ?? TYPESAFE_DEFAULT_MODEL
        );
    }
    async evaluate(options: EvaluationCall): Promise<EvaluationResponse> {
        if (options.zeroDataRetention) {
            throw new Error("Zero Data Retention enforcement is only supported by the Vercel adapter.");
        }
        return evaluateState({ ...options, model: this.model });
    }
}
