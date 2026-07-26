/**
 * Runner = one way to execute a single model call for a pipeline stage.
 * AiProxyRunner is the default; ClaudeCodeRunner/GrokRunner shell out to the
 * respective CLI harnesses. No account/profile names are hardcoded anywhere —
 * everything comes in via RunnerSpec (CLI flags / config).
 */
import type { JsonSchemaSpec } from "@genesiscz/utils/ai/proxy/AiProxyClient";

export interface RunnerCall {
    system: string;
    user: string;
    maxTokens?: number;
    timeoutMs?: number;
    jsonSchema?: JsonSchemaSpec;
    /** Reasoning effort passthrough; overrides the runner-level default. */
    effort?: ReasoningEffort;
    /** Job label recorded on the proxy transcript, e.g. "extract-window-3". */
    label?: string;
    /** Abort if the model goes quiet for this long AFTER it started emitting (default 60s). */
    stallMs?: number;
    /** Abort if the model emits nothing at all for this long (default 90s — silent thinking). */
    firstOutputMs?: number;
}

/** OpenAI-style `reasoning_effort`; grok-4.5 at "low" answers ~3x faster than default. */
export type ReasoningEffort = "low" | "medium" | "high";

export interface RunnerResult {
    text: string;
    /** Parsed JSON when jsonSchema was requested and parsing succeeded. */
    parsed?: unknown;
    parseError?: string;
    elapsedMs: number;
    /** Usage as reported by the backend (never persisted by the runner). */
    usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

export interface Runner {
    /** Identifier recorded in stage-run manifests, e.g. "ai-proxy:martin/grok/grok-4.5". */
    readonly id: string;
    call(input: RunnerCall): Promise<RunnerResult>;
}

export interface RunnerSpec {
    /** "ai-proxy" (default) | "claude-code" | "grok" */
    backend?: "ai-proxy" | "claude-code" | "grok";
    /** Model id — for ai-proxy the proxy model id (account/provider/model or unambiguous bare id). */
    model: string;
    /** claude-code backend: `tools cc run <profile>` profile; never defaulted. */
    ccProfile?: string;
    /** grok backend: grok binary path override. */
    grokBin?: string;
    /** grok backend: number of warm ACP leader processes (default 1). */
    grokPoolSize?: number;
    /** Reasoning effort for every call this runner makes (ai-proxy backend). */
    effort?: ReasoningEffort;
}
