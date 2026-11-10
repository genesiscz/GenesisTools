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
    /** How long the end of stdout waits for the exit code before it ends the connection without one. */
    exitGraceMs?: number;
}

export interface ChildStdioConnection {
    peer: RpcPeer;
    /**
     * Settles once every message handed to stdin so far is written and flushed; rejects with the error of a write
     * that failed. A caller that must order its next message after an answer awaits it.
     */
    written(): Promise<void>;
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Connects a peer to a child process: each line on stdout goes to `peer.receive`, each message the peer writes goes to
 * stdin, and on the end of stdout or the child's exit every waiting request rejects with the exit reason. A failed
 * write or a line past the dialect's limit ends the connection the same way, with its own reason.
 */
export function connectChildStdio(options: ChildStdioOptions): ChildStdioConnection {
    const { child, exitReason: reasonFor, exitGraceMs = 2000, ...peerOptions } = options;
    const exitReason = reasonFor ?? ((code: number) => `${options.label} exited with code ${code}`);
    let last: Promise<void> = Promise.resolve();
    let peer: RpcPeer | undefined;

    const write = (bytes: Buffer): number => {
        // The write starts now, so messages reach stdin in the order the peer sent them; its completion is tracked.
        const current = (async () => {
            await child.stdin.write(bytes.toString());
            await child.stdin.flush?.();
        })();
        current.catch((error) => peer?.close(message(error)));
        last = Promise.all([last, current]).then(() => undefined);
        last.catch(() => undefined);
        return bytes.length;
    };
    const connected = new RpcPeer({ ...peerOptions, write });
    peer = connected;

    void child.exited?.then(
        (code) => connected.close(exitReason(code)),
        (error) => connected.close(message(error))
    );
    void readStdout(child, connected, options, async () => {
        if (!child.exited) {
            return `${options.label} closed its stdout`;
        }

        try {
            return exitReason(await withTimeout(child.exited, exitGraceMs));
        } catch {
            return `${options.label} closed its stdout`;
        }
    });

    return { peer: connected, written: () => last };
}

async function readStdout(
    child: ChildStdio,
    peer: RpcPeer,
    options: Pick<ChildStdioOptions, "log" | "label" | "logFields">,
    endReason: () => Promise<string>
): Promise<void> {
    const reader = child.stdout.getReader();
    let reason: string;

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
        reason = await endReason();
    } catch (error) {
        if (!peer.closed) {
            options.log.warn({ ...options.logFields, error }, `reading ${options.label} stdout failed`);
        }

        reason = message(error);
    } finally {
        reader.releaseLock();
    }

    peer.close(reason);
}
