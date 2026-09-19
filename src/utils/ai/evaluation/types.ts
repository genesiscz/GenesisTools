import { z } from "zod";

export const EVALUATION_PROVIDERS = ["vercel", "typesafe"] as const;
export const evaluationProviderSchema = z.enum(EVALUATION_PROVIDERS);
export type EvaluationProviderId = z.infer<typeof evaluationProviderSchema>;
export interface EvaluationOptions {
    provider?: EvaluationProviderId;
    timeoutMs?: number;
    zeroDataRetention?: boolean;
    signal?: AbortSignal;
}
