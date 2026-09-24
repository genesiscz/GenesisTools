/**
 * Model-facing types of the agent harness, ported 1:1 from Unreal Agent's `harness/llm`
 * (see UPSTREAM.md for the pinned commit).
 *
 * Field names keep the Go spelling (`CallID`, `Output`, ...) on purpose: the session files
 * written by the Go runner and by this port share one versioned JSON format, so a session
 * can move between the two, and the Go test corpus can be replayed against this code
 * without a renaming layer.
 */

export type Role = "user" | "assistant" | "system";

export type ItemType = "message" | "tool_call" | "tool_result" | "reasoning";

export interface Message {
    Role: Role;
    Text: string;
    Phase?: string;
}

export interface ToolCall {
    CallID: string;
    Name: string;
    Arguments: string;
}

export type ToolResultKind = "text" | "image";

export interface ToolResultOutput {
    Kind: ToolResultKind;
    Value: string;
}

export interface ToolResult {
    CallID: string;
    Output: ToolResultOutput[];
}

/** `Raw` is the provider's verbatim reasoning item, replayed unchanged (it may be encrypted). */
export interface Reasoning {
    Summary?: string[];
    Raw?: string;
}

export type Item =
    | { ProviderID?: string; Type: "message"; Data: Message }
    | { ProviderID?: string; Type: "tool_call"; Data: ToolCall }
    | { ProviderID?: string; Type: "tool_result"; Data: ToolResult }
    | { ProviderID?: string; Type: "reasoning"; Data: Reasoning };

export type ToolType = "function" | "hosted";

export interface Tool {
    Type: ToolType;
    Name: string;
    Description: string;
    Parameters: Record<string, unknown>;
}

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

const REASONING_EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
    return typeof value === "string" && REASONING_EFFORTS.has(value);
}

export interface Model {
    ID: string;
    MaxOutputTokens?: number;
    ReasoningEffort?: ReasoningEffort;
}

export interface Request {
    Model: Model;
    Input: Item[];
    Tools: Tool[];
}

export type StopReason = "complete" | "max_output_tokens" | "refused";

/** `InputTokens` includes the cached and cache-write counts; `OutputTokens` includes reasoning. */
export interface Usage {
    InputTokens: number;
    CachedInputTokens: number;
    CacheWriteInputTokens: number;
    OutputTokens: number;
    ReasoningTokens: number;
    Raw?: string;
}

export interface Failure {
    Code: string;
    Message: string;
}

export interface Response {
    ID: string;
    Stop: StopReason;
    Output?: Item[];
    Usage: Usage;
    Failure?: Failure;
}

export interface RequestOptions {
    CacheKey: string;
}

/** Sends one prepared request to a provider. Owns authentication, cancellation and provider errors. */
export interface Adapter {
    respond(request: Request, options: RequestOptions, signal: AbortSignal): Promise<Response>;
}

export function emptyUsage(): Usage {
    return { InputTokens: 0, CachedInputTokens: 0, CacheWriteInputTokens: 0, OutputTokens: 0, ReasoningTokens: 0 };
}
