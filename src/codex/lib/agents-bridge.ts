import { deriveRegistry, findByName, nextSubagentId } from "@app/agents/lib/derived-registry";
import { withFeedLock } from "@app/agents/lib/feed";
import { ensureSessionDir, sessionPaths } from "@app/agents/lib/paths";
import { resolveMany, resolveOne } from "@app/agents/lib/resolve-token";
import { OWNER_THREAD_META_KEY } from "@app/agents/lib/thread-owner";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { RpcNotification } from "./app-server-client";
import { type CodexControl, parseControlBody } from "./control";
import { codexTurnOutcome } from "./terminal-outcome";

const log = logger.child({ component: "codex:agents-bridge" });

export interface AgentsTransportSubscription {
    close(): Promise<void>;
}

export interface AgentsTransport {
    register(agentName: string, session: string, meta?: Record<string, unknown>): Promise<string>;
    send(options: { from: string; to: string; body: string; session: string }): Promise<void>;
    observe(session: string, onLine: (line: string) => void | Promise<void>): Promise<AgentsTransportSubscription>;
}

interface AgentsBridgeOptions {
    agentName: string;
    rendezvousSession: string;
    transport?: AgentsTransport;
    onControl: (control: CodexControl) => void | Promise<void>;
    onSeq?: (seq: number) => void | Promise<void>;
    afterSeq?: number;
    maxPendingSends?: number;
}

interface MessageFeedEvent {
    seq: number;
    type: "message";
    from_agent_id: string;
    to_agent_ids: string[];
    body: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMessageEvent(line: string): MessageFeedEvent | null {
    const parsed = SafeJSON.parse(line, { strict: true });
    if (
        !isRecord(parsed) ||
        parsed.type !== "message" ||
        typeof parsed.seq !== "number" ||
        typeof parsed.from_agent_id !== "string" ||
        typeof parsed.body !== "string" ||
        !Array.isArray(parsed.to_agent_ids) ||
        !parsed.to_agent_ids.every((id) => typeof id === "string")
    ) {
        return null;
    }

    return parsed as unknown as MessageFeedEvent;
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> | null {
    if (!isRecord(value)) {
        return null;
    }

    return isRecord(value[key]) ? value[key] : null;
}

function compactText(value: unknown, maxLength = 400): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLength) {
        return normalized;
    }

    return `${normalized.slice(0, maxLength - 1)}…`;
}

function itemSummary(item: Record<string, unknown>): string {
    if (item.type === "agentMessage") {
        return compactText(item.text) ?? "agent message";
    }

    if (item.type === "commandExecution") {
        const command = compactText(item.command) ?? "command";
        const outcome = typeof item.exitCode === "number" ? `exit ${item.exitCode}` : compactText(item.status);
        return outcome ? `${command} (${outcome})` : command;
    }

    if (item.type === "fileChange") {
        const changeCount = Array.isArray(item.changes) ? item.changes.length : 0;
        return `${changeCount} file ${changeCount === 1 ? "change" : "changes"}`;
    }

    if (item.type === "todoList") {
        const itemCount = Array.isArray(item.items) ? item.items.length : 0;
        return `${itemCount} todo ${itemCount === 1 ? "item" : "items"}`;
    }

    if (item.type === "reasoning") {
        return "reasoning update";
    }

    return compactText(item.type) ?? "Codex item";
}

function eventEnvelope(notification: RpcNotification): Record<string, unknown> | null {
    if (notification.method === "turn/started") {
        return { event: "turn_started", turnId: nestedRecord(notification.params, "turn")?.id };
    }

    const terminal = codexTurnOutcome(notification);
    if (terminal) {
        if (terminal.outcome === "completed") {
            return { event: "turn_completed", turnId: terminal.turnId };
        }

        return {
            event: "error",
            message: terminal.outcome === "interrupted" ? "Codex turn interrupted" : "Codex turn failed",
            outcome: terminal.outcome,
            turnId: terminal.turnId,
            detail: terminal.detail,
        };
    }

    if (notification.method === "error") {
        return { event: "error", detail: notification.params };
    }

    if (notification.method === "item/started" || notification.method === "item/completed") {
        const item = nestedRecord(notification.params, "item");
        if (!item) {
            return null;
        }

        return {
            event: "item",
            phase: notification.method.split("/")[1],
            itemId: item.id,
            itemType: item.type,
            summary: itemSummary(item),
        };
    }

    return null;
}

export class AgentsBridge {
    private readonly agentName: string;
    private readonly session: string;
    private readonly transport: AgentsTransport;
    private readonly onControl: AgentsBridgeOptions["onControl"];
    private readonly onSeq: AgentsBridgeOptions["onSeq"];
    private subscription: AgentsTransportSubscription | null = null;
    private agentId: string | null = null;
    private lastSeq: number;
    private outbound = Promise.resolve();
    private pendingSends = 0;
    private readonly maxPendingSends: number;

    constructor(options: AgentsBridgeOptions) {
        this.agentName = options.agentName;
        this.session = options.rendezvousSession;
        this.transport = options.transport ?? new CliAgentsTransport();
        this.onControl = options.onControl;
        this.onSeq = options.onSeq;
        this.lastSeq = options.afterSeq ?? 0;
        this.maxPendingSends = options.maxPendingSends ?? 256;
    }

    /** `ownerThreadId`: the worker's root thread, the only one `tools agents` lets act as this identity. */
    async start(ownerThreadId?: string): Promise<string> {
        this.agentId = await this.transport.register(
            this.agentName,
            this.session,
            ownerThreadId ? { [OWNER_THREAD_META_KEY]: ownerThreadId } : {}
        );
        this.subscription = await this.transport.observe(this.session, async (line) => {
            await this.handleLine(line);
        });
        return this.agentId;
    }

    async publish(notification: RpcNotification): Promise<void> {
        const envelope = eventEnvelope(notification);
        if (!envelope) {
            return;
        }

        await this.enqueue({
            from: this.agentName,
            to: "lead",
            body: SafeJSON.stringify(envelope, { strict: true }),
            session: this.session,
        });
    }

    async publishEvent(event: Record<string, unknown>): Promise<void> {
        await this.enqueue({
            from: this.agentName,
            to: "lead",
            body: SafeJSON.stringify(event, { strict: true }),
            session: this.session,
        });
    }

    async close(): Promise<void> {
        await this.subscription?.close();
        this.subscription = null;
        await this.outbound;
    }

    private async enqueue(options: { from: string; to: string; body: string; session: string }): Promise<void> {
        while (this.pendingSends >= this.maxPendingSends) {
            await this.outbound;
        }

        this.pendingSends += 1;
        const send = this.outbound.then(() => this.transport.send(options));
        this.outbound = send
            .catch((err) => {
                log.debug(
                    { err, session: this.session, to: options.to },
                    "agents outbound queue recovered after send failure"
                );
            })
            .finally(() => {
                this.pendingSends -= 1;
            });
        await send;
    }

    private async handleLine(line: string): Promise<void> {
        let event: MessageFeedEvent | null;
        try {
            event = parseMessageEvent(line);
        } catch (err) {
            log.debug({ err, line }, "ignoring non-feed agents observer line");
            return;
        }

        if (!event || !this.agentId || event.seq <= this.lastSeq) {
            return;
        }

        this.lastSeq = event.seq;
        await this.onSeq?.(event.seq);

        if (event.from_agent_id === this.agentId || !event.to_agent_ids.includes(this.agentId)) {
            return;
        }

        let control: CodexControl;
        try {
            control = parseControlBody(event.body);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.warn({ err, seq: event.seq, from: event.from_agent_id }, "ignoring invalid Codex control message");
            await this.publishEvent({ event: "error", message });
            return;
        }

        await this.onControl(control);
    }
}

export class CliAgentsTransport implements AgentsTransport {
    /**
     * One `registered` append under the feed lock, like `send`. This used to start a `tools agents login
     * --once` and kill it, which told every peer agent_joined and, 100 ms later, agent_left (2026-10-13).
     * Registering a name again keeps its id and replaces its meta, so a respawn records its new thread.
     */
    async register(agentName: string, session: string, meta: Record<string, unknown> = {}): Promise<string> {
        const paths = sessionPaths(session);
        ensureSessionDir(paths);

        return withFeedLock(paths, ({ events, appendNonMessage }) => {
            const registry = deriveRegistry(events);
            const existing = findByName(registry, agentName);

            if (existing?.is_main) {
                throw new Error(`${agentName} is the main agent of ${session}; a Codex worker cannot take that name`);
            }

            const agentId = existing?.agent_id ?? nextSubagentId(registry);
            appendNonMessage({
                type: "registered",
                agent_name: agentName,
                agent_id: agentId,
                awaiting_login: false,
                is_main: false,
                role: existing?.role ?? null,
                meta,
            });
            return agentId;
        });
    }

    async send(options: { from: string; to: string; body: string; session: string }): Promise<void> {
        const paths = sessionPaths(options.session);
        ensureSessionDir(paths);
        await withFeedLock(paths, ({ events, appendMessageEvent }) => {
            const registry = deriveRegistry(events);
            const sender = resolveOne(registry, options.from, "sender");
            const recipients = resolveMany(registry, options.to, "recipient");

            appendMessageEvent({
                type: "message",
                from_agent_id: sender.agent_id,
                from_agent_name: sender.agent_name,
                to_agent_ids: recipients,
                body: options.body,
                meta: {},
                private: false,
            });
        });
    }

    async observe(
        session: string,
        onLine: (line: string) => void | Promise<void>
    ): Promise<AgentsTransportSubscription> {
        const proc = Bun.spawn({
            cmd: ["tools", "agents", "listen", "--session", session, "--format", "json"],
            env: env.getProcessEnv(),
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
        });
        void consumeLines(proc.stdout, onLine).catch((err) => {
            log.error({ err, pid: proc.pid, session }, "agents observer stdout failed");
        });
        void new Response(proc.stderr)
            .text()
            .then((stderr) => {
                if (stderr.trim()) {
                    log.debug({ stderr, pid: proc.pid, session }, "agents observer stderr");
                }
            })
            .catch((err) => {
                log.debug({ err, pid: proc.pid, session }, "reading agents observer stderr failed");
            });

        return {
            close: async () => {
                try {
                    proc.kill("SIGTERM");
                } catch (err) {
                    log.debug({ err, pid: proc.pid }, "agents observer already exited");
                    // The observer may already have exited with its parent daemon.
                }
                await proc.exited;
            },
        };
    }
}

async function consumeLines(
    stream: ReadableStream<Uint8Array>,
    onLine: (line: string) => void | Promise<void>
): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let partial = "";

    try {
        for (;;) {
            const result = await reader.read();
            if (result.done) {
                break;
            }

            partial += decoder.decode(result.value, { stream: true });
            const lines = partial.split("\n");
            partial = lines.pop() ?? "";
            for (const line of lines) {
                if (line.trim()) {
                    await onLine(line);
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
}
