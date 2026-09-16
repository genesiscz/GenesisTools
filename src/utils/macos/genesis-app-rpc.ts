import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { installedGenesisAppLauncher } from "@genesiscz/utils/macos/genesis-app";

/**
 * Ask GenesisTools.app to do something as its own bundle identity.
 *
 * Some macOS APIs answer to the BUNDLE a process lives in rather than to the TCC responsible
 * process, so a `bun` child of the launcher cannot reach them however it is spawned. Notifications
 * are the first case: they carry the posting bundle's icon and identity, which is why one sent
 * through DarwinKit shows a grey placeholder. This runs the request inside the bundle instead.
 *
 * One process per request, no daemon. That is deliberate. macOS relaunches the bundle on its own
 * when a notification is clicked, so nothing here has to stay resident, and the grants the app
 * holds are only live for the milliseconds a request takes.
 *
 * The envelope is the one a unix socket would carry, so moving this onto a socket later is a
 * transport swap rather than a protocol change. Until a verb genuinely needs a listener — an
 * EventKit change observer is the first real candidate — a child process is the cheaper shape.
 */

export interface GenesisAppRpcFailure {
    /**
     * `unavailable` (no bundle, or routing switched off), `timeout`, `handshake` (the reply was not
     * one JSON line, so something other than the app answered), or whatever the app itself returned:
     * `denied`, `method_unknown`, `params_invalid`, `bad_request`, `internal`.
     */
    code: string;
    message: string;
}

export type GenesisAppRpcOutcome<T> = { ok: true; result: T } | { ok: false; error: GenesisAppRpcFailure };

export interface GenesisAppHello {
    protocol: number;
    bundleId: string;
    version: string;
    /** `CFBundleVersion`, the build epoch. The only reliable way to tell two builds apart. */
    build: string;
    methods: string[];
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** False when there is no bundle to talk to, or the user switched routing off. */
export function isGenesisAppRpcAvailable(): boolean {
    return installedGenesisAppLauncher() !== null;
}

export async function genesisAppRpc<T>(
    method: string,
    params?: Record<string, unknown>,
    opts: { timeoutMs?: number } = {}
): Promise<GenesisAppRpcOutcome<T>> {
    const launcher = installedGenesisAppLauncher();

    if (!launcher) {
        return {
            ok: false,
            error: { code: "unavailable", message: "GenesisTools.app is not installed, or routing is switched off" },
        };
    }

    // Undefined params would serialize as missing keys anyway, but dropping them keeps the request
    // readable in the day log and in `--rpc` by hand.
    const request = SafeJSON.stringify(params ? { method, params: stripUndefined(params) } : { method });
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const proc = Bun.spawn([launcher, "--rpc", request], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
    });

    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
    }, timeoutMs);

    try {
        const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);
        const exitCode = await proc.exited;

        if (timedOut) {
            logger.debug({ method, timeoutMs }, "GenesisTools.app RPC timed out");
            return { ok: false, error: { code: "timeout", message: `${method} timed out after ${timeoutMs}ms` } };
        }

        const line = stdout.trim().split("\n").filter(Boolean).at(-1);

        if (!line) {
            logger.debug({ method, exitCode, stderr }, "GenesisTools.app RPC returned no reply line");
            return {
                ok: false,
                error: {
                    code: "handshake",
                    message: `${method} produced no reply (exit ${exitCode})${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
                },
            };
        }

        return parseReply<T>(method, line, exitCode, stderr);
    } finally {
        clearTimeout(timer);
    }
}

/** Exported for tests: this is where a reply from something other than the app has to be caught. */
export function parseReply<T>(method: string, line: string, exitCode: number, stderr: string): GenesisAppRpcOutcome<T> {
    let reply: unknown;

    try {
        reply = SafeJSON.parse(line, { strict: true });
    } catch (err) {
        logger.debug({ method, line, exitCode, stderr, err }, "GenesisTools.app RPC reply was not JSON");
        return { ok: false, error: { code: "handshake", message: `${method} replied with non-JSON: ${line}` } };
    }

    if (!isReplyShape(reply)) {
        return { ok: false, error: { code: "handshake", message: `${method} replied in an unknown shape: ${line}` } };
    }

    if (reply.ok) {
        logger.debug({ method }, "GenesisTools.app RPC ok");
        return { ok: true, result: reply.result as T };
    }

    logger.debug({ method, error: reply.error }, "GenesisTools.app RPC failed");
    return { ok: false, error: reply.error };
}

interface ReplyShape {
    ok: boolean;
    result?: unknown;
    error: GenesisAppRpcFailure;
}

function isReplyShape(value: unknown): value is ReplyShape {
    if (typeof value !== "object" || value === null || !("ok" in value)) {
        return false;
    }

    const candidate = value as { ok: unknown; error?: unknown };

    if (candidate.ok === true) {
        return true;
    }

    return (
        typeof candidate.error === "object" &&
        candidate.error !== null &&
        "code" in candidate.error &&
        "message" in candidate.error
    );
}

function stripUndefined(params: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
}

/**
 * What the installed build can do. A client that needs a method the installed app does not list is
 * talking to a stale bundle and should say so rather than sending a request that cannot work.
 */
export async function genesisAppHello(): Promise<GenesisAppHello | null> {
    const outcome = await genesisAppRpc<GenesisAppHello>("rpc.hello", undefined, { timeoutMs: 5_000 });
    return outcome.ok ? outcome.result : null;
}
