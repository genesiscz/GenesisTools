// src/utils/macos/darwinkit.ts

import logger from "@app/logger";
import type { CapabilitiesResult, DarwinKitConfig, JsonRpcRequest, JsonRpcResponse } from "./types";

type PendingEntry = {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
};

export class DarwinKitClient {
    private proc: Bun.PipedSubprocess | null = null;
    private pending = new Map<string, PendingEntry>();
    private nextId = 1;
    private startPromise: Promise<void> | null = null;
    private config: Required<DarwinKitConfig>;
    private lineBuffer = "";

    constructor(config: DarwinKitConfig = {}) {
        this.config = {
            timeout: config.timeout ?? 15_000,
            startupTimeout: config.startupTimeout ?? 8_000,
            binaryPath: config.binaryPath ?? "darwinkit",
        };
    }

    /** Ensure the subprocess is running. Idempotent — safe to call multiple times. */
    async start(): Promise<void> {
        if (this.startPromise) {
            return this.startPromise;
        }
        this.startPromise = this._doStart();
        return this.startPromise;
    }

    private async _ensureInstalled(): Promise<void> {
        const which = Bun.spawnSync(["which", this.config.binaryPath]);
        if (which.exitCode === 0) {
            return;
        }

        logger.info("DarwinKitClient: darwinkit not found, installing...");
        console.log("  Installing darwinkit...");

        const downloadUrl =
            "https://github.com/0xMassi/darwinkit/releases/latest/download/darwinkit-macos-universal.tar.gz";
        const installDir = `${process.env.HOME}/.local/bin`;

        // Try direct binary download first (no sudo needed)
        const download = Bun.spawnSync(
            ["bash", "-c", `mkdir -p "${installDir}" && curl -fsSL "${downloadUrl}" | tar xz -C "${installDir}"`],
            { stdio: ["ignore", "pipe", "pipe"] }
        );

        if (download.exitCode === 0) {
            logger.info(`DarwinKitClient: installed to ${installDir}/darwinkit`);
            this.config.binaryPath = `${installDir}/darwinkit`;
            return;
        }

        // Fallback: try Homebrew tap
        const tap = Bun.spawnSync(["brew", "tap", "0xMassi/darwinkit"], {
            stdio: ["ignore", "pipe", "pipe"],
        });

        if (tap.exitCode === 0) {
            const install = Bun.spawnSync(["brew", "install", "darwinkit"], {
                stdio: ["inherit", "inherit", "inherit"],
            });

            if (install.exitCode === 0) {
                logger.info("DarwinKitClient: darwinkit installed via Homebrew");
                return;
            }
        }

        throw new Error(
            "Failed to install darwinkit. Install manually:\n" +
                `  curl -fsSL ${downloadUrl} | tar xz\n` +
                '  mv darwinkit ~/.local/bin/ && export PATH="$HOME/.local/bin:$PATH"'
        );
    }

    private async _doStart(): Promise<void> {
        await this._ensureInstalled();
        logger.debug("DarwinKitClient: spawning darwinkit serve");

        this.proc = Bun.spawn([this.config.binaryPath, "serve"], {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
        });

        // Start reading stdout in the background
        this._readLoop().catch((err) => {
            logger.warn(`DarwinKitClient: read loop error: ${err}`);
        });

        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(
                    new Error(
                        `DarwinKit did not send ready notification within ${this.config.startupTimeout}ms. ` +
                            `Is darwinkit installed? Run: brew install darwinkit`
                    )
                );
            }, this.config.startupTimeout);

            const originalHandler = this._handleLine.bind(this);
            this._handleLine = (line: string) => {
                try {
                    const msg = JSON.parse(line) as JsonRpcResponse;
                    if (!msg.id) {
                        clearTimeout(timer);
                        this._handleLine = originalHandler;
                        resolve();
                        return;
                    }
                } catch {
                    // ignore parse errors during startup
                }
                originalHandler(line);
            };
        });

        logger.debug("DarwinKitClient: ready");
    }

    /** Reads stdout line-by-line using the Web Streams reader. */
    private async _readLoop(): Promise<void> {
        if (!this.proc) {
            return;
        }

        const decoder = new TextDecoder();
        const reader = this.proc.stdout.getReader();

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }

                this.lineBuffer += decoder.decode(value, { stream: true });
                const lines = this.lineBuffer.split("\n");
                // Keep the last (possibly incomplete) chunk in the buffer
                this.lineBuffer = lines.pop() ?? "";
                for (const line of lines) {
                    if (line.trim()) {
                        this._handleLine(line);
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }
    }

    private _handleLine(line: string): void {
        if (!line.trim()) {
            return;
        }

        let msg: JsonRpcResponse;
        try {
            msg = JSON.parse(line) as JsonRpcResponse;
        } catch {
            logger.warn(`DarwinKitClient: failed to parse line: ${line}`);
            return;
        }

        if (!msg.id) {
            return;
        }

        const entry = this.pending.get(msg.id);
        if (!entry) {
            logger.warn(`DarwinKitClient: received response for unknown id: ${msg.id}`);
            return;
        }

        this.pending.delete(msg.id);
        clearTimeout(entry.timer);

        if (msg.error) {
            entry.reject(new Error(`DarwinKit error ${msg.error.code}: ${msg.error.message}`));
        } else {
            entry.resolve(msg.result);
        }
    }

    /** Call a darwinkit method and return the typed result. Starts the process lazily. */
    async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        await this.start();

        const id = String(this.nextId++);
        const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`DarwinKit request "${method}" timed out after ${this.config.timeout}ms`));
            }, this.config.timeout);

            this.pending.set(id, {
                resolve: resolve as (value: unknown) => void,
                reject,
                timer,
            });

            const line = `${JSON.stringify(request)}\n`;
            this.proc?.stdin.write(line);
        });
    }

    /** Close the subprocess and clean up resources. */
    close(): void {
        if (this.proc) {
            try {
                this.proc.stdin.end();
            } catch {
                // ignore
            }
            this.proc = null;
        }
        this.lineBuffer = "";
        for (const [id, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(new Error(`DarwinKitClient closed before request ${id} completed`));
        }
        this.pending.clear();
        this.startPromise = null;
        logger.debug("DarwinKitClient: closed");
    }

    get isRunning(): boolean {
        return this.proc !== null;
    }

    async capabilities(): Promise<CapabilitiesResult> {
        return this.call<CapabilitiesResult>("system.capabilities");
    }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _instance: DarwinKitClient | null = null;

export function getDarwinKit(config?: DarwinKitConfig): DarwinKitClient {
    if (!_instance) {
        _instance = new DarwinKitClient(config);
    }
    return _instance;
}

export function closeDarwinKit(): void {
    if (_instance) {
        _instance.close();
        _instance = null;
    }
}
