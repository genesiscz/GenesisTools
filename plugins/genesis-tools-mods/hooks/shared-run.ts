// One command's answer, shared by every session on this Mac for a while. On 2026-10-27, 26 sessions each asked
// `gh pr view` for the same PRs every 2 minutes (3050 runs that day, about 1.1 s each): the first session to ask
// now writes the answer to `<agents>/mods-state/shared-runs/<hash>.json`, and the others read the file until it is
// `ttlMs` old. A half-written or foreign file reads as a miss, so the worst case is the old cost.
//
// Sessions that miss together would still each run it (after the shared file came, 36 `gh pr view` runs on the
// evening of 2026-10-27 started while another session ran the same one), so a miss claims `<hash>.lock.json` first.
// A session that finds a live claim waits for the claimant's answer instead of running, up to `WAIT_MS`. The host
// has no exclusive create, so a claim is a write read back: two sessions that write in the same moment both see the
// later one, and only its writer runs.
import { agentsDir, type Host, isRecord } from "./shared";

export interface SharedRunResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

/**
 * A `tools` run that failed because this CLI is older than the command or option it was asked for (commander's
 * "unknown command" or "unknown option"). The marketplace plugin can run beside any installed CLI.
 */
export function cliLacks(done: { exitCode: number; stderr: string } | undefined): boolean {
    return done !== undefined && done.exitCode !== 0 && /unknown (?:command|option)/i.test(done.stderr);
}

/** The clock the claims and answers are dated by; a test moves it, since the engine's `Date.now` is read-only. */
export const sharedRunClock = { now: (): number => Date.now() };

/** How long a session waits for another session's identical run before it runs the command itself. */
const WAIT_MS = 10_000;
const POLL_MS = 250;

/** The same command in this session while it runs: one process, every caller gets its answer. */
const inFlight = new Map<string, Promise<SharedRunResult | undefined>>();

/** FNV-1a, 32 bits: a file name for the key. The file holds the key itself, so a collision reads as a miss. */
function hashOf(text: string): string {
    let hash = 0x811c9dc5;

    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }

    return hash.toString(16).padStart(8, "0");
}

/** The cache key of a command, and the file its answer is shared in (the claim is that path with `.lock.json`). */
export function sharedRunFiles(
    dir: string | undefined,
    ask: { argv: readonly string[]; cwd: string }
): { key: string; path: string | undefined } {
    const key = `${ask.cwd}\n${ask.argv.join("\u0000")}`;

    return { key, path: dir ? `${dir}/mods-state/shared-runs/${hashOf(key)}.json` : undefined };
}

/** The shared answer for `key` when it is younger than `ttlMs` and no older than `since`. */
async function readAnswer(
    host: Host,
    ask: { path: string; key: string; ttlMs: number; since?: number }
): Promise<SharedRunResult | undefined> {
    const text = await host.read(ask.path).catch(() => undefined);

    try {
        const held: unknown = text ? JSON.parse(text) : undefined;

        if (
            isRecord(held) &&
            held.key === ask.key &&
            typeof held.at === "number" &&
            sharedRunClock.now() - held.at < ask.ttlMs &&
            held.at >= (ask.since ?? 0) &&
            typeof held.exitCode === "number" &&
            typeof held.stdout === "string"
        ) {
            return {
                exitCode: held.exitCode,
                stdout: held.stdout,
                stderr: typeof held.stderr === "string" ? held.stderr : "",
            };
        }
    } catch {
        // A file another session is writing: a miss.
    }

    return undefined;
}

interface Claim {
    token: string;
    started: number;
    /** When the claim lapses: the claimant's own timeout, or 0 once it answered. */
    until: number;
}

async function readClaim(host: Host, path: string): Promise<Claim | undefined> {
    const text = await host.read(path).catch(() => undefined);

    try {
        const held: unknown = text ? JSON.parse(text) : undefined;

        if (
            isRecord(held) &&
            typeof held.token === "string" &&
            typeof held.started === "number" &&
            typeof held.until === "number"
        ) {
            return { token: held.token, started: held.started, until: held.until };
        }
    } catch {
        // Being written: no claim.
    }

    return undefined;
}

/**
 * Claims the run, or waits for the session that holds the claim. Undefined: this session runs the command (it holds
 * the claim, or the wait ran out, or this host cannot wait).
 */
async function answerOfClaimant(
    host: Host,
    ask: { path: string; lockPath: string; key: string; ttlMs: number; timeoutMs: number; token: string }
): Promise<SharedRunResult | undefined> {
    let claim = await readClaim(host, ask.lockPath);

    if (!claim || claim.until <= sharedRunClock.now()) {
        const mine: Claim = {
            token: ask.token,
            started: sharedRunClock.now(),
            until: sharedRunClock.now() + ask.timeoutMs,
        };
        await host.write(ask.lockPath, JSON.stringify(mine)).catch(() => undefined);
        claim = await readClaim(host, ask.lockPath);

        if (!claim || claim.token === ask.token) {
            return undefined;
        }
    }

    if (!host.sleep) {
        return undefined;
    }

    const deadline = Math.min(claim.until, sharedRunClock.now() + WAIT_MS);

    while (sharedRunClock.now() < deadline) {
        await host.sleep(POLL_MS);
        const answer = await readAnswer(host, { path: ask.path, key: ask.key, ttlMs: ask.ttlMs, since: claim.started });

        if (answer) {
            return answer;
        }

        const now = await readClaim(host, ask.lockPath);

        if (now?.token !== claim.token || now.until <= sharedRunClock.now()) {
            // The claimant finished without a usable answer, or gave up: run.
            return undefined;
        }
    }

    return undefined;
}

async function runShared(
    host: Host,
    ask: { argv: readonly string[]; cwd: string; ttlMs: number; timeoutMs: number },
    key: string,
    path: string | undefined
): Promise<SharedRunResult | undefined> {
    const lockPath = path?.replace(/\.json$/, ".lock.json");
    const token = `${sharedRunClock.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

    if (path && lockPath && ask.ttlMs > 0) {
        const answer = await answerOfClaimant(host, {
            path,
            lockPath,
            key,
            ttlMs: ask.ttlMs,
            timeoutMs: ask.timeoutMs,
            token,
        });

        if (answer) {
            return answer;
        }
    }

    const ran = await host.run(ask.argv, { cwd: ask.cwd, timeoutMs: ask.timeoutMs }).catch(() => undefined);
    // A cut-off stdout still parses as text (a `git status` with half its rows), so it is neither shared nor
    // returned: the caller keeps its last complete reading.
    const done = ran?.isStdoutTruncated ? undefined : ran;

    if (path && done) {
        const record = {
            key,
            at: sharedRunClock.now(),
            exitCode: done.exitCode,
            stdout: done.stdout,
            stderr: done.stderr,
        };
        await host.write(path, JSON.stringify(record)).catch(() => undefined);
    }

    if (lockPath && ask.ttlMs > 0) {
        const claim = await readClaim(host, lockPath);

        if (claim?.token === token) {
            await host.write(lockPath, JSON.stringify({ ...claim, until: 0 })).catch(() => undefined);
        }
    }

    return done ? { exitCode: done.exitCode, stdout: done.stdout, stderr: done.stderr } : undefined;
}

/**
 * `argv` run in `cwd`, or the answer another session (or this one) got for the same command and folder within
 * `ttlMs`. Undefined when the command could not start or timed out; such an answer is not shared.
 */
export async function sharedRun(
    host: Host,
    ask: { argv: readonly string[]; cwd: string; ttlMs: number; timeoutMs: number }
): Promise<SharedRunResult | undefined> {
    const { key, path } = sharedRunFiles(await agentsDir(host), ask);

    if (path) {
        const held = await readAnswer(host, { path, key, ttlMs: ask.ttlMs });

        if (held) {
            return held;
        }
    }

    const running = inFlight.get(key);

    if (running) {
        return running;
    }

    const flight = runShared(host, ask, key, path);
    inFlight.set(key, flight);

    try {
        return await flight;
    } finally {
        inFlight.delete(key);
    }
}
