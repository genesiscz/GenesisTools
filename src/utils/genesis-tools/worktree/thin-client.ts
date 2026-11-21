import { closeSync, openSync, readFileSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { isProcessAlive } from "../../process-alive";
import { toolDataDir } from "../../storage/root";
import { isTestProcess } from "../../test-process";
import type { WorktreeSnapshot, WorktreeSnapshotParams } from "./types";

/**
 * The hook's door to `worktree.snapshot`: plain parsing of `service.json`, one socket, `hello` and one call as JSON
 * lines, then close. No zod, no logger and no full client, so a hook process pays a few milliseconds for it. It
 * imports node:fs, node:path, bun, `./types`, the import-free pid check, and the two small modules that name the
 * service folder and a test process (both load only the env module every hook loads already). Every failure is
 * `ok: false`.
 */
export type ThinCall<T> =
    | { ok: true; result: T; wallMs: number }
    | { ok: false; reason: "no-service" | "timeout" | "rpc-error" | "in-test"; wallMs: number };

function serviceDir(dir?: string): string {
    return dir ?? toolDataDir("genesis-tools");
}

function serviceSocket(dir: string): string | null {
    try {
        const raw: unknown = Bun.JSONC.parse(readFileSync(join(dir, "service.json"), "utf8"));

        if (typeof raw !== "object" || raw === null || !("pid" in raw) || !("socket" in raw)) {
            return null;
        }

        const { pid, socket } = raw;

        if (typeof pid !== "number" || typeof socket !== "string") {
            return null;
        }

        // A recycled pid only costs one failed connect, which the caller reports as no-service.
        return isProcessAlive(pid) ? socket : null;
    } catch {
        // No entry, a damaged one, or a process that is gone: there is no service to call.
        return null;
    }
}

/** The service's zod schema checked the answer; this only tells an answer from an error reply. */
function isSnapshot(value: unknown): value is WorktreeSnapshot {
    return (
        typeof value === "object" &&
        value !== null &&
        "state" in value &&
        (value.state === "ok" || value.state === "unavailable")
    );
}

export async function callWorktreeSnapshot(
    params: WorktreeSnapshotParams,
    options: { deadlineMs: number; dir?: string }
): Promise<ThinCall<WorktreeSnapshot>> {
    const started = performance.now();
    const wallMs = () => performance.now() - started;

    if (isTestProcess() && !options.dir) {
        return { ok: false, reason: "in-test", wallMs: wallMs() };
    }

    const socketPath = serviceSocket(serviceDir(options.dir));

    if (!socketPath) {
        return { ok: false, reason: "no-service", wallMs: wallMs() };
    }

    return new Promise((resolve) => {
        let buffer = "";
        let settled = false;
        let socket: { end(): void; write(data: string): number } | null = null;
        const finish = (answer: ThinCall<WorktreeSnapshot>) => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timer);
            socket?.end();
            resolve(answer);
        };
        const timer = setTimeout(() => finish({ ok: false, reason: "timeout", wallMs: wallMs() }), options.deadlineMs);

        Bun.connect({
            unix: socketPath,
            socket: {
                open(opened) {
                    socket = opened;
                    opened.write(
                        // biome-ignore lint/style/noRestrictedGlobals: the thin client must not load comment-json.
                        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { caller: "agent" } })}\n${JSON.stringify(
                            { jsonrpc: "2.0", id: 2, method: "worktree.snapshot", params }
                        )}\n`
                    );
                },
                data(_socket, chunk) {
                    buffer += chunk.toString();
                    let newline = buffer.indexOf("\n");

                    while (newline >= 0) {
                        const line = buffer.slice(0, newline);
                        buffer = buffer.slice(newline + 1);
                        newline = buffer.indexOf("\n");

                        try {
                            // biome-ignore lint/style/noRestrictedGlobals: the thin client must not load comment-json.
                            const message: unknown = JSON.parse(line);

                            if (
                                typeof message !== "object" ||
                                message === null ||
                                !("id" in message) ||
                                message.id !== 2
                            ) {
                                continue;
                            }

                            const result = "result" in message ? message.result : undefined;

                            if (isSnapshot(result)) {
                                finish({ ok: true, result, wallMs: wallMs() });
                            } else {
                                finish({ ok: false, reason: "rpc-error", wallMs: wallMs() });
                            }
                        } catch {
                            finish({ ok: false, reason: "rpc-error", wallMs: wallMs() });
                        }
                    }
                },
                close() {
                    finish({ ok: false, reason: "rpc-error", wallMs: wallMs() });
                },
                error() {
                    finish({ ok: false, reason: "rpc-error", wallMs: wallMs() });
                },
            },
        }).catch(() => finish({ ok: false, reason: "no-service", wallMs: wallMs() }));
    });
}

/** A detached `genesis-tools serve --detach`, at most once in `cooldownMs` (60,000) per user, by a stamp file. */
export function requestServiceStart(options: { dir?: string; cooldownMs?: number } = {}): void {
    if (isTestProcess() && !options.dir) {
        return;
    }

    const stamp = join(serviceDir(options.dir), "start-request.stamp");
    const cooldownMs = options.cooldownMs ?? 60_000;
    const last = statSync(stamp, { throwIfNoEntry: false })?.mtimeMs ?? 0;

    if (Date.now() - last < cooldownMs) {
        return;
    }

    try {
        closeSync(openSync(stamp, "a"));
        utimesSync(stamp, new Date(), new Date());
    } catch {
        // No service folder yet: the start below makes it, and the next request writes the stamp.
    }

    void import("../tools/services").then(({ genesisToolsServeDetachCommand }) => {
        const child = Bun.spawn(["/bin/sh", "-c", genesisToolsServeDetachCommand()], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
        });
        child.unref();
    });
}
