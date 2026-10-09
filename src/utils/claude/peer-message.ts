import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { batchPsInfo } from "@genesiscz/utils/process/ps";
import { isProcessAlive } from "@genesiscz/utils/process-alive";

/**
 * Claude Code's cross-session messaging (2.1.224+): every interactive session listens on a Unix socket
 * and advertises it in `~/.claude/sessions/<pid>.json`. A newline-delimited JSON `user` frame written to
 * that socket reaches the RUNNING session: a busy one reads it between tool calls, an idle one starts a
 * turn. No keystrokes, so it cannot land in a half-typed prompt or an open dialog.
 *
 * The wire format was read from Claude Code 2.1.224 and verified against a live session.
 * The receiver checks `session_id` against its own id and drops a mismatch, which protects against pid
 * reuse. A bare sender binds no reply socket, so an accepted message gets no receipt; silence after a
 * clean write is the success case.
 */

const { log } = logger.scoped("claude-peer");

export interface ClaudeLiveSession {
    pid: number;
    sessionId: string;
    name: string | null;
    cwd: string | null;
    status: string | null;
    kind: string | null;
    socketPath: string;
    /** The registry file this entry came from (for error messages; never the key file). */
    file: string;
}

function claudeDir(): string {
    return env.paths.getClaudeConfigDir() ?? join(env.paths.getHome(), ".claude");
}

export function claudeSessionsDir(): string {
    return join(claudeDir(), "sessions");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function text(value: unknown): string | null {
    return typeof value === "string" && value !== "" ? value : null;
}

const CLAUDE_COMMAND = /claude/i;

/**
 * Which registry pids still run Claude. A registry entry outlives its process, and a recycled pid that runs
 * something other than Claude is gone too. Liveness is a signal-0 probe per pid; the commands come from ONE
 * batched `ps` for the whole inventory, never one `ps` per entry. A live pid whose command cannot be read
 * stays (unverified), as `classifyPid` treats it.
 */
export function liveClaudePids(
    pids: number[],
    matches: (command: string) => boolean = (command) => CLAUDE_COMMAND.test(command)
): Set<number> {
    const running = new Set(pids.filter((pid) => isProcessAlive(pid)));
    const rows = running.size > 0 ? batchPsInfo([...running]) : new Map<number, { command: string }>();
    const live = new Set<number>();

    for (const pid of pids) {
        const command = rows.get(pid)?.command;

        if (!running.has(pid)) {
            log.debug({ pid, status: "dead" }, "registry entry's process is gone");
        } else if (command !== undefined && !matches(command)) {
            log.debug({ pid, status: "foreign", command }, "registry entry's process is gone");
        } else {
            live.add(pid);
        }
    }

    return live;
}

/** Parse one `<pid>.json` registry file; null when it is not a messaging-capable session. */
export function parseRegistryEntry(raw: string, file: string): ClaudeLiveSession | null {
    let parsed: unknown;

    try {
        parsed = SafeJSON.parse(raw, { strict: true });
    } catch (error) {
        log.debug({ error, file }, "unreadable session registry file");
        return null;
    }

    if (!isRecord(parsed)) {
        return null;
    }

    const entry = parsed;
    const pid = typeof entry.pid === "number" ? entry.pid : null;
    const sessionId = text(entry.sessionId);
    const socketPath = text(entry.messagingSocketPath);

    if (pid === null || !sessionId || !socketPath) {
        return null;
    }

    return {
        pid,
        sessionId,
        name: text(entry.name),
        cwd: text(entry.cwd),
        status: text(entry.status),
        kind: text(entry.kind),
        socketPath,
        file,
    };
}

/** Every live Claude session that advertises a messaging socket. `liveOf` checks the whole inventory at once. */
export function listClaudeLiveSessions(
    dir: string = claudeSessionsDir(),
    liveOf: (pids: number[]) => Set<number> = (pids) => liveClaudePids(pids)
): ClaudeLiveSession[] {
    let names: string[];

    try {
        names = readdirSync(dir);
    } catch (error) {
        log.debug({ error, dir }, "no Claude session registry");
        return [];
    }

    const entries: ClaudeLiveSession[] = [];

    for (const name of names) {
        if (!/^\d+\.json$/.test(name)) {
            continue;
        }

        const file = join(dir, name);
        let raw: string;

        try {
            raw = readFileSync(file, "utf8");
        } catch (error) {
            log.debug({ error, file }, "session registry file vanished");
            continue;
        }

        const entry = parseRegistryEntry(raw, file);

        if (entry) {
            entries.push(entry);
        }
    }

    if (entries.length === 0) {
        return [];
    }

    const live = liveOf(entries.map((entry) => entry.pid));
    return entries.filter((entry) => live.has(entry.pid));
}

/**
 * The peer token for a session, from `<pid>.<sha256 of socket path>.key` (mode 0600, same OS user).
 * Only needed on Windows today, but sent whenever readable. The value never goes to a log.
 */
export function readPeerToken(
    session: Pick<ClaudeLiveSession, "pid">,
    dir: string = claudeSessionsDir()
): string | null {
    let names: string[];

    try {
        names = readdirSync(dir).filter((name) => name.startsWith(`${session.pid}.`) && name.endsWith(".key"));
    } catch (error) {
        log.debug({ error, dir }, "no key files");
        return null;
    }

    for (const name of names) {
        try {
            const parsed: unknown = SafeJSON.parse(readFileSync(join(dir, name), "utf8"), { strict: true });

            const token = isRecord(parsed) ? parsed.peerToken : null;

            if (typeof token === "string" && /^[0-9a-f]{16,128}$/i.test(token)) {
                return token;
            }
        } catch (error) {
            log.debug({ error, pid: session.pid, file: name }, "unreadable key file");
        }
    }

    return null;
}

export type PeerPriority = "now" | "next" | "later";

/** The newline-delimited frames for one message: an optional auth line, then the user frame. */
export function peerFrames(input: {
    sessionId: string;
    text: string;
    token?: string | null;
    priority?: PeerPriority;
}): string {
    const lines: string[] = [];

    if (input.token) {
        lines.push(SafeJSON.stringify({ type: "auth", token: input.token }));
    }

    lines.push(
        SafeJSON.stringify({
            type: "user",
            message: { role: "user", content: input.text },
            session_id: input.sessionId,
            uuid: crypto.randomUUID(),
            ...(input.priority ? { priority: input.priority } : {}),
        })
    );

    return `${lines.join("\n")}\n`;
}

/** The documented cap is about a million characters per message; stay well below the connection cap. */
export const PEER_MESSAGE_MAX_CHARS = 900_000;

/**
 * Write one message to a live session's socket. Resolves once the bytes are flushed and the socket is
 * closed; rejects when the socket cannot be reached within `timeoutMs`.
 */
export async function sendClaudePeerMessage(input: {
    session: Pick<ClaudeLiveSession, "sessionId" | "socketPath" | "pid">;
    text: string;
    token?: string | null;
    priority?: PeerPriority;
    timeoutMs?: number;
}): Promise<void> {
    if (input.text.length > PEER_MESSAGE_MAX_CHARS) {
        throw new Error(`message is ${input.text.length} characters; the limit is ${PEER_MESSAGE_MAX_CHARS}`);
    }

    const payload = peerFrames({
        sessionId: input.session.sessionId,
        text: input.text,
        token: input.token,
        priority: input.priority,
    });
    const timeoutMs = input.timeoutMs ?? 5_000;
    // Bun sockets do not buffer: `write` takes what the kernel accepts (8 KB on a macOS Unix socket) and
    // returns the count, and the rest goes out from `drain`. Ending after one write cut a long message.
    const bytes = Buffer.from(payload, "utf8");
    let written = 0;

    await new Promise<void>((resolve, reject) => {
        let settled = false;
        let open: { end(): void } | null = null;
        const finish = (error?: Error) => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timer);

            if (error) {
                open?.end();
                reject(error);
            } else {
                resolve();
            }
        };
        const timer = setTimeout(
            () => finish(new Error(`no answer from ${input.session.socketPath} within ${timeoutMs} ms`)),
            timeoutMs
        );
        const writeRest = (socket: { write(data: Uint8Array): number; end(): void }) => {
            if (written < bytes.length) {
                written += Math.max(0, socket.write(bytes.subarray(written)));
            }

            if (written >= bytes.length) {
                socket.end();
            }
        };

        Bun.connect({
            unix: input.session.socketPath,
            socket: {
                open(socket) {
                    open = socket;
                    writeRest(socket);
                },
                drain(socket) {
                    writeRest(socket);
                },
                close() {
                    finish(
                        written < bytes.length
                            ? new Error(`${input.session.socketPath} closed after ${written} of ${bytes.length} bytes`)
                            : undefined
                    );
                },
                error(_socket, error) {
                    finish(error);
                },
                connectError(_socket, error) {
                    finish(error);
                },
                data() {
                    // A bare sender gets no receipt for an accepted message; anything that arrives is ignored.
                },
            },
        }).catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
    });

    log.info(
        {
            pid: input.session.pid,
            sessionId: input.session.sessionId,
            chars: input.text.length,
            priority: input.priority,
        },
        "peer message written"
    );
}
