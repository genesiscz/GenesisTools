import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";
import { logger } from "@app/utils/logger";
import type { RpcNotification } from "./app-server-client";
import { type CodexControl, parseControlBody } from "./control";

const log = logger.child({ component: "codex:agents-bridge" });

export interface AgentsTransportSubscription {
    close(): Promise<void>;
}

export interface AgentsTransport {
    register(agentName: string, session: string): Promise<string>;
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
}

interface MessageFeedEvent {
    seq: number;
    type: "message";
    from_agent_id: string;
    to_agent_ids: string[];
    body: string;
}

interface AgentRecord {
    agent_id: string;
    agent_name: string;
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

    if (notification.method === "turn/completed") {
        return { event: "turn_completed", turnId: nestedRecord(notification.params, "turn")?.id };
    }

    if (notification.method === "turn/failed") {
        return { event: "error", message: "Codex turn failed", detail: notification.params };
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

    constructor(options: AgentsBridgeOptions) {
        this.agentName = options.agentName;
        this.session = options.rendezvousSession;
        this.transport = options.transport ?? new CliAgentsTransport();
        this.onControl = options.onControl;
        this.onSeq = options.onSeq;
        this.lastSeq = options.afterSeq ?? 0;
    }

    async start(): Promise<string> {
        this.agentId = await this.transport.register(this.agentName, this.session);
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
        const send = this.outbound.then(() => this.transport.send(options));
        this.outbound = send.catch((err) => {
            log.debug(
                { err, session: this.session, to: options.to },
                "agents outbound queue recovered after send failure"
            );
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

async function runAgentsCommand(args: string[]): Promise<string> {
    const proc = Bun.spawn({
        cmd: ["tools", "agents", ...args],
        env: env.getProcessEnv(),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    if (exitCode !== 0) {
        throw new Error(`tools agents ${args[0] ?? "command"} failed: ${stderr.trim() || `exit ${exitCode}`}`);
    }

    return stdout;
}

export class CliAgentsTransport implements AgentsTransport {
    async register(agentName: string, session: string): Promise<string> {
        const login = Bun.spawn({
            cmd: [
                "tools",
                "agents",
                "login",
                "--agent-name",
                agentName,
                "--once",
                "--session",
                session,
                "--format",
                "json",
            ],
            env: env.getProcessEnv(),
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
        });
        const deadline = Date.now() + 5_000;
        let found: AgentRecord | undefined;

        try {
            while (Date.now() < deadline) {
                const stdout = await runAgentsCommand(["discover", "--session", session, "--format", "json"]);
                const records = SafeJSON.parse(stdout, { strict: true });
                if (!Array.isArray(records)) {
                    throw new Error("tools agents discover returned a non-array response");
                }

                found = records.find(
                    (record): record is AgentRecord =>
                        isRecord(record) && record.agent_name === agentName && typeof record.agent_id === "string"
                );
                if (found) {
                    break;
                }

                await Bun.sleep(50);
            }
        } finally {
            try {
                login.kill("SIGTERM");
            } catch (err) {
                log.debug({ err, pid: login.pid }, "one-shot agents login already exited");
            }

            await login.exited;
        }

        if (!found) {
            throw new Error(`tools agents did not register ${agentName} within 5 seconds`);
        }

        return found.agent_id;
    }

    async send(options: { from: string; to: string; body: string; session: string }): Promise<void> {
        await runAgentsCommand([
            "message",
            "--from",
            options.from,
            "--to",
            options.to,
            "--body",
            options.body,
            "--session",
            options.session,
        ]);
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
