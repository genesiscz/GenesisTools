import { relative } from "node:path";
import watchman from "fb-watchman";
import type { WatchChange, WatchChanges, WatchDriver, WatchedRoot, WatchLoss } from "./types";

const COOKIE_PREFIX = ".watchman-cookie-";
const VERSION_TIMEOUT_MS = 3_000;

/** The instance part of a Watchman clock `c:<start>:<pid>:<root number>:<ticks>`: everything but the ticks. */
function clockInstance(clock: string): string {
    const split = clock.lastIndexOf(":");
    return split > 0 ? clock.slice(0, split) : clock;
}

function toPosix(path: string): string {
    return path.replace(/\\/g, "/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/** A Watchman error that says its synchronization cookie did not come back in time. */
function isSyncTimeout(error: Error): boolean {
    return /sync_timeout|timed out waiting for cookie|cookie/i.test(error.message);
}

/**
 * The Watchman driver. One `fb-watchman` client per driver object, made at the first `open`, never at module scope.
 * The client reads `WATCHMAN_SOCK` itself, so a test or a benchmark points a child process at a private daemon.
 *
 * `since: null` is a `clock` with `sync_timeout`; any other boundary is one `query` with `since`, `sync_timeout`,
 * `relative_root` and the fields `name` and `exists`. `close` never runs `watch-del`: another program may use the
 * same watch, and Watchman reaps an idle one itself.
 */
export function watchmanDriver(): WatchDriver {
    let client: watchman.Client | null = null;
    let ended = false;

    const clientOf = (): watchman.Client => {
        if (!client) {
            client = new watchman.Client();
            ended = false;
            client.on("end", () => {
                ended = true;
                client = null;
            });
            client.on("error", () => {
                ended = true;
                client = null;
            });
        }

        return client;
    };

    type Callback = (error: Error | null, response: unknown) => void;

    /** One command with its own typed overload, as a promise that an abort rejects. */
    const send = (
        issue: (client: watchman.Client, callback: Callback) => void,
        signal?: AbortSignal
    ): Promise<unknown> =>
        new Promise((resolve, reject) => {
            if (signal?.aborted) {
                reject(new Error("aborted"));
                return;
            }

            const onAbort = () => reject(new Error("aborted"));
            signal?.addEventListener("abort", onAbort, { once: true });
            issue(clientOf(), (error, response) => {
                signal?.removeEventListener("abort", onAbort);

                if (error) {
                    reject(error);
                    return;
                }

                resolve(response);
            });
        });

    const lossOf = (error: unknown): WatchChanges => {
        const failure = error instanceof Error ? error : new Error(String(error));

        if (ended) {
            return { kind: "lost", reason: "closed", detail: failure.message };
        }

        const reason: WatchLoss = isSyncTimeout(failure) ? "fence-timeout" : "driver-error";
        return { kind: "lost", reason, detail: failure.message };
    };

    const open: WatchDriver["open"] = async (spec) => {
        let watchRoot: string;
        let relativePath: string | undefined;
        let instance: string;

        try {
            const project = await send((c, done) => c.command(["watch-project", spec.root], done));

            if (!isRecord(project) || typeof project.watch !== "string") {
                return { ok: false, reason: "open-failed", detail: "watch-project gave no watch root" };
            }

            watchRoot = project.watch;
            relativePath = typeof project.relative_path === "string" ? project.relative_path : undefined;
            const clock = await send((c, done) => c.command(["clock", watchRoot], done));
            instance = isRecord(clock) && typeof clock.clock === "string" ? clockInstance(clock.clock) : "unknown";
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            const missing = /ENOENT|spawn|not found/i.test(detail);
            return { ok: false, reason: missing ? "not-installed" : "open-failed", detail };
        }

        const gitPrefix = toPosix(relative(spec.root, spec.gitDir));
        const insideRoot = gitPrefix !== "" && !gitPrefix.startsWith("..") && !/^[a-zA-Z]:/.test(gitPrefix);
        const seenWarnings = new Set<string>();
        let closed = false;

        const reported = (name: string): boolean => {
            const path = toPosix(name);
            const base = path.slice(path.lastIndexOf("/") + 1);

            if (base.startsWith(COOKIE_PREFIX)) {
                return false;
            }

            return !(insideRoot && (path === gitPrefix || path.startsWith(`${gitPrefix}/`)));
        };

        const watched: WatchedRoot = {
            get instance() {
                return instance;
            },
            async changesSince(since, options): Promise<WatchChanges> {
                if (closed) {
                    return { kind: "lost", reason: "closed" };
                }

                const started = performance.now();

                try {
                    if (since === null) {
                        const answer = await send(
                            (c, done) => c.command(["clock", watchRoot, { sync_timeout: options.fenceMs }], done),
                            options.signal
                        );

                        if (!isRecord(answer) || typeof answer.clock !== "string") {
                            return { kind: "lost", reason: "driver-error", detail: "clock gave no clock" };
                        }

                        instance = clockInstance(answer.clock);
                        return {
                            kind: "changes",
                            clock: answer.clock,
                            changes: [],
                            fenceMs: performance.now() - started,
                        };
                    }

                    const query: Record<string, unknown> = {
                        since,
                        sync_timeout: options.fenceMs,
                        fields: ["name", "exists"],
                    };

                    if (relativePath) {
                        query.relative_root = relativePath;
                    }

                    const answer = await send(
                        (c, done) => c.command(["query", watchRoot, query], done),
                        options.signal
                    );
                    const fenceMs = performance.now() - started;

                    if (!isRecord(answer) || typeof answer.clock !== "string") {
                        return { kind: "lost", reason: "driver-error", detail: "query gave no clock" };
                    }

                    const previous = instance;
                    instance = clockInstance(answer.clock);

                    if (answer.is_fresh_instance === true || clockInstance(since) !== previous) {
                        return { kind: "lost", reason: "fresh-instance" };
                    }

                    if (typeof answer.warning === "string" && /recrawl/i.test(answer.warning)) {
                        if (!seenWarnings.has(answer.warning)) {
                            seenWarnings.add(answer.warning);
                            return { kind: "lost", reason: "recrawl", detail: answer.warning.slice(0, 300) };
                        }
                    }

                    const files = Array.isArray(answer.files) ? answer.files : [];
                    const changes: WatchChange[] = [];

                    for (const file of files) {
                        if (isRecord(file) && typeof file.name === "string" && reported(file.name)) {
                            changes.push({ path: toPosix(file.name), exists: file.exists !== false });
                        }
                    }

                    return { kind: "changes", clock: answer.clock, changes, fenceMs };
                } catch (error) {
                    return lossOf(error);
                }
            },
            async close() {
                closed = true;
            },
        };

        return { ok: true, watched };
    };

    return {
        facts: { outlivesProcess: true, fence: "daemon-cookie", fencesLinkedWorktrees: true },
        async available() {
            const binary = Bun.which("watchman");

            if (!binary) {
                return { ok: false, reason: "not-installed" };
            }

            const run = Bun.spawnSync([binary, "--version"], {
                stdout: "pipe",
                stderr: "pipe",
                timeout: VERSION_TIMEOUT_MS,
            });

            if (run.exitCode !== 0) {
                return { ok: false, reason: `watchman --version exited ${run.exitCode}` };
            }

            return { ok: true, version: run.stdout.toString().trim() };
        },
        open,
        async dispose() {
            const current = client;
            client = null;
            current?.end();
        },
    };
}
