import { LspWorker } from "@app/mcp-tsc/LspWorker.js";
import type {
    TSServer,
    DiagnosticsResult,
    DiagnosticsOptions,
    HoverResult,
    HoverPosition,
    HoverOptions,
} from "@app/mcp-tsc/core/interfaces.js";

export interface LspServerOptions {
    cwd: string;
    debug?: boolean;
}

/**
 * TypeScript diagnostics provider using Language Server Protocol.
 * Delegates to LspWorker for low-level LSP communication.
 * Preferred for incremental checks and hover information.
 */
export class LspServer implements TSServer {
    private worker: LspWorker;

    constructor(options: LspServerOptions) {
        this.worker = new LspWorker(options);
    }

    async initialize(): Promise<void> {
        await this.worker.start();
    }

    async getDiagnostics(files: string[], options?: DiagnosticsOptions): Promise<DiagnosticsResult> {
        return await this.worker.getDiagnostics(files, options);
    }

    async getHover(file: string, position: HoverPosition, options?: HoverOptions): Promise<HoverResult> {
        return await this.worker.getHover(file, position, options);
    }

    formatDiagnostics(result: DiagnosticsResult, showWarnings: boolean): string[] {
        return this.worker.formatDiagnostics(result, showWarnings);
    }

    async shutdown(): Promise<void> {
        await this.worker.shutdown();
    }

    /**
     * Get queue statistics (for debugging/monitoring)
     */
    getQueueStats(): { length: number; isProcessing: boolean } {
        return this.worker.getQueueStats();
    }
}
