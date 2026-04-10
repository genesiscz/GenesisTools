export type BlockType =
    | "text"
    | "thinking"
    | "tool-signature"
    | "tool-diff"
    | "tool-result"
    | "role-header"
    | "separator"
    | "code"
    | "image"
    | "metadata"
    | "agent-notification";

export interface FormattedBlock {
    type: BlockType;
    content: string;
    /** Additional lines for multi-line blocks (diff, code). */
    lines?: string[];
    meta?: BlockMeta;
}

export interface BlockMeta {
    role?: "user" | "assistant" | "system";
    toolName?: string;
    filePath?: string;
    language?: string;
    isError?: boolean;
    expandable?: boolean;
    timestamp?: Date;
    model?: string;
    agentId?: string;
    status?: string;
}

export interface FormatOptions {
    showThinking?: boolean;
    toolDetailLevel?: "signature" | "summary" | "full";
    toolInputMaxChars?: number;
    toolOutputMaxChars?: number;
    showRoleHeaders?: boolean;
    showTimestamps?: boolean;
}
