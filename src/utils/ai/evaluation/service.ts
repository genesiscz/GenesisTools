import { logger } from "@genesiscz/utils/logger";
import { createGateway } from "ai";
import { resolveApiKey } from "./auth";
import { describeGatewayFailure } from "./errors";
import { evaluationSchema } from "./evaluate";
import {
    type EvaluationCall,
    type EvaluationProvider,
    type EvaluationResponse,
    TypeSafeEvaluationProvider,
    VercelEvaluationProvider,
} from "./providers";
import { type EvaluationOptions, type EvaluationProviderId, evaluationProviderSchema } from "./types";

export type { EvaluationOptions, EvaluationResponse };
export type Evaluator = (options: EvaluationCall) => Promise<EvaluationResponse>;
export type EvaluationProviderFactory = (
    provider: EvaluationProviderId
) => Promise<{ adapter: EvaluationProvider; apiKey: string }>;

export async function createEvaluator(options: EvaluationOptions = {}): Promise<Evaluator> {
    return createEvaluatorWithProviderFactory(options, async (provider) => {
        const apiKey = await resolveApiKey(provider);
        const adapter =
            provider === "vercel" ? new VercelEvaluationProvider(apiKey) : new TypeSafeEvaluationProvider({ apiKey });
        return { adapter, apiKey };
    });
}

export async function createEvaluatorWithProviderFactory(
    options: EvaluationOptions,
    createProvider: EvaluationProviderFactory
): Promise<Evaluator> {
    const defaultProvider = evaluationProviderSchema.parse(options.provider ?? "vercel");
    const providers = new Map<EvaluationProviderId, Promise<{ adapter: EvaluationProvider; apiKey: string }>>();
    const providerFor = (provider: EvaluationProviderId) => {
        let resolved = providers.get(provider);
        if (!resolved) {
            resolved = createProvider(provider);
            providers.set(provider, resolved);
        }
        return resolved;
    };
    await providerFor(defaultProvider);
    return async (call) => {
        const merged = { ...options, ...call };
        const provider = evaluationProviderSchema.parse(merged.provider ?? defaultProvider);
        const { adapter, apiKey } = await providerFor(provider);
        const input = evaluationSchema.parse(call.input);
        try {
            return await adapter.evaluate({ ...merged, provider, input });
        } catch (error) {
            if (merged.signal?.aborted) {
                throw new Error("Evaluation stopped.");
            }
            const message =
                provider === "vercel"
                    ? describeGatewayFailure({ error, timeoutMs: merged.timeoutMs ?? 30000, apiKey })
                    : describeTypeSafeFailure(error);
            logger.warn({ provider, message }, "Jev evaluation failed");
            throw new Error(message);
        }
    };
}

function describeTypeSafeFailure(error: unknown): string {
    if (error instanceof Error && error.message.includes("Zero Data Retention enforcement")) {
        return error.message;
    }
    const status =
        error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number"
            ? error.statusCode
            : undefined;
    return status === 401
        ? "TypeSafe rejected the credential. Run tools jev login --provider typesafe."
        : status === 403
          ? "TypeSafe denied access. Check your TypeSafe account and key permissions."
          : status === 429
            ? "TypeSafe rate limit reached. Wait before trying again."
            : error instanceof Error && error.name.includes("Timeout")
              ? "TypeSafe request timed out."
              : `TypeSafe request failed${status ? ` (HTTP ${status})` : ""}. Check your TypeSafe account. No retry was attempted.`;
}

export async function evaluateRequest(options: EvaluationCall): Promise<EvaluationResponse> {
    // The evaluator parses `input` against the same schema before it sends anything, so validating
    // here as well charged every call a second full parse for an identical verdict and an
    // identical error. That cost lands inside the arena and experiment loops, which run it per step.
    return (await createEvaluator(options))(options);
}

export async function gatewayStatus(provider: EvaluationProviderId = "vercel") {
    let apiKey: string;
    try {
        apiKey = await resolveApiKey(provider);
    } catch (error) {
        logger.debug("Jev dashboard has no usable saved credential");
        return { configured: false, error: error instanceof Error ? error.message : "Run tools jev login." };
    }

    if (provider === "typesafe") {
        return { configured: true, provider, credentialOnly: true };
    }

    try {
        const gateway = createGateway({
            apiKey,
            fetch: Object.assign(
                (url: RequestInfo | URL, options?: RequestInit) =>
                    fetch(url, { ...options, signal: AbortSignal.timeout(10000) }),
                { preconnect: fetch.preconnect }
            ),
        });
        logger.debug({ url: "https://ai-gateway.vercel.sh/v1/credits" }, "Reading Jev gateway credit balance");
        const credits = await gateway.getCredits();
        return { configured: true, balance: credits.balance, totalUsed: credits.totalUsed };
    } catch (error) {
        return { configured: true, error: describeGatewayFailure({ error, timeoutMs: 10000, apiKey }) };
    }
}
