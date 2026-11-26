import { closeSync, mkdirSync, openSync, readFileSync, statSync, utimesSync } from "node:fs";
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
        let bufferBytes = 0;
        const maxFrameBytes = 8 * 1024 * 1024;
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
                    if (settled) {
                        return;
                    }
                    bufferBytes += chunk.byteLength;
                    if (bufferBytes > maxFrameBytes) {
                        finish({ ok: false, reason: "rpc-error", wallMs: wallMs() });
                        return;
                    }
                    buffer += chunk.toString();
                    let newline = buffer.indexOf("\n");

                    while (newline >= 0) {
                        const line = buffer.slice(0, newline);
                        bufferBytes -= Buffer.byteLength(line) + 1;
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

/** Requests a detached service at most once per cooldown. The injected launcher keeps tests isolated. */
export function requestServiceStart(
    options: { dir?: string; cooldownMs?: number; launch?: () => Promise<void> } = {}
): Promise<void> {
    if (isTestProcess() && !options.launch) {
        return Promise.resolve();
    }

    return (async () => {
        const { withFileLock } = await import("../../storage/file-lock");
        const dir = serviceDir(options.dir);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const stamp = join(dir, "start-request.stamp");
        await withFileLock(`${stamp}.lock`, async () => {
            const last = statSync(stamp, { throwIfNoEntry: false })?.mtimeMs ?? 0;
            if (Date.now() - last < (options.cooldownMs ?? 60_000)) {
                return;
            }

            closeSync(openSync(stamp, "a", 0o600));
            utimesSync(stamp, new Date(), new Date());
            if (options.launch) {
                await options.launch();
                return;
            }

            const { genesisToolsServeDetachCommand } = await import("../tools/services");
            const child = Bun.spawn(["/bin/sh", "-c", genesisToolsServeDetachCommand()], {
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
            });
            child.unref();
        });
    })().catch(() => undefined);
}
