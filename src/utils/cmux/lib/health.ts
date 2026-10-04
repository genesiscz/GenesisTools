import { isCmuxAccessDenied } from "@genesiscz/utils/cmux/lib/access-denied";
import { runCmux } from "@genesiscz/utils/cmux/lib/cli";
import { logger } from "@genesiscz/utils/logger";

/**
 * cmux health triage. The socket layer answers `ping`/`capabilities` off the app's
 * UI thread, while state commands (`identify`, `list-panes`, …) require it — so a
 * livelocked UI thread (2026-08-27 Task Manager incident) leaves ping healthy and
 * every state command starving forever. Probing both sides tells the states apart.
 *
 * `access-denied` is a THIRD distinct signature (#446 item 2): cmux is answering
 * fine, it is just refusing a caller that was not started inside a cmux pane. That
 * must never read as `socket-dead` — the fix is a different shell, not a restart.
 */
export type CmuxHealthState = "healthy" | "not-running" | "socket-dead" | "ui-starved" | "access-denied";

export interface CmuxProbeResult {
    ok: boolean;
    ms: number;
    detail?: string;
}

export interface CmuxHealth {
    state: CmuxHealthState;
    appPid?: number;
    appCpu?: number;
    probes: {
        ping: CmuxProbeResult;
        capabilities?: CmuxProbeResult;
        identify: CmuxProbeResult;
    };
}

export interface ProbeCmuxHealthOptions {
    pingTimeoutMs?: number;
    identifyTimeoutMs?: number;
    /** Also time the `capabilities` probe (doctor display; not needed for classification). */
    full?: boolean;
}

export function classifyCmuxHealth(input: {
    appRunning: boolean;
    pingOk: boolean;
    identifyOk: boolean;
    /** cmux answered, but with "Access denied - only processes started inside cmux can connect". */
    accessDenied?: boolean;
}): CmuxHealthState {
    if (input.accessDenied) {
        return "access-denied";
    }

    if (input.pingOk && input.identifyOk) {
        return "healthy";
    }

    if (input.pingOk) {
        return "ui-starved";
    }

    return input.appRunning ? "socket-dead" : "not-running";
}

/** The app binary `ps` reports for a running cmux. Exported: the rescue kill path
 * re-checks a pid against this before signalling it. */
export const APP_BINARY_SUFFIX = "cmux.app/Contents/MacOS/cmux";

async function findCmuxApp(): Promise<{ pid: number; cpu: number } | undefined> {
    try {
        const proc = Bun.spawn(["ps", "-axo", "pid=,%cpu=,comm="], {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "ignore",
        });
        const text = await new Response(proc.stdout).text();
        await proc.exited;

        for (const line of text.split("\n")) {
            const match = line.trim().match(/^(\d+)\s+([\d.]+)\s+(.+)$/);
            if (match?.[3]?.endsWith(APP_BINARY_SUFFIX)) {
                return { pid: Number(match[1]), cpu: Number(match[2]) };
            }
        }
    } catch (error) {
        logger.debug({ error }, "[cmux-health] ps scan failed");
    }

    return undefined;
}

async function timedProbe(args: string[], timeoutMs: number, expect?: string): Promise<CmuxProbeResult> {
    const startedAt = Date.now();
    try {
        const result = await runCmux(args, { timeoutMs });
        const ms = Date.now() - startedAt;
        if (result.timedOut) {
            return { ok: false, ms, detail: `timed out after ${timeoutMs} ms` };
        }

        if (result.code !== 0) {
            return { ok: false, ms, detail: result.stderr.trim().slice(0, 200) || `exit ${result.code}` };
        }

        if (expect && !result.stdout.includes(expect)) {
            return { ok: false, ms, detail: `unexpected output: ${result.stdout.slice(0, 80)}` };
        }

        return { ok: true, ms };
    } catch (error) {
        return {
            ok: false,
            ms: Date.now() - startedAt,
            detail: error instanceof Error ? error.message : String(error),
        };
    }
}

export async function probeCmuxHealth(opts: ProbeCmuxHealthOptions = {}): Promise<CmuxHealth> {
    const pingTimeoutMs = opts.pingTimeoutMs ?? 1500;
    const identifyTimeoutMs = opts.identifyTimeoutMs ?? 4000;

    const [app, ping] = await Promise.all([findCmuxApp(), timedProbe(["ping"], pingTimeoutMs, "PONG")]);
    const capabilities = opts.full ? await timedProbe(["capabilities"], pingTimeoutMs) : undefined;
    // Skip the slow probe when the socket is already dead — identify cannot succeed.
    const identify = ping.ok
        ? await timedProbe(["identify"], identifyTimeoutMs)
        : { ok: false, ms: 0, detail: "skipped (ping failed)" };

    const accessDenied = isCmuxAccessDenied(ping.detail) || isCmuxAccessDenied(identify.detail);

    return {
        state: classifyCmuxHealth({
            appRunning: app !== undefined,
            pingOk: ping.ok,
            identifyOk: identify.ok,
            accessDenied,
        }),
        appPid: app?.pid,
        appCpu: app?.cpu,
        probes: { ping, capabilities, identify },
    };
}

export class CmuxUnresponsiveError extends Error {
    readonly health: CmuxHealth;

    constructor(context: string, health: CmuxHealth) {
        super(describeUnresponsive(context, health));
        this.name = "CmuxUnresponsiveError";
        this.health = health;
    }
}

function describeUnresponsive(context: string, health: CmuxHealth): string {
    switch (health.state) {
        case "not-running":
            return `${context}: cmux is not running.`;
        case "socket-dead":
            return `${context}: the cmux app is running (pid ${health.appPid}) but its socket does not answer — run \`tools cmux doctor\`.`;
        case "ui-starved":
            return (
                `${context}: cmux's UI thread is not responding (ping answers in ${health.probes.ping.ms} ms but ` +
                `identify starved${health.appCpu !== undefined ? `, app CPU ${health.appCpu}%` : ""}) — likely a UI livelock. ` +
                "Run `tools cmux doctor` for triage and the rescue recipe."
            );
        case "access-denied":
            return (
                `${context}: cmux refused the connection (only processes started inside cmux can connect) — ` +
                "run this from a cmux pane, or change cmux's socket access setting."
            );
        default:
            return `${context}: cmux unhealthy`;
    }
}

/**
 * Cheap fail-fast preflight for anything about to issue cmux state commands.
 * Throws CmuxUnresponsiveError within ~4 s instead of letting every downstream
 * request hang for its full per-request timeout.
 */
export async function ensureCmuxResponsive(context: string, opts: ProbeCmuxHealthOptions = {}): Promise<CmuxHealth> {
    const health = await probeCmuxHealth({ identifyTimeoutMs: 3500, ...opts });
    if (health.state !== "healthy") {
        throw new CmuxUnresponsiveError(context, health);
    }

    return health;
}
