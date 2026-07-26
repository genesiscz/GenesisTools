import { GrokAcpPool } from "@genesiscz/utils/ai/grok/acp";
import { extractJsonValue } from "@genesiscz/utils/ai/proxy/AiProxyClient";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { Runner, RunnerCall, RunnerResult } from "./types";

let sharedPool: GrokAcpPool | undefined;

export function getSharedGrokPool(size?: number): GrokAcpPool {
    if (!sharedPool) {
        sharedPool = new GrokAcpPool({ size });
    }

    return sharedPool;
}

export function shutdownSharedGrokPool(): void {
    sharedPool?.shutdown();
    sharedPool = undefined;
}

/**
 * Grok app-server harness: warm `grok agent stdio` leader(s) with auth-once ACP
 * pool (~4-5s/prompt vs ~14s for cold `grok -p`). Runs on the grok CLI's
 * default model — ACP has no per-prompt model override.
 */
export class GrokRunner implements Runner {
    readonly id: string;
    private readonly pool: GrokAcpPool;

    constructor(model?: string, options: { binPath?: string; poolSize?: number; pool?: GrokAcpPool } = {}) {
        this.pool =
            options.pool ??
            (options.binPath || options.poolSize
                ? new GrokAcpPool({ binPath: options.binPath, size: options.poolSize })
                : getSharedGrokPool());
        this.id = "grok:acp-default";

        if (model) {
            logger.warn({ model }, "GrokRunner: ACP runs the grok CLI default model; per-call model ignored");
        }
    }

    async call(input: RunnerCall): Promise<RunnerResult> {
        const started = performance.now();
        let prompt = `${input.system.trim()}\n\n${input.user.trim()}`;

        if (input.jsonSchema) {
            prompt +=
                `\n\nRespond ONLY with a JSON value valid against this JSON Schema (no prose, no code fences):\n` +
                SafeJSON.stringify(input.jsonSchema.schema, { strict: true });
        }

        const text = await this.pool.call(prompt, input.timeoutMs ?? 240_000);
        const result: RunnerResult = {
            text,
            elapsedMs: Math.round(performance.now() - started),
        };

        if (input.jsonSchema) {
            const { value, error } = extractJsonValue(text);
            result.parsed = value;
            result.parseError = error;
        }

        return result;
    }
}
