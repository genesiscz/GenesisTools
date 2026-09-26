import type { TranscriptTool } from "@genesiscz/utils/ai/transcripts";

// The tool families the hub's transcript groups calls by (Swift `TranscriptToolKind` in
// Hub/Stolen/Sessions/SessionTranscriptDocument.swift). Same names, same verbs, so a handoff reads
// like the transcript it summarises.

export const TOOL_KINDS = ["command", "read", "edit", "search", "web", "agent", "skill", "mcp", "other"] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

const KIND_BY_NAME: Record<string, ToolKind> = {
    Bash: "command",
    BashOutput: "command",
    KillShell: "command",
    Monitor: "command",
    commandExecution: "command",
    shell: "command",
    exec_command: "command",
    run_terminal_cmd: "command",
    Read: "read",
    NotebookRead: "read",
    read_file: "read",
    view: "read",
    Edit: "edit",
    Write: "edit",
    MultiEdit: "edit",
    NotebookEdit: "edit",
    apply_patch: "edit",
    edit_file: "edit",
    write_file: "edit",
    create_file: "edit",
    Grep: "search",
    Glob: "search",
    LS: "search",
    ToolSearch: "search",
    grep: "search",
    list_dir: "search",
    file_search: "search",
    WebSearch: "web",
    WebFetch: "web",
    web_search: "web",
    Task: "agent",
    Agent: "agent",
    Workflow: "agent",
    SendMessage: "agent",
    Skill: "skill",
};

export function toolKind(name: string): ToolKind {
    if (name.startsWith("mcp__")) {
        return "mcp";
    }

    return KIND_BY_NAME[name] ?? "other";
}

/** `mcp__genesis-tools__handoff_post` → `genesis-tools · handoff_post`. */
export function toolDisplayName(name: string): string {
    return name.startsWith("mcp__") ? name.slice(5).replaceAll("__", " · ") : name;
}

function summarizeKind(kind: ToolKind, count: number): string {
    const s = count === 1 ? "" : "s";

    switch (kind) {
        case "command":
            return `Ran ${count} command${s}`;
        case "read":
            return `Read ${count} file${s}`;
        case "edit":
            return `Changed ${count} file${s}`;
        case "search":
            return `${count} search${count === 1 ? "" : "es"}`;
        case "web":
            return `${count} web call${s}`;
        case "agent":
            return `${count} sub-agent${s}`;
        case "skill":
            return `${count} skill${s}`;
        case "mcp":
            return `${count} MCP call${s}`;
        case "other":
            return `${count} other tool${s}`;
    }
}

/** `Ran 3 commands · Read 2 files`, in family order. Empty for no calls. */
export function summarizeTools(tools: readonly TranscriptTool[]): string {
    const counts = new Map<ToolKind, number>();

    for (const tool of tools) {
        const kind = toolKind(tool.name);
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }

    return TOOL_KINDS.filter((kind) => counts.has(kind))
        .map((kind) => summarizeKind(kind, counts.get(kind) ?? 0))
        .join(" · ");
}

export function isFailedTool(tool: TranscriptTool): boolean {
    return tool.isError || (tool.exitCode ?? 0) !== 0;
}

/** The first line of a call's key argument, clipped to `max` characters. */
export function keyArgument(tool: TranscriptTool, max = 120): string {
    const first = tool.inputPreview.split("\n", 1)[0]?.trim() ?? "";
    return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}
