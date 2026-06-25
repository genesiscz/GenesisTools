import { logger } from "@app/logger";
import pLimit from "p-limit";
import type { GrokSubscriptionClient } from "./client";
import {
    GROK_PROBE_CANDIDATES,
    GROK_STATIC_CATALOG,
    inferModelSpeed,
    inferModelThinking,
    mergeModelCatalog,
} from "./models";
import type { GrokModelRecord } from "./types";

export async function discoverPickerModels(client: GrokSubscriptionClient): Promise<GrokModelRecord[]> {
    const payload = (await client.getModels()) as { data?: Array<{ id?: string }> };
    const models = payload.data ?? [];

    return models
        .filter((item): item is { id: string } => typeof item.id === "string")
        .map((item) => ({
            id: item.id,
            source: "picker" as const,
            visibility: "high" as const,
            speed: inferModelSpeed(item.id),
            thinking: inferModelThinking(item.id),
            probeStatus: "ok" as const,
        }));
}

export async function probeModel(client: GrokSubscriptionClient, id: string): Promise<GrokModelRecord> {
    const result = await client.probeModel(id);
    const staticMeta = GROK_STATIC_CATALOG.find((model) => model.id === id);

    return {
        id,
        source: "probe",
        visibility: staticMeta?.visibility ?? (result.ok ? "medium" : "low"),
        speed: staticMeta?.speed ?? inferModelSpeed(id),
        thinking: staticMeta?.thinking ?? inferModelThinking(id),
        probeStatus: result.ok ? "ok" : "fail",
        httpCode: result.httpCode,
    };
}

export async function probeAllCandidates(
    client: GrokSubscriptionClient,
    options?: { concurrency?: number; candidates?: string[] }
): Promise<GrokModelRecord[]> {
    const requestedConcurrency = options?.concurrency ?? 4;
    const concurrency =
        requestedConcurrency === Number.POSITIVE_INFINITY ||
        (Number.isInteger(requestedConcurrency) && requestedConcurrency >= 1)
            ? requestedConcurrency
            : 4;
    const candidates = options?.candidates ?? GROK_PROBE_CANDIDATES;
    const limit = pLimit(concurrency);

    const results = await Promise.all(
        candidates.map((id) =>
            limit(async () => {
                try {
                    return await probeModel(client, id);
                } catch (error) {
                    logger.warn({ id, error }, "grok model probe failed");
                    return {
                        id,
                        source: "probe" as const,
                        visibility: "low" as const,
                        speed: inferModelSpeed(id),
                        thinking: inferModelThinking(id),
                        probeStatus: "fail" as const,
                    };
                }
            })
        )
    );

    return results;
}

export async function buildGrokModelCatalog(
    client: GrokSubscriptionClient,
    options?: { probe?: boolean; concurrency?: number }
): Promise<GrokModelRecord[]> {
    const picker = await discoverPickerModels(client);

    if (!options?.probe) {
        return mergeModelCatalog(picker, []);
    }

    const probed = await probeAllCandidates(client, { concurrency: options.concurrency });
    return mergeModelCatalog(picker, probed);
}
