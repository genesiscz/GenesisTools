import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { getConfig, saveTtydSessions } from "@app/dev-dashboard/config";
import { isClaudeForegroundCommand, parseClaudePaneTitle } from "@app/dev-dashboard/lib/tmux/claude-pane-title";
import { makeTtydTmuxSessionName } from "@app/dev-dashboard/lib/tmux/naming";
import type { TtydSession } from "@app/dev-dashboard/lib/ttyd/types";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { findFreePort } from "@genesiscz/utils/net/free-port";
import { killWithEscalation } from "@genesiscz/utils/process/killWithEscalation";
import { profiler } from "@genesiscz/utils/profile";
import { buildTerminalSpawnEnv } from "@genesiscz/utils/terminal/locale";
import { resolveTmuxBin } from "@genesiscz/utils/tmux/bin";
import {
    createTmuxSession,
    ensureTmuxServerPersists,
    ensureTmuxSessionEnvironment,
    killTmuxSession,
    listTmuxSessionActivePanes,
    renameTmuxSession,
    sessionExists,
} from "@genesiscz/utils/tmux/sessions";
import type { Subprocess } from "bun";

export { ttydLabel } from "@app/dev-dashboard/lib/ttyd/label";

type TtydChild = Subprocess<"ignore", "ignore", "ignore">;

interface Tracked {
    session: TtydSession;
    child: TtydChild | null;
}

export interface SpawnOptions {
    command?: string;
    cwd?: string;
    attachTmuxSession?: string;
}

export interface KillTtydOptions {
    killTmux?: boolean;
}

const registry = new Map<string, Tracked>();
const TTYD_BIN = "/opt/homebrew/bin/ttyd";
let hydrated = false;

// `listTtyd` is polled by several routes every few seconds and `spawnTtyd` sits on the
// interactive "new terminal" path, so both are worth breaking into phases: a slow request
// here is always one phase, never the whole function.
//   PROFILE=ttyd,tmux tools dev-dashboard …
const prof = profiler.scope("ttyd");

function tmuxAlreadyOpenInTtyd(tmuxSessionName: string): boolean {
    for (const tracked of registry.values()) {
        if (tracked.session.tmuxSessionName === tmuxSessionName) {
            return true;
        }
    }

    return false;
}

/**
 * Verify the live process at `pid` is actually *this* ttyd session and not an
 * unrelated process that reused the PID. ttyd is spawned with a unique
 * `-b /ttyd/<id>` base path, so its argv carries the session id as a marker.
 */
async function processMatchesSessionAsync(session: TtydSession): Promise<boolean> {
    const proc = Bun.spawn(["/bin/ps", "-p", String(session.pid), "-o", "command="], {
        stdio: ["ignore", "pipe", "ignore"],
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
        return false;
    }

    const cmd = stdout.trim();
    return cmd.includes("ttyd") && cmd.includes(`/ttyd/${session.id}`);
}

/**
 * Batched async variant — parallelizes N× `ps -p PID` across all sessions.
 * Benchmark on Apple Silicon (n=11): sync-serial 10.4ms median, async-parallel
 * 2.6ms median, sync-batch (one `ps -p PID1,PID2,…`) 43ms (macOS ps takes a
 * full-proctable slow path for multi-pid). Async-parallel is the win.
 */
async function isSessionAliveBatch(sessions: TtydSession[]): Promise<Map<string, boolean>> {
    return new Map(
        await Promise.all(
            sessions.map(async (session): Promise<[string, boolean]> => {
                if (session.pid <= 0) {
                    return [session.id, false];
                }

                try {
                    process.kill(session.pid, 0);
                } catch {
                    return [session.id, false];
                }

                return [session.id, await processMatchesSessionAsync(session)];
            })
        )
    );
}

let persistRegistryOverride: (() => Promise<void>) | null = null;

/** Test hook: replace disk persistence so spawn-failure cleanup can be exercised. */
export function __setPersistRegistryForTest(fn: (() => Promise<void>) | null): void {
    persistRegistryOverride = fn;
}

async function persistRegistry(): Promise<void> {
    if (persistRegistryOverride) {
        await persistRegistryOverride();
        return;
    }

    const all = Array.from(registry.values()).map((tracked) => tracked.session);
    const alive = await prof.measureAsync("persist.aliveBatch", () => isSessionAliveBatch(all));
    const sessions = all.filter((session) => alive.get(session.id) === true);
    // Re-reads the whole config off disk before writing it back; called once per spawn/kill
    // AND once per renamed session inside the list hot path.
    await prof.measureAsync("persist.saveConfig", () => saveTtydSessions(sessions));
}

async function hydrateRegistry(): Promise<void> {
    if (hydrated) {
        return;
    }

    // Don't latch `hydrated` until the config actually loads — a transient
    // read error here would otherwise permanently brick hydration.
    const config = await getConfig();
    hydrated = true;

    const fresh = config.ttydSessions.filter((session) => !registry.has(session.id));
    const alive = await isSessionAliveBatch(fresh);
    let changed = false;

    for (const session of fresh) {
        if (alive.get(session.id) === true) {
            registry.set(session.id, { session, child: null });
        } else {
            changed = true;
        }
    }

    if (changed) {
        await persistRegistry();
    }
}

// Short TTL cache so 2-3s polls (TmuxSessionsPanel @3s, /ttyd route @5s) don't each
// pay 11× `ps -p $PID` subprocess spawns. Explicit spawn/kill/onExit paths already
// mutate the registry directly, so this cache only delays detection of EXTERNAL
// deaths (ttyd crash, external kill -9); 3s of staleness is harmless — the next
// poll catches it and the front-proxy 502s the stale id in the meantime.
const PRUNE_TTL_MS = 3000;
let lastPruneAt = 0;

async function pruneDeadSessions(): Promise<void> {
    if (Date.now() - lastPruneAt < PRUNE_TTL_MS) {
        return;
    }

    const all = Array.from(registry.values()).map((tracked) => tracked.session);
    const alive = await isSessionAliveBatch(all);
    let changed = false;

    for (const session of all) {
        if (alive.get(session.id) !== true) {
            registry.delete(session.id);
            changed = true;
        }
    }

    lastPruneAt = Date.now();

    if (changed) {
        await persistRegistry();
    }
}

async function stopTtydProcess(tracked: Tracked, id: string): Promise<void> {
    if (tracked.child) {
        await killWithEscalation(tracked.child);
        return;
    }

    if (!(await processMatchesSessionAsync(tracked.session))) {
        logger.debug({ id, pid: tracked.session.pid }, "ttyd pid no longer ours; skipping kill");
        return;
    }

    const pid = tracked.session.pid;

    try {
        await killWithEscalation({
            kill(signal) {
                process.kill(pid, signal);
            },
            on(event, listener) {
                if (event !== "exit") {
                    return;
                }

                const poll = async (): Promise<void> => {
                    try {
                        process.kill(pid, 0);

                        // A live PID isn't necessarily still ttyd — the OS can reuse a PID
                        // within the escalation grace window. Confirm ownership before
                        // continuing to treat it as the process we're waiting to exit.
                        if (!(await processMatchesSessionAsync(tracked.session))) {
                            listener();
                            return;
                        }

                        setTimeout(() => void poll(), 200);
                    } catch (err) {
                        // ESRCH means the process is actually gone; anything else (e.g. EPERM,
                        // pid reused by a process we can't signal) means it's still alive.
                        if (err && typeof err === "object" && "code" in err && err.code === "ESRCH") {
                            listener();
                        } else {
                            setTimeout(() => void poll(), 200);
                        }
                    }
                };

                void poll();
            },
        });
    } catch (err) {
        logger.debug({ err, id }, "ttyd process already gone");
    }
}

/**
 * Match the attach target specifically — the base path also contains the ttyd
 * uuid which can look like a session fragment.
 *
 * The name must END the argument. `ps` prints argv space-joined, so a plain
 * `includes("-t bridge")` also matches `-t bridge-2`, and that false positive is
 * the dangerous direction: the heal sweep would read a ttyd attached to the WRONG
 * tmux session as correctly bound and never relaunch it.
 */
export function argvTargetsTmux(cmd: string, tmuxSessionName: string): boolean {
    if (!cmd.includes("attach-session") || tmuxSessionName.length === 0) {
        return false;
    }

    const needle = `-t ${tmuxSessionName}`;

    for (let at = cmd.indexOf(needle); at !== -1; at = cmd.indexOf(needle, at + needle.length)) {
        const next = cmd[at + needle.length];

        if (next === undefined || /\s/.test(next)) {
            return true;
        }
    }

    return false;
}

/**
 * ttyd's attach target is baked into argv at spawn (`tmux attach-session -t NAME`).
 * Renaming the tmux session (or only updating config.tmuxSessionName) leaves a live
 * ttyd forever trying the old name → "can't find session" + "Reconnecting…".
 * True when the live process cmdline still contains the expected session name.
 */
async function ttydProcessTargetsTmuxAsync(session: TtydSession, tmuxSessionName: string): Promise<boolean> {
    if (session.pid <= 0) {
        return false;
    }

    const proc = Bun.spawn(["/bin/ps", "-p", String(session.pid), "-o", "command="], {
        stdio: ["ignore", "pipe", "ignore"],
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
        return false;
    }

    return argvTargetsTmux(stdout, tmuxSessionName);
}

interface LaunchTtydParams {
    id: string;
    port: number;
    cwd: string;
    command: string;
    tmuxSessionName: string;
    /** Preserve display name + startedAt across retarget restarts. */
    name?: string;
    startedAt?: string;
}

/**
 * Spawn ttyd bound to an existing (or just-created) tmux session under a fixed
 * id/port. Shared by first spawn and rename retarget so `/ttyd/<id>/` stays stable.
 */
function launchTtydChild(params: LaunchTtydParams): { session: TtydSession; child: TtydChild } {
    const { id, port, cwd, command, tmuxSessionName, name, startedAt } = params;
    const tmuxBin = resolveTmuxBin();

    // Bind loopback-only and serve under /ttyd/<id> so the Bun.serve front
    // proxy can reverse-proxy it same-origin (HTTPS tunnel + mobile, where a
    // bare http://localhost:<port> iframe is unreachable). The base-path makes
    // ttyd emit correctly-prefixed asset/ws URLs so no path rewriting needed.
    const child: TtydChild = Bun.spawn({
        cmd: [
            TTYD_BIN,
            "-i",
            "127.0.0.1",
            "-b",
            `/ttyd/${id}`,
            "-W",
            "-p",
            String(port),
            tmuxBin,
            "attach-session",
            "-t",
            tmuxSessionName,
        ],
        cwd,
        env: buildTerminalSpawnEnv(),
        stdio: ["ignore", "ignore", "ignore"],
        detached: true,
        onExit(_proc, code, signal, err) {
            if (err) {
                logger.error({ err, id, port }, "ttyd child error");
            }

            logger.debug({ id, port, code, signal }, "ttyd child exited");

            // Only drop the registry entry if THIS child is still the registered
            // one. A retarget kill+relaunch replaces the entry with a new pid;
            // the old child's onExit must not wipe the replacement.
            const current = registry.get(id);

            if (current && current.session.pid === child.pid) {
                registry.delete(id);
                void persistRegistry().catch((persistErr) => {
                    logger.warn({ err: persistErr, id, port }, "failed to persist ttyd registry after child exit");
                });
            }
        },
    });

    // ttyd must outlive the dashboard. detached: true runs setsid() so ttyd
    // gets its own process group and does not take the SIGHUP delivered to the
    // dashboard's group on exit; unref() additionally frees the parent event
    // loop so the dashboard can exit cleanly while ttyd keeps running.
    child.unref();

    const session: TtydSession = {
        id,
        port,
        command,
        cwd,
        pid: child.pid,
        startedAt: startedAt ?? new Date().toISOString(),
        tmuxSessionName,
        name,
    };

    return { session, child };
}

/**
 * stop → launch → registry-swap must be one transaction. `listTtyd()` (heal) and
 * `retargetTtydTmuxBindings()` (rename) both mutate the same `Tracked`, and several
 * server routes poll listTtyd concurrently — without this two callers can each kill
 * and relaunch the same session, contending for one id/port while their onExit
 * callbacks race to delete the registry entry the other just wrote.
 */
let lifecycleChain: Promise<unknown> = Promise.resolve();

function withTtydLifecycleLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = lifecycleChain.then(fn, fn);
    lifecycleChain = run.catch(() => undefined);

    return run;
}

/** ttyd binds its port within a few ms; anything slower means it is not coming up. */
const TTYD_LISTEN_TIMEOUT_MS = 2000;

/**
 * Resolve once the child is actually accepting connections on `port`. A ttyd that
 * loses the bind race exits instead of listening, which `Bun.spawn` cannot report.
 */
async function waitForTtydListening(child: TtydChild, port: number): Promise<void> {
    const deadline = Date.now() + TTYD_LISTEN_TIMEOUT_MS;

    for (;;) {
        if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(`ttyd exited before listening on ${port} (code ${child.exitCode ?? child.signalCode})`);
        }

        try {
            const socket = await Bun.connect({
                hostname: "127.0.0.1",
                port,
                socket: { data() {}, error() {} },
            });
            socket.end();
            return;
        } catch (err) {
            if (Date.now() >= deadline) {
                throw new Error(`ttyd never listened on ${port} within ${TTYD_LISTEN_TIMEOUT_MS}ms: ${String(err)}`);
            }

            await Bun.sleep(25);
        }
    }
}

/**
 * Kill the live ttyd (not the tmux session) and re-launch it with the same
 * id/port pointing at `tmuxSessionName`. Keeps iframe `/ttyd/<id>/` URLs valid
 * across renames.
 */
async function relaunchTtydAtTmux(tracked: Tracked, tmuxSessionName: string): Promise<void> {
    // Split lock-wait from the work: queueing behind another caller's kill+relaunch is
    // indistinguishable from a slow relaunch when only the route is timed.
    const endLockWait = prof.start("relaunch.lockWait");

    return withTtydLifecycleLock(async () => {
        endLockWait();
        const prev = tracked.session;

        if (!(await sessionExists(tmuxSessionName))) {
            throw new Error(`tmux session ${tmuxSessionName} does not exist`);
        }

        // A concurrent caller (heal + retarget, or two polling routes) may have
        // relaunched this session at the same target while we waited for the lock.
        // Replacing a healthy child would drop live websockets for nothing.
        if (await ttydProcessTargetsTmuxAsync(prev, tmuxSessionName)) {
            tracked.session = { ...prev, tmuxSessionName };
            registry.set(prev.id, tracked);
            logger.debug({ id: prev.id, tmuxSessionName }, "ttyd already targets this tmux session; skipping relaunch");
            return;
        }

        await Promise.all([ensureTmuxSessionEnvironment(tmuxSessionName), ensureTmuxServerPersists()]);

        await prof.measureAsync("relaunch.stopProcess", () => stopTtydProcess(tracked, prev.id));

        // Port may still be draining for a tick after kill; retry bind briefly.
        let lastErr: unknown;
        for (let attempt = 0; attempt < 8; attempt++) {
            let launched: { session: TtydSession; child: TtydChild } | undefined;

            try {
                launched = launchTtydChild({
                    id: prev.id,
                    port: prev.port,
                    cwd: prev.cwd,
                    command: prev.command,
                    tmuxSessionName,
                    name: prev.name,
                    startedAt: prev.startedAt,
                });

                // Bun.spawn succeeds even when ttyd itself dies on a busy port —
                // that failure surfaces asynchronously, so without this probe the
                // retry loop never retries and callers see a "successful" retarget
                // pointing at a dead endpoint.
                //
                // Worst case here is 8 attempts × TTYD_LISTEN_TIMEOUT_MS plus backoff, so a
                // per-attempt timer is the difference between "ttyd is slow" and "attempt 6".
                const spawnedChild = launched.child;
                await prof.measureAsync("relaunch.waitListening", () => waitForTtydListening(spawnedChild, prev.port));

                tracked.session = launched.session;
                tracked.child = launched.child;
                registry.set(prev.id, tracked);
                return;
            } catch (err) {
                lastErr = err;

                if (launched) {
                    await killWithEscalation(launched.child).catch((killErr) => {
                        logger.debug({ err: killErr, id: prev.id }, "failed to kill ttyd attempt that never listened");
                    });
                }

                await Bun.sleep(50 * (attempt + 1));
            }
        }

        throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    });
}

export async function spawnTtyd(opts: SpawnOptions = {}): Promise<TtydSession> {
    await prof.measureAsync("spawn.hydrate", () => hydrateRegistry());

    if (!existsSync(TTYD_BIN)) {
        throw new Error(`ttyd not found at ${TTYD_BIN}`);
    }

    const rawCommand = opts.command ?? env.paths.getShell("/bin/zsh");
    const command = rawCommand.trim().length > 0 && !rawCommand.includes("=") ? rawCommand.trim() : "/bin/zsh";
    const cwd = opts.cwd ?? process.cwd();
    const port = await prof.measureAsync("spawn.freePort", () => findFreePort());
    const id = randomUUID();

    let tmuxSessionName: string;

    if (opts.attachTmuxSession) {
        if (!(await sessionExists(opts.attachTmuxSession))) {
            throw new Error(`tmux session ${opts.attachTmuxSession} does not exist`);
        }

        if (tmuxAlreadyOpenInTtyd(opts.attachTmuxSession)) {
            const err = new Error(`tmux session ${opts.attachTmuxSession} is already open in ttyd`);
            (err as Error & { statusCode?: number }).statusCode = 409;
            throw err;
        }

        const attachTo = opts.attachTmuxSession;
        tmuxSessionName = attachTo;
        await prof.measureAsync("spawn.tmuxAttachSetup", () =>
            Promise.all([
                ensureTmuxSessionEnvironment(attachTo),
                // Re-pin the server even when attaching to a pre-existing session — it may
                // have been bootstrapped (by an older dashboard) with exit-empty on.
                ensureTmuxServerPersists(),
            ])
        );
    } else {
        const created = makeTtydTmuxSessionName(id);
        tmuxSessionName = created;
        await prof.measureAsync("spawn.tmuxCreateSession", () => createTmuxSession(created, cwd, command));
    }

    const { session, child } = launchTtydChild({ id, port, cwd, command, tmuxSessionName });

    try {
        registry.set(id, { session, child });
        await prof.measureAsync("spawn.persist", () => persistRegistry());
    } catch (err) {
        registry.delete(id);
        await killWithEscalation(child);
        logger.error({ err, id }, "[ttyd] registry persist failed after spawn; killed orphaned child");
        throw err;
    }

    logger.info({ id, port, command, cwd, tmuxSessionName, attach: Boolean(opts.attachTmuxSession) }, "ttyd spawned");

    return session;
}

/**
 * Config/registry can say `tmuxSessionName: "bridge"` while the live ttyd still
 * has `attach-session -t dd-OLD` in argv (rename retarget used to only
 * rewrite JSON). Heal by relaunching misaligned processes so list/UI recover without
 * a manual kill.
 */
const HEAL_TTL_MS = 3000;
let lastHealAt = 0;

async function healStaleTtydTmuxTargets(liveTmuxSessions: ReadonlySet<string>): Promise<void> {
    // Same reasoning as pruneDeadSessions' TTL: listTtyd is polled from several
    // routes every few seconds, and a stale attach target only appears on rename.
    if (Date.now() - lastHealAt < HEAL_TTL_MS) {
        return;
    }

    lastHealAt = Date.now();

    // One `ps` per session, all in flight at once — never a serial blocking sweep.
    // Existence checks reuse the caller's single list-sessions result: a per-binding
    // `sessionExists` here was an N+1 subprocess storm (10 bindings = 10 extra
    // full `tmux list-sessions` calls per poll).
    const candidates = await Promise.all(
        Array.from(registry.values()).map(async (tracked): Promise<Tracked | null> => {
            const expected = tracked.session.tmuxSessionName;

            if (!expected || !liveTmuxSessions.has(expected)) {
                return null;
            }

            if (await ttydProcessTargetsTmuxAsync(tracked.session, expected)) {
                return null;
            }

            // Process dead → pruneDeadSessions owns that path.
            if (tracked.session.pid > 0) {
                try {
                    process.kill(tracked.session.pid, 0);
                } catch {
                    return null;
                }
            }

            return tracked;
        })
    );

    let changed = false;

    for (const tracked of candidates) {
        if (!tracked) {
            continue;
        }

        const expected = tracked.session.tmuxSessionName;

        if (!expected) {
            continue;
        }

        try {
            logger.warn(
                { id: tracked.session.id, expected, pid: tracked.session.pid },
                "ttyd argv still targets a stale tmux name; relaunching against config binding"
            );
            await relaunchTtydAtTmux(tracked, expected);
            changed = true;
        } catch (err) {
            logger.warn(
                { err, id: tracked.session.id, expected },
                "failed to heal ttyd after stale tmux attach target"
            );
        }
    }

    if (changed) {
        await persistRegistry();
    }
}

export async function listTtyd(): Promise<TtydSession[]> {
    await prof.measureAsync("list.hydrate", () => hydrateRegistry());

    // prune touches only ps + config; the tmux list touches only tmux — run them
    // concurrently. (hydrate stays sequential: prune reads the hydrated registry.)
    const [, panesByTmux] = await Promise.all([
        prof.measureAsync("list.prune", () => pruneDeadSessions()),
        // One list-sessions call serving THREE consumers: heal's existence set,
        // syncNames' pane titles, and the lastCommand enrichment below.
        prof.measureAsync("list.activePanes", () => listTmuxSessionActivePanes()),
    ]);

    await prof.measureAsync("list.heal", () => healStaleTtydTmuxTargets(new Set(panesByTmux.keys())));
    // Can escalate into a tmux rename + full ttyd kill/relaunch inside this GET.
    await prof.measureAsync("list.syncClaudeNames", () => syncNamesFromClaudePaneTitles(panesByTmux));

    return Array.from(registry.values()).map((tracked) => {
        const { session } = tracked;
        const pane = session.tmuxSessionName ? panesByTmux.get(session.tmuxSessionName) : undefined;

        return { ...session, lastCommand: pane?.command || undefined };
    });
}

/**
 * Claude `/rename` only updates `#{pane_title}` (`✳ name`). Mirror that onto the real tmux
 * session name + ttyd display label so Session Hub / tabs stay in sync.
 */
async function syncNamesFromClaudePaneTitles(
    panesByTmux: Awaited<ReturnType<typeof listTmuxSessionActivePanes>>
): Promise<void> {
    // Snapshot first — retarget mutates registry bindings mid-loop.
    const candidates = Array.from(registry.values())
        .map((tracked) => {
            const fromName = tracked.session.tmuxSessionName;

            if (!fromName) {
                return null;
            }

            const pane = panesByTmux.get(fromName);

            if (!pane || !isClaudeForegroundCommand(pane.command)) {
                return null;
            }

            const toName = parseClaudePaneTitle(pane.title);

            if (!toName || toName === fromName) {
                // Tmux already matches; still mirror a stale ttyd display name.
                if (toName && tracked.session.name !== toName) {
                    return { id: tracked.session.id, fromName, toName, renameTmux: false };
                }

                return null;
            }

            return { id: tracked.session.id, fromName, toName, renameTmux: true };
        })
        .filter((c): c is { id: string; fromName: string; toName: string; renameTmux: boolean } => c !== null);

    if (candidates.length === 0) {
        return;
    }

    for (const { id, fromName, toName, renameTmux } of candidates) {
        try {
            if (renameTmux) {
                // The pane map's keys are the full live session-name set from this
                // poll's single list-sessions — no extra tmux call for the clash check.
                if (panesByTmux.has(toName)) {
                    logger.debug(
                        { id, fromName, toName },
                        "claude pane title sync skipped: destination tmux session already exists"
                    );
                    continue;
                }

                await renameTmuxSession(fromName, toName);
                await retargetTtydTmuxBindings(fromName, toName);

                // Retarget updates bindings under the new name; refresh the pane map key for later reads.
                const pane = panesByTmux.get(fromName);

                if (pane) {
                    panesByTmux.delete(fromName);
                    panesByTmux.set(toName, pane);
                }
            }

            const tracked = registry.get(id);

            if (!tracked) {
                continue;
            }

            tracked.session.name = toName;
            await persistRegistry();
            logger.info({ id, fromName, toName, renameTmux }, "synced tmux/ttyd name from Claude pane title (/rename)");
        } catch (err) {
            logger.debug({ err, id, fromName, toName }, "claude pane title sync failed");
        }
    }
}

/**
 * Resolve a session's port. The front-proxy (a *separate* process from the
 * vite-middleware that runs `spawnTtyd`) hits this for every /ttyd/<id>/*
 * request, so the hit path stays in-memory — no per-request disk I/O.
 *
 * But `hydrateRegistry()` latches `hydrated` for the process lifetime and the
 * registry Map is per-process: a terminal spawned by the vite-middleware
 * process *after* the proxy process hydrated is in config but absent from the
 * proxy's registry, so a pure in-memory lookup 502s ("session not found")
 * forever — even across hard refreshes. On a miss, fall back to one fresh
 * config read so cross-process / post-hydrate sessions resolve. Hits never
 * touch disk; only the (rare, first-load) miss does.
 */
export async function getTtydPort(id: string): Promise<number | null> {
    await hydrateRegistry();

    const cachedPort = registry.get(id)?.session.port;
    if (cachedPort !== undefined) {
        return cachedPort;
    }

    const config = await getConfig();
    return config.ttydSessions.find((session) => session.id === id)?.port ?? null;
}

/**
 * Resolve a session's tmux session name. Like getTtydPort, this is on the hit
 * path of frequent polling (the scrollbar reads tmux state), so it stays
 * in-memory with a single config fallback for cross-process / post-hydrate
 * sessions — no per-call prune.
 */
export async function getTtydTmuxSessionName(id: string): Promise<string | null> {
    await hydrateRegistry();

    const cached = registry.get(id)?.session.tmuxSessionName;
    if (cached !== undefined) {
        return cached;
    }

    const config = await getConfig();
    return config.ttydSessions.find((session) => session.id === id)?.tmuxSessionName ?? null;
}

export async function renameTtyd(id: string, name: string): Promise<boolean> {
    await hydrateRegistry();
    const tracked = registry.get(id);

    if (!tracked) {
        return false;
    }

    const trimmed = name.trim();

    // Clearing the display name only — keep the tmux session (identity still derives from
    // tmuxSessionName via deriveTtydDisplayName).
    if (!trimmed) {
        tracked.session.name = undefined;
        await persistRegistry();
        logger.info({ id, name: undefined }, "ttyd display name cleared");

        return true;
    }

    const fromTmux = tracked.session.tmuxSessionName;

    if (fromTmux && fromTmux !== trimmed) {
        // One identity: tab rename = tmux rename. Retarget relaunches ttyd so attach argv tracks.
        await renameTmuxSession(fromTmux, trimmed);
        await retargetTtydTmuxBindings(fromTmux, trimmed);
    }

    const after = registry.get(id);

    if (!after) {
        return false;
    }

    after.session.name = trimmed;
    await persistRegistry();
    logger.info(
        { id, name: trimmed, tmuxSessionName: after.session.tmuxSessionName },
        "ttyd renamed (synced to tmux when bound)"
    );

    return true;
}

/** After a hub-side tmux rename, mirror the new name onto every bound ttyd display label. */
export async function syncTtydDisplayNamesForTmux(tmuxSessionName: string, displayName: string): Promise<void> {
    await hydrateRegistry();

    const trimmed = displayName.trim();
    let changed = false;

    for (const tracked of registry.values()) {
        if (tracked.session.tmuxSessionName !== tmuxSessionName) {
            continue;
        }

        const next = trimmed.length > 0 ? trimmed : undefined;

        if (tracked.session.name === next) {
            continue;
        }

        tracked.session.name = next;
        changed = true;
    }

    if (changed) {
        await persistRegistry();
        logger.info({ tmuxSessionName, displayName: trimmed }, "synced ttyd display names after tmux rename");
    }
}

export async function retargetTtydTmuxBindings(fromName: string, toName: string): Promise<void> {
    await hydrateRegistry();

    const affected = Array.from(registry.values()).filter((tracked) => tracked.session.tmuxSessionName === fromName);

    if (affected.length === 0) {
        return;
    }

    // ttyd freezes `attach-session -t <name>` in argv at spawn. Updating only
    // config.tmuxSessionName leaves the process forever attaching to the old
    // name ("can't find session" after any reconnect). Kill+relaunch with the
    // same id/port so iframe URLs stay valid.
    //
    // Persist after EACH relaunch: the kill+relaunch already happened, so a later
    // failure must not leave disk describing the pre-rename binding for sessions
    // whose process is already serving the new one (a restart would hydrate stale
    // state and healing would skip it, the old tmux name being gone).
    for (const tracked of affected) {
        await relaunchTtydAtTmux(tracked, toName);

        try {
            await persistRegistry();
        } catch (err) {
            logger.error(
                { err, id: tracked.session.id, fromName, toName },
                "ttyd relaunched at the new tmux name but persisting the binding failed"
            );
            throw err;
        }
    }

    logger.info(
        { fromName, toName, count: affected.length, ids: affected.map((t) => t.session.id) },
        "retargeted ttyd tmux bindings after rename (relaunched processes)"
    );
}

export async function killTtyd(id: string, opts: KillTtydOptions = {}): Promise<boolean> {
    await hydrateRegistry();

    const tracked = registry.get(id);

    if (!tracked) {
        return false;
    }

    await stopTtydProcess(tracked, id);

    if (opts.killTmux && tracked.session.tmuxSessionName) {
        await killTmuxSession(tracked.session.tmuxSessionName);
    }

    registry.delete(id);
    await persistRegistry();

    return true;
}

export async function killAllTtyd(): Promise<void> {
    // After a dashboard restart the in-memory registry is empty but sessions
    // persist in config; hydrate first so they're actually terminated.
    await hydrateRegistry();

    for (const [id, tracked] of registry.entries()) {
        await stopTtydProcess(tracked, id);
    }

    registry.clear();
    await persistRegistry();
}
