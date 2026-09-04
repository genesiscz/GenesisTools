/**
 * The ONE way this repo starts a CDP-enabled browser: build the flags, spawn
 * the app, wait until the port answers. `open`, `restart` and src/youtube's
 * extension browser all come through here, so a launch gotcha is paid for once.
 */
import { logger } from "@genesiscz/utils/logger";
import { type CdpProbe, probe } from "./cdp.ts";
import {
    type BrowserId,
    browserById,
    browserExecutable,
    freshProfileDir,
    launchBrowser,
    waitForCdp,
} from "./resolve-attach.ts";

const { log } = logger.scoped("chrome-devtools:launch");

/** A launch that shares the user's real profile is warm; 20s is plenty. */
export const DEFAULT_LAUNCH_TIMEOUT_MS = 20_000;

/**
 * A launch that creates its own profile dir is COLD: first run parses the cert
 * store and validates every loaded extension, which was measured well past 15s.
 * 30s gives that headroom without hanging forever on a genuinely broken launch.
 */
export const COLD_PROFILE_TIMEOUT_MS = 30_000;

/** Chromium launch flags. Exported for tests: the --user-data-dir rule is what keeps `open` off the real profile. */
export function launchArgs(
    port: number,
    opts: { fresh?: boolean; extension?: string; userDataDir?: string }
): string[] {
    const args = [`--remote-debugging-port=${port}`, "--no-first-run", "--no-default-browser-check"];

    if (opts.fresh || opts.extension || opts.userDataDir) {
        args.push(`--user-data-dir=${opts.userDataDir ?? freshProfileDir(port)}`);
        // Local/private-network access checks block CDP-driven fetches to dev
        // servers, so throwaway profiles disable them. The user's REAL profile
        // (plain open / restart) keeps every protection — a normal browsing
        // session must never run security-downgraded.
        args.push("--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks");
    }

    if (opts.extension) {
        args.push(`--load-extension=${opts.extension}`, `--disable-extensions-except=${opts.extension}`);
    }

    return args;
}

/** Spawn that keeps the browser's stdio, so a failed launch leaves a readable log. Injectable for tests. */
export type SpawnLoggedFn = (cmd: string[], logPath: string) => { pid: number; kill: () => void };

const defaultSpawnLogged: SpawnLoggedFn = (cmd, logPath) => {
    // stdio ["ignore","ignore","ignore"] makes Chrome/Brave STALL before it
    // opens the CDP port — confirmed live, repeatedly: the process starts,
    // spawns exactly a GPU helper and never progresses. Piping stdout/stderr
    // to a real file (not /dev/null, not ignored) is the fix. Do not
    // "simplify" this back to ignore.
    const child = Bun.spawn(cmd, { stdio: ["ignore", Bun.file(logPath), Bun.file(logPath)] });

    return { pid: child.pid, kill: () => child.kill() };
};

export type LaunchStage = "spawn" | "timeout";

export class CdpLaunchError extends Error {
    readonly stage: LaunchStage;
    /** Tail of the browser's own log, when the launch owned its stdio. */
    readonly logTail: string | null;

    constructor(message: string, opts: { stage: LaunchStage; logTail?: string | null }) {
        super(message);
        this.name = "CdpLaunchError";
        this.stage = opts.stage;
        this.logTail = opts.logTail ?? null;
    }
}

export interface LaunchCdpOpts {
    port: number;
    /** Defaults to chrome. Unknown ids throw — never silently fall back to another browser. */
    browser?: BrowserId;
    url?: string;
    fresh?: boolean;
    /** Unpacked extension dir; implies its own profile. */
    extension?: string;
    /** Explicit profile dir, e.g. a per-launch mkdtemp. Implies isolation like --fresh. */
    userDataDir?: string;
    timeoutMs?: number;
    /** Own the browser's stdio and write it here. Required to get a pid back, and to see WHY a launch failed. */
    logPath?: string;
    spawnLogged?: SpawnLoggedFn;
    launch?: typeof launchBrowser;
    probe?: (port: number) => Promise<CdpProbe | null>;
    waitFor?: typeof waitForCdp;
    readLog?: (path: string) => Promise<string>;
}

export interface LaunchedCdpBrowser {
    /** Only known when the launch owned the spawn (logPath); `open -na` reports no pid. */
    pid: number | null;
    port: number;
    userDataDir: string | null;
    browser: string;
    pages: number;
}

const LOG_TAIL_LINES = 40;

async function readLogTail(path: string, readLog: (path: string) => Promise<string>): Promise<string> {
    try {
        const text = await readLog(path);

        return text.split("\n").slice(-LOG_TAIL_LINES).join("\n");
    } catch (err) {
        // The launch already failed; losing the log too must not mask that.
        log.debug({ err, path }, "browser log unreadable after a failed launch");

        return "(log unreadable)";
    }
}

/**
 * Launch a browser with a CDP port and return once that port answers.
 *
 * Throws CdpLaunchError rather than exiting, so every door (CLI, youtube's
 * extension browser) renders its own guidance. `stage` says whether the spawn
 * itself refused or the port never came up, and `logTail` carries the browser's
 * own complaint when we owned its stdio.
 */
export async function launchCdpBrowser(
    opts: LaunchCdpOpts & { logPath: string }
): Promise<LaunchedCdpBrowser & { pid: number }>;
export async function launchCdpBrowser(opts: LaunchCdpOpts): Promise<LaunchedCdpBrowser>;
export async function launchCdpBrowser(opts: LaunchCdpOpts): Promise<LaunchedCdpBrowser> {
    const id = opts.browser ?? "chrome";
    const def = browserById(id);

    if (!def) {
        throw new CdpLaunchError(`unknown browser '${id}'`, { stage: "spawn" });
    }

    const isolated = opts.fresh === true || opts.extension !== undefined || opts.userDataDir !== undefined;
    const userDataDir = isolated ? (opts.userDataDir ?? freshProfileDir(opts.port)) : null;
    const args = launchArgs(opts.port, {
        fresh: opts.fresh,
        extension: opts.extension,
        userDataDir: opts.userDataDir,
    });
    const url = opts.url ?? "about:blank";
    let pid: number | null = null;
    let kill = () => {};

    if (opts.logPath) {
        const bin = browserExecutable({ browser: def });

        if (!bin) {
            throw new CdpLaunchError(`no ${def.app} executable found on this machine`, { stage: "spawn" });
        }

        const child = (opts.spawnLogged ?? defaultSpawnLogged)([bin, ...args, url], opts.logPath);
        pid = child.pid;
        kill = child.kill;
    } else {
        const launch = (opts.launch ?? launchBrowser)({ browser: def, args, url });

        if (!launch.ok) {
            throw new CdpLaunchError(launch.message, { stage: "spawn" });
        }
    }

    const probeFn = opts.probe ?? probe;
    const timeoutMs = opts.timeoutMs ?? (isolated ? COLD_PROFILE_TIMEOUT_MS : DEFAULT_LAUNCH_TIMEOUT_MS);
    const up = await (opts.waitFor ?? waitForCdp)({ port: opts.port, probe: probeFn, timeoutMs });
    const result = up ? await probeFn(opts.port) : null;

    if (!result) {
        const logTail = opts.logPath
            ? await readLogTail(opts.logPath, opts.readLog ?? ((p) => Bun.file(p).text()))
            : null;
        kill();

        throw new CdpLaunchError(
            `${def.app} launched but CDP port ${opts.port} never answered within ${timeoutMs}ms` +
                (opts.logPath ? `\n--- ${opts.logPath} (last ${LOG_TAIL_LINES} lines) ---\n${logTail}` : ""),
            { stage: "timeout", logTail }
        );
    }

    return { pid, port: opts.port, userDataDir, browser: result.browser, pages: result.pages.length };
}
