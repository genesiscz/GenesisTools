import { withTimeout } from "@genesiscz/utils/async";
import { RpcPeer, type RpcPeerOptions } from "./peer";

/** The pipes of a child process that speaks JSON-RPC on stdio: a Bun subprocess fits, and a test passes a fake. */
export interface ChildStdio {
    stdin: { write(chunk: string): unknown; flush?(): unknown };
    stdout: ReadableStream<Uint8Array>;
    /** Settles with the exit code; without it, the end of stdout alone ends the connection. */
    exited?: Promise<number>;
}

export interface ChildStdioOptions extends Omit<RpcPeerOptions, "write" | "onBacklogFull"> {
    child: ChildStdio;
    /** The reason every waiting request rejects with when the child exits; `<label> exited with code <n>` by default. */
    exitReason?: (code: number) => string;
    /**
     * How long the end of stdout waits for the exit code, and the exit waits for the rest of stdout, before the
     * connection ends without the other.
     */
    exitGraceMs?: number;
}

/**
 * The bytes handed to stdin and not flushed yet, past which the next message waits in the peer's outbox. There it
 * counts toward `OUTBOX_LIMIT_BYTES`, so a child that stopped reading ends its connection instead of piling up writes.
 */
export const CHILD_STDIN_HIGH_WATER_BYTES = 64 * 1024;

export interface ChildStdioConnection {
    peer: RpcPeer;
    /**
     * Settles once every message the peer sent before this call is written to stdin and flushed, the ones its outbox
     * still holds included; a message sent later does not extend the wait. Rejects with the error of a write that
     * failed, or when the connection closed before those messages were written (the outbox dropped them). A caller
     * that must order its next message after an answer awaits it.
     */
    written(): Promise<void>;
    /**
     * Settles once this adapter ended the connection: stdout was read to its end, or the child exited and the rest of
     * its stdout was read (for at most `exitGraceMs`), and the peer is closed. A caller that acts on the exit awaits it,
     * so the replies the child wrote before it exited reach their calls first.
     */
    ended: Promise<void>;
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** A `written()` call: it waits until the bytes the peer had sent when it was called are written. */
interface WriteWaiter {
    through: number;
    resolve: () => void;
    reject: (error: Error) => void;
}

/** One message handed to stdin: `start` is its first byte in the order the peer sent them. */
interface StdinWrite {
    start: number;
    bytes: number;
    done: boolean;
}

/**
 * Connects a peer to a child process: each line on stdout goes to `peer.receive`, each message the peer writes goes to
 * stdin, and at the end of stdout every waiting request rejects with the exit reason. An exit first reads the rest of
 * stdout, so the replies the child wrote before it exited still resolve their calls. A failed write or a line past the
 * dialect's limit ends the connection the same way, with its own reason.
 */
export function connectChildStdio(options: ChildStdioOptions): ChildStdioConnection {
    const { child, exitReason: reasonFor, exitGraceMs = 2000, ...peerOptions } = options;
    const exitReason = reasonFor ?? ((code: number) => `${options.label} exited with code ${code}`);
    let inFlight = 0;
    let peer: RpcPeer | undefined;
    /** The bytes handed to stdin, and of those the leading ones whose write and flush finished, in the peer's order. */
    let acceptedBytes = 0;
    let writtenBytes = 0;
    const writes: StdinWrite[] = [];
    let failure: { start: number; error: Error } | undefined;
    const waiters = new Set<WriteWaiter>();

    const settleWaiters = (): void => {
        for (const waiter of waiters) {
            if (writtenBytes >= waiter.through) {
                waiters.delete(waiter);
                waiter.resolve();
            } else if (failure && waiter.through > failure.start) {
                waiters.delete(waiter);
                waiter.reject(failure.error);
            } else if (peer?.closed && waiter.through > acceptedBytes) {
                // A closed peer hands nothing more to stdin: what its outbox held or dropped is never written.
                waiters.delete(waiter);
                waiter.reject(new Error(`${options.label} closed before its messages were written`));
            }
        }
    };

    // Below the high-water mark a message goes to stdin at once. Past it the write takes none of it: the peer's outbox
    // holds it, where the backlog limit applies, and each write that finishes flushes the outbox again.
    const write = (bytes: Buffer): number => {
        if (inFlight > 0 && inFlight + bytes.length > CHILD_STDIN_HIGH_WATER_BYTES) {
            return 0;
        }

        inFlight += bytes.length;
        const entry: StdinWrite = { start: acceptedBytes, bytes: bytes.length, done: false };
        acceptedBytes += bytes.length;
        writes.push(entry);
        // The write starts now, so messages reach stdin in the order the peer sent them; its completion is tracked.
        const current = (async () => {
            await child.stdin.write(bytes.toString());
            await child.stdin.flush?.();
        })();
        current.then(
            () => {
                inFlight -= bytes.length;
                entry.done = true;

                for (let head = writes[0]; head?.done; head = writes[0]) {
                    writtenBytes += head.bytes;
                    writes.shift();
                }

                peer?.flush();
                settleWaiters();
            },
            (error) => {
                inFlight -= bytes.length;
                failure ??= { start: entry.start, error: error instanceof Error ? error : new Error(message(error)) };
                peer?.close(message(error));
                settleWaiters();
            }
        );
        return bytes.length;
    };
    const written = (): Promise<void> => {
        const through = peer?.sentBytes ?? 0;

        return new Promise<void>((resolve, reject) => {
            waiters.add({ through, resolve, reject });
            settleWaiters();
        });
    };
    const connected = new RpcPeer({ ...peerOptions, write, onBacklogFull: settleWaiters });
    peer = connected;
    const reader = child.stdout.getReader();
    const stdoutEnded = readStdout(reader, connected, options);
    const endings = [
        stdoutEnded.then(async (failure) => {
            if (failure !== undefined) {
                connected.close(failure);
                return;
            }

            if (!child.exited) {
                connected.close(`${options.label} closed its stdout`);
                return;
            }

            try {
                connected.close(exitReason(await withTimeout(child.exited, exitGraceMs)));
            } catch (error) {
                options.log.debug(
                    { ...options.logFields, error },
                    `${options.label} closed its stdout without an exit`
                );
                connected.close(`${options.label} closed its stdout`);
            }
        }),
    ];

    if (child.exited) {
        endings.push(
            child.exited.then(
                async (code) => {
                    // The replies the child wrote before it exited can still sit in the pipe: stdout is read to its
                    // end first (for at most the grace), so they reach their calls before the exit rejects the rest.
                    try {
                        await withTimeout(stdoutEnded, exitGraceMs);
                    } catch (error) {
                        options.log.debug(
                            { ...options.logFields, error },
                            `${options.label} exited and its stdout stayed open`
                        );
                        // A grandchild that holds stdout open would keep the read (and the pipe) alive for good.
                        reader.cancel(exitReason(code)).catch((cancelError) => {
                            options.log.debug(
                                { ...options.logFields, error: cancelError },
                                `${options.label} stdout cancel failed`
                            );
                        });
                    }

                    connected.close(exitReason(code));
                },
                (error) => connected.close(message(error))
            )
        );
    }

    return { peer: connected, written, ended: Promise.race(endings) };
}

/**
 * Feeds stdout to the peer, line by line, until its end. Resolves with undefined at the end of stdout, or with the
 * reason of a read that failed; the caller closes the peer.
 */
async function readStdout(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    peer: RpcPeer,
    options: Pick<ChildStdioOptions, "log" | "label" | "logFields">
): Promise<string | undefined> {
    try {
        for (;;) {
            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            peer.receive(value);
        }

        // A child that exits right after its last reply may end it without a newline: a closing newline reads it.
        peer.receive(new TextEncoder().encode("\n"));
        return undefined;
    } catch (error) {
        if (!peer.closed) {
            options.log.warn({ ...options.logFields, error }, `reading ${options.label} stdout failed`);
        }

        return message(error);
    } finally {
        reader.releaseLock();
    }
}
