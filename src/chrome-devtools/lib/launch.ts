/**
 * The ONE way this repo starts a CDP-enabled browser: build the flags, spawn
 * the app, wait until the port answers. `open`, `restart` and src/youtube's
 * extension browser all come through here, so a launch gotcha is paid for once.
 * The way back is here too: `quitOwnedBrowser` and `closeBrowserOnPort` quit
 * through CDP, because a kill signal leaks a 1.4 GB app copy on macOS.
 */
import {
    BACKGROUND_WINDOW_TARGET,
    backgroundLaunchSupported,
    idleDisplayWindowArgs,
} from "@genesiscz/utils/chrome-devtools/window-placement";
import { logger } from "@genesiscz/utils/logger";
import { isProcessAlive } from "@genesiscz/utils/process-alive";
import { profiler } from "@genesiscz/utils/profile";
import { type Browser, browser, type CdpProbe, newTab, probe } from "./cdp.ts";
import {
    currentPlatform,
    defaultExec,
    type ExecFn,
    listListeningTcpPorts,
    listProcesses,
    type Platform,
    processExecutable,
} from "./platform.ts";
import {
    type BrowserId,
    browserById,
    browserExecutable,
    classifyProcessName,
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

/**
 * Branded Chrome on macOS copies its whole app (about 1.4 GB) into `com.google.Chrome.code_sign_clone/` under the temp
 * folder at every launch, and leaves the copy behind when the browser does not exit cleanly (Chromium issue 379125944).
 * Every launch turns it off. Other platforms ignore the unknown feature name.
 */
export const CODE_SIGN_CLONE_FEATURE = "MacAppCodeSignClone";

const LOCAL_NETWORK_FEATURES = ["LocalNetworkAccessChecks", "PrivateNetworkAccessChecks"];

/** The first window of a background launch: the desktop layout size, shrunk to fit the idle display. */
const BACKGROUND_WINDOW_SIZE = { width: 1440, height: 1000 };

/**
 * Chrome reads only the LAST `--disable-features` flag, so every feature a launch turns off must be in one flag.
 * Merges the lists of all `--disable-features` entries in `args` with `features` into one flag, kept where the first
 * one was (or appended).
 */
export function withDisabledFeatures(args: string[], features: string[]): string[] {
    const prefix = "--disable-features=";
    const merged: string[] = [];
    for (const arg of args) {
        if (arg.startsWith(prefix)) {
            merged.push(...arg.slice(prefix.length).split(","));
        }
    }

    merged.push(...features);
    const flag = `${prefix}${[...new Set(merged.filter(Boolean))].join(",")}`;
    const first = args.findIndex((arg) => arg.startsWith(prefix));
    const rest = args.filter((arg) => !arg.startsWith(prefix));
    if (first < 0) {
        return [...rest, flag];
    }

    return [...rest.slice(0, first), flag, ...rest.slice(first)];
}

/** Chromium launch flags. Exported for tests: the --user-data-dir rule is what keeps `open` off the real profile. */
export function launchArgs(
    port: number,
    opts: {
        fresh?: boolean;
        extension?: string;
        userDataDir?: string;
        disposableProfile?: boolean;
        profileDirectory?: string;
        /** No startup window: the caller opens the first one over CDP, inactive (see `BackgroundLaunch`). */
        background?: boolean;
        /** `--window-position` / `--window-size` for that window. */
        windowArgs?: string[];
    }
): string[] {
    const args = [`--remote-debugging-port=${port}`, "--no-first-run", "--no-default-browser-check"];
    const explicitDir = opts.userDataDir !== undefined;

    if (opts.profileDirectory) {
        // Naming the profile is what keeps the "Who's using …?" picker shut on a
        // multi-profile browser. It selects a directory INSIDE the user-data-dir,
        // so it composes with every other profile flag rather than replacing one.
        args.push(`--profile-directory=${opts.profileDirectory}`);
    }

    if (opts.fresh || opts.extension || explicitDir) {
        args.push(`--user-data-dir=${opts.userDataDir ?? freshProfileDir(port)}`);
    }

    const disabledFeatures: string[] = [];

    if ((!explicitDir && (opts.fresh || opts.extension)) || opts.disposableProfile) {
        // Local/private-network access checks block CDP-driven fetches to dev
        // servers, so THROWAWAY profiles disable them: the /tmp dir this launcher
        // creates, or one the caller declares disposable. An arbitrary
        // --user-data-dir keeps logins between runs, so it keeps every protection
        // too, exactly like the user's real profile (plain open / restart) —
        // including when --extension or --fresh is passed alongside it. A session
        // that holds credentials must never run security-downgraded.
        disabledFeatures.push(...LOCAL_NETWORK_FEATURES);
    }

    disabledFeatures.push(CODE_SIGN_CLONE_FEATURE);
    args.push(`--disable-features=${disabledFeatures.join(",")}`);

    if (opts.background) {
        args.push("--no-startup-window", ...(opts.windowArgs ?? []));
    }

    if (opts.extension) {
        args.push(`--load-extension=${opts.extension}`, `--disable-extensions-except=${opts.extension}`);
    }

    return args;
}

/** Spawn that keeps the browser's stdio, so a failed launch leaves a readable log. Injectable for tests. */
export type SpawnLoggedFn = (cmd: string[], logPath: string) => { pid: number; kill: () => void };

export const defaultSpawnLogged: SpawnLoggedFn = (cmd, logPath) => {
    // stdio ["ignore","ignore","ignore"] makes Chrome/Brave STALL before it
    // opens the CDP port — confirmed live, repeatedly: the process starts,
    // spawns exactly a GPU helper and never progresses. Piping stdout/stderr
    // to a real file (not /dev/null, not ignored) is the fix. Do not
    // "simplify" this back to ignore.
    const child = Bun.spawn(cmd, { stdio: ["ignore", Bun.file(logPath), Bun.file(logPath)] });
    child.unref();

    return { pid: child.pid, kill: () => child.kill() };
};

/** `window`: the browser came up, but neither first-window path (inactive, then normal) opened its page. */
export type LaunchStage = "spawn" | "timeout" | "window";

/**
 * How an isolated launch on macOS leaves the user's focus alone. A startup window is shown active and Chrome activates
 * itself, so the launch passes `--no-startup-window`, places the first window on a display the user is not working on,
 * and opens the url over CDP in a window Chrome shows inactive. Injectable for tests.
 */
export interface BackgroundLaunch {
    /** Placement flags for the first window; empty preserves the normal startup window. */
    windowArgs: () => Promise<string[]>;
    /** Opens the url in an inactive window once the CDP port answers. */
    openWindow: (port: number, url: string) => Promise<void>;
}

/**
 * Opens the url in a window Chrome shows inactive. If that fails, `PUT /json/new` opens it in a normal (active) window,
 * as before; a failure there is propagated so CDP availability cannot hide a missing window.
 */
export async function openBackgroundWindow(port: number, url: string): Promise<void> {
    try {
        const conn = await browser(port);
        try {
            await conn.send("Target.createTarget", { url, ...BACKGROUND_WINDOW_TARGET });
        } finally {
            conn.close();
        }

        return;
    } catch (err) {
        log.debug({ err, port }, "inactive first window failed; opening the url in a normal window");
    }

    try {
        await newTab(port, url);
    } catch (err) {
        log.debug({ err, port, url }, "could not open the first window");
        throw err;
    }
}

export const defaultBackgroundLaunch: BackgroundLaunch = {
    windowArgs: () => idleDisplayWindowArgs(BACKGROUND_WINDOW_SIZE),
    openWindow: openBackgroundWindow,
};

export class CdpLaunchError extends Error {
    readonly stage: LaunchStage;
    /** Tail of the browser's own log, when the launch owned its stdio. */
    readonly logTail: string | null;
    /** The launch already quit the browser it spawned, so the caller must not quit it again. */
    readonly childQuit: boolean;

    constructor(message: string, opts: { stage: LaunchStage; logTail?: string | null; childQuit?: boolean }) {
        super(message);
        this.name = "CdpLaunchError";
        this.stage = opts.stage;
        this.logTail = opts.logTail ?? null;
        this.childQuit = opts.childQuit ?? false;
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
    /**
     * The caller made `userDataDir` for this launch and throws it away afterwards.
     * Only such a profile may run with the local/private-network checks disabled;
     * a directory the launcher did not create is assumed to hold credentials.
     */
    disposableProfile?: boolean;
    /** Profile dir inside the user-data-dir, e.g. "Default" / "Profile 1". Keeps the profile picker shut. */
    profileDirectory?: string;
    /**
     * Set by the doors that open a browser for the user (`open`, the recording browser), normally to
     * `defaultBackgroundLaunch`. Applies to an isolated profile on macOS only. The user's real profile always launches
     * with its startup window, because `--no-startup-window` would skip its session restore.
     */
    background?: BackgroundLaunch;
    platform?: Platform;
    timeoutMs?: number;
    /** Own the browser's stdio and write it here. Required to get a pid back, and to see WHY a launch failed. */
    logPath?: string;
    spawnLogged?: SpawnLoggedFn;
    launch?: typeof launchBrowser;
    probe?: (port: number) => Promise<CdpProbe | null>;
    waitFor?: typeof waitForCdp;
    readLog?: (path: string) => Promise<string>;
    quit?: QuitDeps;
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
const prof = profiler.scope("chrome-devtools");

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
    // Resolved ONCE: freshProfileDir() is unique per call, so a second call inside launchArgs would
    // generate a DIFFERENT directory than the one reported here, and the browser would launch into
    // one dir while this function told the caller it was using another.
    const generatedUserDataDir = isolated && opts.userDataDir === undefined ? freshProfileDir(opts.port) : undefined;
    const userDataDir = isolated ? (opts.userDataDir ?? generatedUserDataDir ?? null) : null;
    const platform = opts.platform ?? currentPlatform();
    if (isolated && opts.background && !backgroundLaunchSupported(platform)) {
        log.debug({ platform }, "background window placement is macOS-only; the window keeps its default placement");
    }

    const requestedBackground =
        isolated && opts.background && backgroundLaunchSupported(platform) ? opts.background : null;
    const windowArgs = requestedBackground ? await requestedBackground.windowArgs() : [];
    const background = windowArgs.length > 0 ? requestedBackground : null;
    if (background) {
        const owners = listenerPids(opts.port, opts.quit ?? {});
        if (owners.length > 0) {
            throw new CdpLaunchError(
                `CDP port ${opts.port} is already occupied; refusing to open the launch URL in another browser`,
                { stage: "spawn" }
            );
        }
    }

    const args = launchArgs(opts.port, {
        fresh: opts.fresh,
        extension: opts.extension,
        userDataDir: opts.userDataDir ?? generatedUserDataDir,
        // A dir THIS function generated is thrown away afterwards by definition, same as the
        // --fresh/--extension default launchArgs would otherwise have generated itself.
        disposableProfile: opts.disposableProfile || generatedUserDataDir !== undefined,
        profileDirectory: opts.profileDirectory,
        background: background !== null,
        windowArgs,
    });
    const url = opts.url ?? "about:blank";
    // A url on argv would open the startup window, which is shown active.
    const argvUrl = background ? [] : [url];
    let pid: number | null = null;
    let kill = () => {};

    if (opts.logPath) {
        const bin = browserExecutable({ browser: def });

        if (!bin) {
            throw new CdpLaunchError(`no ${def.app} executable found on this machine`, { stage: "spawn" });
        }

        const child = (opts.spawnLogged ?? defaultSpawnLogged)([bin, ...args, ...argvUrl], opts.logPath);
        pid = child.pid;
        kill = child.kill;
    } else {
        const launch = (opts.launch ?? launchBrowser)({
            browser: def,
            args,
            url: argvUrl[0],
            background: background !== null,
        });

        if (!launch.ok) {
            throw new CdpLaunchError(launch.message, { stage: "spawn" });
        }
    }

    const probeFn = opts.probe ?? probe;
    const timeoutMs = opts.timeoutMs ?? (isolated ? COLD_PROFILE_TIMEOUT_MS : DEFAULT_LAUNCH_TIMEOUT_MS);
    const up = await prof.measureAsync(`launch.wait-cdp.${isolated ? "isolated" : "profile"}`, () =>
        (opts.waitFor ?? waitForCdp)({ port: opts.port, probe: probeFn, timeoutMs })
    );

    if (up && background) {
        try {
            await background.openWindow(opts.port, url);
        } catch (err) {
            const logTail = opts.logPath
                ? await readLogTail(opts.logPath, opts.readLog ?? ((p) => Bun.file(p).text()))
                : null;
            kill();
            throw new CdpLaunchError(
                `${def.app} launched on port ${opts.port}, but its first window did not open: ${err instanceof Error ? err.message : String(err)}`,
                { stage: "window", logTail }
            );
        }
    }

    const result = up ? await prof.measureAsync("launch.probe", () => probeFn(opts.port)) : null;

    if (!result) {
        const logTail = opts.logPath
            ? await readLogTail(opts.logPath, opts.readLog ?? ((p) => Bun.file(p).text()))
            : null;

        if (pid !== null) {
            await quitOwnedBrowser({ port: opts.port, pid, kill, deps: opts.quit });
        }

        throw new CdpLaunchError(
            `${def.app} launched but CDP port ${opts.port} never answered within ${timeoutMs}ms` +
                (opts.logPath ? `\n--- ${opts.logPath} (last ${LOG_TAIL_LINES} lines) ---\n${logTail}` : ""),
            { stage: "timeout", logTail, childQuit: pid !== null }
        );
    }

    return { pid, port: opts.port, userDataDir, browser: result.browser, pages: result.pages.length };
}

/** How long a browser gets to exit after `Browser.close` before a caller that owns it falls back to a kill. */
export const QUIT_TIMEOUT_MS = 3_000;
/** `close` never kills, so it can afford to wait for a slow quit. */
export const CLOSE_TIMEOUT_MS = 10_000;
const EXIT_POLL_MS = 200;

/** Injectable primitives, so a test never reaches a real browser that happens to listen on its port. */
export interface QuitDeps {
    connect?: (port: number) => Promise<Pick<Browser, "send" | "close">>;
    alive?: (pid: number) => boolean;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    exec?: ExecFn;
    platform?: Platform;
}

/** The pids listening on `port`. Two of them means one browser on 127.0.0.1 and another on [::1]. */
function listenerPids(port: number, deps: QuitDeps): number[] {
    const listeners = listListeningTcpPorts(deps.exec ?? defaultExec, deps.platform ?? currentPlatform());

    return [...new Set(listeners.flatMap((l) => (l.port === port && l.pid !== null ? [l.pid] : [])))];
}

/**
 * Asks the browser on `port` to quit over CDP. Returns false when nothing answered.
 *
 * Use this, never a kill signal: macOS Chrome and Brave keep a copy of their app bundle for each launch
 * (`/var/folders/<user>/X/<bundle id>.code_sign_clone/`, about 1.4 GB) and delete it only when they quit on their own.
 * 102 such copies filled the disk on 2026-10-08; `Browser.close` removed the copy within 2 s.
 */
export async function requestBrowserClose(port: number, deps: QuitDeps = {}): Promise<boolean> {
    let conn: Pick<Browser, "send" | "close">;
    try {
        conn = await (deps.connect ?? browser)(port);
    } catch (error) {
        log.debug({ error, port }, "Browser.close could not reach the browser");
        return false;
    }

    // Chrome drops the socket as it quits, so the reply often never comes.
    await conn.send("Browser.close", {}, { timeoutMs: QUIT_TIMEOUT_MS }).catch((error: unknown) => {
        log.debug({ error, port }, "Browser.close got no reply");
    });
    conn.close();
    log.debug({ port }, "Browser.close sent");

    return true;
}

async function waitForExit(pid: number, timeoutMs: number, deps: QuitDeps): Promise<boolean> {
    const alive = deps.alive ?? isProcessAlive;
    const sleep = deps.sleep ?? Bun.sleep;
    const now = deps.now ?? Date.now;
    const deadline = now() + timeoutMs;

    while (alive(pid)) {
        const remaining = deadline - now();
        if (remaining <= 0) {
            return false;
        }

        await sleep(Math.min(EXIT_POLL_MS, remaining));
    }

    return true;
}

/**
 * Quits a browser this process started: `Browser.close` first, and a kill only when the browser is still running
 * `QUIT_TIMEOUT_MS` later or never answered CDP at all (a launch that timed out has no other way in).
 *
 * `Browser.close` goes out only when `pid` is the one process listening on `port`. CDP connects to 127.0.0.1, and a
 * browser started while another one holds 127.0.0.1:<port> binds only [::1], so asking the port without that check
 * could quit the user's other browser.
 */
export async function quitOwnedBrowser(opts: {
    port: number;
    pid: number;
    kill: () => void;
    /** The child's exit, when the caller holds it: an exited child that is not reaped yet still answers a pid probe. */
    exited?: Promise<unknown>;
    deps?: QuitDeps;
}): Promise<"closed" | "killed"> {
    const deps = opts.deps ?? {};
    const owners = listenerPids(opts.port, deps);

    if (owners.length !== 1 || owners[0] !== opts.pid) {
        log.warn(
            { port: opts.port, pid: opts.pid, owners },
            "the CDP port is not this browser's alone, so it is not asked to quit; killing it leaves its app copy behind"
        );
    } else if (await requestBrowserClose(opts.port, deps)) {
        const sleep = deps.sleep ?? Bun.sleep;
        const quit = opts.exited
            ? await Promise.race([opts.exited.then(() => true), sleep(QUIT_TIMEOUT_MS).then(() => false)])
            : await waitForExit(opts.pid, QUIT_TIMEOUT_MS, deps);

        if (quit) {
            return "closed";
        }

        log.warn(
            { port: opts.port, pid: opts.pid },
            "browser did not quit after Browser.close; killing it leaves its app copy behind"
        );
    } else {
        log.warn(
            { port: opts.port, pid: opts.pid },
            "browser does not answer CDP; killing it leaves its app copy behind"
        );
    }

    opts.kill();
    return "killed";
}

export type CloseOnPortResult =
    | { status: "closed"; pid: number }
    | { status: "nothing-listening" }
    | { status: "several-listeners"; pids: number[] }
    | { status: "not-a-browser"; pid: number; command: string }
    | { status: "main-profile"; pid: number; command: string }
    | { status: "unreachable"; pid: number }
    | { status: "still-running"; pid: number };

export interface CloseOnPortOpts {
    port: number;
    allowMainProfile?: boolean;
    timeoutMs?: number;
    deps?: QuitDeps;
}

/**
 * Quits the browser that listens on `port` through `Browser.close` and waits for its process to exit. It never kills:
 * a browser still running after `timeoutMs` is reported. It refuses a browser on the user's own profile (no
 * `--user-data-dir`) unless `allowMainProfile`, and a port two processes listen on (one on 127.0.0.1, one on [::1]),
 * because CDP would reach only one of them.
 */
export async function closeBrowserOnPort(opts: CloseOnPortOpts): Promise<CloseOnPortResult> {
    const result = await closeOnPort(opts);
    log.debug({ port: opts.port, ...result }, "close browser on port");

    return result;
}

async function closeOnPort(opts: CloseOnPortOpts): Promise<CloseOnPortResult> {
    const deps = opts.deps ?? {};
    const pids = listenerPids(opts.port, deps);

    if (pids.length === 0) {
        return { status: "nothing-listening" };
    }

    if (pids.length > 1) {
        return { status: "several-listeners", pids };
    }

    const pid = pids[0];
    const exec = deps.exec ?? defaultExec;
    const platform = deps.platform ?? currentPlatform();
    const command = listProcesses(exec, platform).find((p) => p.pid === pid)?.command ?? "";
    // The executable's own name, never its arguments: a proxy started with a browser's path as an argument is
    // not a browser.
    const executable = processExecutable(pid, exec, platform)?.split(/[/\\]/).pop() ?? "";

    if (classifyProcessName(executable) === null) {
        return { status: "not-a-browser", pid, command };
    }

    // An argument of its own: the text inside a URL or another flag's value must not pass the guard.
    if (!opts.allowMainProfile && !/(?:^|\s)--user-data-dir(?:=|\s|$)/.test(command)) {
        return { status: "main-profile", pid, command };
    }

    if (!(await requestBrowserClose(opts.port, deps))) {
        return { status: "unreachable", pid };
    }

    const exited = await waitForExit(pid, opts.timeoutMs ?? CLOSE_TIMEOUT_MS, deps);

    return exited ? { status: "closed", pid } : { status: "still-running", pid };
}
