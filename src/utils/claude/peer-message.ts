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
 *
 * Sent from inside a Claude Code session, the content is the `cross-session-message` envelope that names that
 * session (its socket, name and permission class), as Claude Code's own SendMessage writes it (read from 2.1.296).
 * A receiver in bypass mode delivers only a sender that declares bypass too; a plain frame is held for approval.
 * The receiver's receipts then go to the parent's socket, which refuses them (the connecting pid is this child).
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

/**
 * Ids (lower case) of every Claude session whose process is still running, from the registry alone: no
 * messaging socket needed. A parked entry (`parkedJobId`, the conversation moved to a background job under a
 * new id) does not count, because its id is frozen. null when the registry cannot be read, so a caller can
 * tell "unknown" from "not running".
 *
 * Liveness is a signal-0 probe only, without `liveClaudePids`' batched `ps`: measured 2026-10-23 on 26
 * entries, 0.39 ms median against 213 ms, and this runs on every monitor poll. Claude deletes its entry on
 * exit, so only a crash leaves one behind, and a recycled pid then reads as alive: the fail-open side.
 */
export function liveClaudeSessionIds(
    dir: string = claudeSessionsDir(),
    liveOf: (pids: number[]) => Set<number> = (pids) => new Set(pids.filter((pid) => isProcessAlive(pid)))
): Set<string> | null {
    let names: string[];

    try {
        names = readdirSync(dir);
    } catch (error) {
        log.debug({ error, dir }, "no Claude session registry");
        return null;
    }

    const byPid = new Map<number, string>();

    for (const name of names) {
        if (!/^\d+\.json$/.test(name)) {
            continue;
        }

        try {
            const parsed: unknown = SafeJSON.parse(readFileSync(join(dir, name), "utf8"), { strict: true });

            if (
                isRecord(parsed) &&
                typeof parsed.pid === "number" &&
                text(parsed.sessionId) &&
                !text(parsed.parkedJobId)
            ) {
                byPid.set(parsed.pid, String(parsed.sessionId).toLowerCase());
            }
        } catch (error) {
            // Entries can disappear between readdir and read when a process exits. Other failures
            // leave an unknown live inventory, so do not classify every missing session as dead.
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
                continue;
            }

            log.debug({ error, name }, "unreadable session registry file");
            return null;
        }
    }

    const live = liveOf([...byPid.keys()]);
    return new Set([...byPid].filter(([pid]) => live.has(pid)).map(([, id]) => id));
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

/** The permission class a sender declares in `from-mode`; Claude Code knows no other values. */
export type PeerSenderMode = "bypass" | "prompting";

/**
 * The Claude Code session a message is sent on behalf of (`peer-sender.ts` reads it from the environment of a
 * Bash tool child). The receiver trusts `mode` as written and auto-delivers only a sender whose class matches
 * its own, so `mode` must be the sender's real class, and null whenever that is not known.
 */
export interface PeerSender {
    /** The sending session's id. */
    sessionId: string;
    /** The sending session's OWN messaging socket (`$CLAUDE_CODE_MESSAGING_SOCKET`), never the receiver's. */
    socketPath: string;
    /** Its registry name, shown by the receiver as `from-name`. */
    name: string | null;
    /** Null when the mode is unknown or `plan`: then the envelope carries no `from-mode`. */
    mode: PeerSenderMode | null;
}

const ENVELOPE_TAG = "cross-session-message";

/** The sender to attest for a message to `targetSessionId`: none to the sender's own session, which stays as before. */
export function attestingSender(sender: PeerSender | null | undefined, targetSessionId: string): PeerSender | null {
    return sender && sender.sessionId !== targetSessionId ? sender : null;
}

/**
 * Claude Code's peer address for a socket path (`aV` and `R` in 2.1.296): `uds:` plus the path with each UTF-8
 * byte of a character outside `[A-Za-z0-9:_/.\-]` (backslash included in that set) written as `%XX`.
 */
export function peerAddress(socketPath: string): string {
    const encoder = new TextEncoder();
    const encoded = socketPath.replace(/[^A-Za-z0-9:_/.\\-]/gu, (char) =>
        Array.from(encoder.encode(char), (byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join("")
    );

    return `uds:${encoded}`;
}

/**
 * A `from-name` value exactly as the receiver re-serializes it (`Ny` in 2.1.296): `"`, `<` and `>` removed,
 * Unicode Cf, Cc, Cs, Zl and Zp removed, trimmed, then cut to 64 code points plus an ellipsis. The receiver
 * compares its re-serialization with the envelope byte for byte, and any difference hides the whole envelope.
 */
export function peerSenderName(name: string): string {
    const kept = name
        .replace(/["<>]/g, "")
        .replace(/[\p{Cf}\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/gu, "")
        .trim();
    const points = [...kept];

    return points.length > 64 ? `${points.slice(0, 64).join("")}…` : kept;
}

/**
 * The body with a backslash after the `<` of every closing envelope tag, in any case and with `-` or `_`, so the
 * body cannot end the envelope early. Claude Code also escapes look-alike characters and fillers inside the tag;
 * a body with those fails the receiver's round-trip check, which then holds the message, as for no attestation.
 */
export function escapePeerBody(body: string): string {
    return body.replace(/<(?=\/cross[-_]session[-_]message)/giu, "<\\");
}

/** The `cross-session-message` envelope Claude Code's receiver parses (`ldt` in 2.1.296); attribute order is fixed. */
export function peerEnvelope(input: {
    from: string;
    name: string | null;
    mode: PeerSenderMode | null;
    body: string;
}): string {
    const attributes = [`from="${input.from}"`];
    const name = input.name === null ? "" : peerSenderName(input.name);

    if (name) {
        attributes.push(`from-name="${name}"`);
    }

    if (input.mode) {
        attributes.push(`from-mode="${input.mode}"`);
    }

    return `<${ENVELOPE_TAG} ${attributes.join(" ")}>\n${escapePeerBody(input.body)}\n</${ENVELOPE_TAG}>`;
}

/**
 * The newline-delimited frames for one message: an optional auth line, then the user frame. With a `sender` (and
 * a target other than the sender's own session) the content is the attested envelope and the frame carries the
 * sender's address, `msgV` and `msg_id`, like Claude Code's own SendMessage; without one it is the plain text.
 */
export function peerFrames(input: {
    sessionId: string;
    text: string;
    token?: string | null;
    priority?: PeerPriority;
    sender?: PeerSender | null;
    /** Tests pin the ids; a random UUID v4 otherwise. */
    newId?: () => string;
}): string {
    const newId = input.newId ?? (() => crypto.randomUUID());
    const sender = attestingSender(input.sender, input.sessionId);
    const from = sender ? peerAddress(sender.socketPath) : null;
    // Claude Code's own sender always says "next"; a plain frame keeps the receiver's default unless asked.
    const priority = input.priority ?? (sender ? "next" : undefined);
    const lines: string[] = [];

    if (input.token) {
        lines.push(SafeJSON.stringify({ type: "auth", token: input.token }));
    }

    lines.push(
        SafeJSON.stringify({
            type: "user",
            message: {
                role: "user",
                content:
                    sender && from
                        ? peerEnvelope({ from, name: sender.name, mode: sender.mode, body: input.text })
                        : input.text,
            },
            session_id: input.sessionId,
            uuid: newId(),
            ...(priority ? { priority } : {}),
            ...(from ? { from, msgV: 1, msg_id: newId() } : {}),
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
    /** The session the message is sent on behalf of; none sends the plain, unattested frame. */
    sender?: PeerSender | null;
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
        sender: input.sender,
    });
    const attested = attestingSender(input.sender, input.session.sessionId);
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
            attested: attested ? { name: attested.name, mode: attested.mode } : null,
        },
        "peer message written"
    );
}
