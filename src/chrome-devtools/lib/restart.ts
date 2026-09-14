/**
 * The three things `restart` got wrong, as testable pieces.
 *
 * 1. A slow quit is not a failed quit. A page with a `beforeunload` handler makes
 *    the browser ask the user before it closes, and that prompt can hold the
 *    process far longer than a quick liveness check allows. Reporting that as
 *    "still running" and recommending `--force` pointed a `kill -KILL` at a
 *    browser that was already shutting down cleanly, which costs session restore.
 * 2. On a multi-profile browser the relaunch opens the "Who's using …?" picker,
 *    so `restart` handed back a browser the operator still had to finish
 *    launching by hand. Naming the profile up front avoids that window entirely.
 * 3. `restart` never checked what it produced, so proving the browser was fine
 *    meant reaching for curl and AppleScript afterwards.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { Target } from "./cdp.ts";
import { isDevToolsTarget } from "./net-panel.ts";
import { currentPlatform, type Platform } from "./platform.ts";
import { type BrowserId, devtoolsPortRelpaths } from "./resolve-attach.ts";

const { log } = logger.scoped("chrome-devtools:restart");

/**
 * How long a quit may take before `--force` is worth mentioning.
 *
 * The reported beforeunload case exited on its own after roughly 30s, so any
 * deadline at or under that turns a healthy quit into a false failure. The old
 * 15s default is exactly how the bug was produced.
 */
export const QUIT_DEADLINE_MS = 45_000;

/** How often to say the wait is deliberate, so a long quit does not read as a hang. */
export const QUIT_NOTICE_EVERY_MS = 8_000;

/**
 * Chromium's profile picker is a WebUI page, so CDP sees it without any Accessibility grant.
 *
 * The scheme has to START there and the host has to END there. A plain
 * `includes("://profile-picker")` also matches an ordinary site on a host called
 * `profile-picker.example.com`, or the marker text sitting inside another page's query string
 * or fragment (`https://app.example.com/login?next=chrome://profile-picker/`), and a false
 * picker makes `restart` exit non-zero about a browser that came up correctly. The `?`, `#`
 * and end-of-string branches are there because a MISSED picker is the worse error: the verb
 * would call a browser ready while it is still sitting behind "Who's using …?".
 */
export const PROFILE_PICKER_PATTERN = /^[\w-]+:\/\/profile-picker(\/|\?|#|$)/i;

/** What the picker window is titled across the Chromium family ("Who's using Brave?"). */
export const PICKER_WINDOW_PREFIX = "Who's using";

export function isProfilePickerTarget(target: { url: string }): boolean {
    return PROFILE_PICKER_PATTERN.test(target.url);
}

export function findProfilePicker(list: Target[]): Target | null {
    return list.find(isProfilePickerTarget) ?? null;
}

/**
 * The AppleScript that closes the picker, for the case where it opened anyway.
 *
 * This is printed, never run: clicking another app's window needs an
 * Accessibility grant, and `restart` must not silently require one.
 */
export function pickerDismissHint(appName: string): string {
    return [
        `osascript -e 'tell application "System Events" to tell process "${appName}"`,
        `  repeat with w in windows`,
        `    if (name of w) starts with "${PICKER_WINDOW_PREFIX}" then click button 1 of w`,
        `  end repeat`,
        `end tell'`,
    ].join("\n");
}

/**
 * A profile directory name is resolved by the browser INSIDE its user-data-dir, so a
 * separator or `..` would point it somewhere else entirely. The value travels as one
 * fused `--profile-directory=<name>` argv element through an array spawn, so no shell
 * sees it and a leading dash cannot detach into a flag; the leading-character rule is
 * there to keep the name a plain directory name, not to defuse an injection.
 */
export function isSafeProfileDirectory(name: string): boolean {
    return /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name);
}

/** `~/Library/Application Support/BraveSoftware/Brave-Browser`, or null for a browser with no known layout. */
export function userDataDirFor(
    browser: BrowserId,
    platform: Platform = currentPlatform(),
    home?: string
): string | null {
    const entry = devtoolsPortRelpaths(platform).find((e) => e.id === browser);

    if (!entry) {
        return null;
    }

    const base = home ?? (platform === "win32" ? (env.get("LOCALAPPDATA") ?? "") : env.paths.getHome());

    if (!base) {
        return null;
    }

    // The relpaths name the DevToolsActivePort file; its directory IS the user-data-dir.
    return dirname(join(base, entry.rel));
}

export function localStatePath(
    browser: BrowserId,
    platform: Platform = currentPlatform(),
    home?: string
): string | null {
    const dir = userDataDirFor(browser, platform, home);

    return dir ? join(dir, "Local State") : null;
}

/** `profile.last_used` from a `Local State` document, or null when it is absent or unusable as a flag. */
export function parseLastUsedProfile(text: string): string | null {
    let parsed: unknown;

    try {
        parsed = SafeJSON.parse(text, { strict: true });
    } catch (err) {
        log.debug({ err }, "Local State did not parse as JSON");

        return null;
    }

    if (typeof parsed !== "object" || parsed === null) {
        return null;
    }

    const profile = (parsed as { profile?: unknown }).profile;

    if (typeof profile !== "object" || profile === null) {
        return null;
    }

    const lastUsed = (profile as { last_used?: unknown }).last_used;

    if (typeof lastUsed !== "string" || !isSafeProfileDirectory(lastUsed)) {
        log.debug({ lastUsed }, "profile.last_used is missing or is not a usable directory name");

        return null;
    }

    return lastUsed;
}

export interface ProfileResolution {
    /** The directory to pass as --profile-directory, or null to launch without the flag. */
    directory: string | null;
    /** Why there is no directory. Null on success — the reason is only needed when it failed. */
    reason: string | null;
    localStatePath: string | null;
}

function defaultReadFile(path: string): string | null {
    try {
        // Read on every restart, never cached. `restart` reads it BEFORE the quit, so
        // the value is the profile the still-running browser has open — which is the
        // one to reopen — rather than whatever the exit rewrite leaves behind.
        return readFileSync(path, "utf8");
    } catch (err) {
        log.debug({ err, path }, "Local State read failed");

        return null;
    }
}

/**
 * Which profile should the relaunch open?
 *
 * The directory must exist before it is passed on: naming a profile the browser
 * does not have makes it create a brand new empty one, which looks exactly like
 * the logged-out browser the operator was trying to avoid.
 */
export function resolveLastUsedProfile(opts: {
    browser: BrowserId;
    platform?: Platform;
    home?: string;
    readFile?: (path: string) => string | null;
    exists?: (path: string) => boolean;
}): ProfileResolution {
    const platform = opts.platform ?? currentPlatform();
    const statePath = localStatePath(opts.browser, platform, opts.home);

    if (!statePath) {
        return { directory: null, reason: `no known profile layout for '${opts.browser}'`, localStatePath: null };
    }

    const read = opts.readFile ?? defaultReadFile;
    const text = read(statePath);

    if (text === null) {
        return { directory: null, reason: `${statePath} is unreadable`, localStatePath: statePath };
    }

    const directory = parseLastUsedProfile(text);

    if (!directory) {
        return { directory: null, reason: "profile.last_used is absent or unusable", localStatePath: statePath };
    }

    const exists = opts.exists ?? existsSync;
    const dir = userDataDirFor(opts.browser, platform, opts.home);

    if (dir && !exists(join(dir, directory))) {
        return {
            directory: null,
            reason: `profile.last_used names '${directory}', which is not on disk`,
            localStatePath: statePath,
        };
    }

    return { directory, reason: null, localStatePath: statePath };
}

/** Why a quit is taking this long, in the operator's terms rather than as a failure. */
export function slowQuitNote(waitedMs: number): string {
    const seconds = Math.round(waitedMs / 1000);

    return (
        `still quitting after ${seconds}s — that is usually a page with a beforeunload handler ` +
        "asking the user to confirm before it closes. The browser is shutting down, not stuck."
    );
}

export interface RestartVerification {
    port: number;
    cdpReachable: boolean;
    browser: string | null;
    /** False when the tab list did not answer, so every count below is unknown, not zero. */
    targetsListed: boolean;
    /** Ordinary tabs. DevTools windows and the picker are counted separately. */
    pageTargets: number;
    devtoolsWindows: number;
    picker: { url: string; title: string } | null;
}

/**
 * What did the relaunch actually produce?
 *
 * Read-only: one /json/version and one /json/list. The whole point is that an
 * operator should not have to run curl and an AppleScript window enumeration
 * afterwards to find out whether the restart worked.
 */
export async function verifyRestart(opts: {
    port: number;
    /**
     * `/json/version` only. The full `probe()` wraps version AND the tab list in one
     * try, so a stalled list returns null and a live browser reads as "no CDP" — which
     * would then fail the restart the verification was added to confirm.
     */
    version: (port: number) => Promise<string | null>;
    targets: (port: number) => Promise<Target[]>;
}): Promise<RestartVerification> {
    const browser = await opts.version(opts.port);

    if (browser === null) {
        return {
            port: opts.port,
            cdpReachable: false,
            browser: null,
            targetsListed: false,
            pageTargets: 0,
            devtoolsWindows: 0,
            picker: null,
        };
    }

    let list: Target[];

    try {
        list = await opts.targets(opts.port);
    } catch (err) {
        // /json/version answered, so the endpoint IS up; a failed list must not
        // downgrade that to "unreachable", and its counts must not read as zero.
        log.debug({ err, port: opts.port }, "target list failed after a successful version probe");

        return {
            port: opts.port,
            cdpReachable: true,
            browser,
            targetsListed: false,
            pageTargets: 0,
            devtoolsWindows: 0,
            picker: null,
        };
    }

    const picker = findProfilePicker(list);
    const pages = list.filter((t) => t.type === "page" && !isDevToolsTarget(t) && !isProfilePickerTarget(t));

    return {
        port: opts.port,
        cdpReachable: true,
        browser,
        targetsListed: true,
        pageTargets: pages.length,
        devtoolsWindows: list.filter(isDevToolsTarget).length,
        picker: picker ? { url: picker.url, title: picker.title ?? "" } : null,
    };
}

/**
 * Did the relaunch produce a browser that is ready to drive?
 *
 * `targetsListed: false` is not a success. The picker check never ran on that path, so
 * `picker === null` means UNKNOWN rather than absent, and exiting 0 on it would report a
 * verification that did not happen — the same defect as calling a browser behind a picker
 * a good restart.
 */
export function restartSucceeded(v: RestartVerification): boolean {
    return v.cdpReachable && v.targetsListed && v.picker === null;
}

/** The end-state block every restart prints, so nobody has to reach for curl. */
export function formatVerification(v: RestartVerification, opts: { appName: string }): string[] {
    if (!v.cdpReachable) {
        return [`verify: port ${v.port} is NOT answering CDP — the relaunch produced no debuggable browser.`];
    }

    if (!v.targetsListed) {
        // The endpoint answered, so the relaunch worked. Printing "0 page target(s)"
        // and "no profile picker is open" here would be two claims nothing checked.
        return [
            `verify: port ${v.port} answers (${v.browser ?? "unknown"}), but its tab list did not — target counts and the profile picker are UNKNOWN.`,
        ];
    }

    const lines = [
        `verify: port ${v.port} answers (${v.browser ?? "unknown"}) · ${v.pageTargets} page target(s)` +
            (v.devtoolsWindows > 0 ? ` · ${v.devtoolsWindows} DevTools window(s)` : ""),
    ];

    if (v.picker) {
        lines.push(`verify: a profile picker is STILL OPEN (${v.picker.url}) — the browser is not ready to drive.`);
        lines.push("  dismiss it (needs an Accessibility grant for your terminal):");
        for (const line of pickerDismissHint(opts.appName).split("\n")) {
            lines.push(`    ${line}`);
        }
    } else {
        lines.push("verify: no profile picker is open.");
    }

    return lines;
}
