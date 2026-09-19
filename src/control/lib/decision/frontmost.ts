import { logger } from "@genesiscz/utils/logger";
import { captureSync } from "@genesiscz/utils/process/ps";
import { runAxAsync } from "../runner";

const { log } = logger.scoped("control-frontmost");

/** Apps whose window content is a web page; the AX tab strip lives in scope `chrome`. */
export const BROWSER_APPS: readonly string[] = [
    "Brave Browser",
    "Google Chrome",
    "Chromium",
    "Microsoft Edge",
    "Arc",
    "Vivaldi",
    "Opera",
    "Safari",
    "Firefox",
    "Zen",
];

/** Window owners that are never a voice target: system UI and our own launcher. */
const SYSTEM_OWNERS = new Set([
    "Dock",
    "WindowServer",
    "Window Server",
    "Control Center",
    "Notification Center",
    "NotificationCenter",
    "Spotlight",
    "SystemUIServer",
    "loginwindow",
    "Screenshot",
    "TextInputMenuAgent",
    "GenesisTools",
]);

export interface FrontWindow {
    pid: number;
    app: string;
    windowId?: number;
    title?: string;
}

/** A resolved target, plus whether the WindowServer named it or z-order guessed it. */
export interface FrontTarget extends FrontWindow {
    focused: boolean;
}

export function isBrowserApp(app: string): boolean {
    return BROWSER_APPS.includes(app);
}

/**
 * Every ancestor pid of `pid`, from one `ps` read. The terminal that started us is one of them,
 * whatever it is called (cmux, iTerm2, Terminal, Ghostty, an IDE), so excluding the whole chain
 * needs no list of terminal names.
 */
export function ancestorPids(pid: number = process.pid, table?: Map<number, number>): Set<number> {
    const parents = table ?? readParentTable();
    const seen = new Set<number>();
    let current = parents.get(pid);
    while (current !== undefined && current > 1 && !seen.has(current)) {
        seen.add(current);
        current = parents.get(current);
    }

    return seen;
}

function readParentTable(): Map<number, number> {
    const result = captureSync("ps", ["-axo", "pid=,ppid="], { timeoutMs: 5000 });
    if (result.status !== 0) {
        log.warn({ status: result.status, stderr: result.stderr.slice(0, 200) }, "ps failed; no ancestor exclusion");
        return new Map();
    }

    return parseParentTable(result.stdout);
}

export function parseParentTable(stdout: string): Map<number, number> {
    const table = new Map<number, number>();
    for (const line of stdout.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
        if (match) {
            table.set(Number(match[1]), Number(match[2]));
        }
    }

    return table;
}

/**
 * The first on-screen window, front to back, whose owner is neither in `excludePids` (our own
 * process chain) nor a system owner. That is "the app the user is looking at" as seen from a
 * terminal: the terminal itself is an ancestor, so the pick falls through to the window behind it.
 */
/**
 * `preferPid` is the WindowServer's own frontmost application. When it is somebody else's, it is
 * the exact answer to "what is the user looking at" and wins outright. When it is this process's
 * own terminal it says nothing, and the pick falls back to window z-order, which is a guess: a
 * window raised on another display can sit above the app the user actually means.
 */
export function pickFrontWindow(
    windows: FrontWindow[],
    options: { excludePids: Set<number>; excludeApps?: Set<string>; preferPid?: number }
): FrontWindow | null {
    const excludeApps = options.excludeApps ?? SYSTEM_OWNERS;
    const usable = (window: FrontWindow): boolean =>
        !options.excludePids.has(window.pid) && !excludeApps.has(window.app) && window.app.length > 0;
    if (options.preferPid !== undefined && !options.excludePids.has(options.preferPid)) {
        const focused = windows.find((window) => window.pid === options.preferPid && usable(window));
        if (focused) {
            return focused;
        }
    }

    return windows.find(usable) ?? null;
}

function parseFrontWindows(raw: unknown): FrontWindow[] {
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as { windows?: unknown }).windows)) {
        return [];
    }

    const windows: FrontWindow[] = [];
    for (const row of (raw as { windows: unknown[] }).windows) {
        if (!row || typeof row !== "object") {
            continue;
        }

        const record = row as { pid?: unknown; app?: unknown; windowId?: unknown; title?: unknown };
        if (typeof record.pid !== "number" || typeof record.app !== "string") {
            continue;
        }

        windows.push({
            pid: record.pid,
            app: record.app,
            ...(typeof record.windowId === "number" ? { windowId: record.windowId } : {}),
            ...(typeof record.title === "string" ? { title: record.title } : {}),
        });
    }

    return windows;
}

/**
 * Resolve the app the user is looking at through `ax-tool front` (on-screen windows, front to
 * back). Returns null when nothing but our own terminal and system UI is on screen.
 */
export async function frontmostTarget(
    options: { run?: typeof runAxAsync; signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<FrontTarget | null> {
    const result = await (options.run ?? runAxAsync)({
        args: ["front"],
        timeoutMs: options.timeoutMs ?? 5000,
        signal: options.signal,
    });
    if (!result.ok) {
        log.warn({ error: result.error }, "ax-tool front failed; no frontmost target");
        return null;
    }

    const windows = parseFrontWindows(result);
    const excludePids = ancestorPids();
    excludePids.add(process.pid);
    const rawFrontmost = (result as { frontmostPid?: unknown }).frontmostPid;
    const preferPid = typeof rawFrontmost === "number" ? rawFrontmost : undefined;
    const picked = pickFrontWindow(windows, { excludePids, preferPid });
    const focused = picked !== null && preferPid !== undefined && picked.pid === preferPid;
    log.info(
        {
            onScreen: windows.length,
            excludedPids: excludePids.size,
            frontmostPid: rawFrontmost,
            focused,
            picked: picked ? { app: picked.app, pid: picked.pid, title: picked.title } : null,
        },
        "frontmost target resolved"
    );
    return picked === null ? null : { ...picked, focused };
}

export interface AppSwitchTarget {
    pid: number;
    app: string;
    title?: string;
}

/**
 * The apps a spoken "switch to X" may name: every on-screen app except this process's own
 * terminal chain and the system UI, most recently in front first, one row per app. Sourced from
 * the same window list the frontmost pick uses, so an app that is offered is one that is really
 * on screen rather than merely running.
 */
export async function switchableApps(
    options: { run?: typeof runAxAsync; signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<AppSwitchTarget[]> {
    const result = await (options.run ?? runAxAsync)({
        args: ["front"],
        timeoutMs: options.timeoutMs ?? 5000,
        signal: options.signal,
    });
    if (!result.ok) {
        log.warn({ error: result.error }, "ax-tool front failed; no app switch targets");
        return [];
    }

    const excludePids = ancestorPids();
    excludePids.add(process.pid);
    const seen = new Set<string>();
    const apps: AppSwitchTarget[] = [];
    for (const window of parseFrontWindows(result)) {
        if (excludePids.has(window.pid) || SYSTEM_OWNERS.has(window.app) || window.app.length === 0) {
            continue;
        }

        if (!seen.has(window.app)) {
            seen.add(window.app);
            apps.push({ pid: window.pid, app: window.app, title: window.title });
        }
    }

    log.debug({ apps: apps.map((item) => item.app) }, "switchable apps");
    return apps;
}

/** Bring one app forward. The native side polls until it really is frontmost and says which pid won. */
export async function activateApp(
    pid: number,
    options: { run?: typeof runAxAsync; signal?: AbortSignal } = {}
): Promise<{ ok: boolean; error?: string }> {
    const result = await (options.run ?? runAxAsync)({
        args: ["activate", "--pid", String(pid)],
        timeoutMs: 8000,
        signal: options.signal,
    });
    const frontmost = (result as { frontmostPid?: unknown }).frontmostPid;
    log.info({ pid, ok: result.ok, frontmostPid: frontmost }, "app activation");
    if (!result.ok) {
        return { ok: false, error: result.error ?? "activation failed" };
    }

    if (typeof frontmost === "number" && frontmost !== pid) {
        return { ok: false, error: `activation did not take; pid ${frontmost} is frontmost` };
    }

    return { ok: true };
}
