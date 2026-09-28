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
    /**
     * TypeSafe model id. Omitted means `jev-latest`, which every live-policy caller keeps. Only
     * `tools jev grep` passes a pin, because its answer cache must not outlive a moved alias. The
     * Vercel adapter ignores it and stays on `JEV_MODEL`.
     */
    model?: string;
    /** Which feature spent the call (`grep`, `listen`, ...). Booked as `meta.label` in the usage ledger. */
    usageLabel?: string;
    timeoutMs?: number;
    zeroDataRetention?: boolean;
    signal?: AbortSignal;
}
