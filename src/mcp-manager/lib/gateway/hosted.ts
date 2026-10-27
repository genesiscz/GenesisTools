import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { UnifiedMCPServerConfig } from "@app/mcp-manager/utils/providers/types.js";
import type { MCPProviderName } from "@app/mcp-manager/utils/types.js";
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
 * socket, plus its session file). Cursor sends no identity, and grok and copilot carry their
 * session ids only in a stdio child's env, so they keep stdio.
 */
export const HOSTED_HTTP_PROVIDERS: ReadonlySet<MCPProviderName> = new Set<MCPProviderName>(["claude", "codex"]);

const SOURCE_ROOT = resolve(moduleDir(import.meta), "../../..");
/** A child that has not printed its ready line by then failed to start; the call gets the error. */
const CHILD_START_MS = 30_000;

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

interface HostedChild {
    proc: Subprocess<"ignore", "pipe", "inherit">;
    socket: string;
    generation: number;
    /** It printed `draining`: it finishes its requests, and the next call starts a new child. */
    retired: boolean;
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

/**
 * Starts the hosted server's child on first use and again after it drained or died, and forwards each request to it
 * over its unix socket with the caller's peer ports in a header. A child that drains between the check and the call
 * refuses the connection; the call then starts the new child once and retries there.
 */
export class HostedSupervisor {
    private child: HostedChild | undefined;
    private starting: Promise<HostedChild> | undefined;
    private generation = 0;

    constructor(
        private readonly name: string,
        private readonly server: Pick<HostedServer, "entry" | "sourceRoot">,
        private readonly options: { socketDir?: string; checkMs?: number } = {}
    ) {}

    /** The live child's pid, for the log and the tests. */
    get pid(): number | undefined {
        return this.child && !this.child.retired ? this.child.proc.pid : undefined;
    }

    /** Ends the child (the gateway's shutdown, a test's end). */
    stop(): void {
        this.child?.proc.kill();
        this.child = undefined;
    }

    async forward(request: Request, peer: HostedPeer | null): Promise<Response> {
        const url = new URL(request.url);
        const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
        const headers = new Headers(request.headers);

        if (peer) {
            headers.set(HOSTED_PEER_HEADER, SafeJSON.stringify(peer));
        }

        for (let attempt = 1; ; attempt++) {
            const child = await this.current();

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

    private current(): Promise<HostedChild> {
        const child = this.child;

        if (child && !child.retired && child.proc.exitCode === null) {
            return Promise.resolve(child);
        }

        this.starting ??= this.start().finally(() => {
            this.starting = undefined;
        });
        return this.starting;
    }

    private async start(): Promise<HostedChild> {
        const dir = this.options.socketDir ?? toolDataDir("mcp-manager", "hosted");
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        this.generation += 1;
        const socket = join(dir, `${this.name}-${process.pid}-${this.generation}.sock`);
        const started = Date.now();
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
            { stdin: "ignore", stdout: "pipe", stderr: "inherit", env: { ...process.env } }
        );
        const child: HostedChild = { proc, socket, generation: this.generation, retired: false };
        const { promise: ready, resolve: markReady, reject: failStart } = Promise.withResolvers<void>();
        const timer = setTimeout(
            () => failStart(new Error(`hosted ${this.name} did not start within ${CHILD_START_MS / 1000} s`)),
            CHILD_START_MS
        );
        void watchChild(child, markReady).catch((error) => {
            logger.warn({ server: this.name, error }, "hosted child output ended with an error");
        });
        void proc.exited.then((code) => {
            failStart(new Error(`hosted ${this.name} exited with ${code} before it was ready`));
            logger.info(
                { server: this.name, pid: proc.pid, code, generation: child.generation },
                "hosted child exited"
            );

            if (this.child === child) {
                this.child = undefined;
            }
        });

        try {
            await ready;
        } catch (error) {
            proc.kill();
            throw error;
        } finally {
            clearTimeout(timer);
        }

        logger.info(
            { server: this.name, pid: proc.pid, generation: child.generation, ms: Date.now() - started },
            "hosted child ready"
        );
        this.child = child;
        return child;
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
