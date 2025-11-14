/**
 * Core interfaces and types for tsc-single TypeScript diagnostics tool
 */

// ============================================================================
// Diagnostic Types
// ============================================================================

export interface TsDiagnostic {
    file: string;
    line: number;
    character: number;
    severity: number;
    code: string | number;
    message: string;
}

export interface DiagnosticsResult {
    errors: number;
    warnings: number;
    diagnostics: TsDiagnostic[];
}

export interface DiagnosticsOptions {
    showWarnings?: boolean;
    maxWaitMs?: number;
}

// ============================================================================
// Hover Types
// ============================================================================

export interface HoverContents {
    kind?: string;
    value: string;
}

export interface HoverRange {
    start: { line: number; character: number };
    end: { line: number; character: number };
}

export interface RawHoverResponse {
    contents: string | HoverContents | Array<string | HoverContents>;
    range?: HoverRange;
}

export interface HoverResult {
    contents: string;
    range?: HoverRange;
    raw?: RawHoverResponse | null;
}

export interface HoverPosition {
    line: number; // 1-based
    character: number; // 1-based
}

// ============================================================================
// CLI Types
// ============================================================================

export interface CliArgs {
    _: string[];
    mcp: boolean;
    diagnostics: boolean;
    hover: boolean;
    "use-tsc": boolean;
    warnings: boolean;
    raw: boolean;
    line?: string;
    char?: string;
    text?: string;
    root?: string;
    "kill-server": boolean;
    all: boolean;
    help: boolean;
}

export enum CommandType {
    MCP = "mcp",
    Diagnostics = "diagnostics",
    Hover = "hover",
    KillServer = "kill-server",
}

// ============================================================================
// Server Types
// ============================================================================

export interface ServerInfo {
    pid: number;
    cwd: string;
    started: number;
}

/**
 * Core interface that all TypeScript diagnostic providers must implement.
 * This abstraction allows switching between different checking strategies
 * (LSP-based, Compiler API, etc.) without changing consumer code.
 */
export interface TSServer {
    /**
     * Get diagnostics for the specified files
     */
    getDiagnostics(files: string[], options?: DiagnosticsOptions): Promise<DiagnosticsResult>;

    /**
     * Get hover information at a specific position
     */
    getHover(file: string, position: HoverPosition): Promise<HoverResult>;

    /**
     * Format diagnostics for display
     */
    formatDiagnostics(result: DiagnosticsResult, showWarnings: boolean): string[];

    /**
     * Lifecycle: Initialize the server if needed
     */
    initialize?(): Promise<void>;

    /**
     * Lifecycle: Clean shutdown
     */
    shutdown?(): Promise<void>;
}
