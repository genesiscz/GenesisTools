import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { hubServerSocketPath } from "./paths";
import { type CallResult, LineBuffer } from "./protocol";

/** A reply past this is dropped and the caller does the work itself, instead of buffering until the timeout. */
const MAX_REPLY_CHARS = 64 * 1024 * 1024;

/**
 * One call to the resident hub server, if one runs: the same argv the CLI takes, answered by the server's door
 * with its warm caches. Null when no server listens, it has no door for this argv (`unsupported`), it is
 * draining, or it does not answer in time — the caller then does the work itself, exactly as before. Never
 * starts a server.
 */
export async function callHubServer({
    argv,
    timeoutMs,
    socketPath = hubServerSocketPath(),
    maxReplyChars = MAX_REPLY_CHARS,
}: {
    argv: string[];
    timeoutMs: number;
    socketPath?: string;
    maxReplyChars?: number;
}): Promise<CallResult | null> {
    if (!existsSync(socketPath)) {
        return null;
    }

    return new Promise((resolve) => {
        let settled = false;
        const replyLines = new LineBuffer(maxReplyChars);
        const socket = createConnection(socketPath);
        const finish = (result: CallResult | null, why?: string) => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timer);
            socket.destroy();
            if (why) {
                logger.debug(
                    { argv: argv.slice(0, 3), why },
                    "[hub-server client] no answer; the caller does the work"
                );
            }

            resolve(result);
        };
        const timer = setTimeout(() => finish(null, `no answer in ${timeoutMs} ms`), timeoutMs);
        socket.once("connect", () => {
            socket.write(`${SafeJSON.stringify({ id: 1, op: "call", argv, timeoutMs }, { strict: true })}\n`);
        });
        // Decode across chunks: a multi-byte character split between two chunks must not become U+FFFD.
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => {
            const lines = replyLines.push(String(chunk));
            if (lines === null) {
                finish(null, `reply longer than ${maxReplyChars} characters`);
                return;
            }

            const line = lines[0];
            if (line === undefined) {
                return;
            }

            try {
                const reply = SafeJSON.parse(line, { strict: true }) as {
                    ok?: boolean;
                    code?: string;
                    stdout?: string;
                    stderr?: string;
                    exit?: number;
                };
                if (reply.ok === true && typeof reply.stdout === "string" && typeof reply.exit === "number") {
                    finish({ stdout: reply.stdout, stderr: reply.stderr ?? "", exit: reply.exit });
                    return;
                }

                finish(null, `server answered ${reply.code ?? "not ok"}`);
            } catch (error) {
                finish(null, `unreadable reply: ${String(error)}`);
            }
        });
        socket.once("error", (error) => finish(null, `socket error: ${error.message}`));
        socket.once("close", () => finish(null, "closed before an answer"));
    });
}
