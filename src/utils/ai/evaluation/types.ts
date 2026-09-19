import { z } from "zod";

export const EVALUATION_PROVIDERS = ["vercel", "typesafe"] as const;
export const evaluationProviderSchema = z.enum(EVALUATION_PROVIDERS);
export type EvaluationProviderId = z.infer<typeof evaluationProviderSchema>;

/**
 * `typesafe` is the default. The Vercel AI Gateway answers "Service temporarily unavailable"
 * often enough to lose whole utterances of a live listen session (seven in one 39-second run on
 * 2026-09-19). `--provider vercel` still selects it.
 */
export const DEFAULT_EVALUATION_PROVIDER: EvaluationProviderId = "typesafe";
export interface EvaluationOptions {
    provider?: EvaluationProviderId;
    timeoutMs?: number;
    zeroDataRetention?: boolean;
    signal?: AbortSignal;
}
