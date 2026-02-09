/**
 * MCP adapter types for TypeScript diagnostics tool
 */

/**
 * Arguments for GetTsDiagnostics MCP tool
 */
export interface GetTsDiagnosticsArgs {
    files: string | string[] | unknown;
    showWarnings?: boolean;
    timeout?: number;
}

/**
 * Arguments for GetTsHover MCP tool
 */
export interface GetTsHoverArgs {
    file: string;
    line: number;
    character?: number;
    text?: string;
    includeRaw?: boolean;
    timeout?: number; // Timeout in seconds (default: 3)
}

/**
 * Response structure for GetTsHover MCP tool
 */
export interface GetTsHoverResponse {
    file: string;
    line: number;
    character: number;
    lineContent: string;
    hover: string;
    raw?: unknown;
}
