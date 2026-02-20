import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import logger from "@app/logger";
import { JSONRPCEndpoint, LspClient } from "ts-lsp-client";

// ============================================================================
// Types
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

export interface LspWorkerOptions {
    cwd: string;
    debug?: boolean;
}

interface FileState {
    isOpen: boolean;
    version: number;
    modTime: number;
    diagnostics: LspDiagnostic[];
    diagnosticsReceivedAt: number | null;
}

interface LspDiagnostic {
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    severity: number;
    code?: string | number;
    message: string;
}

// Error types for classification
export class LspError extends Error {
    constructor(
        message: string,
        public readonly code?: string,
        public readonly isRetryable: boolean = false
    ) {
        super(message);
        this.name = "LspError";
    }
}

export class LspTimeoutError extends LspError {
    constructor(
        message: string,
        public readonly timeoutMs: number,
        public readonly operation: string
    ) {
        super(message, "TIMEOUT", true);
        this.name = "LspTimeoutError";
    }
}

export class LspProtocolError extends LspError {
    constructor(
        message: string,
        public readonly originalError?: Error
    ) {
        super(message, "PROTOCOL", true);
        this.name = "LspProtocolError";
    }
}

// ============================================================================
// Request Queue
// ============================================================================

interface QueuedRequest<T> {
    id: number;
    execute: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (error: Error) => void;
    priority: number; // Lower = higher priority
    createdAt: number;
}

/**
 * Request queue that serializes LSP operations to prevent race conditions.
 * Supports priority ordering and timeout handling.
 */
class RequestQueue {
    private queue: QueuedRequest<unknown>[] = [];
    private processing = false;
    private requestId = 0;

    async enqueue<T>(execute: () => Promise<T>, priority: number = 10): Promise<T> {
        return new Promise((resolve, reject) => {
            const request: QueuedRequest<T> = {
                id: ++this.requestId,
                execute,
                resolve: resolve as (value: unknown) => void,
                reject,
                priority,
                createdAt: Date.now(),
            };

            // Insert in priority order (lower number = higher priority)
            const insertIndex = this.queue.findIndex((r) => r.priority > priority);
            if (insertIndex === -1) {
                this.queue.push(request as QueuedRequest<unknown>);
            } else {
                this.queue.splice(insertIndex, 0, request as QueuedRequest<unknown>);
            }

            this.processNext();
        });
    }

    private async processNext(): Promise<void> {
        if (this.processing || this.queue.length === 0) {
            return;
        }

        this.processing = true;
        const request = this.queue.shift()!;

        try {
            const result = await request.execute();
            request.resolve(result);
        } catch (error) {
            request.reject(error as Error);
        } finally {
            this.processing = false;
            // Process next request if any
            if (this.queue.length > 0) {
                setImmediate(() => this.processNext());
            }
        }
    }

    get length(): number {
        return this.queue.length;
    }

    get isProcessing(): boolean {
        return this.processing;
    }
}

// ============================================================================
// LspWorker
// ============================================================================

/**
 * Manages TypeScript Language Server lifecycle and operations.
 * Features:
 * - Request queuing for serialized execution
 * - Configurable timeouts for all operations
 * - Automatic retry with exponential backoff
 * - Proper error classification and logging
 */
export class LspWorker {
    private lspProcess: ChildProcess | null = null;
    private endpoint: JSONRPCEndpoint | null = null;
    private client: LspClient | null = null;
    private files = new Map<string, FileState>();
    private diagnosticsBarrier = 0;
    private cwd: string;
    private debug: boolean;
    private initialized = false;
    private requestQueue = new RequestQueue();

    // Configuration
    private readonly DEFAULT_DIAGNOSTICS_TIMEOUT_MS = 30000;
    private readonly DEFAULT_HOVER_TIMEOUT_MS = 3000;
    private readonly MAX_RETRIES = 2;
    private readonly RETRY_DELAY_MS = 500;
    private readonly DIAGNOSTICS_STABILITY_MS = 50;

    constructor(options: LspWorkerOptions) {
        this.cwd = options.cwd;
        this.debug = options.debug ?? false;
    }

    // ========================================================================
    // Logging
    // ========================================================================

    private log(message: string, level: "info" | "warn" | "error" | "debug" = "info", extra?: object): void {
        const logContext = {
            component: "mcp-tsc",
            subcomponent: "LspWorker",
            pid: process.pid,
            cwd: this.cwd,
            queueLength: this.requestQueue.length,
            ...extra,
        };

        if (this.debug || level === "error" || level === "warn") {
            switch (level) {
                case "error":
                    logger.error(logContext, message);
                    break;
                case "warn":
                    logger.warn(logContext, message);
                    break;
                case "debug":
                    logger.debug(logContext, message);
                    break;
                default:
                    logger.info(logContext, message);
            }
        }
    }

    // ========================================================================
    // Lifecycle
    // ========================================================================

    async start(): Promise<void> {
        if (this.initialized && this.isLspAlive()) {
            this.log("LSP already initialized and alive");
            return;
        }

        // If initialized but dead, cleanup first
        if (this.initialized) {
            this.log("LSP was initialized but process died, cleaning up...", "warn");
            await this.cleanup();
        }

        this.log("Starting LSP server...");
        const startTime = Date.now();

        return new Promise<void>((resolve, reject) => {
            this.lspProcess = spawn("typescript-language-server", ["--stdio"], {
                cwd: this.cwd,
                stdio: ["pipe", "pipe", "pipe"],
            });

            if (!this.lspProcess.stdin || !this.lspProcess.stdout) {
                reject(new LspError("Failed to create LSP process streams"));
                return;
            }

            this.endpoint = new JSONRPCEndpoint(this.lspProcess.stdin, this.lspProcess.stdout);
            this.client = new LspClient(this.endpoint);

            // Handle diagnostics notifications
            this.endpoint.on(
                "textDocument/publishDiagnostics",
                (params: { uri: string; diagnostics: LspDiagnostic[] }) => {
                    this.handleDiagnosticsNotification(params);
                }
            );

            // Handle stderr for debugging
            this.lspProcess.stderr?.on("data", (data) => {
                this.log(`LSP stderr: ${data.toString().trim()}`, "warn");
            });

            // Handle process errors
            this.lspProcess.on("error", (err) => {
                this.log(`LSP process error: ${err.message}`, "error", { error: err.message, stack: err.stack });
                this.initialized = false;
                reject(new LspError(`Failed to start typescript-language-server: ${err.message}`));
            });

            // Handle process exit
            this.lspProcess.on("exit", (code, signal) => {
                this.log(
                    `LSP process exited with code ${code}${signal ? ` (signal: ${signal})` : ""}`,
                    code === 0 ? "info" : "error",
                    { exitCode: code, signal }
                );
                this.initialized = false;
                this.files.clear();
            });

            // Initialize the server
            this.initializeLsp()
                .then(() => {
                    this.log(`LSP initialized in ${Date.now() - startTime}ms`);
                    this.initialized = true;
                    resolve();
                })
                .catch(reject);
        });
    }

    private async initializeLsp(): Promise<void> {
        if (!this.client) throw new LspError("LSP client not created");

        await this.client.initialize({
            processId: process.pid,
            rootUri: `file://${this.cwd}`,
            capabilities: {
                textDocument: {
                    publishDiagnostics: { relatedInformation: true },
                    hover: { contentFormat: ["markdown", "plaintext"] },
                },
            },
        });

        this.client.initialized();
    }

    private isLspAlive(): boolean {
        return this.lspProcess !== null && !this.lspProcess.killed && this.lspProcess.exitCode === null;
    }

    private async cleanup(): Promise<void> {
        if (this.lspProcess) {
            try {
                this.lspProcess.kill();
            } catch {
                // Ignore
            }
        }
        this.lspProcess = null;
        this.endpoint = null;
        this.client = null;
        this.initialized = false;
        this.files.clear();
    }

    async shutdown(): Promise<void> {
        if (!this.client || !this.lspProcess) return;

        try {
            this.log("Shutting down LSP server...");
            await this.client.shutdown();
            this.client.exit();
            this.lspProcess.kill();
            this.log("LSP server shutdown complete");
        } catch (error) {
            this.log(`Error during shutdown: ${error}`, "error");
        } finally {
            await this.cleanup();
        }
    }

    // ========================================================================
    // Diagnostics Handling
    // ========================================================================

    private handleDiagnosticsNotification(params: { uri: string; diagnostics: LspDiagnostic[] }): void {
        const { uri, diagnostics } = params;
        const now = Date.now();

        // Ignore stale diagnostics
        if (now < this.diagnosticsBarrier) {
            this.log(`Ignoring stale diagnostics for ${path.basename(uri)}`, "debug");
            return;
        }

        const state = this.getOrCreateFileState(uri);
        state.diagnostics = diagnostics;
        state.diagnosticsReceivedAt = now;

        this.log(`Received ${diagnostics.length} diagnostics for ${path.basename(uri)}`, "debug");
    }

    // ========================================================================
    // File State Management
    // ========================================================================

    private getFileState(uri: string): FileState | undefined {
        return this.files.get(uri);
    }

    private getOrCreateFileState(uri: string): FileState {
        let state = this.files.get(uri);
        if (!state) {
            state = {
                isOpen: false,
                version: 0,
                modTime: 0,
                diagnostics: [],
                diagnosticsReceivedAt: null,
            };
            this.files.set(uri, state);
        }
        return state;
    }

    private async openFile(file: string): Promise<void> {
        const uri = `file://${file}`;
        const content = readFileSync(file, "utf-8");
        const languageId = file.endsWith(".tsx") || file.endsWith(".jsx") ? "typescriptreact" : "typescript";

        this.client?.didOpen({
            textDocument: { uri, languageId, version: 1, text: content },
        });

        const state = this.getOrCreateFileState(uri);
        state.isOpen = true;
        state.version = 1;
        state.diagnostics = [];
        state.diagnosticsReceivedAt = null;

        try {
            state.modTime = statSync(file).mtimeMs;
        } catch {
            // Ignore
        }
    }

    private async updateFile(file: string): Promise<void> {
        const uri = `file://${file}`;
        const content = readFileSync(file, "utf-8");
        const state = this.getFileState(uri);

        if (!state || !state.isOpen) {
            await this.openFile(file);
            return;
        }

        // Clear old diagnostics
        state.diagnostics = [];
        state.diagnosticsReceivedAt = null;

        // Send didChange notification
        const newVersion = state.version + 1;
        this.endpoint?.notify("textDocument/didChange", {
            textDocument: { uri, version: newVersion },
            contentChanges: [{ text: content }],
        });
        state.version = newVersion;

        try {
            state.modTime = statSync(file).mtimeMs;
        } catch {
            // Ignore
        }
    }

    private fileNeedsUpdate(file: string): boolean {
        const uri = `file://${file}`;
        const state = this.getFileState(uri);

        if (!state || !state.isOpen) return true;

        try {
            const currentModTime = statSync(file).mtimeMs;
            return state.modTime === 0 || currentModTime > state.modTime;
        } catch {
            return true;
        }
    }

    // ========================================================================
    // Public API: getDiagnostics
    // ========================================================================

    async getDiagnostics(
        targetFiles: string[],
        options: { showWarnings?: boolean; maxWaitMs?: number } = {}
    ): Promise<DiagnosticsResult> {
        const maxWait = options.maxWaitMs ?? this.DEFAULT_DIAGNOSTICS_TIMEOUT_MS;

        // Enqueue with normal priority
        return this.requestQueue.enqueue(() => this.getDiagnosticsWithRetry(targetFiles, options, maxWait), 10);
    }

    private async getDiagnosticsWithRetry(
        targetFiles: string[],
        options: { showWarnings?: boolean; maxWaitMs?: number },
        maxWait: number,
        attempt: number = 1
    ): Promise<DiagnosticsResult> {
        try {
            return await this.getDiagnosticsInternal(targetFiles, options, maxWait);
        } catch (error) {
            const isRetryable = error instanceof LspError && error.isRetryable;
            const shouldRetry = isRetryable && attempt < this.MAX_RETRIES;

            this.log(`getDiagnostics failed (attempt ${attempt}/${this.MAX_RETRIES}): ${error}`, "error", {
                error: error instanceof Error ? error.message : String(error),
                isRetryable,
                willRetry: shouldRetry,
            });

            if (shouldRetry) {
                // Exponential backoff
                const delay = this.RETRY_DELAY_MS * 2 ** (attempt - 1);
                this.log(`Retrying in ${delay}ms...`);
                await new Promise((r) => setTimeout(r, delay));

                // If LSP died, restart it
                if (!this.isLspAlive()) {
                    this.log("LSP died, restarting...", "warn");
                    await this.start();
                }

                return this.getDiagnosticsWithRetry(targetFiles, options, maxWait, attempt + 1);
            }

            throw error;
        }
    }

    private async getDiagnosticsInternal(
        targetFiles: string[],
        options: { showWarnings?: boolean; maxWaitMs?: number },
        maxWait: number
    ): Promise<DiagnosticsResult> {
        // Ensure LSP is running
        if (!this.isLspAlive()) {
            await this.start();
        }

        if (!this.initialized || !this.client) {
            throw new LspError("LSP not initialized");
        }

        const showWarnings = options.showWarnings ?? false;

        // Determine which files need opening/updating
        const filesToProcess: string[] = [];
        for (const file of targetFiles) {
            if (this.fileNeedsUpdate(file)) {
                filesToProcess.push(file);
            }
        }

        // Process files that need updating
        if (filesToProcess.length > 0) {
            this.log(`Processing ${filesToProcess.length} file(s) for diagnostics`);
            this.diagnosticsBarrier = Date.now();

            for (const file of filesToProcess) {
                const uri = `file://${file}`;
                const state = this.getFileState(uri);
                if (!state || !state.isOpen) {
                    await this.openFile(file);
                } else {
                    await this.updateFile(file);
                }
            }
        }

        // Collect files missing diagnostics
        const filesMissingDiagnostics = targetFiles.filter((file) => {
            const uri = `file://${file}`;
            const state = this.getFileState(uri);
            return state?.isOpen && state.diagnosticsReceivedAt === null;
        });

        const filesToWaitFor = [...new Set([...filesToProcess, ...filesMissingDiagnostics])];

        // Wait for diagnostics if needed
        if (filesToWaitFor.length > 0) {
            await this.waitForDiagnostics(filesToWaitFor, maxWait);
        }

        // Collect and return diagnostics
        return this.collectDiagnostics(targetFiles, showWarnings);
    }

    private async waitForDiagnostics(files: string[], maxWaitMs: number): Promise<void> {
        const startTime = Date.now();
        const checkInterval = 50;

        while (Date.now() - startTime < maxWaitMs) {
            const allReady = files.every((file) => {
                const uri = `file://${file}`;
                const state = this.getFileState(uri);
                return state?.diagnosticsReceivedAt !== null;
            });

            if (allReady) {
                // Wait for stability
                const allStable = files.every((file) => {
                    const uri = `file://${file}`;
                    const state = this.getFileState(uri);
                    const receivedAt = state?.diagnosticsReceivedAt;
                    return (
                        receivedAt !== null &&
                        receivedAt !== undefined &&
                        Date.now() - receivedAt >= this.DIAGNOSTICS_STABILITY_MS
                    );
                });

                if (allStable) {
                    this.log(`Diagnostics stable after ${Date.now() - startTime}ms`);
                    return;
                }
            }

            await new Promise((r) => setTimeout(r, checkInterval));
        }

        // Timeout - identify missing files
        const missingFiles = files.filter((file) => {
            const uri = `file://${file}`;
            const state = this.getFileState(uri);
            return state?.diagnosticsReceivedAt === null;
        });

        if (missingFiles.length > 0) {
            // Close timed-out files so they can be reopened fresh
            for (const file of missingFiles) {
                const uri = `file://${file}`;
                const state = this.getFileState(uri);
                if (state?.isOpen) {
                    try {
                        this.client?.didClose({ textDocument: { uri } });
                    } catch {
                        // Ignore
                    }
                    state.isOpen = false;
                    state.diagnostics = [];
                    state.diagnosticsReceivedAt = null;
                }
            }

            const error = new LspTimeoutError(
                `Timeout waiting for diagnostics (${maxWaitMs}ms) for ${missingFiles.length} file(s)`,
                maxWaitMs,
                "getDiagnostics"
            );
            // @ts-expect-error - Add extra info for error handling
            error.missingFiles = missingFiles;
            // @ts-expect-error
            error.isTimeout = true;
            throw error;
        }
    }

    private collectDiagnostics(files: string[], _showWarnings: boolean): DiagnosticsResult {
        let errors = 0;
        let warnings = 0;
        const diagnostics: TsDiagnostic[] = [];

        for (const file of files) {
            const uri = `file://${file}`;
            const state = this.getFileState(uri);
            const fileDiagnostics = state?.diagnostics || [];

            for (const d of fileDiagnostics) {
                // Skip info/hint (severity > 2)
                if (d.severity > 2) continue;

                const diagnostic: TsDiagnostic = {
                    file,
                    line: d.range.start.line + 1,
                    character: d.range.start.character + 1,
                    severity: d.severity || 1,
                    code: d.code || "",
                    message: d.message,
                };

                diagnostics.push(diagnostic);

                if (d.severity === 1) errors++;
                else if (d.severity === 2) warnings++;
            }
        }

        // Sort by file, then line, then character
        diagnostics.sort((a, b) => {
            if (a.file !== b.file) return a.file.localeCompare(b.file);
            if (a.line !== b.line) return a.line - b.line;
            return a.character - b.character;
        });

        return { errors, warnings, diagnostics };
    }

    // ========================================================================
    // Public API: getHover
    // ========================================================================

    async getHover(
        file: string,
        position: { line: number; character: number },
        options: { timeoutMs?: number } = {}
    ): Promise<HoverResult> {
        const timeoutMs = options.timeoutMs ?? this.DEFAULT_HOVER_TIMEOUT_MS;

        // Enqueue with high priority (hover should be fast)
        return this.requestQueue.enqueue(() => this.getHoverWithRetry(file, position, timeoutMs), 5);
    }

    private async getHoverWithRetry(
        file: string,
        position: { line: number; character: number },
        timeoutMs: number,
        attempt: number = 1
    ): Promise<HoverResult> {
        try {
            return await this.getHoverInternal(file, position, timeoutMs);
        } catch (error) {
            const isRetryable = error instanceof LspError && error.isRetryable;
            const shouldRetry = isRetryable && attempt < this.MAX_RETRIES;

            this.log(`getHover failed (attempt ${attempt}/${this.MAX_RETRIES}): ${error}`, "error", {
                error: error instanceof Error ? error.message : String(error),
                isRetryable,
                willRetry: shouldRetry,
                file: path.basename(file),
                position,
            });

            if (shouldRetry) {
                const delay = this.RETRY_DELAY_MS * 2 ** (attempt - 1);
                this.log(`Retrying hover in ${delay}ms...`);
                await new Promise((r) => setTimeout(r, delay));

                if (!this.isLspAlive()) {
                    this.log("LSP died, restarting...", "warn");
                    await this.start();
                }

                return this.getHoverWithRetry(file, position, timeoutMs, attempt + 1);
            }

            throw error;
        }
    }

    private async getHoverInternal(
        file: string,
        position: { line: number; character: number },
        timeoutMs: number
    ): Promise<HoverResult> {
        if (!this.isLspAlive()) {
            await this.start();
        }

        if (!this.initialized || !this.endpoint) {
            throw new LspError("LSP not initialized");
        }

        const uri = `file://${file}`;

        // Ensure file is open
        const state = this.getFileState(uri);
        if (!state || !state.isOpen) {
            await this.openFile(file);
            // Give LSP a moment to process
            await new Promise((r) => setTimeout(r, 100));
        } else if (this.fileNeedsUpdate(file)) {
            await this.updateFile(file);
            await new Promise((r) => setTimeout(r, 100));
        }

        this.log(`Getting hover for ${path.basename(file)} at ${position.line}:${position.character}`, "debug");

        // Create timeout promise
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => {
                reject(new LspTimeoutError(`Hover timeout after ${timeoutMs}ms`, timeoutMs, "getHover"));
            }, timeoutMs);
        });

        // Send hover request with timeout
        try {
            const response = await Promise.race([
                this.endpoint.send("textDocument/hover", {
                    textDocument: { uri },
                    position: {
                        line: position.line - 1,
                        character: position.character - 1,
                    },
                }) as Promise<RawHoverResponse | null>,
                timeoutPromise,
            ]);

            if (!response) {
                return { contents: "" };
            }

            return this.parseHoverResponse(response);
        } catch (error) {
            // Classify error
            if (error instanceof LspTimeoutError) {
                throw error;
            }

            // Check for protocol errors
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (
                errorMessage.includes("protocol") ||
                errorMessage.includes("closed") ||
                errorMessage.includes("socket")
            ) {
                throw new LspProtocolError(`LSP protocol error: ${errorMessage}`, error as Error);
            }

            throw new LspError(`Hover failed: ${errorMessage}`);
        }
    }

    private parseHoverResponse(response: RawHoverResponse): HoverResult {
        let contents = "";

        if (typeof response.contents === "string") {
            contents = response.contents;
        } else if (Array.isArray(response.contents)) {
            contents = response.contents.map((item) => (typeof item === "string" ? item : item.value || "")).join("\n");
        } else if (response.contents && typeof response.contents === "object" && "value" in response.contents) {
            contents = response.contents.value;
        }

        return {
            contents,
            range: response.range,
            raw: response,
        };
    }

    // ========================================================================
    // Utility Methods
    // ========================================================================

    async closeFiles(files: string[]): Promise<void> {
        if (!this.client) return;

        for (const file of files) {
            const uri = `file://${file}`;
            try {
                this.client.didClose({ textDocument: { uri } });
            } catch {
                // Ignore
            }
            const state = this.getFileState(uri);
            if (state) {
                state.isOpen = false;
                state.diagnostics = [];
                state.diagnosticsReceivedAt = null;
            }
        }
    }

    formatDiagnostics(result: DiagnosticsResult, showWarnings: boolean): string[] {
        const lines: string[] = [];

        for (const d of result.diagnostics) {
            if (d.severity > 2) continue;
            if (d.severity === 2 && !showWarnings) continue;

            const relativeFile = path.relative(this.cwd, d.file) || d.file;
            const severityText = d.severity === 1 ? "error" : "warning";
            lines.push(`${relativeFile}:${d.line}:${d.character} - ${severityText} TS${d.code}: ${d.message}`);
        }

        return lines;
    }

    // For testing/debugging
    getQueueStats(): { length: number; isProcessing: boolean } {
        return {
            length: this.requestQueue.length,
            isProcessing: this.requestQueue.isProcessing,
        };
    }
}
