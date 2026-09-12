import { chmodSync, mkdtempSync } from "node:fs";
import { rmdir, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { type WebSocket, WebSocketServer } from "ws";
import type { CodexAccountBinding } from "./account";
import { AppServerClient, type AppServerProcess } from "./app-server-client";
import { CodexTuiBridge } from "./tui-bridge";

type TerminalAccount = Pick<CodexAccountBinding, "authenticate" | "refresh">;

export async function initializeAccountClient(
    client: AppServerClient,
    account: TerminalAccount
): Promise<Record<string, unknown>> {
    const initialized = await client.request<Record<string, unknown>>("initialize", {
        clientInfo: { name: "genesis-tools-codex", title: "GenesisTools Codex", version: "0.1.0" },
        capabilities: { experimentalApi: true },
    });
    await client.notify("initialized");
    await account.authenticate(client);
    return initialized;
}

/**
 * A cap, not a design limit: the socket is 0600 inside a 0700 directory, so only this user can
 * reach it, and this only stops a runaway from opening connections without bound.
 */
const MAX_PEERS = 8;

/** Enough of the child's stderr to recognise why it died; it explains itself in one line. */
const STDERR_TAIL = 4000;

/**
 * Two `codex app-server` children that initialize the SAME `CODEX_HOME` in the same instant
 * fight over its sqlite state runtime, and one of them dies.
 *
 * Measured 2026-09-11 against three accounts and one home: two simultaneous cold starts left
 * one survivor and one `exited with code 1`, while the same two started a second apart both
 * ran, and a third then joined them, each reporting its own usage. So the home is not
 * single-owner; only the first moment of initializing it is. The loser has to wait for the
 * winner to finish, which takes well under a second.
 */
export class CodexHomeBusyError extends Error {
    constructor(readonly stderr: string) {
        super("Another Codex app-server was initializing this home; it was not ready in time");
        this.name = "CodexHomeBusyError";
    }
}

export function isHomeInitRace(stderr: string): boolean {
    return /failed to initialize (?:sqlite )?state runtime/i.test(stderr);
}

export async function openTerminalServer(options: {
    account: TerminalAccount;
    child: AppServerProcess;
    signal?: AbortSignal;
    socketRoot?: string;
}) {
    const peers = new Set<WebSocket>();
    let primary: WebSocket | undefined;
    let bridge: CodexTuiBridge | undefined;
    let threadId: string | undefined;
    let stderrTail = "";
    const client = new AppServerClient(options.child, {
        onNotification: (notification) => {
            if (notification.method === "thread/started") {
                const params = notification.params as { thread?: { id?: string } } | undefined;
                if (typeof params?.thread?.id === "string") {
                    threadId = params.thread.id;
                }
            }
            return bridge?.notification(notification);
        },
        onServerRequest: (request) => {
            if (request.method === "account/chatgptAuthTokens/refresh") {
                const params = request.params as { previousAccountId?: string | null } | undefined;
                return options.account.refresh(params?.previousAccountId ?? null);
            }

            return bridge?.serverRequest(request) ?? Promise.reject(new Error("Codex terminal is not connected"));
        },
        // The byte count alone said nothing: when the app-server explains a failure on stderr,
        // that text is the only account of it anywhere, so keep it (bounded, file-only).
        onStderr: (text) => {
            // Kept, not only logged: a cold-start race on the home says so here and nowhere
            // else, and the launcher retries on exactly that sentence.
            stderrTail = `${stderrTail}${text}`.slice(-STDERR_TAIL);
            logger.debug(
                { bytes: text.length, stderr: text.length > 2000 ? `${text.slice(0, 2000)}…` : text },
                "Codex app-server stderr received"
            );
        },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener: (() => void) | undefined;
    let initialized: Record<string, unknown>;
    try {
        const aborted = new Promise<never>((_resolve, reject) => {
            const onAbort = () => {
                const reason = options.signal?.reason;
                reject(reason instanceof Error ? reason : new Error("Codex terminal initialization aborted"));
            };
            if (options.signal?.aborted) {
                onAbort();
                return;
            }
            options.signal?.addEventListener("abort", onAbort, { once: true });
            removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
        });
        initialized = await Promise.race([
            initializeAccountClient(client, options.account),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("Codex account initialization timed out")), 25000);
            }),
            aborted,
        ]);
    } catch (error) {
        logger.warn({ error, stderr: stderrTail }, "Codex account initialization failed");
        await client.close();

        if (isHomeInitRace(stderrTail)) {
            throw new CodexHomeBusyError(stderrTail);
        }

        throw error;
    } finally {
        clearTimeout(timer);
        removeAbortListener?.();
    }

    /** Requests the TUI made that the app-server refused; reported after the TUI releases the screen. */
    const failures: Array<{ method: string; error: Error }> = [];
    let setupDir: string | undefined;
    let setupServer: ReturnType<typeof createServer> | undefined;
    let setupSockets: WebSocketServer | undefined;
    try {
        options.signal?.throwIfAborted();
        // A short private path avoids macOS's 104-byte Unix socket path limit.
        const dir = mkdtempSync(
            join(options.socketRoot ?? (process.platform === "win32" ? tmpdir() : "/tmp"), "gt-codex-")
        );
        setupDir = dir;
        chmodSync(dir, 0o700);
        const socketPath = join(dir, "tui.sock");
        bridge = new CodexTuiBridge({
            client,
            send: (message, target) => {
                const frame = SafeJSON.stringify(message, { strict: true });

                if (target.kind === "peer") {
                    (target.peer as WebSocket | undefined)?.send(frame);
                    return;
                }

                if (target.kind === "primary") {
                    primary?.send(frame);
                    return;
                }

                for (const peer of peers) {
                    peer.send(frame);
                }
            },
            onRequestFailed: (failure) => failures.push(failure),
        });
        bridge.ready(initialized);
        const activeBridge = bridge;
        /**
         * Several peers at once: the native TUI opens a SECOND connection for its own session
         * picker, and a single-peer relay refused it with "failed to connect to remote app server".
         * The first peer stays the primary, which is where a server-initiated request goes.
         */
        const server = createServer((_request, response) => {
            response.writeHead(400).end();
        });
        const connections = new Set<Socket>();
        server.on("connection", (connection) => {
            connections.add(connection);
            connection.once("close", () => connections.delete(connection));
        });
        const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
        setupServer = server;
        setupSockets = sockets;
        server.on("upgrade", (request, connection, head) => {
            if (request.headers.origin || peers.size >= MAX_PEERS) {
                logger.debug(
                    {
                        reason: request.headers.origin
                            ? "cross-origin upgrade"
                            : `already relaying ${peers.size} peers`,
                        socketPath,
                    },
                    "Refused a Codex terminal upgrade"
                );
                connection.destroy();
                return;
            }
            sockets.handleUpgrade(request, connection, head, (ws) => {
                peers.add(ws);
                primary ??= ws;
                logger.debug({ peers: peers.size, primary: primary === ws }, "Admitted a Codex terminal peer");
                // The bridge outlives each peer, and the previous peer's close disconnected it,
                // so a replacement has to be re-attached or it is admitted into a dead relay.
                activeBridge.connect();
                ws.on("message", (data) => {
                    let message: unknown;
                    try {
                        message = SafeJSON.parse(String(data), { strict: true });
                    } catch (error) {
                        const raw = String(data);
                        logger.debug(
                            { error, bytes: raw.length, preview: raw.slice(0, 200) },
                            "Rejected malformed Codex terminal JSON"
                        );
                        ws.close(1007, "Invalid JSON");
                        return;
                    }

                    void activeBridge.receive(message, ws).catch((error) => {
                        logger.debug({ error }, "Codex terminal relay rejected a message");
                        ws.close(1011, "Codex relay failed");
                    });
                });
                // A superseded peer still emits `close` and `error`, and the raw connection's own
                // close already released the latch, so an unguarded handler would tear down the
                // relay belonging to the peer that replaced it.
                const forget = () => {
                    if (!peers.delete(ws)) {
                        return;
                    }

                    if (primary === ws) {
                        primary = peers.values().next().value;
                        // Requests already sent to the departing primary can never be answered:
                        // their ids were issued to that socket and the peer taking over never saw
                        // them. Reject them here or the caller awaits a response that cannot come.
                        if (primary) {
                            activeBridge.failPending("Codex terminal primary disconnected");
                        }
                    }

                    // Only the LAST peer leaving tears the relay down; a picker closing must not
                    // disconnect the TUI that opened it.
                    if (peers.size === 0) {
                        activeBridge.disconnect();
                    }
                };
                ws.on("close", forget);
                ws.on("error", (error) => {
                    logger.debug({ error, peers: peers.size }, "Codex terminal socket failed");
                    forget();
                });
            });
        });
        await new Promise<void>((resolve, reject) => {
            const failed = (error: Error) => {
                server.off("listening", ready);
                reject(error);
            };
            const ready = () => {
                server.off("error", failed);
                resolve();
            };
            server.once("error", failed);
            server.once("listening", ready);
            server.listen(socketPath);
        });
        // A one-shot `error` handler is consumed by the listen promise, so the next server error
        // had no listener at all and became an uncaught exception that took the process with it.
        // This one keeps a listener for the rest of the server's life.
        server.on("error", (error) => {
            logger.warn({ error, socketPath }, "Codex terminal server error");
        });
        chmodSync(socketPath, 0o600);
        options.signal?.throwIfAborted();
        let closed = false;
        return {
            socketPath,
            address: `unix://${socketPath}`,
            client,
            failures,
            get threadId() {
                return threadId;
            },
            async close() {
                if (closed) {
                    return;
                }

                closed = true;
                activeBridge.disconnect();

                for (const peer of peers) {
                    peer.terminate();
                }

                peers.clear();
                for (const connection of connections) {
                    connection.destroy();
                }
                sockets.close();
                await client.close();
                server.closeAllConnections();
                await new Promise<void>((resolve, reject) =>
                    server.close((error) => {
                        if (error && !("code" in error && error.code === "ERR_SERVER_NOT_RUNNING")) {
                            reject(error);
                        } else {
                            resolve();
                        }
                    })
                );
                try {
                    await unlink(socketPath);
                } catch (error) {
                    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
                        logger.warn({ error, socketPath }, "Could not remove Codex terminal socket");
                    }
                }

                await rmdir(dir).catch((error: unknown) => {
                    logger.warn({ dir, error }, "Could not remove the Codex terminal socket directory");
                });
            },
        };
    } catch (error) {
        // The caller may or may not reach a logger before this ends the process, and this is the
        // only place that knows which stage failed.
        logger.warn({ error, setupDir }, "Codex terminal setup failed");
        await client.close();

        for (const peer of peers) {
            peer.terminate();
        }
        setupSockets?.close();
        setupServer?.closeAllConnections();
        setupServer?.close();
        if (setupDir) {
            try {
                await unlink(join(setupDir, "tui.sock"));
            } catch (cleanupError) {
                logger.debug({ cleanupError }, "Cleaning failed Codex socket setup");
            }
            // Never let a cleanup failure replace the reason the terminal could not start.
            await rmdir(setupDir).catch((cleanupError: unknown) => {
                logger.debug({ setupDir, cleanupError }, "Cleaning failed Codex socket setup directory");
            });
        }

        throw error;
    }
}
