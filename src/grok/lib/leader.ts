import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileSessionStore, openSessions, type SessionStore } from "@app/cmux/lib/session-store";
import { GrokAcpClient, GrokAcpError, GrokAcpRefusedError, type GrokLeaderSession } from "@genesiscz/utils/ai/grok/acp";
import { logger } from "@genesiscz/utils/logger";
import { nativeHomePath } from "@genesiscz/utils/providers/session-paths";
import { toolDataDir } from "@genesiscz/utils/storage/root";

const { log } = logger.scoped("grok-leader");

/**
 * Grok leader mode: a TUI started with `--leader --leader-socket <sock>` runs its session inside a shared leader
 * process (it starts one on that socket when none answers, `--no-exit-on-disconnect`, and later TUIs join it). A
 * second ACP client on the same socket lists the session (`session/list`) and prompts it (`session/prompt`); the TUI
 * shows the prompt and the answer as its own turn. Live-tested on grok 1.0.70, 2026-10-30. The ACP framing is
 * `GrokAcpClient` in `@genesiscz/utils/ai/grok/acp`; this module picks the socket and the session.
 */

/** macOS `sun_path` holds 104 bytes with the terminating NUL. */
const MAX_SOCKET_PATH = 103;

/**
 * The leader socket of one Grok account's `tools cmux agents new` sessions: one leader per account, so a second
 * session of that account joins the first one's leader. Never the default `~/.grok/leader.sock`, which may be the
 * user's own leader.
 */
export function grokLeaderSocket(account: string): string {
    const slug =
        account
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 24) || "account";
    const hash = createHash("sha256").update(account).digest("hex").slice(0, 8);
    const socket = toolDataDir("grok", "leaders", `${slug}-${hash}.sock`);
    if (Buffer.byteLength(socket, "utf8") <= MAX_SOCKET_PATH) {
        return socket;
    }

    // A long GENESIS_TOOLS_HOME (a sandbox) does not fit a socket path, and neither does macOS's per-user temp folder
    // under a test sandbox; a per-user folder under /tmp does.
    const base = process.platform === "win32" ? tmpdir() : "/tmp";
    const user = typeof process.getuid === "function" ? String(process.getuid()) : "user";
    const short = join(
        base,
        `gt-grok-leaders-${user}`,
        `${createHash("sha256").update(socket).digest("hex").slice(0, 16)}.sock`
    );
    if (Buffer.byteLength(short, "utf8") > MAX_SOCKET_PATH) {
        throw new Error(`the Grok leader socket path is longer than ${MAX_SOCKET_PATH} bytes: ${short}`);
    }

    return short;
}

/** The TUI's own default leader socket (`~/.grok/leader.sock`, or under `GROK_HOME`). */
export function defaultGrokLeaderSocket(): string {
    return nativeHomePath("grok", "leader.sock");
}

/** The leader sockets a session's record names (`tools cmux agents new grok`), newest first. */
export function recordedLeaderSockets(sessionId: string, store: SessionStore = fileSessionStore()): string[] {
    const sockets = openSessions(store.read())
        .filter((record) => record.providers?.grok?.leader.sessionId === sessionId)
        .map((record) => record.providers?.grok?.leader.socket)
        .filter((socket): socket is string => typeof socket === "string")
        .reverse();
    return [...new Set(sockets)];
}

/**
 * The sockets to ask for a session, in order: the ones its record names, then the default socket. A socket file that
 * does not exist is skipped, so no leader process is started by asking.
 */
export function leaderSocketsFor(
    sessionId: string,
    deps: { store?: SessionStore; exists?: (path: string) => boolean; defaultSocket?: string } = {}
): string[] {
    const exists = deps.exists ?? existsSync;
    const candidates = [
        ...recordedLeaderSockets(sessionId, deps.store),
        deps.defaultSocket ?? defaultGrokLeaderSocket(),
    ];
    return [...new Set(candidates)].filter((socket) => exists(socket));
}

function canonicalPath(path: string): string {
    try {
        return realpathSync(path);
    } catch (error) {
        log.debug({ error, path }, "the path has no realpath; comparing it as written");
        return path;
    }
}

/**
 * The listed session a send goes to: the exact id first; else, when a cwd is given, the one session in that folder
 * (macOS lists `/private/tmp/...` for `/tmp/...`, so both sides are compared by realpath). Several in one folder is
 * no match: typing into the wrong agent is worse than not sending.
 */
export function matchLeaderSession(
    sessions: readonly GrokLeaderSession[],
    query: { sessionId?: string; cwd?: string }
): GrokLeaderSession | undefined {
    const byId = query.sessionId ? sessions.find((session) => session.sessionId === query.sessionId) : undefined;
    if (byId) {
        return byId;
    }

    if (!query.cwd) {
        return undefined;
    }

    const wanted = canonicalPath(query.cwd);
    const inFolder = sessions.filter((session) => session.cwd && canonicalPath(session.cwd) === wanted);
    return inFolder.length === 1 ? inFolder[0] : undefined;
}

export type GrokLeaderSend =
    /** The leader queued (or started) the prompt in this session; the turn runs there now. */
    | { kind: "delivered"; socket: string; sessionId: string; promptId?: string }
    /** No leader holds the session, or none answered; nothing was sent, so a lower rung may take it. */
    | { kind: "absent"; reason: string }
    /** The prompt was written and no acknowledgement came; it may have been accepted, so it must not be resent. */
    | { kind: "unknown"; socket: string; sessionId: string; reason: string };

export interface GrokLeaderClient {
    listSessions(timeoutMs?: number): Promise<GrokLeaderSession[]>;
    promptSession(
        sessionId: string,
        text: string,
        options?: { until?: "queued" | "completed"; timeoutMs?: number }
    ): Promise<{ outcome: string; promptId?: string }>;
    reset(): void;
}

export interface GrokLeaderSendDeps {
    sockets?: (sessionId: string) => string[];
    client?: (socket: string) => GrokLeaderClient;
}

const LIST_TIMEOUT_MS = 15_000;
const QUEUE_TIMEOUT_MS = 30_000;

/**
 * Send `text` as the next prompt of the Grok session through a leader that holds it. Waits only for the leader's
 * queue acknowledgement, then closes the client; the turn runs on in the leader and the TUI renders it (live
 * 2026-10-30: the client exited 0.3 s after the acknowledgement and the TUI showed the prompt and its answer).
 */
export async function sendToGrokLeader(
    input: { sessionId: string; text: string; cwd?: string },
    deps: GrokLeaderSendDeps = {}
): Promise<GrokLeaderSend> {
    const sockets = (deps.sockets ?? ((id) => leaderSocketsFor(id)))(input.sessionId);
    const open = deps.client ?? ((socket: string) => new GrokAcpClient(0, { leader: { socket } }));
    const misses: string[] = [];

    if (sockets.length === 0) {
        return { kind: "absent", reason: "no Grok leader socket exists for this session" };
    }

    for (const socket of sockets) {
        const client = open(socket);
        try {
            let sessions: GrokLeaderSession[];
            try {
                sessions = await client.listSessions(LIST_TIMEOUT_MS);
            } catch (error) {
                log.debug({ error, socket }, "the Grok leader did not answer session/list");
                misses.push(`${socket}: no answer`);
                continue;
            }

            const match = matchLeaderSession(sessions, { sessionId: input.sessionId, cwd: input.cwd });
            if (!match) {
                misses.push(`${socket}: ${sessions.length} sessions, none is this one`);
                continue;
            }

            try {
                const sent = await client.promptSession(match.sessionId, input.text, {
                    until: "queued",
                    timeoutMs: QUEUE_TIMEOUT_MS,
                });
                log.info(
                    { socket, sessionId: match.sessionId, outcome: sent.outcome, promptId: sent.promptId },
                    "prompt queued in the Grok leader"
                );
                return {
                    kind: "delivered",
                    socket,
                    sessionId: match.sessionId,
                    ...(sent.promptId ? { promptId: sent.promptId } : {}),
                };
            } catch (error) {
                if (error instanceof GrokAcpRefusedError) {
                    log.info({ error, socket, sessionId: match.sessionId }, "the Grok leader refused the prompt");
                    misses.push(`${socket}: refused (${error.message})`);
                    continue;
                }

                log.warn(
                    { error, socket, sessionId: match.sessionId },
                    "the Grok leader prompt has an unknown outcome"
                );
                return {
                    kind: "unknown",
                    socket,
                    sessionId: match.sessionId,
                    reason: error instanceof GrokAcpError ? error.message : String(error),
                };
            }
        } finally {
            client.reset();
        }
    }

    log.info({ sessionId: input.sessionId, misses }, "no Grok leader holds this session");
    return { kind: "absent", reason: `no Grok leader holds this session (${misses.join("; ")})` };
}
