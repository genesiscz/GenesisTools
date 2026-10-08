import { type LiveAgentSurface, matchLiveAgentSurfaces } from "@app/cmux/lib/session-adopt";
import { liveAgentSurfacesNow } from "@app/cmux/lib/session-close-live";
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
 * channel throws `NoChannelError`, and only `--allow-keystrokes` then pastes into its cmux surface
 * (`cmux paste --submit`, which refuses to type over a draft or into an open dialog).
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
    via: "claude-socket" | "codex-queue" | "cmux-paste";
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

/** The session was found but its agent offers no structured way in (or refused); keystrokes are the only path. */
export class NoChannelError extends MessageError {
    constructor(
        message: string,
        readonly sessionId: string,
        suggestions: string[] = []
    ) {
        super(message, suggestions);
        this.name = "NoChannelError";
    }
}

function liveLabel(entry: LiveAgentSurface): string {
    return `${entry.sessionId.slice(0, 8)}  "${entry.surface.title ?? ""}"  ${entry.surface.workspaceTitle ?? ""}  ${entry.surface.ref}`;
}

/**
 * A session id for a query: the transcript resolver first (id, prefix, path, /rename title), then the
 * live cmux surfaces of that agent (tab title, workspace title, cwd folder), so `vybava` finds the
 * Grok tab called "vybava - grok". Several live matches fail with each candidate's exact command.
 */
export async function resolveSessionId(input: {
    alias: TurnProvider;
    query: string;
    first: boolean;
    transcript?: (query: string, first: boolean) => Promise<string>;
    live?: () => Promise<LiveAgentSurface[]>;
}): Promise<string> {
    const transcript =
        input.transcript ??
        (async (query, first) => (await resolveWaitTranscript(input.alias, query, first)).sessionId);
    const live = input.live ?? liveAgentSurfacesNow;

    try {
        return await transcript(input.query, input.first);
    } catch (error) {
        log.debug({ error, query: input.query, alias: input.alias }, "no transcript match; trying live cmux tabs");
    }

    const surfaces = await live().catch((error: unknown) => {
        log.debug({ error }, "cmux tree unavailable");
        return [];
    });
    const hits = matchLiveAgentSurfaces(input.query, input.alias, surfaces);

    if (hits.length === 1) {
        return hits[0].sessionId;
    }

    const mine = surfaces.filter((entry) => entry.agent === input.alias);
    const shown = hits.length > 1 ? hits : mine;
    throw new MessageError(
        hits.length > 1
            ? `"${input.query}" matches ${hits.length} running ${input.alias} sessions:\n${hits.map((hit) => `  ${liveLabel(hit)}`).join("\n")}`
            : `no ${input.alias} session matches "${input.query}" (tried session id, path, /rename title, cmux tab and workspace titles)` +
                  (mine.length > 0
                      ? `\nrunning ${input.alias} sessions in cmux:\n${mine.map((entry) => `  ${liveLabel(entry)}`).join("\n")}`
                      : ""),
        shown.map((entry) => `tools ${input.alias} message ${entry.sessionId} "<text>"`)
    );
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
    const resolveId = deps.resolveId ?? ((query, first) => resolveSessionId({ alias: "claude", query, first }));

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
                    if (resolveError instanceof MessageError && resolveError.suggestions.length > 0) {
                        throw resolveError;
                    }

                    log.debug({ error: resolveError, query: request.query }, "no session id for the query");
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
    const resolveId = deps.resolveId ?? ((query, first) => resolveSessionId({ alias: "codex", query, first }));
    const queue = deps.queue ?? runCodexQueue;

    return {
        async deliver(request) {
            const sessionId = await resolveId(request.query, request.first === true);
            const result = await queue(sessionId, request.text);

            if (result.code !== 0) {
                throw new NoChannelError(
                    `codex queue refused (${result.code}): ${result.stderr.trim() || "no detail"}. ` +
                        "A Codex TUI takes queued messages only when it was started against the shared app-server (--remote or the default daemon).",
                    sessionId
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

/**
 * Grok has no structured way into a running TUI: checked 2026-10-08 on a live `grok` (1.0.44) in cmux, the
 * process holds only connected anonymous socket pairs and no listening socket, and no leader runs
 * (`grok leader list`: none). Sessions GenesisTools starts itself are driven over ACP (`tools grok worker`).
 */
export function grokMessageDriver(
    deps: { resolveId?: (query: string, first: boolean) => Promise<string> } = {}
): MessageDriver {
    const resolveId = deps.resolveId ?? ((query, first) => resolveSessionId({ alias: "grok", query, first }));

    return {
        async deliver(request) {
            const sessionId = await resolveId(request.query, request.first === true);
            throw new NoChannelError(
                `Grok has no structured channel into a running session (session ${sessionId}): the TUI listens on no socket.`,
                sessionId
            );
        },
    };
}

/** Paste into the session's cmux surface and submit; cmux refuses over a draft or an open dialog. */
async function pasteIntoSurface(input: {
    alias: TurnProvider;
    sessionId: string;
    text: string;
    live?: () => Promise<LiveAgentSurface[]>;
}): Promise<MessageDelivery> {
    const surfaces = await (input.live ?? liveAgentSurfacesNow)();
    const target = surfaces.find((entry) => entry.sessionId === input.sessionId && entry.agent === input.alias);

    if (!target) {
        throw new MessageError(`session ${input.sessionId} has no live cmux surface to paste into`);
    }

    const proc = Bun.spawn(["cmux", "paste", "--surface", target.surface.ref, "--submit", "--", input.text], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

    if (code !== 0) {
        throw new MessageError(
            `cmux paste refused (${code}): ${stderr.trim() || "no detail"}. It refuses while the prompt holds a draft or a question/permission dialog is open.`
        );
    }

    return {
        agent: input.alias,
        sessionId: input.sessionId,
        name: target.surface.title,
        via: "cmux-paste",
        note: `pasted and submitted in ${target.surface.ref} (keystrokes, no structured channel)`,
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
    allowKeystrokes?: boolean;
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
        const delivery = await messageDriverFor(alias)
            .deliver({ query, text, priority, first: flags.first })
            .catch((error: unknown) => {
                if (!(error instanceof NoChannelError)) {
                    throw error;
                }

                if (!flags.allowKeystrokes) {
                    throw new MessageError(error.message, [
                        `tools ${alias} message ${error.sessionId} "<text>" --allow-keystrokes   # paste into its cmux tab (refuses over a draft or dialog)`,
                    ]);
                }

                log.debug(
                    { alias, sessionId: error.sessionId },
                    "no structured channel; pasting into the cmux surface"
                );
                return pasteIntoSurface({ alias, sessionId: error.sessionId, text });
            });

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
        .option(
            "--allow-keystrokes",
            "When the agent has no structured channel (Grok, a Codex TUI without the shared app-server), paste into its cmux tab with cmux paste --submit"
        )
        .option("--json", "Print {agent,sessionId,name,via,note}")
        .addHelpText(
            "after",
            `
<session> is a session id (8+ characters is enough), a session name, a /rename title, or part of the
cmux tab or workspace title the session runs in ("vybava" finds the tab "vybava - grok").
<text> is the message; pass - to read it from stdin.

Channels:
  claude  its cross-session socket (~/.claude/sessions/<pid>.json -> /tmp/cc-socks/<pid>.sock).
          A busy session reads it between tool calls; an idle one starts a turn. The receiving
          Claude sees it as a message from another session (advice, not the user's own words), and a
          session in bypass mode holds it for approval unless its crossSessionInbound setting is accept.
  codex   codex queue on the shared app-server; runs after the current turn. Needs a TUI attached to
          that server (started with --remote or the default daemon).
  grok    no structured channel: the TUI listens on no socket. --allow-keystrokes pastes into its cmux
          tab instead (cmux paste --submit refuses over a draft or an open dialog).

Not the agents bus: \`tools agents message\` sends to agents logged into a bus session.`
        )
        .action(async (session: string, parts: string[], flags: MessageFlags) => {
            await messageCommand(alias, session, parts, flags);
        });
}
