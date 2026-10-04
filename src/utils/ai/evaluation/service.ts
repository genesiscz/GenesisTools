import { recordUsage } from "@genesiscz/utils/ai/usage";
import { currentCommand } from "@genesiscz/utils/cli/current-command";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { createGateway } from "ai";
import { resolveApiKey } from "./auth";
import { classifyEvaluationFailure, describeGatewayFailure, EvaluationError } from "./errors";
import { evaluationSchema } from "./evaluate";
import {
    type EvaluationCall,
    type EvaluationProvider,
    type EvaluationResponse,
    TypeSafeEvaluationProvider,
    VercelEvaluationProvider,
} from "./providers";
import { loadJevSettings } from "./settings";
import { JEV_USAGE_APP } from "./spend";
import {
    DEFAULT_EVALUATION_PROVIDER,
    type EvaluationOptions,
    type EvaluationProviderId,
    evaluationProviderSchema,
} from "./types";

export type { EvaluationOptions, EvaluationResponse };
/** `costUsd` is the list price `recordUsage` booked for the call; absent when the catalog has no rate. */
export type PricedEvaluationResponse = EvaluationResponse & { costUsd?: number };
export type Evaluator = (options: EvaluationCall) => Promise<PricedEvaluationResponse>;

const { log } = logger.scoped("jev-evaluate");
const prof = profiler.scope("jev-evaluate");

/**
 * Running totals for this process, written into every "Jev evaluation done" line so the last
 * line of any run states what the whole run spent. Reset only by process exit.
 */
const totals = { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unpricedCalls: 0, ms: 0 };

function summarizeAnswers(answers: EvaluationResponse["answers"]): Record<string, string> {
    const summary: Record<string, string> = {};
    for (const [id, answer] of Object.entries(answers)) {
        if (!answer) {
            continue;
        }

        if (answer.type === "choice") {
            const p = answer.probabilities?.[answer.choice];
            summary[id] = `choice ${answer.choice}${p === undefined ? "" : ` p=${p.toFixed(2)}`}`;
        } else if (answer.type === "boolean") {
            summary[id] = `bool p=${answer.probability.toFixed(2)}`;
        } else if (answer.type === "score") {
            summary[id] = `score ${answer.score}`;
        }
    }

    return summary;
}
export type EvaluationProviderFactory = (
    provider: EvaluationProviderId
) => Promise<{ adapter: EvaluationProvider; apiKey: string }>;

/**
 * An evaluator made on first use and kept for later calls. A failed creation (no key yet, an unreadable
 * vault) is not kept: the next call tries again, so `tools jev login` works without a server restart.
 */
export function lazyEvaluator(create: () => Promise<Evaluator>): () => Promise<Evaluator> {
    let pending: Promise<Evaluator> | undefined;
    return () => {
        pending ??= create().catch((error: unknown) => {
            pending = undefined;
            throw error;
        });
        return pending;
    };
}

export async function createEvaluator(options: EvaluationOptions = {}): Promise<Evaluator> {
    return createEvaluatorWithProviderFactory(options, async (provider) => {
        const apiKey = await resolveApiKey(provider);
        const adapter =
            provider === "vercel"
                ? new VercelEvaluationProvider(apiKey)
                : new TypeSafeEvaluationProvider({ apiKey, model: options.model });
        return { adapter, apiKey };
    });
}

export async function createEvaluatorWithProviderFactory(
    options: EvaluationOptions,
    createProvider: EvaluationProviderFactory
): Promise<Evaluator> {
    const defaultProvider = evaluationProviderSchema.parse(
        options.provider ?? (await loadJevSettings()).provider ?? DEFAULT_EVALUATION_PROVIDER
    );
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
        const questions = Object.keys(input.questions ?? {});
        log.debug({ provider, questions, timeoutMs: merged.timeoutMs ?? 30000 }, "Jev evaluation start");
        const stop = prof.start("evaluate");
        try {
            const response = await adapter.evaluate({ ...merged, provider, input });
            const ms = stop();
            const inputTokens = response.usage.inputTokens ?? 0;
            const outputTokens = response.usage.outputTokens ?? 0;
            totals.calls += 1;
            totals.inputTokens += inputTokens;
            totals.outputTokens += outputTokens;
            totals.ms += ms;
            // recordUsage never throws. It prices the call from the catalog and books it in the ledger
            // that `tools ai-spend jev` and the dashboard's spend block read, so its price is the one reported.
            // An explicit label wins; otherwise the running command (`jev listen`, `control fill`, ...).
            const label = merged.usageLabel ?? currentCommand();
            const booked = await recordUsage({
                app: JEV_USAGE_APP,
                accountId: `jev:${provider}`,
                provider: `jev-${provider}`,
                modelId: response.model,
                inputTokens,
                outputTokens,
                meta: { questions: questions.length, ...(label ? { label } : {}) },
            });
            if (booked.costUsd === undefined) {
                totals.unpricedCalls += 1;
            } else {
                totals.costUsd += booked.costUsd;
            }

            log.info(
                {
                    provider,
                    model: response.model,
                    questions,
                    answers: summarizeAnswers(response.answers),
                    usage: response.usage,
                    costUsd: booked.costUsd,
                    ms: Math.round(ms),
                    totals: { ...totals, ms: Math.round(totals.ms) },
                },
                "Jev evaluation done"
            );
            return { ...response, costUsd: booked.costUsd };
        } catch (error) {
            totals.failures += 1;
            stop();
            if (merged.signal?.aborted) {
                log.info({ provider, questions }, "Jev evaluation aborted by the caller");
                // The dashboard compares this exact message; keep it.
                throw new EvaluationError({ code: "cancelled", message: "Evaluation stopped." });
            }
            const message =
                provider === "vercel"
                    ? describeGatewayFailure({ error, timeoutMs: merged.timeoutMs ?? 30000, apiKey })
                    : describeTypeSafeFailure(error);
            const failure = classifyEvaluationFailure(error);
            logger.warn(
                { provider, message, code: failure.code, statusCode: failure.statusCode },
                "Jev evaluation failed"
            );
            throw new EvaluationError({ ...failure, message });
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
        ? `TypeSafe rejected the credential. Run ${toolCommand("jev login")} --provider typesafe.`
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
        return {
            configured: false,
            error: error instanceof Error ? error.message : `Run ${toolCommand("jev login")}.`,
        };
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
