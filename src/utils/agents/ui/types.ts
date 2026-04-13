import type { FormatOptions } from "../formatters/types";
import type { AgentMessage, AgentSessionInfo } from "../types";

export interface MessageCardProps {
    message: AgentMessage;
    formatOptions?: FormatOptions;
    defaultExpanded?: boolean;
}

export interface SessionTimelineProps {
    messages: AgentMessage[];
    sessionInfo?: AgentSessionInfo;
    formatOptions?: FormatOptions;
}

export interface ToolCallCardProps {
    name: string;
    signature: string;
    diffLines?: string[];
    resultContent?: string;
    isError?: boolean;
    defaultExpanded?: boolean;
}

export interface DiffViewProps {
    lines: string[];
    filePath?: string;
    maxCollapsedLines?: number;
}

export interface ThinkingBlockProps {
    content: string;
    defaultExpanded?: boolean;
}

export interface SessionHeaderProps {
    sessionInfo: AgentSessionInfo;
}
