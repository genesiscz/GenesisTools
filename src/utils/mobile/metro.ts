import { existsSync } from "node:fs";
import { env } from "@genesiscz/utils/env";
import { readLastLines } from "@genesiscz/utils/fs/read-lines";
import { logger } from "@genesiscz/utils/logger";
import type { PidFileState } from "@genesiscz/utils/process/pidfile";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { type DetachedService, serviceState, startDetached, stopDetached } from "./service";

const log = logger.child({ component: "mobile.metro" });

/**
 * Metro, the React Native bundler a Debug build loads its JavaScript from. One server per port, started from the
 * app's own folder (from a repo root it cannot resolve the app's modules), with `CI` removed from its environment:
 * Metro with `CI` set serves the bundle it started with and never rebuilds, and agent shells export `CI=1`.
 */
export interface MetroStatus {
    port: number;
    running: boolean;
    owned: PidFileState["status"];
    pid: number | null;
    log: string;
}

function metroService(options: { port: number; appDir: string }): DetachedService {
    const { CI: _ci, ...inherited } = env.getProcessEnv();
    return {
        name: `metro :${options.port}`,
        command: ["bunx", "expo", "start", "--port", String(options.port)],
        cwd: options.appDir,
        environment: { ...inherited, EXPO_NO_TELEMETRY: "1", BROWSER: "none" },
        logPath: metroLogPath(options.port),
        pidPath: toolDataDir("mobile", "metro", `${options.port}.pid`),
        expect: "expo",
    };
}

export function metroLogPath(port: number): string {
    return toolDataDir("mobile", "metro", `${port}.log`);
}

/** True when Metro answers on the port. 127.0.0.1, not localhost: localhost can resolve to ::1 while Metro binds IPv4. */
export async function metroRunning(port: number): Promise<boolean> {
    try {
        const response = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(2_500) });
        return (await response.text()).includes("packager-status:running");
    } catch (error) {
        log.debug({ port, error }, "metro not answering");
        return false;
    }
}

export async function metroStatus(port: number): Promise<MetroStatus> {
    const state = serviceState({ pidPath: toolDataDir("mobile", "metro", `${port}.pid`), expect: "expo" });
    return {
        port,
        running: await metroRunning(port),
        owned: state.status,
        pid: state.status === "live" ? state.pid : null,
        log: metroLogPath(port),
    };
}

/** Starts Metro for the app on the port unless one already answers there. */
export async function startMetro(options: { port: number; appDir: string; timeoutMs?: number }): Promise<MetroStatus> {
    if (await metroRunning(options.port)) {
        return metroStatus(options.port);
    }

    await startDetached(metroService(options), {
        ready: () => metroRunning(options.port),
        timeoutMs: options.timeoutMs ?? 120_000,
    });
    return metroStatus(options.port);
}

export function stopMetro(port: number): Promise<boolean> {
    return stopDetached({
        name: `metro :${port}`,
        pidPath: toolDataDir("mobile", "metro", `${port}.pid`),
        expect: "expo",
    });
}

/** A line Metro prints once a bundle was served or the app ran (a console line), or the bundle failed. */
const APP_RAN = /\bBundled \d+ms\b|Bundling failed|\[runtime not ready\]|^\s*(LOG|INFO|WARN|ERROR|DEBUG) {2}\S/m;

/** An error the app or the bundle did not survive. A logged ERROR the app goes on from is not in this list. */
const FATAL = [
    /\[runtime not ready\]/,
    /SyntheticError/,
    /Bundling failed/,
    /Unable to resolve module/,
    /Invariant Violation/,
    /Failed to construct transformer/,
    /SyntaxError in/,
    /ERROR\s+\[?(TypeError|ReferenceError|SyntaxError|RangeError)/,
];

export interface MetroLogReport {
    /** The app fetched its bundle or logged since the last bundle. */
    ran: boolean;
    /** The fatal lines after the newest `Bundled` line, oldest first. */
    fatal: string[];
    /** Every `ERROR` and `WARN` console line after the newest `Bundled` line. */
    console: string[];
}

/** Reads Metro's log from the newest bundle on: whether the app ran, and the errors it printed since. */
export function readMetroLog(text: string): MetroLogReport {
    const lines = text.split("\n");
    let start = 0;

    for (let index = lines.length - 1; index >= 0; index--) {
        if (/\bBundled \d+ms\b/.test(lines[index])) {
            start = index;
            break;
        }
    }

    const tail = lines.slice(start);
    return {
        ran: APP_RAN.test(tail.join("\n")),
        fatal: tail.filter((line) => FATAL.some((pattern) => pattern.test(line))).map((line) => line.trim()),
        console: tail.filter((line) => /^\s*(ERROR|WARN) {2}\S/.test(line)).map((line) => line.trim()),
    };
}

export function readMetroLogFile(port: number, maxBytes = 512_000): MetroLogReport {
    const path = metroLogPath(port);

    if (!existsSync(path)) {
        return { ran: false, fatal: [], console: [] };
    }

    return readMetroLog(readLastLines(path, { maxBytes }).lines.join("\n"));
}
