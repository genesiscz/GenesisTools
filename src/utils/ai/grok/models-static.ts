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
    seed("grok-4.7", "high", "medium", "optional", "ok"),
    seed("grok-4.7-build-fast", "high", "fast", "reasoning", "ok"),
    seed("grok-4.6", "high", "medium", "optional", "ok"),
    seed("grok-4.5", "high", "medium", "optional", "ok"),
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
];
