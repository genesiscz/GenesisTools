#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { glob } from "glob";
import path from "path";
import ts from "typescript";
import { LspWorker, type DiagnosticsResult } from "./LspWorker.js";

// Get file arguments from command line
const args = process.argv.slice(2);

// Parse flags
const useMcp = args.includes("--mcp");
const useLsp = args.includes("--lsp");
const showWarnings = args.includes("--warnings");
const fileArgs = args.filter((arg) => !["--lsp", "--warnings", "--mcp"].includes(arg));

// Resolve file patterns to actual file paths
async function resolveFiles(patterns: string[], cwd: string = process.cwd()): Promise<string[]> {
    const files = new Set<string>();

    for (const pattern of patterns) {
        const absolutePath = path.resolve(cwd, pattern);

        // Check if it's a directory
        if (ts.sys.directoryExists(absolutePath)) {
            const dirPattern = path.join(pattern, "**/*.{ts,tsx,js,jsx}").replace(/\\/g, "/");
            const matches = await glob(dirPattern, {
                cwd: cwd,
                absolute: false,
                ignore: ["**/node_modules/**", "**/*.d.ts", "**/dist/**", "**/build/**"],
            });
            matches.forEach((file) => files.add(path.resolve(cwd, file)));
        }
        // Check if it's a glob pattern
        else if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[") || pattern.includes("{")) {
            const matches = await glob(pattern, {
                cwd: cwd,
                absolute: false,
                ignore: ["**/node_modules/**", "**/*.d.ts"],
            });
            matches.forEach((file) => files.add(path.resolve(cwd, file)));
        }
        // Check if it's a direct file path
        else if (ts.sys.fileExists(absolutePath)) {
            files.add(absolutePath);
        } else {
            console.warn(`Warning: File or directory not found: ${pattern}`);
        }
    }

    return Array.from(files);
}

// Filter files based on tsconfig
function filterByTsconfig(targetFiles: string[], cwd: string = process.cwd()): string[] {
    const configPath = ts.findConfigFile(cwd, ts.sys.fileExists, "tsconfig.json");
    if (!configPath) {
        console.error("tsconfig.json not found");
        return [];
    }

    const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(configPath));
    const tsconfigFiles = new Set(parsed.fileNames.map((f) => path.resolve(f)));

    return targetFiles.filter((f) => tsconfigFiles.has(path.resolve(f)));
}

// Helper to wrap array values
function wrapArray(value: unknown | string | string[] | undefined): string[] {
    if (!value) return [];
    return Array.isArray(value) ? value : [String(value)];
}

// Check files using TypeScript Compiler API
async function checkFilesWithCompilerAPI(
    targetFiles: string[],
    showWarnings: boolean,
    cwd: string = process.cwd()
): Promise<DiagnosticsResult> {
    const configPath = ts.findConfigFile(cwd, ts.sys.fileExists, "tsconfig.json");
    if (!configPath) {
        throw new Error("tsconfig.json not found");
    }

    const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(configPath));

    const program = ts.createProgram({
        rootNames: parsed.fileNames,
        options: parsed.options,
    });

    const targetDiagnostics: ts.Diagnostic[] = [];

    for (const file of targetFiles) {
        const sourceFile = program.getSourceFile(file);
        if (sourceFile) {
            const syntacticDiagnostics = program.getSyntacticDiagnostics(sourceFile);
            const semanticDiagnostics = program.getSemanticDiagnostics(sourceFile);
            targetDiagnostics.push(...syntacticDiagnostics, ...semanticDiagnostics);
        }
    }

    targetDiagnostics.sort((a, b) => {
        if (!a.file || !b.file) return 0;
        if (a.file.fileName !== b.file.fileName) {
            return a.file.fileName.localeCompare(b.file.fileName);
        }
        return (a.start ?? 0) - (b.start ?? 0);
    });

    let errors = 0;
    let warnings = 0;
    const diagnostics: any[] = [];

    for (const d of targetDiagnostics) {
        const file = d.file?.fileName ?? "";
        const { line, character } =
            d.file && d.start != null ? ts.getLineAndCharacterOfPosition(d.file, d.start) : { line: 0, character: 0 };
        const msg = ts.flattenDiagnosticMessageText(d.messageText, " ");

        const diagnostic = {
            file,
            line: line + 1,
            character: character + 1,
            severity: d.category === ts.DiagnosticCategory.Error ? 1 : 2,
            code: d.code,
            message: msg,
        };

        diagnostics.push(diagnostic);

        if (d.category === ts.DiagnosticCategory.Error) {
            errors++;
        } else if (d.category === ts.DiagnosticCategory.Warning) {
            warnings++;
        }
    }

    return { errors, warnings, diagnostics };
}

// ======================
// MCP SERVER MODE
// ======================

async function runMcpServer() {
    const rootDir = fileArgs[0] || process.cwd();
    const cwd = path.resolve(rootDir);

    console.error(`Starting TypeScript Diagnostics MCP Server (root: ${cwd})`);

    // Create MCP server
    const server = new Server(
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

    // Create persistent LSP worker
    const lspWorker = new LspWorker({ cwd, debug: true });

    // Start LSP on server initialization
    await lspWorker.start();

    // List available tools
    server.setRequestHandler(ListToolsRequestSchema, async () => {
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
                        },
                        required: ["files"],
                    },
                },
            ],
        };
    });

    // Handle tool calls
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const toolName = request.params.name;

        if (toolName !== "GetTsDiagnostics") {
            return {
                isError: true,
                content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
            };
        }

        try {
            const args = (request.params.arguments || {}) as any;
            const filePatterns = wrapArray(args.files);
            const showWarnings: boolean = Boolean(args.showWarnings ?? false);

            if (filePatterns.length === 0) {
                return {
                    isError: true,
                    content: [{ type: "text", text: "Error: files parameter is required" }],
                };
            }

            // Resolve files
            const targetFiles = await resolveFiles(filePatterns, cwd);
            if (targetFiles.length === 0) {
                return {
                    isError: true,
                    content: [{ type: "text", text: "No files found matching the specified patterns" }],
                };
            }

            // Filter by tsconfig
            const filteredFiles = filterByTsconfig(targetFiles, cwd);
            if (filteredFiles.length === 0) {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: `None of the matched files are included in tsconfig.json (${targetFiles.length} file(s) excluded)`,
                        },
                    ],
                };
            }

            // Get diagnostics using LSP
            const result = await lspWorker.getDiagnostics(filteredFiles, { showWarnings });
            const formattedLines = lspWorker.formatDiagnostics(result, showWarnings);
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

            const diagnosticsText = formattedLines.length > 0 ? "\n\n" + formattedLines.join("\n") : "";

            return {
                content: [
                    {
                        type: "text",
                        text: summary + diagnosticsText,
                    },
                ],
            };
        } catch (error: any) {
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: `Error: ${error.message}`,
                    },
                ],
            };
        }
    });

    // Cleanup on exit
    process.on("SIGINT", async () => {
        await lspWorker.shutdown();
        process.exit(0);
    });

    process.on("SIGTERM", async () => {
        await lspWorker.shutdown();
        process.exit(0);
    });

    // Start MCP server
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("TypeScript Diagnostics MCP Server running");
}

// ======================
// CLI MODE
// ======================

async function runCli() {
    if (fileArgs.length === 0) {
        console.error("Usage: tsc-single [--lsp] [--warnings] <file|directory|pattern> [...more]");
        console.error("");
        console.error("Options:");
        console.error("  --lsp        Use typescript-language-server for diagnostics");
        console.error("  --warnings   Show warnings in addition to errors");
        console.error("  --mcp        Run as MCP server");
        console.error("");
        console.error("Examples:");
        console.error("  tsc-single src/app.ts                    # single file");
        console.error("  tsc-single src                            # all TS files in src/");
        console.error("  tsc-single 'src/**/*.ts'                  # glob pattern (use quotes!)");
        console.error("  tsc-single --lsp src/app.ts               # use LSP for checking");
        console.error("  tsc-single --warnings src/app.ts          # show warnings too");
        console.error("  tsc-single --mcp /path/to/project         # run as MCP server");
        process.exit(1);
    }

    const cwd = process.cwd();
    const targetFiles = await resolveFiles(fileArgs, cwd);

    if (targetFiles.length === 0) {
        console.error("No files found matching the specified patterns");
        process.exit(1);
    }

    const filteredFiles = filterByTsconfig(targetFiles, cwd);

    if (filteredFiles.length === 0) {
        console.error("None of the matched files are included in tsconfig.json");
        console.error(`Matched ${targetFiles.length} file(s), but none are in the current TypeScript project`);
        process.exit(1);
    }

    if (filteredFiles.length < targetFiles.length) {
        console.log(`Note: ${targetFiles.length - filteredFiles.length} file(s) excluded (not in tsconfig.json)`);
    }

    console.log(`Checking ${filteredFiles.length} file(s)...`);

    let result: DiagnosticsResult;

    if (useLsp) {
        const lspWorker = new LspWorker({ cwd, debug: process.env.DEBUG === "1" });
        try {
            await lspWorker.start();
            result = await lspWorker.getDiagnostics(filteredFiles, { showWarnings });
            await lspWorker.shutdown();
        } catch (error) {
            await lspWorker.shutdown();
            throw error;
        }
    } else {
        result = await checkFilesWithCompilerAPI(filteredFiles, showWarnings, cwd);
    }

    // Display diagnostics
    const formattedLines = useLsp
        ? new LspWorker({ cwd }).formatDiagnostics(result, showWarnings)
        : result.diagnostics
              .filter((d) => d.severity <= 2 && (d.severity === 1 || showWarnings))
              .map((d) => {
                  const relativeFile = path.relative(cwd, d.file) || d.file;
                  const severityText = d.severity === 1 ? "error" : "warning";
                  return `${relativeFile}:${d.line}:${d.character} - ${severityText} TS${d.code}: ${d.message}`;
              });

    formattedLines.forEach((line) => console.log(line));

    // Summary
    console.log();
    if (result.errors === 0 && result.warnings === 0) {
        console.log("✓ No issues found");
    } else {
        if (result.errors > 0) {
            console.log(`✗ Found ${result.errors} error(s)`);
        }
        if (result.warnings > 0) {
            console.log(`⚠ Found ${result.warnings} warning(s)`);
        }
    }

    // Exit with error code if there were errors
    if (result.errors > 0) {
        process.exit(2);
    }
}

// ======================
// MAIN
// ======================

async function main() {
    if (useMcp) {
        await runMcpServer();
    } else {
        await runCli();
    }
}

main().catch((err) => {
    console.error("Error:", err);
    process.exit(2);
});
