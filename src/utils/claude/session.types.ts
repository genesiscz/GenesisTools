/** Options for extracting plain text from session messages. */
export interface ExtractTextOptions {
    /** Include tool result content in the extracted text. Default: false */
    includeToolResults?: boolean;
    /** Include thinking/reasoning blocks. Default: false */
    includeThinking?: boolean;
    /** Include system messages (errors, stop hooks). Default: false */
    includeSystemMessages?: boolean;
    /** Prefix tool calls with their name (e.g. "[Edit]"). Default: true */
    includeToolNames?: boolean;
    /** Maximum character length for the returned string. */
    maxLength?: number;
}

/** Options for preparing session content for an LLM prompt. */
export interface PromptContentOptions {
    /** Maximum token budget for the prepared content. */
    tokenBudget: number;
    /** Content selection strategy when the session exceeds the budget. */
    priority: "balanced" | "user-first" | "assistant-first" | "summary-first";
    /** Include tool result blocks. Default: false */
    includeToolResults?: boolean;
    /** Include thinking/reasoning blocks. Default: false */
    includeThinking?: boolean;
    /** Prefix each message with its ISO timestamp. Default: false */
    includeTimestamps?: boolean;
}

/** Result of `toPromptContent()` — token-budgeted session transcript. */
export interface PreparedContent {
    /** The formatted transcript string. */
    content: string;
    /** Estimated token count of `content`. */
    tokenCount: number;
    /** Whether the content was truncated to fit the budget. */
    truncated: boolean;
    /** Human-readable description of what was truncated. */
    truncationInfo: string;
    /** Summary statistics for the prepared content. */
    stats: {
        userMessages: number;
        assistantMessages: number;
        toolCalls: number;
        filesModified: string[];
    };
}

/** Aggregated statistics for a session. */
export interface SessionStats {
    /** Total number of JSONL entries (all types). */
    messageCount: number;
    /** Number of user-role messages. */
    userMessageCount: number;
    /** Number of assistant-role messages. */
    assistantMessageCount: number;
    /** Number of system messages (errors, stop hooks, etc.). */
    systemMessageCount: number;
    /** Number of subagent messages. */
    subagentMessageCount: number;
    /** Number of progress messages. */
    progressMessageCount: number;
    /** Number of PR link messages. */
    prLinkCount: number;
    /** Total number of tool_use blocks across all assistant and subagent messages. */
    toolCallCount: number;
    /** Tool name -> invocation count. */
    toolUsage: Record<string, number>;
    /** Aggregated API token usage from assistant message metadata. */
    tokenUsage: { input: number; output: number; cached: number };
    /** Distinct model IDs seen in assistant messages. */
    modelsUsed: string[];
    /** Unique file paths referenced in tool calls. */
    filesModified: string[];
    /** Duration in milliseconds between first and last timestamp. */
    duration: number;
    /** Earliest message timestamp. */
    firstTimestamp: Date | null;
    /** Latest message timestamp. */
    lastTimestamp: Date | null;
}

/** Lightweight metadata for a discovered session file (no full parse). */
export interface SessionInfo {
    filePath: string;
    sessionId: string | null;
    title: string | null;
    summary: string | null;
    gitBranch: string | null;
    project: string | null;
    startDate: Date | null;
    fileSize: number;
    messageCount: number;
    isSubagent: boolean;
}

/** Options for `ClaudeSession.findSessions()`. */
export interface SessionDiscoveryOptions {
    /** Project name (directory basename) to scope to. */
    project?: string;
    /** Search all project dirs under ~/.claude/projects/. Default: false (current project only). */
    allProjects?: boolean;
    /** Only include sessions starting on or after this date. */
    since?: Date;
    /** Only include sessions starting on or before this date. */
    until?: Date;
    /** Include subagent sessions. Default: false */
    includeSubagents?: boolean;
    /** Maximum number of sessions to return. */
    limit?: number;
}

/** Summary of a single tool invocation. */
export interface ToolCallSummary {
    /** Tool name (e.g. "Edit", "Bash"). */
    name: string;
    /** Full input object passed to the tool. */
    input: Record<string, unknown>;
    /** File path argument, if the tool accepts one. */
    filePath?: string;
    /** ISO timestamp of the parent message (if available). */
    timestamp?: string;
}

/** Tail target — session or agent JSONL file resolved for tailing. */
export interface TailTarget {
    filePath: string;
    label: string;
    sessionId: string;
    agentId?: string;
    agentDescription?: string;
    isAgent: boolean;
}

/** Agent meta.json schema. */
export interface AgentMeta {
    agentType: string;
    description: string;
}
