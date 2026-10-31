import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { callerSessionReadable } from "@app/genesis-tools-mcp/lib/http-caller";
import type { UnifiedMCPServerConfig } from "@app/mcp-manager/utils/providers/types.js";
import type { MCPProviderName } from "@app/mcp-manager/utils/types.js";
import { ACCOUNT_PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/alias-list";
import { harnessHost } from "@genesiscz/utils/ai/providers/harness-index";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import type { Subprocess } from "bun";
import {
    HOSTED_DRAINING_LINE,
    HOSTED_PEER_HEADER,
    HOSTED_READY_LINE,
    type HostedHandler,
    type HostedPeer,
} from "./hosted-protocol";

export type { HostedHandler, HostedPeer } from "./hosted-protocol";

/**
 * MCP servers the gateway hosts, instead of each harness session spawning one over stdio. A hosted server keeps its
 * stdio definition in the unified config: that is what every harness outside HOSTED_HTTP_PROVIDERS still gets, and
 * what a rollback restores.
 *
 * It runs in a child process the gateway starts (`hosted-child.ts`), never in the gateway itself: the launchd gateway
 * lives for days, and an in-process import kept its first code for good (2026-10-27: the gateway of 2026-10-19 wrote
 * the decision log with a store a week old). The child exits once its code changes, and the next call starts the new
 * code; the gateway itself needs no restart.
 */
export interface HostedServer {
    /**
     * Env keys of the stored stdio definition that become request headers in the http
     * projection, because a harness cannot pass env to a remote server.
     */
    envHeaders: Record<string, string>;
    /**
     * The child's entry script: it imports the server's handler statically and calls `runHostedChild`
     * (`hosted-child.ts`). `sourceRoot`: the folder whose edits make the child exit for the new code.
     */
    entry: string;
    sourceRoot: string;
}

/**
 * Harnesses whose MCP client the gateway can identify per request (the process that owns the
 * socket, plus its session file): the ones whose caller session the HTTP door can read
 * (`callerSessionReadable`). Cursor sends no identity, and grok and copilot carry their
 * session ids only in a stdio child's env, so they keep stdio.
 */
export const HOSTED_HTTP_PROVIDERS: ReadonlySet<MCPProviderName> = new Set<MCPProviderName>(
    ACCOUNT_PROVIDER_ALIASES.filter((id) => callerSessionReadable(harnessHost(id).agent))
);

const SOURCE_ROOT = resolve(moduleDir(import.meta), "../../..");
/**
 * How long one call waits for a starting child's ready line. A child still starting by then is not stopped: it keeps
 * starting, and the next call waits for that same child. On 2026-10-27 a loaded Mac took 8 s, 22 s and 30 s to start
 * it, and three children in a row were killed at 30 s with nothing on stderr, each one throwing away the start of
 * the one before.
 */
const CHILD_START_MS = 30_000;
/** A child that has not printed its ready line by then is stopped, and the next call starts a new one. */
const CHILD_GIVE_UP_MS = 120_000;
/** The tail of a child's stderr that the supervisor keeps for the start error and the log line. */
const STDERR_TAIL_BYTES = 4_096;
/** The part of that tail a start error's message carries (the log line has all of it). */
const MESSAGE_STDERR_CHARS = 1_000;
/** How long an exited child's stderr may take to reach its end before the start error is built without the rest. */
const STDERR_DRAIN_MS = 1_000;

const HOSTED: Record<string, HostedServer> = {
    "genesis-tools": {
        envHeaders: { GENESIS_TOOLS_MCP_CAPABILITIES: "X-Genesis-Mcp-Capabilities" },
        entry: join(SOURCE_ROOT, "genesis-tools-mcp/hosted-child.ts"),
        sourceRoot: SOURCE_ROOT,
    },
};

export const HOSTABLE: readonly string[] = Object.keys(HOSTED);

export function hostedServer(name: string): HostedServer | undefined {
    return Object.hasOwn(HOSTED, name) ? HOSTED[name] : undefined;
}

/** The unified entry asks for the http projection, and the gateway can actually host it. */
export function isGatewayHosted(name: string, config: UnifiedMCPServerConfig | undefined): boolean {
    return config?._meta?.gatewayHosted === true && hostedServer(name) !== undefined;
}

/** The last `limit` bytes a stream carried. */
class ByteTail {
    private bytes = new Uint8Array(0);

    constructor(private readonly limit: number) {}

    push(chunk: Uint8Array): void {
        if (chunk.byteLength >= this.limit) {
            this.bytes = chunk.slice(chunk.byteLength - this.limit);
            return;
        }

        const keep = Math.min(this.bytes.byteLength, this.limit - chunk.byteLength);
        const next = new Uint8Array(keep + chunk.byteLength);
        next.set(this.bytes.subarray(this.bytes.byteLength - keep), 0);
        next.set(chunk, keep);
        this.bytes = next;
    }

    text(): string {
        return new TextDecoder().decode(this.bytes).trim();
    }
}

interface HostedChild {
    proc: Subprocess<"ignore", "pipe", "pipe">;
    socket: string;
    generation: number;
    startedAt: number;
    /** The tail of its stderr. The stderr itself still goes on to the gateway's stderr (the launchd log). */
    stderr: ByteTail;
    /** Resolves once its stderr reached its end. */
    stderrRead: Promise<void>;
    /** It printed `draining`, or the supervisor stopped it: the next call starts a new child. */
    retired: boolean;
}

interface StartingChild {
    child: HostedChild;
    ready: Promise<HostedChild>;
}

export interface HostedSupervisorOptions {
    /** Where the child's socket goes; default `~/.genesis-tools/mcp-manager/hosted`. */
    socketDir?: string;
    /** How often the child checks its code for changes (its `--check-ms`). */
    checkMs?: number;
    /** How long one call waits for a starting child; default CHILD_START_MS. */
    startMs?: number;
    /** When a child that is still starting is stopped; default CHILD_GIVE_UP_MS. */
    giveUpMs?: number;
    /** Copy the child's stderr to this process's stderr; default true. */
    forwardStderr?: boolean;
}

/**
 * Why a child did not get ready for a call. `timeout`: the call's wait ended and the child is still starting.
 * `exited`: it ended before its ready line. `gave-up`: it was still starting at the give-up ceiling and was stopped.
 */
type HostedStartFailure = "timeout" | "exited" | "gave-up";

/** What a call learns about a child that did not get ready for it; also the fields of the failure's log line. */
interface HostedStartFacts {
    failure: HostedStartFailure;
    pid: number;
    code: number | null;
    signal: string | null;
    /** How long the child had been starting. */
    ms: number;
    /** The tail of its stderr, at most STDERR_TAIL_BYTES. */
    stderr: string;
}

/** A hosted child that did not get ready for a call: what happened, its pid, its exit and the tail of its stderr. */
class HostedStartError extends Error {
    constructor(
        server: string,
        readonly facts: HostedStartFacts,
        waitedMs: number
    ) {
        super(startErrorMessage(server, facts, waitedMs));
        this.name = "HostedStartError";
    }
}

function duration(ms: number): string {
    return ms >= 1_000 ? `${Math.round(ms / 100) / 10} s` : `${ms} ms`;
}

/** What happened, per failure: the first part of a start error's message. */
const FAILURE_TEXT: Record<HostedStartFailure, (server: string, facts: HostedStartFacts, waitedMs: number) => string> =
    {
        timeout: (server, { pid, ms }, waitedMs) =>
            `hosted ${server} did not start within ${duration(waitedMs)}: the child (pid ${pid}) has been starting for ${duration(ms)} and is still running; the next call waits for it`,
        exited: (server, { pid, code, signal, ms }) =>
            `hosted ${server} exited before it was ready (pid ${pid}, code ${code ?? "none"}, signal ${signal ?? "none"}, after ${duration(ms)})`,
        "gave-up": (server, { pid }, waitedMs) =>
            `hosted ${server} did not start within ${duration(waitedMs)}: the child (pid ${pid}) was still running and was stopped; the next call starts a new one`,
    };

function startErrorMessage(server: string, facts: HostedStartFacts, waitedMs: number): string {
    const what = FAILURE_TEXT[facts.failure](server, facts, waitedMs);
    const { stderr } = facts;

    return stderr
        ? `${what}; its stderr ends with: ${stderr.slice(-MESSAGE_STDERR_CHARS)}`
        : `${what}; it wrote nothing on stderr`;
}

/** Reads the child's stdout lines: resolves on the ready line, marks the child retired on the draining line. */
async function watchChild(child: HostedChild, onReady: () => void): Promise<void> {
    const decoder = new TextDecoder();
    let buffered = "";

    for await (const chunk of child.proc.stdout) {
        buffered += decoder.decode(chunk, { stream: true });
        let newline = buffered.indexOf("\n");

        while (newline >= 0) {
            const line = buffered.slice(0, newline).trim();
            buffered = buffered.slice(newline + 1);
            newline = buffered.indexOf("\n");

            if (line === HOSTED_READY_LINE) {
                onReady();
            } else if (line === HOSTED_DRAINING_LINE) {
                child.retired = true;
            }
        }
    }
}

/** Keeps the tail of the child's stderr, and copies it on to this process's stderr when asked to. */
async function readStderr(proc: Subprocess<"ignore", "pipe", "pipe">, tail: ByteTail, forward: boolean): Promise<void> {
    for await (const chunk of proc.stderr) {
        tail.push(chunk);

        if (forward) {
            process.stderr.write(chunk);
        }
    }
}

/** Waits for `promise`, or `ms`, whichever comes first. */
async function settleWithin(promise: Promise<void>, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
    });

    try {
        await Promise.race([promise, deadline]);
    } finally {
        clearTimeout(timer);
    }
}

/** The JSON-RPC id of a request body that is one JSON-RPC message, else null. */
function requestId(body: ArrayBuffer | undefined): string | number | null {
    if (!body) {
        return null;
    }

    try {
        const value: unknown = SafeJSON.parse(new TextDecoder().decode(body), { strict: true });

        if (
            typeof value === "object" &&
            value !== null &&
            "id" in value &&
            (typeof value.id === "string" || typeof value.id === "number")
        ) {
            return value.id;
        }
    } catch (error) {
        logger.debug({ error }, "hosted: the request body is not one JSON-RPC message");
    }

    return null;
}

/**
 * The answer to a call whose child did not get ready: a JSON-RPC error that says what happened, so the harness shows
 * the reason (it used to get Bun's HTML error page) and never reads the call as done. The call never reached a child.
 */
function startFailedResponse(error: HostedStartError, body: ArrayBuffer | undefined): Response {
    const { failure, pid, code, signal } = error.facts;
    return new Response(
        SafeJSON.stringify({
            jsonrpc: "2.0",
            id: requestId(body),
            error: { code: -32000, message: error.message, data: { failure, pid, code, signal } },
        }),
        { status: 503, headers: { "Content-Type": "application/json" } }
    );
}

/**
 * Starts the hosted server's child on first use and again after it drained or died, and forwards each request to it
 * over its unix socket with the caller's peer ports in a header. A child that drains between the check and the call
 * refuses the connection; the call then starts the new child once and retries there.
 *
 * A start is bounded twice: a call waits `startMs` for the ready line and then fails, while the child keeps starting
 * for the next call, until `giveUpMs`, when it is stopped. Each failure names what happened (still running, exited
 * with its code and signal, stopped) with the child's pid and the tail of its stderr, in the call's error and the log.
 */
export class HostedSupervisor {
    private child: HostedChild | undefined;
    private starting: StartingChild | undefined;
    private generation = 0;

    constructor(
        private readonly name: string,
        private readonly server: Pick<HostedServer, "entry" | "sourceRoot">,
        private readonly options: HostedSupervisorOptions = {}
    ) {}

    /** The live child's pid, for the log and the tests. */
    get pid(): number | undefined {
        return this.child && !this.child.retired ? this.child.proc.pid : undefined;
    }

    /** Ends the child and a child that is still starting (the gateway's shutdown, a test's end). */
    stop(): void {
        for (const child of [this.child, this.starting?.child]) {
            if (child) {
                child.retired = true;
                child.proc.kill();
            }
        }

        this.child = undefined;
        this.starting = undefined;
    }

    async forward(request: Request, peer: HostedPeer | null): Promise<Response> {
        const url = new URL(request.url);
        const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
        const headers = new Headers(request.headers);

        if (peer) {
            headers.set(HOSTED_PEER_HEADER, SafeJSON.stringify(peer));
        }

        for (let attempt = 1; ; attempt++) {
            let child: HostedChild;

            try {
                child = await this.current();
            } catch (error) {
                if (error instanceof HostedStartError) {
                    return startFailedResponse(error, body);
                }

                throw error;
            }

            try {
                return await fetch(`http://hosted${url.pathname}${url.search}`, {
                    unix: child.socket,
                    method: request.method,
                    headers,
                    ...(body ? { body } : {}),
                });
            } catch (error) {
                if (attempt > 1) {
                    throw error;
                }

                logger.info(
                    { server: this.name, generation: child.generation, error },
                    "hosted child refused the call; starting a new one"
                );
                child.retired = true;
            }
        }
    }

    private async current(): Promise<HostedChild> {
        const child = this.child;

        if (child && !child.retired && child.proc.exitCode === null && child.proc.signalCode === null) {
            return child;
        }

        this.starting ??= this.start();
        const { child: pending, ready } = this.starting;
        const waitMs = this.options.startMs ?? CHILD_START_MS;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(this.startError("timeout", pending, waitMs)), waitMs);
        });

        try {
            return await Promise.race([ready, late]);
        } catch (error) {
            if (error instanceof HostedStartError && error.facts.failure === "timeout") {
                logger.warn(
                    { server: this.name, generation: pending.generation, ...error.facts },
                    "hosted child not ready by the call's deadline; it keeps starting"
                );
            }

            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    private startError(failure: HostedStartFailure, child: HostedChild, waitedMs: number): HostedStartError {
        const facts: HostedStartFacts = {
            failure,
            pid: child.proc.pid,
            code: child.proc.exitCode,
            signal: child.proc.signalCode,
            ms: Date.now() - child.startedAt,
            stderr: child.stderr.text(),
        };
        return new HostedStartError(this.name, facts, waitedMs);
    }

    private start(): StartingChild {
        const dir = this.options.socketDir ?? toolDataDir("mcp-manager", "hosted");
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        this.generation += 1;
        const socket = join(dir, `${this.name}-${process.pid}-${this.generation}.sock`);
        const proc = Bun.spawn(
            [
                process.execPath,
                this.server.entry,
                "--socket",
                socket,
                "--source-root",
                this.server.sourceRoot,
                ...(this.options.checkMs ? ["--check-ms", String(this.options.checkMs)] : []),
            ],
            { stdin: "ignore", stdout: "pipe", stderr: "pipe" }
        );
        const stderr = new ByteTail(STDERR_TAIL_BYTES);
        const stderrRead = readStderr(proc, stderr, this.options.forwardStderr ?? true).catch((error) => {
            logger.warn({ server: this.name, pid: proc.pid, error }, "hosted child stderr ended with an error");
        });
        const child: HostedChild = {
            proc,
            socket,
            generation: this.generation,
            startedAt: Date.now(),
            stderr,
            stderrRead,
            retired: false,
        };
        const { promise: ready, resolve: markReady, reject: failStart } = Promise.withResolvers<HostedChild>();
        const giveUpMs = this.options.giveUpMs ?? CHILD_GIVE_UP_MS;
        const giveUp = setTimeout(() => {
            failStart(this.startError("gave-up", child, giveUpMs));
            proc.kill();
        }, giveUpMs);

        void watchChild(child, () => markReady(child)).catch((error) => {
            logger.warn({ server: this.name, error }, "hosted child output ended with an error");
        });
        void proc.exited.then(async () => {
            await settleWithin(child.stderrRead, STDERR_DRAIN_MS);
            failStart(this.startError("exited", child, Date.now() - child.startedAt));
            // A child that never got ready has its stderr in the start failure's line, and a stopped one needs none.
            const crashed = this.child === child && !child.retired && proc.exitCode !== 0;
            logger.info(
                {
                    server: this.name,
                    pid: proc.pid,
                    code: proc.exitCode,
                    signal: proc.signalCode,
                    generation: child.generation,
                    ...(crashed ? { stderr: stderr.text() } : {}),
                },
                "hosted child exited"
            );

            if (this.child === child) {
                this.child = undefined;
            }
        });
        ready.then(
            () => {
                clearTimeout(giveUp);

                if (this.starting?.child === child) {
                    this.starting = undefined;
                }

                if (child.retired) {
                    return;
                }

                logger.info(
                    {
                        server: this.name,
                        pid: proc.pid,
                        generation: child.generation,
                        ms: Date.now() - child.startedAt,
                    },
                    "hosted child ready"
                );
                this.child = child;
            },
            (error: unknown) => {
                clearTimeout(giveUp);

                if (this.starting?.child === child) {
                    this.starting = undefined;
                }

                const fields = {
                    server: this.name,
                    generation: child.generation,
                    ...(error instanceof HostedStartError ? error.facts : { pid: proc.pid, error }),
                };

                if (child.retired) {
                    logger.info(fields, "hosted child stopped before it was ready");
                } else {
                    logger.warn(fields, "hosted child failed to start");
                }
            }
        );

        return { child, ready };
    }
}

const supervisors = new Map<string, HostedSupervisor>();

/** The handler the gateway calls for a hosted server's path: a forward to its child process. */
export function hostedHandler(name: string): Promise<HostedHandler> | undefined {
    const server = hostedServer(name);

    if (!server) {
        return undefined;
    }

    let supervisor = supervisors.get(name);

    if (!supervisor) {
        supervisor = new HostedSupervisor(name, server);
        supervisors.set(name, supervisor);
    }

    const forward = supervisor;
    return Promise.resolve((request, peer) => forward.forward(request, peer));
}
