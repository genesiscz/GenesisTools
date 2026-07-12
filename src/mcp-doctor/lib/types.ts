export type Transport = "stdio" | "http" | "sse";

export type ConfigSource = "~/.claude.json" | ".mcp.json" | ".cursor/mcp.json";

export type Status = "ok" | "slow" | "timeout" | "error" | "invalid";

export interface StdioServer {
    name: string;
    transport: "stdio";
    source: ConfigSource;
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd?: string;
    overrides?: ConfigSource;
}

export interface RemoteServer {
    name: string;
    transport: "http" | "sse";
    source: ConfigSource;
    url: string;
    overrides?: ConfigSource;
}

export interface InvalidServer {
    name: string;
    transport: Transport;
    source: ConfigSource;
    invalidReason: string;
    overrides?: ConfigSource;
}

export type NormalizedServer = StdioServer | RemoteServer | InvalidServer;

export function isInvalidServer(s: NormalizedServer): s is InvalidServer {
    return "invalidReason" in s;
}

export interface ProbeResult {
    name: string;
    source: ConfigSource;
    transport: Transport;
    status: Status;
    latencyMs: number | null;
    toolCount: number;
    tools: string[];
    resourceCount: number;
    promptCount: number;
    serverInfo: { name: string; version: string } | null;
    error: string | null;
}

export interface DuplicateTool {
    tool: string;
    servers: string[];
}

export interface DoctorSummary {
    total: number;
    ok: number;
    slow: number;
    timeout: number;
    error: number;
    duplicateTools: number;
}

export interface DoctorReport {
    servers: ProbeResult[];
    duplicates: DuplicateTool[];
    summary: DoctorSummary;
}
