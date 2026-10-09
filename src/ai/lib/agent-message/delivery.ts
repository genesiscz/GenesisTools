import { resolveSessionTranscript } from "@app/ai/lib/sessions/resolve-transcript";
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
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { type CmuxRunResult, runCmux } from "@genesiscz/utils/cmux/lib/cli";
import { logger } from "@genesiscz/utils/logger";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";

const { log } = logger.scoped("agent-message");

/**
 * Deliver a message to a RUNNING agent session through the agent's own structured channel, never by typing
 * into its terminal. One driver per agent; an agent without such a channel throws `NoChannelError`, and only
 * `allowKeystrokes` then pastes into its cmux surface (`cmux paste --submit`, which refuses to type over a
 * draft or into an open dialog). `tools <agent> message` is the CLI adapter over this module.
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
        (async (query, first) => (await resolveSessionTranscript(input.alias, query, first)).sessionId);
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
                hits.map((hit) => toolCommand("claude message", hit.sessionId, '"<text>"'))
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
                                          `${toolCommand("claude message", session.sessionId, '"<text>"')}   # ${session.name ?? ""}`
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

/** How long `codex queue` may take to hand the message to the app-server before the send counts as unknown. */
export const CODEX_QUEUE_TIMEOUT_MS = 30_000;

export interface CodexQueueResult {
    code: number;
    stderr: string;
    /** The deadline passed: the message may or may not be queued. */
    timedOut: boolean;
}

/** `codex queue` under the shared bounded runner: a deadline with kill escalation, and both pipes drained. */
async function runCodexQueue(threadId: string, text: string): Promise<CodexQueueResult> {
    const result = await boundedCommand({
        command: ["codex", "queue", "--thread", threadId, "--message", text],
        timeoutMs: CODEX_QUEUE_TIMEOUT_MS,
    });
    const timedOut = result.error?.code === "ETIMEDOUT";
    log.debug(
        { threadId, status: result.status, signal: result.signal, error: result.error?.message, timedOut },
        "codex queue finished"
    );

    return {
        code: result.status ?? 1,
        stderr: result.stderr.trim() || result.error?.message || "",
        timedOut,
    };
}

/**
 * Codex: `codex queue` adds the message to the thread's queue on the shared app-server daemon; it runs
 * after the current turn. Works only when the TUI is attached to that daemon; a TUI with its own embedded
 * server answers "No active session".
 */
export function codexMessageDriver(
    deps: {
        resolveId?: (query: string, first: boolean) => Promise<string>;
        queue?: (threadId: string, text: string) => Promise<CodexQueueResult>;
    } = {}
): MessageDriver {
    const resolveId = deps.resolveId ?? ((query, first) => resolveSessionId({ alias: "codex", query, first }));
    const queue = deps.queue ?? runCodexQueue;

    return {
        async deliver(request) {
            const sessionId = await resolveId(request.query, request.first === true);
            const result = await queue(sessionId, request.text);

            // Not a NoChannelError: the queue may hold the message already, and a keystroke fallback would send it twice.
            if (result.timedOut) {
                throw new MessageError(
                    `codex queue gave no answer within ${CODEX_QUEUE_TIMEOUT_MS / 1000} s, so the message may or may not be queued in ${sessionId}. Check the session before you send it again.`
                );
            }

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

/**
 * Paste into the session's cmux surface and submit; cmux refuses over a draft or an open dialog.
 * The paste runs through the shared bounded runner, so a wedged cmux ends in a MessageError, not a hang.
 */
export async function pasteIntoSurface(input: {
    alias: TurnProvider;
    sessionId: string;
    text: string;
    live?: () => Promise<LiveAgentSurface[]>;
    run?: (args: string[]) => Promise<CmuxRunResult>;
}): Promise<MessageDelivery> {
    const surfaces = await (input.live ?? liveAgentSurfacesNow)();
    const target = surfaces.find((entry) => entry.sessionId === input.sessionId && entry.agent === input.alias);

    if (!target) {
        throw new MessageError(`session ${input.sessionId} has no live cmux surface to paste into`);
    }

    const run = input.run ?? ((args: string[]) => runCmux(args));
    const result = await run(["paste", "--surface", target.surface.ref, "--submit", "--", input.text]);

    if (result.timedOut) {
        throw new MessageError(`cmux paste into ${target.surface.ref} timed out: ${result.stderr.trim()}`);
    }

    if (result.code !== 0) {
        throw new MessageError(
            `cmux paste refused (${result.code}): ${result.stderr.trim() || "no detail"}. It refuses while the prompt holds a draft or a question/permission dialog is open.`
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

/**
 * Deliver through the agent's driver. When the agent has no structured channel, paste into its cmux surface
 * only with `allowKeystrokes`; without it, fail with the exact command that would allow it.
 */
export async function deliverMessage(input: {
    alias: TurnProvider;
    request: MessageRequest;
    allowKeystrokes: boolean;
    driver?: MessageDriver;
    paste?: typeof pasteIntoSurface;
}): Promise<MessageDelivery> {
    const driver = input.driver ?? messageDriverFor(input.alias);
    const paste = input.paste ?? pasteIntoSurface;

    try {
        return await driver.deliver(input.request);
    } catch (error) {
        if (!(error instanceof NoChannelError)) {
            throw error;
        }

        if (!input.allowKeystrokes) {
            throw new MessageError(error.message, [
                `tools ${input.alias} message ${error.sessionId} "<text>" --allow-keystrokes   # paste into its cmux tab (refuses over a draft or dialog)`,
            ]);
        }

        log.debug(
            { alias: input.alias, sessionId: error.sessionId },
            "no structured channel; pasting into the cmux surface"
        );
        return paste({ alias: input.alias, sessionId: error.sessionId, text: input.request.text });
    }
}
