import { logger } from "@genesiscz/utils/logger";
import { createGateway } from "ai";
import { resolveApiKey } from "./auth";
import { describeGatewayFailure } from "./errors";
import { createJevModel, evaluateState, evaluationSchema } from "./evaluate";

export interface EvaluationOptions {
    timeoutMs?: number;
    zeroDataRetention?: boolean;
    signal?: AbortSignal;
}

export async function evaluateRequest(options: EvaluationOptions & { input: unknown }) {
    const input = evaluationSchema.parse(options.input);
    const apiKey = await resolveApiKey();
    try {
        return await evaluateState({
            input,
            model: createJevModel(apiKey),
            timeoutMs: options.timeoutMs,
            zeroDataRetention: options.zeroDataRetention,
            signal: options.signal,
        });
    } catch (error) {
        if (options.signal?.aborted) {
            throw new Error("Evaluation stopped.");
        }

        const message = describeGatewayFailure({ error, timeoutMs: options.timeoutMs ?? 30000, apiKey });
        logger.warn({ message }, "Jev evaluation failed");
        throw new Error(message);
    }
}

export type EvaluationResponse = Awaited<ReturnType<typeof evaluateRequest>>;

export async function gatewayStatus() {
    let apiKey: string;
    try {
        apiKey = await resolveApiKey();
    } catch (error) {
        logger.debug("Jev dashboard has no usable saved credential");
        return { configured: false, error: error instanceof Error ? error.message : "Run tools jev login." };
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
