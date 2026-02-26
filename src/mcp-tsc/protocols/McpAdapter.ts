import { readFileSync } from "node:fs";
import path from "node:path";
import type { DiagnosticsResult, TSServer } from "@app/mcp-tsc/core/interfaces.js";
import type { GetTsDiagnosticsArgs, GetTsHoverArgs, GetTsHoverResponse } from "@app/mcp-tsc/types/mcp.js";
import { filterByTsconfig, resolveFiles } from "@app/mcp-tsc/utils/FileResolver.js";
import { normalizeFilePaths } from "@app/utils.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import ts from "typescript";

export interface McpAdapterOptions {
    server: TSServer; // The underlying TSServer implementation (always LspServer)
    cwd: string;
    timeout?: number; // Global timeout in seconds (default: 30)
}

/**
 * MCP protocol adapter that wraps a TSServer implementation.
 * This is NOT a diagnostic provider - it's a protocol layer that
 * exposes TSServer capabilities via the Model Context Protocol.
 *
 * Always uses LspServer as the underlying implementation because
 * LSP provides both diagnostics and hover capabilities efficiently.
 */
export class McpAdapter {
    private mcpServer: Server;
    private tsServer: TSServer;
    private cwd: string;
    private globalTimeout: number; // Global timeout in seconds

    constructor(options: McpAdapterOptions) {
        this.tsServer = options.server;
        this.cwd = options.cwd;
        this.globalTimeout = options.timeout ?? 30;

        this.mcpServer = new Server(
            {
                name: "typescript-diagnostics",
                version: "1.0.0",
            },
            {
                capabilities: {
                    tools: {},
                },
            }
        );

        this.setupHandlers();
    }

    private setupHandlers(): void {
        // Register tool list
        this.mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: [
                    {
                        name: "GetTsDiagnostics",
                        description:
                            "Get TypeScript diagnostics for files matching the specified patterns. Use instead of running any 'tsc' command which isnt for the full project",
                        inputSchema: {
                            type: "object",
                            properties: {
                                files: {
                                    oneOf: [
                                        { type: "string", description: "Single file path or glob pattern" },
                                        {
                                            type: "array",
                                            items: { type: "string" },
                                            description: "Array of file paths or glob patterns",
                                        },
                                    ],
                                    description:
                                        "File path(s) or glob pattern(s) to check. Examples: 'src/app.ts', 'src/**/*.ts', ['file1.ts', 'file2.ts']",
                                },
                                showWarnings: {
                                    type: "boolean",
                                    description: "Include warnings in addition to errors (default: false)",
                                },
                                timeout: {
                                    type: "number",
                                    description:
                                        "Timeout in seconds for diagnostics (overrides global --timeout option, default: 30)",
                                },
                            },
                            required: ["files"],
                        },
                    },
                    {
                        name: "GetTsHover",
                        description:
                            "Get TypeScript hover information (type definitions, documentation) for a specific location in a TypeScript file. Useful for introspecting types, function signatures, and variable definitions. Returns JSDoc comments, parameter descriptions, return types, and examples.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                file: {
                                    type: "string",
                                    description: "Path to the TypeScript file",
                                },
                                line: {
                                    type: "number",
                                    description: "Line number (1-based) to get hover information for",
                                },
                                character: {
                                    type: "number",
                                    description:
                                        "Character position (1-based) on the line. If not provided, will use the first non-whitespace character on the line.",
                                },
                                text: {
                                    type: "string",
                                    description:
                                        "Optional: Text to search for on the specified line. Will hover over the first occurrence of this text.",
                                },
                                includeRaw: {
                                    type: "boolean",
                                    description:
                                        "Optional: Include the raw LSP response with full structural data (default: false)",
                                },
                                timeout: {
                                    type: "number",
                                    description: "Timeout in seconds for hover (default: 3)",
                                },
                            },
                            required: ["file", "line"],
                        },
                    },
                ],
            };
        });

        // Register tool call handler
        this.mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
            const toolName = request.params.name;
            const args = request.params.arguments || {};

            if (toolName === "GetTsHover") {
                return await this.handleGetHover(args as unknown as GetTsHoverArgs);
            }

            if (toolName === "GetTsDiagnostics") {
                return await this.handleGetDiagnostics(args as unknown as GetTsDiagnosticsArgs);
            }

            return {
                isError: true,
                content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
            };
        });
    }

    private async handleGetDiagnostics(args: GetTsDiagnosticsArgs) {
        try {
            // Normalize file paths from various formats (string, array, JSON string, Python-style array)
            const filePatterns = normalizeFilePaths(args.files);
            const showWarnings: boolean = Boolean(args.showWarnings ?? false);
            // Use timeout from parameter if provided, otherwise use global timeout
            const timeoutSeconds = args.timeout !== undefined ? Number(args.timeout) : this.globalTimeout;
            const timeoutMs = timeoutSeconds * 1000; // Convert to milliseconds

            if (filePatterns.length === 0) {
                return {
                    isError: true,
                    content: [{ type: "text", text: "Error: files parameter is required" }],
                };
            }

            // Resolve files relative to MCP server's working directory
            const targetFiles = await resolveFiles(filePatterns, this.cwd);
            if (targetFiles.length === 0) {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: `No files found matching the specified patterns.\nSearched in: ${
                                this.cwd
                            }\nPatterns: ${JSON.stringify(filePatterns)}`,
                        },
                    ],
                };
            }

            // Filter by tsconfig
            const filteredFiles = filterByTsconfig(targetFiles, this.cwd);
            if (filteredFiles.length === 0) {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: `None of the matched files are included in tsconfig.json.\nFound ${
                                targetFiles.length
                            } file(s) but they are not in the TypeScript project.\nFiles found: ${targetFiles
                                .slice(0, 5)
                                .join(", ")}${targetFiles.length > 5 ? "..." : ""}`,
                        },
                    ],
                };
            }

            // Get diagnostics using TSServer
            let result: DiagnosticsResult;
            try {
                result = await this.tsServer.getDiagnostics(filteredFiles, {
                    showWarnings,
                    maxWaitMs: timeoutMs,
                });
            } catch (error) {
                // Handle timeout errors by instructing client to retry with lower timeout
                const timeoutError = error as Error & { isTimeout?: boolean; missingFiles?: string[] };
                if (timeoutError?.isTimeout && timeoutError?.missingFiles) {
                    const missingFilesList = timeoutError.missingFiles.map((f: string) => `  - ${f}`).join("\n");
                    const retryTimeoutSeconds = 5;
                    return {
                        isError: true,
                        content: [
                            {
                                type: "text",
                                text: `Timeout waiting for diagnostics (${timeoutMs}ms).

Missing diagnostics for the following file(s):
${missingFilesList}

Please retry with a lower timeout (e.g., timeout=${retryTimeoutSeconds}) to get faster feedback.`,
                            },
                        ],
                    };
                }
                // Re-throw other errors
                throw error;
            }

            const formattedLines = this.tsServer.formatDiagnostics(result, showWarnings);

            // Build response
            let summary = `Checked ${filteredFiles.length} file(s)\n`;
            if (result.errors === 0 && result.warnings === 0) {
                summary += "✓ No issues found";
            } else {
                if (result.errors > 0) {
                    summary += `✗ Found ${result.errors} error(s)`;
                }
                if (result.warnings > 0) {
                    summary += `${result.errors > 0 ? "\n" : ""}⚠ Found ${result.warnings} warning(s)`;
                }
            }

            const diagnosticsText = formattedLines.length > 0 ? `\n\n${formattedLines.join("\n")}` : "";

            return {
                content: [
                    {
                        type: "text",
                        text: summary + diagnosticsText,
                    },
                ],
            };
        } catch (error) {
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
            };
        }
    }

    private async handleGetHover(args: GetTsHoverArgs) {
        try {
            const filePath = args.file;
            const line = args.line;
            const charArg = args.character;
            const text = args.text;
            const includeRaw = args.includeRaw;
            // Default hover timeout is 3 seconds
            const timeoutSeconds = args.timeout !== undefined ? Number(args.timeout) : 3;
            const timeoutMs = timeoutSeconds * 1000;

            if (!filePath) {
                return {
                    isError: true,
                    content: [{ type: "text", text: "Error: file parameter is required" }],
                };
            }

            if (!line) {
                return {
                    isError: true,
                    content: [{ type: "text", text: "Error: line parameter is required" }],
                };
            }

            const absolutePath = path.resolve(this.cwd, filePath);
            if (!ts.sys.fileExists(absolutePath)) {
                return {
                    isError: true,
                    content: [{ type: "text", text: `Error: File not found: ${filePath}` }],
                };
            }

            // Read file to get line content
            const fileContent = readFileSync(absolutePath, "utf-8");
            const lines = fileContent.split("\n");
            if (line > lines.length) {
                return {
                    isError: true,
                    content: [
                        { type: "text", text: `Error: Line ${line} is out of range (file has ${lines.length} lines)` },
                    ],
                };
            }

            const lineContent = lines[line - 1];
            let character: number;

            // Smart position handling
            if (text) {
                const index = lineContent.indexOf(text);
                if (index === -1) {
                    return {
                        isError: true,
                        content: [{ type: "text", text: `Error: Text "${text}" not found on line ${line}` }],
                    };
                }
                character = index + 1;
            } else if (charArg !== undefined) {
                character = charArg;
            } else {
                // Find first non-whitespace character
                const match = lineContent.match(/\S/);
                character = match ? match.index! + 1 : 1;
            }

            // Get hover using TSServer with timeout
            const hover = await this.tsServer.getHover(absolutePath, { line, character }, { timeoutMs });

            // Build response object
            const response: GetTsHoverResponse = {
                file: filePath,
                line: line,
                character: character,
                lineContent: lineContent,
                hover: hover.contents,
            };

            if (includeRaw && hover.raw) {
                response.raw = hover.raw;
            }

            // Return as structured JSON text that clients can parse
            return {
                content: [
                    {
                        type: "text",
                        text: `\`\`\`json\n${JSON.stringify(response, null, 2)}\n\`\`\``,
                    },
                ],
            };
        } catch (error) {
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
            };
        }
    }

    async start(): Promise<void> {
        try {
            // Initialize underlying TSServer
            if (this.tsServer.initialize) {
                await this.tsServer.initialize();
            }

            // Start MCP server
            const transport = new StdioServerTransport();
            console.error("TypeScript Diagnostics MCP Server starting...");
            console.error("Connecting MCP server to transport...");
            await this.mcpServer.connect(transport);
            console.error("TypeScript Diagnostics MCP Server connected, should be running indefinitely...");
        } catch (error) {
            console.error("MCP Server failed to start:", error);
            throw error;
        }
    }

    async shutdown(): Promise<void> {
        if (this.tsServer.shutdown) {
            await this.tsServer.shutdown();
        }
    }
}
