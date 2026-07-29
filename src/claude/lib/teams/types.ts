/** Claude Code agent-team models used by `tools claude teams`. */

export type TeammateBackend = "tmux" | "in-process" | "unknown";

export type TeammateLiveStatus = "running" | "idle" | "dead" | "not-logged-in" | "unknown";

export interface TeamMemberConfig {
    agentId: string;
    name: string;
    agentType?: string;
    model?: string;
    color?: string;
    prompt?: string;
    cwd?: string;
    joinedAt?: number;
    tmuxPaneId?: string;
    backendType?: string;
    isActive?: boolean;
    planModeRequired?: boolean;
    subscriptions?: unknown[];
}

export interface TeamConfigFile {
    name: string;
    description?: string;
    createdAt?: number;
    leadAgentId?: string;
    leadSessionId?: string;
    members: TeamMemberConfig[];
}

export interface TeammateLastMessage {
    role: "user" | "assistant" | "system" | "other";
    text: string;
    timestamp?: string;
    /** True when text is the lead's initial assignment (`<teammate-message>`). */
    isLeadAssignment?: boolean;
}

export interface TeammateTranscriptRef {
    sessionId: string;
    path: string;
    mtimeMs: number;
    hasLeadAssignment: boolean;
    lastMessage?: TeammateLastMessage;
    messageCount: number;
}

export interface LiveTeammateProcess {
    pid: number;
    cmdline: string;
    agentId: string;
    agentName: string;
    teamName: string;
    model?: string;
    parentSessionId?: string;
    tmuxSession?: string;
    tmuxPaneId?: string;
    tmuxPaneIndex?: number;
    account?: string;
}

export interface TeamMemberView {
    member: TeamMemberConfig;
    isLead: boolean;
    backend: TeammateBackend;
    status: TeammateLiveStatus;
    live?: LiveTeammateProcess;
    transcript?: TeammateTranscriptRef;
    /** Best one-line activity for the table. */
    activity: string;
}

export interface TeamView {
    /** Directory name under ~/.claude/teams (usually `session-<8hex>`). */
    teamName: string;
    configPath: string;
    config: TeamConfigFile;
    leadSessionId?: string;
    cwd?: string;
    projectDir?: string;
    mtimeMs: number;
    members: TeamMemberView[];
    /** Non-lead members only. */
    teammates: TeamMemberView[];
    lead?: TeamMemberView;
    /** Tmux session that currently hosts this team (if any). */
    tmuxSession?: string;
    leadPaneId?: string;
}
