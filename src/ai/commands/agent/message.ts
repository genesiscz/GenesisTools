import type { TurnProvider } from "@genesiscz/utils/ai/transcripts/turn-state";
import {
    type ClaudeLiveSession,
    listClaudeLiveSessions,
    type PeerPriority,
    readPeerToken,
    sendClaudePeerMessage,
} from "@genesiscz/utils/claude/peer-message";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { resolveWaitTranscript } from "./wait";

const { log } = logger.scoped("agent-message");

/**
 * `tools <agent> message <session> <text>`: deliver a message to a RUNNING session through the agent's own
 * structured channel, never by typing into its terminal. One driver per agent; an agent without such a
 * channel says so and names the keystroke fallback (`tools <agent> cmux send`).
 *
 * Not the agents bus: `tools agents message` talks to agents logged into a bus session. This reaches a
 * session that is not on the bus at all.
 */

export interface MessageRequest {
    query: string;
    text: string;
    priority?: PeerPriority;
    first?: boolean;
}

export interface MessageDelivery {
    agent: TurnProvider;
    sessionId: string;
    name: string | null;
    via: "claude-socket" | "codex-queue";
    /** What the receiver does with it, in one line. */
    note: string;
}

export class MessageError extends Error {
    constructor(
        message: string,
        /** Copy-paste lines that would work instead. */
        readonly suggestions: string[] = []
    ) {
        super(message);
        this.name = "MessageError";
    }
}

export interface MessageDriver {
    deliver(request: MessageRequest): Promise<MessageDelivery>;
}

function shortId(id: string): string {
    return id.slice(0, 8);
}

function describe(session: ClaudeLiveSession): string {
    return `${shortId(session.sessionId)}  ${session.name ?? "(no name)"}  ${session.status ?? "?"}  ${session.cwd ?? ""}`;
}

/**
 * A live Claude session by full id, an 8+ character id prefix, its exact name, or a unique part of its
 * name. Several matches fail with the candidates and the exact command for each.
 */
export function pickClaudeSession(query: string, sessions: readonly ClaudeLiveSession[]): ClaudeLiveSession {
    const needle = query.trim().toLowerCase();
    const tiers: ClaudeLiveSession[][] = [
        sessions.filter((session) => session.sessionId.toLowerCase() === needle),
        needle.length >= 8 ? sessions.filter((session) => session.sessionId.toLowerCase().startsWith(needle)) : [],
        sessions.filter((session) => session.name?.toLowerCase() === needle),
        sessions.filter((session) => session.name?.toLowerCase().includes(needle)),
    ];

    for (const hits of tiers) {
        if (hits.length === 1) {
            return hits[0];
        }

        if (hits.length > 1) {
            throw new MessageError(
                `"${query}" matches ${hits.length} running Claude sessions:\n${hits.map((hit) => `  ${describe(hit)}`).join("\n")}`,
                hits.map((hit) => `tools claude message ${hit.sessionId} "<text>"`)
            );
        }
    }

    throw new MessageError(`no running Claude session matches "${query}"`);
}

export function claudeMessageDriver(
    deps: {
        sessions?: () => ClaudeLiveSession[];
        token?: (session: ClaudeLiveSession) => string | null;
        send?: typeof sendClaudePeerMessage;
        resolveId?: (query: string, first: boolean) => Promise<string>;
    } = {}
): MessageDriver {
    const sessions = deps.sessions ?? (() => listClaudeLiveSessions());
    const token = deps.token ?? ((session) => readPeerToken(session));
    const send = deps.send ?? sendClaudePeerMessage;
    const resolveId =
        deps.resolveId ?? (async (query, first) => (await resolveWaitTranscript("claude", query, first)).sessionId);

    return {
        async deliver(request) {
            const live = sessions();
            let target: ClaudeLiveSession;

            try {
                target = pickClaudeSession(request.query, live);
            } catch (error) {
                if (!(error instanceof MessageError) || error.suggestions.length > 0) {
                    throw error;
                }

                // Not a live id or name: maybe a /rename title or a path the transcript resolver knows.
                const sessionId = await resolveId(request.query, request.first === true).catch((resolveError) => {
                    log.debug({ error: resolveError, query: request.query }, "transcript resolver found nothing");
                    return null;
                });
                const running = sessionId ? live.find((session) => session.sessionId === sessionId) : undefined;

                if (!running) {
                    throw new MessageError(
                        sessionId
                            ? `Claude session ${sessionId} is not running (no live entry in ~/.claude/sessions); a message needs a running session`
                            : `no running Claude session matches "${request.query}" (tried id, id prefix, session name, /rename title)`,
                        live.length > 0
                            ? live
                                  .slice(0, 5)
                                  .map(
                                      (session) =>
                                          `tools claude message ${session.sessionId} "<text>"   # ${session.name ?? ""}`
                                  )
                            : []
                    );
                }

                target = running;
            }

            await send({ session: target, text: request.text, token: token(target), priority: request.priority });
            return {
                agent: "claude",
                sessionId: target.sessionId,
                name: target.name,
                via: "claude-socket",
                note:
                    target.status === "busy"
                        ? "busy: it reads the message between tool calls"
                        : "idle: it starts a turn with the message",
            };
        },
    };
}

async function runCodexQueue(threadId: string, text: string): Promise<{ code: number; stderr: string }> {
    const proc = Bun.spawn(["codex", "queue", "--thread", threadId, "--message", text], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { code, stderr };
}

/**
 * Codex: `codex queue` adds the message to the thread's queue on the shared app-server daemon; it runs
 * after the current turn. Works only when the TUI is attached to that daemon; a TUI with its own embedded
 * server answers "No active session".
 */
export function codexMessageDriver(
    deps: {
        resolveId?: (query: string, first: boolean) => Promise<string>;
        queue?: (threadId: string, text: string) => Promise<{ code: number; stderr: string }>;
    } = {}
): MessageDriver {
    const resolveId =
        deps.resolveId ?? (async (query, first) => (await resolveWaitTranscript("codex", query, first)).sessionId);
    const queue = deps.queue ?? runCodexQueue;

    return {
        async deliver(request) {
            const sessionId = await resolveId(request.query, request.first === true);
            const result = await queue(sessionId, request.text);

            if (result.code !== 0) {
                throw new MessageError(
                    `codex queue refused (${result.code}): ${result.stderr.trim() || "no detail"}. ` +
                        "A Codex TUI reaches only the shared app-server when it was started with --remote (or the default daemon).",
                    [`tools codex cmux send ${sessionId} "<text>"   # keystroke fallback`]
                );
            }

            return {
                agent: "codex",
                sessionId,
                name: null,
                via: "codex-queue",
                note: "queued on the shared app-server: it runs after the current turn",
            };
        },
    };
}

/** Grok has no structured way into a running TUI yet (no leader runs; `grok agent --leader` is untested). */
export function grokMessageDriver(
    deps: { resolveId?: (query: string, first: boolean) => Promise<string> } = {}
): MessageDriver {
    const resolveId =
        deps.resolveId ?? (async (query, first) => (await resolveWaitTranscript("grok", query, first)).sessionId);

    return {
        async deliver(request) {
            const sessionId = await resolveId(request.query, request.first === true);
            throw new MessageError(
                `Grok has no structured channel into a running session yet (session ${sessionId}). ` +
                    "Sessions GenesisTools starts itself are driven over ACP (`tools grok worker`).",
                [`tools grok cmux send ${sessionId} "<text>"   # keystroke fallback into its cmux pane`]
            );
        },
    };
}

export function messageDriverFor(alias: TurnProvider): MessageDriver {
    if (alias === "claude") {
        return claudeMessageDriver();
    }

    return alias === "codex" ? codexMessageDriver() : grokMessageDriver();
}

interface MessageFlags {
    priority?: string;
    first?: boolean;
    json?: boolean;
}

async function readText(parts: string[]): Promise<string> {
    if (parts.length === 1 && parts[0] === "-") {
        return (await new Response(Bun.stdin.stream()).text()).trim();
    }

    return parts.join(" ").trim();
}

const PRIORITIES: readonly PeerPriority[] = ["now", "next", "later"];

export async function messageCommand(alias: TurnProvider, query: string, parts: string[], flags: MessageFlags) {
    const text = await readText(parts);

    if (!text) {
        out.error(`nothing to send: tools ${alias} message <session> <text> (or - to read stdin)`);
        process.exitCode = 2;
        return;
    }

    if (flags.priority !== undefined && !PRIORITIES.some((priority) => priority === flags.priority)) {
        out.error(`--priority must be one of ${PRIORITIES.join(", ")} (got ${flags.priority})`);
        process.exitCode = 2;
        return;
    }

    const priority = PRIORITIES.find((value) => value === flags.priority);

    try {
        const delivery = await messageDriverFor(alias).deliver({ query, text, priority, first: flags.first });

        if (flags.json) {
            out.result(delivery);
        } else {
            out.println(
                `sent to ${alias} ${delivery.sessionId}${delivery.name ? ` (${delivery.name})` : ""} via ${delivery.via}; ${delivery.note}`
            );
        }
    } catch (error) {
        if (error instanceof MessageError) {
            out.error(error.message);

            for (const line of error.suggestions) {
                out.error(`  ${line}`);
            }
        } else {
            out.error(error instanceof Error ? error.message : String(error));
        }

        process.exitCode = 1;
    }

    await out.flush();
}

export function registerAgentMessageCommand(program: Command, alias: TurnProvider): Command {
    return program
        .command("message <session> [text...]")
        .description(
            `Send a message into a RUNNING ${alias} session through the agent's own channel, not by typing into its terminal`
        )
        .option("--priority <now|next|later>", "Claude: when the session handles it (default: its own queue order)")
        .option("--first", "When a /rename title matches several sessions, take the newest instead of failing")
        .option("--json", "Print {agent,sessionId,name,via,note}")
        .addHelpText(
            "after",
            `
<session> is a session id (8+ characters is enough), a session name, or a /rename title.
<text> is the message; pass - to read it from stdin.

Channels:
  claude  its cross-session socket (~/.claude/sessions/<pid>.json -> /tmp/cc-socks/<pid>.sock).
          A busy session reads it between tool calls; an idle one starts a turn. The receiving
          Claude sees it as a message from another session (advice, not the user's own words), and a
          session in bypass mode holds it for approval unless its crossSessionInbound setting is accept.
  codex   codex queue on the shared app-server; runs after the current turn. Needs a TUI attached to
          that server (started with --remote or the default daemon).
  grok    no structured channel yet; the error names the keystroke fallback.

Not the agents bus: \`tools agents message\` sends to agents logged into a bus session.`
        )
        .action(async (session: string, parts: string[], flags: MessageFlags) => {
            await messageCommand(alias, session, parts, flags);
        });
}
