import { ChildProcess, spawn } from "child_process";
import { readFileSync } from "fs";
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
    private diagnosticsMap = new Map<string, any[]>();
    private diagnosticsLastUpdated = new Map<string, number>(); // Track when diagnostics last changed
    private openFiles = new Set<string>(); // Track which files are currently open
    private fileVersions = new Map<string, number>(); // Track file versions for didChange
    private fileContents = new Map<string, string>(); // Track file contents to detect changes
    private diagnosticsBarrier = 0; // Timestamp barrier - ignore diagnostics before this time
    private cwd: string;
    private debug: boolean;
    private initialized = false;

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
                this.diagnosticsMap.set(uri, diagnostics);
                this.diagnosticsLastUpdated.set(uri, now);
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

        this.log(`Checking ${targetFiles.length} file(s)...`);

        // Check which files need updates (new files or changed files)
        const filesToOpen: string[] = [];
        const filesToUpdate: string[] = [];

        for (const file of targetFiles) {
            const uri = `file://${file}`;
            const content = readFileSync(file, "utf-8");

            if (!this.openFiles.has(uri)) {
                filesToOpen.push(file);
            } else if (this.fileContents.get(uri) !== content) {
                // File is open but content changed on disk
                filesToUpdate.push(file);
            }
        }

        if (filesToOpen.length > 0 || filesToUpdate.length > 0) {
            const openStart = Date.now();

            // Set barrier before opening/updating to ignore any stale diagnostics
            this.diagnosticsBarrier = Date.now();

            // Open new files
            if (filesToOpen.length > 0) {
                this.log(`Opening ${filesToOpen.length} new file(s)...`);
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
                    this.openFiles.add(uri);
                    this.fileVersions.set(uri, 1);
                    this.fileContents.set(uri, content);

                    // Clear diagnostics for newly opened files
                    this.diagnosticsMap.delete(uri);
                    this.diagnosticsLastUpdated.delete(uri);
                }
            }

            // Update changed files
            if (filesToUpdate.length > 0) {
                this.log(`Updating ${filesToUpdate.length} changed file(s)...`);
                for (const file of filesToUpdate) {
                    const uri = `file://${file}`;
                    const content = readFileSync(file, "utf-8");
                    const currentVersion = this.fileVersions.get(uri) || 1;
                    const newVersion = currentVersion + 1;

                    this.endpoint!.notify("textDocument/didChange", {
                        textDocument: {
                            uri,
                            version: newVersion,
                        },
                        contentChanges: [{ text: content }],
                    });
                    this.fileVersions.set(uri, newVersion);
                    this.fileContents.set(uri, content);

                    // Clear diagnostics for updated files
                    this.diagnosticsMap.delete(uri);
                    this.diagnosticsLastUpdated.delete(uri);
                }
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
                    return this.diagnosticsMap.has(uri);
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
                    const lastUpdate = this.diagnosticsLastUpdated.get(uri);
                    return lastUpdate && now - lastUpdate >= stabilityWindowMs;
                });

                if (allDiagnosticsStable) {
                    this.log(`All diagnostics received and stable (${Date.now() - waitStart}ms)`);
                    break;
                }

                await new Promise((r) => setTimeout(r, 100));
            }

            if (Date.now() - waitStart >= maxWait) {
                this.log(`Timeout waiting for diagnostics (${maxWait}ms)`);
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
            const diagnostics = this.diagnosticsMap.get(uri) || [];

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
            this.diagnosticsMap.delete(uri);
            this.diagnosticsLastUpdated.delete(uri);
            this.fileVersions.delete(uri);
            this.fileContents.delete(uri);
            this.openFiles.delete(uri); // Track that file is now closed
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
            this.diagnosticsMap.clear();
            this.diagnosticsLastUpdated.clear();
            this.fileVersions.clear();
            this.fileContents.clear();
            this.openFiles.clear();
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
