import { SafeJSON } from "@genesiscz/utils/json";
import { isObject } from "@genesiscz/utils/object";

/**
 * Claude Code's statusline input: the JSON document it pipes to the `statusLine` command on every render. It is not
 * a hook payload (`src/agents/lib/hooks/payload.ts` owns those), so it has its own owner here, under `src/utils/`
 * because the statusline renderer in `@genesiscz/utils` reads it too. Every statusline reads these typed fields,
 * never a raw key such as `transcript_path` (lint-rules `no-hook-payload-read`).
 */
export interface StatuslineInput {
    sessionId?: string;
    transcriptPath?: string;
    /** `workspace.current_dir`, else the top-level `cwd`. */
    cwd?: string;
    /** `workspace.project_dir`: the folder the session started in. */
    projectDir?: string;
    model?: { id?: string; displayName?: string };
    /** `cost.total_cost_usd`: what Claude Code itself counts for the session. */
    totalCostUsd?: number;
    /** `effort.level`. */
    effortLevel?: string;
    contextWindow?: StatuslineContextWindow;
    /** `agent.name`: set when the frame belongs to a subagent, not the main thread. */
    agentName?: string;
    raw: Record<string, unknown>;
}

export interface StatuslineContextWindow {
    totalInputTokens?: number;
    /** `context_window_size`. */
    size?: number;
    /** `current_usage`: the tokens of the last request, present only when Claude Code sends the block. */
    currentUsage?: { inputTokens?: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number };
}

function record(value: unknown): Record<string, unknown> | undefined {
    return isObject(value) ? value : undefined;
}

/** An empty string counts as absent: Claude Code sends `""` for a field it has no value for yet. */
function str(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function contextWindowOf(window: Record<string, unknown> | undefined): StatuslineContextWindow | undefined {
    if (!window) {
        return undefined;
    }

    const usage = record(window.current_usage);

    return {
        totalInputTokens: num(window.total_input_tokens),
        size: num(window.context_window_size),
        currentUsage: usage
            ? {
                  inputTokens: num(usage.input_tokens),
                  cacheCreationInputTokens: num(usage.cache_creation_input_tokens),
                  cacheReadInputTokens: num(usage.cache_read_input_tokens),
              }
            : undefined,
    };
}

/** The typed fields of an already parsed statusline document. Claude Code spells keys in snake_case; the camelCase twins are read too. */
export function statuslineInputFrom(raw: Record<string, unknown>): StatuslineInput {
    const workspace = record(raw.workspace);
    const model = record(raw.model);

    return {
        sessionId: str(raw.session_id) ?? str(raw.sessionId),
        transcriptPath: str(raw.transcript_path) ?? str(raw.transcriptPath),
        cwd: str(workspace?.current_dir) ?? str(raw.cwd),
        projectDir: str(workspace?.project_dir),
        model: model
            ? { id: str(model.id), displayName: str(model.display_name) ?? str(model.displayName) }
            : undefined,
        totalCostUsd: num(record(raw.cost)?.total_cost_usd),
        effortLevel: str(record(raw.effort)?.level),
        contextWindow: contextWindowOf(record(raw.context_window) ?? record(raw.contextWindow)),
        agentName: str(record(raw.agent)?.name),
        raw,
    };
}

/** The statusline document from stdin text, or null when it is empty, not JSON, or not an object. */
export function parseStatuslineInput(text: string): StatuslineInput | null {
    const trimmed = text.trim();

    if (!trimmed) {
        return null;
    }

    try {
        const raw = record(SafeJSON.parse(trimmed, { strict: true }));
        return raw ? statuslineInputFrom(raw) : null;
    } catch {
        // A statusline must render even when Claude Code sends something unexpected; the caller prints its fallback.
        return null;
    }
}
