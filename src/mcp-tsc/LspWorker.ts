import { ChildProcess, spawn } from "child_process";
import { readFileSync, statSync } from "fs";
import path from "path";
import { JSONRPCEndpoint, LspClient } from "ts-lsp-client";

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

interface FileState {
    isOpen: boolean;
    version: number;
    content: string;
    modTime: number;
    diagnostics: any[];
    diagnosticsLastUpdated: number | null;
}

export interface LspWorkerOptions {
    cwd: string;
    debug?: boolean;
}

/**
 * Manages TypeScript Language Server lifecycle and diagnostics collection.
 * Can be used in both one-off mode (CLI) and persistent mode (MCP server).
 */
export class LspWorker {
    private lspProcess: ChildProcess | null = null;
    private endpoint: JSONRPCEndpoint | null = null;
    private client: LspClient | null = null;
    private files = new Map<string, FileState>(); // Consolidated file state
    private diagnosticsBarrier = 0; // Timestamp barrier - ignore diagnostics before this time
    private cwd: string;
    private debug: boolean;
    private initialized = false;

    private getFileState(uri: string): FileState | undefined {
        return this.files.get(uri);
    }

    private getOrCreateFileState(uri: string): FileState {
        let state = this.files.get(uri);
        if (!state) {
            state = {
                isOpen: false,
                version: 0,
                content: "",
                modTime: 0,
                diagnostics: [],
                diagnosticsLastUpdated: null,
            };
            this.files.set(uri, state);
        }
        return state;
    }

    constructor(options: LspWorkerOptions) {
        this.cwd = options.cwd;
        this.debug = options.debug ?? false;
    }

    private log(message: string): void {
        if (this.debug) {
            const now = new Date();
            const timestamp = `[${now.toLocaleString()}.${String(now.getMilliseconds()).padStart(3, "0")}]`;
            console.error(`${timestamp} ${message}`);
        }
    }

    /**
     * Start and initialize the LSP server if not already running
     */
    async start(): Promise<void> {
        if (this.initialized) {
            this.log("LSP already initialized, reusing...");
            return;
        }

        this.log("Starting LSP mode...");
        const startTime = Date.now();

        return new Promise<void>((resolve, reject) => {
            // Spawn typescript-language-server
            this.log("Spawning typescript-language-server...");
            this.lspProcess = spawn("typescript-language-server", ["--stdio"], {
                cwd: this.cwd,
                stdio: ["pipe", "pipe", "pipe"],
            });

            if (!this.lspProcess.stdin || !this.lspProcess.stdout) {
                reject(new Error("Failed to create LSP process streams"));
                return;
            }

            this.log(`Server spawned (cwd: ${this.cwd})`);

            // Create LSP client
            this.endpoint = new JSONRPCEndpoint(this.lspProcess.stdin, this.lspProcess.stdout);
            this.client = new LspClient(this.endpoint);

            // Listen for diagnostic notifications
            this.endpoint.on("textDocument/publishDiagnostics", (params: any) => {
                const uri = params.uri;
                const diagnostics = params.diagnostics || [];
                const filename = uri.split("/").pop() || uri;
                const now = Date.now();

                // Ignore diagnostics that arrive before the barrier (stale from close operations)
                if (now < this.diagnosticsBarrier) {
                    this.log(
                        `Ignoring stale diagnostics for ${filename}: ${diagnostics.length} items (before barrier)`
                    );
                    return;
                }

                this.log(`Received diagnostics for ${filename}: ${diagnostics.length} items`);
                const state = this.getOrCreateFileState(uri);
                state.diagnostics = diagnostics;
                state.diagnosticsLastUpdated = now;
            });

            this.lspProcess.stderr?.on("data", (data) => {
                this.log(`LSP stderr: ${data.toString().trim()}`);
            });

            this.lspProcess.on("error", (err) => {
                reject(new Error(`Failed to start typescript-language-server: ${err.message}`));
            });

            // Initialize the server
            (async () => {
                try {
                    this.log("Sending initialize request...");
                    await this.client!.initialize({
                        processId: process.pid,
                        rootUri: `file://${this.cwd}`,
                        capabilities: {
                            textDocument: {
                                publishDiagnostics: { relatedInformation: true },
                            },
                        },
                    });
                    this.log(`Initialized (${Date.now() - startTime}ms)`);

                    this.client!.initialized();
                    this.initialized = true;
                    resolve();
                } catch (error) {
                    reject(error);
                }
            })();
        });
    }

    /**
     * Get diagnostics for the specified files
     */
    async getDiagnostics(
        targetFiles: string[],
        options: { showWarnings?: boolean; maxWaitMs?: number } = {}
    ): Promise<DiagnosticsResult> {
        if (!this.initialized || !this.client) {
            throw new Error("LSP not initialized. Call start() first.");
        }

        const showWarnings = options.showWarnings ?? false;
        const maxWait = options.maxWaitMs ?? 30000;

        // Log which files are being checked
        const fileList = targetFiles.map((f) => `- ${path.relative(this.cwd, f) || f}`).join("\n");
        this.log(`Checking ${targetFiles.length} file(s):\n${fileList}`);

        // Check which files need updates (new files or changed files)
        // Use file modification times for faster change detection without reading content
        const filesToOpen: string[] = [];
        const filesToUpdate: string[] = [];

        for (const file of targetFiles) {
            const uri = `file://${file}`;
            const state = this.getFileState(uri);

            if (!state || !state.isOpen) {
                // File not open - needs to be opened
                filesToOpen.push(file);
            } else {
                // File is open - check if it changed using modification time
                try {
                    const stats = statSync(file);
                    const currentModTime = stats.mtimeMs;

                    if (state.modTime === 0 || currentModTime > state.modTime) {
                        // File changed on disk - needs update
                        filesToUpdate.push(file);
                    }
                } catch (error) {
                    // File might not exist anymore or stat failed - treat as changed
                    filesToUpdate.push(file);
                }
            }
        }

        if (filesToOpen.length > 0 || filesToUpdate.length > 0) {
            const openStart = Date.now();

            // Set barrier before opening/updating to ignore any stale diagnostics
            this.diagnosticsBarrier = Date.now();

            // Open new files
            if (filesToOpen.length > 0) {
                const openList = filesToOpen.map((f) => `- ${path.relative(this.cwd, f) || f}`).join("\n");
                this.log(`Opening ${filesToOpen.length} new file(s):\n${openList}`);
                for (const file of filesToOpen) {
                    const uri = `file://${file}`;
                    const content = readFileSync(file, "utf-8");
                    const languageId =
                        file.endsWith(".tsx") || file.endsWith(".jsx") ? "typescriptreact" : "typescript";

                    this.client.didOpen({
                        textDocument: {
                            uri,
                            languageId,
                            version: 1,
                            text: content,
                        },
                    });

                    const state = this.getOrCreateFileState(uri);
                    state.isOpen = true;
                    state.version = 1;
                    state.content = content;

                    // Store modification time
                    try {
                        const stats = statSync(file);
                        state.modTime = stats.mtimeMs;
                    } catch {
                        // Ignore stat errors
                    }

                    // Clear diagnostics for newly opened files
                    state.diagnostics = [];
                    state.diagnosticsLastUpdated = null;
                }
            }

            // Update changed files
            if (filesToUpdate.length > 0) {
                const updateList = filesToUpdate.map((f) => `- ${path.relative(this.cwd, f) || f}`).join("\n");
                this.log(`Updating ${filesToUpdate.length} changed file(s):\n${updateList}`);
                for (const file of filesToUpdate) {
                    const uri = `file://${file}`;
                    const content = readFileSync(file, "utf-8");
                    // State should exist since file was in filesToUpdate (was checked as open)
                    const state = this.getFileState(uri);

                    // Safety check: if state doesn't exist or file isn't actually open, open it instead
                    if (!state || !state.isOpen) {
                        const languageId =
                            file.endsWith(".tsx") || file.endsWith(".jsx") ? "typescriptreact" : "typescript";

                        this.client.didOpen({
                            textDocument: {
                                uri,
                                languageId,
                                version: 1,
                                text: content,
                            },
                        });

                        const fileState = this.getOrCreateFileState(uri);
                        fileState.isOpen = true;
                        fileState.version = 1;
                        fileState.content = content;

                        // Update modification time
                        try {
                            const stats = statSync(file);
                            fileState.modTime = stats.mtimeMs;
                        } catch {
                            // Ignore stat errors
                        }

                        // Clear diagnostics for newly opened files
                        fileState.diagnostics = [];
                        fileState.diagnosticsLastUpdated = null;
                    } else {
                        // File is open, send didChange notification
                        const newVersion = state.version + 1;
                        this.endpoint!.notify("textDocument/didChange", {
                            textDocument: {
                                uri,
                                version: newVersion,
                            },
                            contentChanges: [{ text: content }],
                        });
                        state.version = newVersion;
                        state.content = content;

                        // Update modification time
                        try {
                            const stats = statSync(file);
                            state.modTime = stats.mtimeMs;
                        } catch {
                            // Ignore stat errors
                        }

                        // Clear diagnostics for updated files
                        state.diagnostics = [];
                        state.diagnosticsLastUpdated = null;
                    }
                }
            }

            if (filesToOpen.length > 0) {
                const openedList = filesToOpen.map((f) => `- ${path.relative(this.cwd, f) || f}`).join("\n");
                this.log(`Files opened:\n${openedList}`);
            }
            if (filesToUpdate.length > 0) {
                const updatedList = filesToUpdate.map((f) => `- ${path.relative(this.cwd, f) || f}`).join("\n");
                this.log(`Files updated:\n${updatedList}`);
            }
            this.log(`Files opened/updated (${Date.now() - openStart}ms)`);
        } else {
            this.log(`All ${targetFiles.length} file(s) already open with current content`);
        }

        const filesToWaitFor = [...filesToOpen, ...filesToUpdate];

        // Wait for diagnostics if we opened or updated files
        if (filesToWaitFor.length > 0) {
            this.log("Waiting for diagnostics...");
            const waitStart = Date.now();
            const stabilityWindowMs = 50;
            const minWaitMs = 50;

            while (Date.now() - waitStart < maxWait) {
                const now = Date.now();

                // Check if all files have diagnostics
                const allFilesHaveDiagnostics = filesToWaitFor.every((file) => {
                    const uri = `file://${file}`;
                    const state = this.getFileState(uri);
                    return (
                        state !== undefined && state.diagnostics.length >= 0 && state.diagnosticsLastUpdated !== null
                    );
                });

                if (!allFilesHaveDiagnostics) {
                    await new Promise((r) => setTimeout(r, 100));
                    continue;
                }

                // Don't exit early if we haven't waited the minimum time
                if (now - waitStart < minWaitMs) {
                    await new Promise((r) => setTimeout(r, 100));
                    continue;
                }

                // Check if diagnostics have stabilized
                const allDiagnosticsStable = filesToWaitFor.every((file) => {
                    const uri = `file://${file}`;
                    const state = this.getFileState(uri);
                    return (
                        state !== undefined &&
                        state.diagnosticsLastUpdated !== null &&
                        now - state.diagnosticsLastUpdated >= stabilityWindowMs
                    );
                });

                if (allDiagnosticsStable) {
                    // Collect and format diagnostics for logging
                    const diagnosticsLines: string[] = [];
                    let totalErrors = 0;
                    let totalWarnings = 0;

                    for (const file of filesToWaitFor) {
                        const uri = `file://${file}`;
                        const state = this.getFileState(uri);
                        const diags = state?.diagnostics || [];
                        for (const d of diags) {
                            // Skip info/hint diagnostics
                            if (d.severity > 2) continue;

                            // Skip warnings unless showWarnings is true
                            if (d.severity === 2 && !showWarnings) continue;

                            const relativeFile = path.relative(this.cwd, file) || file;
                            const severityText = d.severity === 1 ? "error" : "warning";
                            const line = d.range.start.line + 1;
                            const character = d.range.start.character + 1;
                            const code = d.code || "";
                            diagnosticsLines.push(
                                `${relativeFile}:${line}:${character} - ${severityText} TS${code}: ${d.message}`
                            );

                            if (d.severity === 1) totalErrors++;
                            else if (d.severity === 2) totalWarnings++;
                        }
                    }

                    const statusSummary =
                        totalErrors === 0 && totalWarnings === 0
                            ? " - all files OK (no errors or warnings)"
                            : ` - ${totalErrors} error(s), ${totalWarnings} warning(s)`;

                    const diagnosticsOutput =
                        diagnosticsLines.length > 0
                            ? `\n${diagnosticsLines.map((line) => `  ${line}`).join("\n")}`
                            : "";

                    this.log(
                        `All diagnostics received and stable (${
                            Date.now() - waitStart
                        }ms)${statusSummary}${diagnosticsOutput}`
                    );
                    break;
                }

                await new Promise((r) => setTimeout(r, 100));
            }

            if (Date.now() - waitStart >= maxWait) {
                // Check which files are missing diagnostics
                const missingFiles: string[] = [];
                for (const file of filesToWaitFor) {
                    const uri = `file://${file}`;
                    const state = this.getFileState(uri);
                    if (!state || state.diagnosticsLastUpdated === null) {
                        missingFiles.push(file);
                    }
                }
                if (missingFiles.length > 0) {
                    const missingList = missingFiles.map((f) => `- ${path.relative(this.cwd, f) || f}`).join("\n");
                    this.log(
                        `Timeout waiting for diagnostics (${maxWait}ms) - missing diagnostics for:\n${missingList}`
                    );
                    // Throw error with timeout information for retry logic
                    const error: any = new Error(`Timeout waiting for diagnostics (${maxWait}ms)`);
                    error.isTimeout = true;
                    error.missingFiles = missingFiles;
                    throw error;
                } else {
                    this.log(`Timeout waiting for diagnostics (${maxWait}ms)`);
                }
            }
        } else {
            this.log("Using cached diagnostics from already-open files with current content");
        }

        // Process diagnostics
        let errors = 0;
        let warnings = 0;
        const allDiagnostics: TsDiagnostic[] = [];

        for (const file of targetFiles) {
            const uri = `file://${file}`;
            const state = this.getFileState(uri);
            const diagnostics = state?.diagnostics || [];

            for (const d of diagnostics) {
                allDiagnostics.push({
                    file,
                    line: d.range.start.line + 1,
                    character: d.range.start.character + 1,
                    severity: d.severity || 1,
                    code: d.code || "",
                    message: d.message,
                });

                if (d.severity === 1) {
                    errors++;
                } else if (d.severity === 2) {
                    warnings++;
                }
            }
        }

        // Log final summary if no files were opened/updated (using cached diagnostics)
        if (filesToWaitFor.length === 0) {
            const statusSummary =
                errors === 0 && warnings === 0
                    ? " - all files OK (no errors or warnings)"
                    : ` - ${errors} error(s), ${warnings} warning(s)`;
            this.log(`Diagnostics check complete${statusSummary}`);
        }

        // Sort diagnostics
        allDiagnostics.sort((a, b) => {
            if (a.file !== b.file) return a.file.localeCompare(b.file);
            if (a.line !== b.line) return a.line - b.line;
            return a.character - b.character;
        });

        return {
            errors,
            warnings,
            diagnostics: allDiagnostics,
        };
    }

    /**
     * Close files in the LSP to free memory (optional for persistent mode)
     */
    async closeFiles(files: string[]): Promise<void> {
        if (!this.client) return;

        for (const file of files) {
            const uri = `file://${file}`;
            this.client.didClose({
                textDocument: { uri },
            });
            const state = this.getFileState(uri);
            if (state) {
                state.isOpen = false;
                state.diagnostics = [];
                state.diagnosticsLastUpdated = null;
            }
        }
    }

    /**
     * Shutdown and cleanup the LSP server
     */
    async shutdown(): Promise<void> {
        if (!this.client || !this.lspProcess) {
            return;
        }

        try {
            this.log("Shutting down LSP server...");
            await this.client.shutdown();
            this.client.exit();
            this.lspProcess.kill();
            this.log("LSP server shutdown complete");
        } catch (error) {
            this.log(`Error during shutdown: ${error}`);
        } finally {
            this.lspProcess = null;
            this.endpoint = null;
            this.client = null;
            this.initialized = false;
            this.files.clear();
        }
    }

    /**
     * Get hover information at a specific position in a file
     */
    async getHover(file: string, position: { line: number; character: number }): Promise<HoverResult> {
        if (!this.initialized || !this.endpoint) {
            throw new Error("LSP not initialized. Call start() first.");
        }

        const uri = `file://${file}`;

        // Ensure file is open
        const state = this.getFileState(uri);
        if (!state || !state.isOpen) {
            const content = readFileSync(file, "utf-8");
            const languageId = file.endsWith(".tsx") || file.endsWith(".jsx") ? "typescriptreact" : "typescript";

            this.client!.didOpen({
                textDocument: {
                    uri,
                    languageId,
                    version: 1,
                    text: content,
                },
            });

            const fileState = this.getOrCreateFileState(uri);
            fileState.isOpen = true;
            fileState.version = 1;
            fileState.content = content;

            // Store modification time
            try {
                const stats = statSync(file);
                fileState.modTime = stats.mtimeMs;
            } catch {
                // Ignore stat errors
            }

            // Wait a bit for LSP to process the file
            await new Promise((r) => setTimeout(r, 100));
        }

        this.log(`Getting hover info for ${file} at line ${position.line}, character ${position.character}`);

        try {
            const response = (await this.endpoint.send("textDocument/hover", {
                textDocument: { uri },
                position: {
                    line: position.line - 1, // Convert from 1-based to 0-based
                    character: position.character - 1, // Convert from 1-based to 0-based
                },
            })) as RawHoverResponse | null;

            if (!response) {
                return { contents: "" };
            }

            this.log(`Raw hover response: ${JSON.stringify(response, null, 2)}`);

            let contents = "";
            if (typeof response.contents === "string") {
                contents = response.contents;
            } else if (Array.isArray(response.contents)) {
                contents = response.contents
                    .map((item) => (typeof item === "string" ? item : item.value || ""))
                    .join("\n");
            } else if (response.contents && typeof response.contents === "object" && "value" in response.contents) {
                contents = response.contents.value;
            }

            return {
                contents,
                range: response.range,
                raw: response, // Include full raw response for deeper inspection
            };
        } catch (error) {
            this.log(`Error getting hover info: ${error}`);
            throw error;
        }
    }

    /**
     * Format diagnostics for display
     */
    formatDiagnostics(result: DiagnosticsResult, showWarnings: boolean): string[] {
        const lines: string[] = [];

        for (const d of result.diagnostics) {
            // Skip info/hint diagnostics
            if (d.severity > 2) continue;

            // Skip warnings unless requested
            if (d.severity === 2 && !showWarnings) continue;

            const relativeFile = path.relative(this.cwd, d.file) || d.file;
            const severityText = d.severity === 1 ? "error" : "warning";
            lines.push(`${relativeFile}:${d.line}:${d.character} - ${severityText} TS${d.code}: ${d.message}`);
        }

        return lines;
    }
}
