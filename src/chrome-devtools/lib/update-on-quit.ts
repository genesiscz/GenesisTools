/**
 * A browser can install a staged update the moment it quits. On 2026-11-02 `restart --browser brave` relaunched in
 * the same second Brave's update replaced `Versions/156.1.98.60` with `156.1.98.63`: the new process loaded the old
 * framework folder, which the install then removed, and it died with SIGTRAP in ChromeMain a second later. So after
 * the old process exits, `restart` waits until the app bundle stops changing and no updater of that vendor runs.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { findProcesses } from "@genesiscz/utils/process/processes";
import type { BrowserId } from "./resolve-attach.ts";

const { log } = logger.scoped("chrome-devtools:update-on-quit");

/** How long the bundle must stay the same, with no updater running, before a relaunch. */
export const UPDATE_STABLE_MS = 3_000;

/** The longest a relaunch waits for an install. Past it the relaunch goes ahead and the second check judges it. */
export const UPDATE_WAIT_MS = 60_000;

const UPDATE_POLL_MS = 500;

export interface BundleState {
    /** `CFBundleShortVersionString` of the app's Info.plist; null while the bundle is missing or unreadable. */
    version: string | null;
    /** The app folder's mtime: an install that swaps the bundle moves it. Null while the folder is missing. */
    mtimeMs: number | null;
}

/** Updater processes by vendor, matched against the full `ps` command line. */
const UPDATERS: Array<{ prefix: string; pattern: RegExp }> = [
    { prefix: "brave", pattern: /BraveUpdater|BraveSoftwareUpdate/ },
    { prefix: "chrome", pattern: /GoogleUpdater|GoogleSoftwareUpdate|Keystone/ },
    { prefix: "edge", pattern: /EdgeUpdater|Microsoft AutoUpdate/ },
];

export function updaterPattern(browser: BrowserId): RegExp | null {
    return UPDATERS.find((u) => browser.startsWith(u.prefix))?.pattern ?? null;
}

/** `/Applications/X.app` from the executable `/Applications/X.app/Contents/MacOS/X`. */
export function appBundleOf(executable: string): string {
    return dirname(dirname(dirname(executable)));
}

export function parseShortVersion(plist: string): string | null {
    return plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? null;
}

export function readBundleState(appPath: string): BundleState {
    let mtimeMs: number | null = null;
    let version: string | null = null;

    try {
        mtimeMs = statSync(appPath).mtimeMs;
        version = parseShortVersion(readFileSync(`${appPath}/Contents/Info.plist`, "utf8"));
    } catch (err) {
        log.debug({ err, appPath }, "app bundle not readable (missing or mid-install)");
    }

    return { version, mtimeMs };
}

/** The command line of the first running process that matches `pattern`, or null. A system updater runs as root. */
export function runningUpdater(pattern: RegExp): string | null {
    return findProcesses({ command: pattern, otherUsers: true })[0]?.command ?? null;
}

export interface UpdateWaitDeps {
    readState: () => BundleState;
    /** The command line of a running updater of this browser's vendor, or null. */
    updater: () => string | null;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
}

export interface UpdateWaitResult {
    before: BundleState;
    after: BundleState;
    /** The version or the bundle folder changed between the quit and the relaunch. */
    changed: boolean;
    /** False when the cap ran out while the bundle still changed or an updater still ran. */
    settled: boolean;
    waitedMs: number;
    /** The updater still running when the cap ran out. */
    updater: string | null;
}

function sameState(a: BundleState, b: BundleState): boolean {
    return a.version === b.version && a.mtimeMs === b.mtimeMs;
}

/**
 * Waits after the old browser exited until the bundle has stayed the same for `stableMs`, is present, and no updater
 * runs, capped at `timeoutMs`. `before` is the state read before the quit.
 */
export async function waitForUpdateOnQuit(opts: {
    before: BundleState;
    deps: UpdateWaitDeps;
    stableMs?: number;
    timeoutMs?: number;
}): Promise<UpdateWaitResult> {
    const sleep = opts.deps.sleep ?? ((ms: number) => Bun.sleep(ms));
    const now = opts.deps.now ?? Date.now;
    const stableMs = opts.stableMs ?? UPDATE_STABLE_MS;
    const timeoutMs = opts.timeoutMs ?? UPDATE_WAIT_MS;
    const startedAt = now();
    let last = opts.deps.readState();
    let stableSince = startedAt;
    let updater: string | null = null;
    const result = (settled: boolean): UpdateWaitResult => ({
        before: opts.before,
        after: last,
        changed: !sameState(opts.before, last),
        settled,
        waitedMs: now() - startedAt,
        updater: settled ? null : updater,
    });

    while (true) {
        updater = opts.deps.updater();
        if (updater !== null) {
            stableSince = now();
        }
        const present = last.version !== null && last.mtimeMs !== null;

        if (present && updater === null && now() - stableSince >= stableMs) {
            break;
        }

        if (now() - startedAt >= timeoutMs) {
            log.warn({ last, updater, waitedMs: now() - startedAt }, "app bundle did not settle before the cap");

            return result(false);
        }

        await sleep(Math.min(UPDATE_POLL_MS, startedAt + timeoutMs - now()));
        const next = opts.deps.readState();

        if (!sameState(next, last)) {
            log.info({ from: last, to: next }, "app bundle changed after the quit");
            last = next;
            stableSince = now();
        }
    }

    return result(true);
}

/** The lines `restart` prints about the wait; empty when nothing changed and nothing ran. */
export function formatUpdateWait(r: UpdateWaitResult, opts: { appName: string }): string[] {
    const seconds = Math.round(r.waitedMs / 1000);
    const lines: string[] = [];

    if (r.changed) {
        lines.push(
            r.before.version !== r.after.version
                ? `${opts.appName} updated ${r.before.version ?? "?"} -> ${r.after.version ?? "?"} while quitting; waited ${seconds}s for the install.`
                : `${opts.appName}'s app bundle changed while quitting; waited ${seconds}s for it to settle.`
        );
    }

    if (!r.settled) {
        lines.push(
            `${opts.appName} was still being updated after ${seconds}s` +
                (r.updater ? ` (${r.updater.slice(0, 120)})` : "") +
                "; relaunching anyway, the check after the relaunch decides."
        );
    }

    return lines;
}
