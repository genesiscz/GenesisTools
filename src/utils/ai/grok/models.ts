import { existsSync, readFileSync } from "node:fs";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { grokModelsCachePath } from "./paths";
import type { GrokModelRecord, GrokModelSpeed, GrokModelThinking, GrokModelVisibility } from "./types";

function seed(
    id: string,
    visibility: GrokModelVisibility,
    speed: GrokModelSpeed,
    thinking: GrokModelThinking,
    probeStatus?: GrokModelRecord["probeStatus"]
): GrokModelRecord {
    return {
        id,
        source: "static",
        visibility,
        speed,
        thinking,
        probeStatus,
    };
}

export const GROK_STATIC_CATALOG: GrokModelRecord[] = [
    seed("grok-build", "high", "slow", "reasoning", "ok"),
    seed("grok-composer-2.5-fast", "high", "fast", "reasoning", "ok"),
    seed("grok-build-0.1", "medium", "slow", "reasoning", "ok"),
    seed("grok-code-fast", "medium", "fast", "none", "ok"),
    seed("grok-code-fast-1", "medium", "fast", "none", "ok"),
    seed("grok-code-fast-1-0825", "medium", "fast", "none", "ok"),
    seed("grok-3", "medium", "medium", "optional", "ok"),
    seed("grok-3-mini", "medium", "fast", "none", "ok"),
    seed("grok-3-fast", "medium", "fast", "none", "ok"),
    seed("grok-3-fast-latest", "medium", "fast", "none", "ok"),
    seed("grok-3-mini-fast", "medium", "fast", "none", "ok"),
    seed("grok-3-mini-fast-latest", "medium", "fast", "none", "ok"),
    seed("grok-4", "medium", "medium", "optional", "ok"),
    seed("grok-4-fast", "medium", "fast", "none", "ok"),
    seed("grok-4-fast-reasoning", "medium", "medium", "reasoning", "ok"),
    seed("grok-4-fast-non-reasoning", "medium", "fast", "none", "ok"),
    seed("grok-4-0709", "medium", "medium", "optional", "ok"),
    seed("grok-4-1-fast", "medium", "fast", "none", "ok"),
    seed("grok-4-1-fast-reasoning", "medium", "medium", "reasoning", "ok"),
    seed("grok-4-1-fast-non-reasoning", "medium", "fast", "none", "ok"),
    seed("grok-latest", "medium", "medium", "optional", "ok"),
    seed("grok-4.3", "medium", "medium", "optional", "ok"),
    seed("grok-4.20", "medium", "medium", "optional", "ok"),
    seed("grok-4.20-multi-agent", "medium", "slow", "multi-agent", "ok"),
    seed("grok-4.20-0309", "medium", "medium", "optional", "ok"),
    seed("grok-4.20-0309-reasoning", "medium", "medium", "reasoning", "ok"),
    seed("grok-4.20-0309-non-reasoning", "medium", "fast", "none", "ok"),
    seed("grok-4.20-multi-agent-0309", "medium", "slow", "multi-agent", "ok"),
    seed("composer-2.5-fast", "low", "fast", "none", "fail"),
    seed("grok-composer-2.5", "low", "fast", "reasoning", "fail"),
    seed("grok-4.1-fast", "low", "fast", "none", "fail"),
    seed("grok-2", "low", "medium", "optional", "fail"),
    seed("grok-2-vision", "low", "medium", "optional", "fail"),
    seed("grok-beta", "low", "medium", "optional", "fail"),
    seed("grok-4-auto", "low", "medium", "optional", "fail"),
    seed("grok-build-latest", "low", "slow", "reasoning", "fail"),
];

export const GROK_PROBE_CANDIDATES = [
    ...GROK_STATIC_CATALOG.map((model) => model.id),
    "auto",
    "fast",
    "expert",
    "heavy",
    "grok-build-plan",
    "grok-build-fast",
];

export function inferModelSpeed(id: string): GrokModelSpeed {
    if (/fast|mini|composer|code-fast/i.test(id)) {
        return "fast";
    }

    if (/reasoning|multi-agent|grok-build/i.test(id)) {
        return "slow";
    }

    return "medium";
}

export function isGrokComposerModel(id: string): boolean {
    return /grok-composer(?:-2\.5)?(?:-fast)?$/i.test(id) || /^composer-2\.5(?:-fast)?$/i.test(id);
}

export function inferModelThinking(id: string): GrokModelThinking {
    if (/multi-agent/i.test(id)) {
        return "multi-agent";
    }

    if (isGrokComposerModel(id)) {
        return "reasoning";
    }

    if (/non-reasoning|code-fast|mini|fast/i.test(id)) {
        return "none";
    }

    if (/reasoning|grok-build/i.test(id)) {
        return "reasoning";
    }

    return "optional";
}

export function toProxyId(accountName: string, providerSlug: string, upstreamId: string): string {
    return `${accountName}/${providerSlug}/${upstreamId}`;
}

export function readModelsCache(path?: string): Record<string, unknown> {
    const cachePath = path ?? grokModelsCachePath();

    if (!existsSync(cachePath)) {
        return {};
    }

    try {
        const parsed = SafeJSON.parse(readFileSync(cachePath, "utf-8"));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            return {};
        }

        return parsed as Record<string, unknown>;
    } catch (err) {
        logger.debug({ err, cachePath }, "grok: failed to parse models cache");
        return {};
    }
}

export function enrichFromPickerCache(record: GrokModelRecord, cache: Record<string, unknown>): GrokModelRecord {
    const cached = cache[record.id];

    if (typeof cached !== "object" || cached === null) {
        return record;
    }

    const info = cached as {
        context_window?: number;
        api_backend?: string;
        agent_type?: string;
        hidden?: boolean;
    };

    return {
        ...record,
        context_window: info.context_window ?? record.context_window,
        api_backend: info.api_backend ?? record.api_backend,
        agent_type: info.agent_type ?? record.agent_type,
        hidden: info.hidden ?? record.hidden,
    };
}

export function mergeModelCatalog(
    picker: GrokModelRecord[],
    probed: GrokModelRecord[],
    staticCatalog: GrokModelRecord[] = GROK_STATIC_CATALOG
): GrokModelRecord[] {
    const byId = new Map<string, GrokModelRecord>();

    for (const record of staticCatalog) {
        byId.set(record.id, { ...record });
    }

    for (const record of probed) {
        const existing = byId.get(record.id);
        byId.set(record.id, existing ? { ...existing, ...record } : record);
    }

    for (const record of picker) {
        const existing = byId.get(record.id);
        byId.set(record.id, {
            ...(existing ?? record),
            ...record,
            source: "picker",
            visibility: "high",
        });
    }

    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
