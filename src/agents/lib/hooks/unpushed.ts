import { spawnSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import type { UnpushedConfig } from "./config";
import { assertPrivateFile, makePrivateDir } from "./diff/private-dir";
import { hookDiag } from "./log";
import { unpushedRoot } from "./paths";

/**
 * The Stop-phase reminder about work that is committed but not pushed. It runs at the end of
 * EVERY turn of every session, so it is held to at most two git processes per repository:
 *
 *   1. one `git rev-parse` for the common git dir, HEAD, the upstream and the branch;
 *   2. one `git log @{u}..HEAD` for the count and the oldest date, only when HEAD or the
 *      upstream moved since the last look (the answer is cached per pair of commits).
 *
 * The time of the last push is read from the upstream's reflog FILE, not from a third process.
 * A branch without an upstream, a detached HEAD or an upstream that is gone makes step 1 fail,
 * and that is the quiet case, not an error.
 */

export interface UnpushedState {
    root: string;
    branch: string;
    count: number;
    /** Committer time of the oldest unpushed commit, in ms. */
    oldestMs: number;
    /** When the upstream last moved by a push from this clone, in ms, when the reflog says. */
    lastPushMs: number | null;
}

const GIT_TIMEOUT_MS = 3_000;

function git(root: string, args: string[]): string | null {
    const run = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS });

    return run.status === 0 && typeof run.stdout === "string" ? run.stdout : null;
}

function keyOf(root: string): string {
    return Bun.hash(root).toString(36);
}

interface Cached {
    key: string;
    count: number;
    oldestMs: number;
}

function readCache(root: string): Cached | null {
    try {
        return SafeJSON.parse(readFileSync(join(unpushedRoot(), `${keyOf(root)}.json`), "utf8"), {
            strict: true,
        }) as Cached;
    } catch {
        // No cache is the first look at this repository, not a failure.
        return null;
    }
}

function writeCache(root: string, cached: Cached): void {
    try {
        const path = join(unpushedRoot(), `${keyOf(root)}.json`);
        assertPrivateFile(path);
        writeFileSync(path, SafeJSON.stringify(cached), { mode: 0o600 });
    } catch (err) {
        hookDiag("Could not cache the unpushed count", { err, root });
    }
}

/** The last `update by push` line of a reflog file, as ms. */
function lastPush(reflog: string): number | null {
    let text: string;

    try {
        // One line per fetch or push of this one branch, so the whole file is small.
        text = readFileSync(reflog, "utf8");
    } catch {
        // A remote-tracking ref that was only ever fetched may have no reflog at all.
        return null;
    }

    const lines = text.split("\n").filter((line) => line.includes("\tupdate by push"));
    const seconds = Number(/> (\d+) [+-]\d{4}\t/.exec(lines.at(-1) ?? "")?.[1]);

    return Number.isFinite(seconds) ? seconds * 1000 : null;
}

/** What is unpushed on the current branch of `root`, or `null` for the quiet cases. Never throws. */
export function unpushedState(root: string): UnpushedState | null {
    const head = git(root, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
        "HEAD",
        "@{u}",
        "--symbolic-full-name",
        "@{u}",
        "--abbrev-ref",
        "HEAD",
    ]);

    if (head === null) {
        return null;
    }

    const [commonDir, headOid, upstreamOid, upstreamRef, branch] = head.trim().split("\n");

    if (!commonDir || !headOid || !upstreamOid || !upstreamRef || !branch) {
        return null;
    }

    const key = `${headOid}:${upstreamOid}`;
    let cached = readCache(root);

    if (cached?.key !== key) {
        const log = git(root, ["log", "--format=%ct", "@{u}..HEAD"]);

        if (log === null) {
            return null;
        }

        const times = log
            .split("\n")
            .filter(Boolean)
            .map((line) => Number(line) * 1000);

        cached = { key, count: times.length, oldestMs: times.length > 0 ? Math.min(...times) : 0 };
        writeCache(root, cached);
    }

    return {
        root,
        branch,
        count: cached.count,
        oldestMs: cached.oldestMs,
        lastPushMs: lastPush(join(commonDir, "logs", upstreamRef)),
    };
}

export function isDue(state: UnpushedState, config: UnpushedConfig, now: number): boolean {
    if (state.count === 0) {
        return false;
    }

    return state.count > config.maxCommits || now - state.oldestMs > config.maxAgeMinutes * 60_000;
}

/**
 * One reminder per repository per `everyMinutes`, across every session. The claim is an
 * exclusive create of the file for the current window, and a claim in the previous window that
 * is still younger than the interval also holds, so a window boundary cannot fire twice in a row.
 */
export function claimReminder(root: string, everyMinutes: number, now: number, dir = unpushedRoot()): boolean {
    const span = Math.max(1, everyMinutes) * 60_000;
    const window = Math.floor(now / span);
    const name = (at: number) => join(dir, `${keyOf(root)}.${at}.claim`);

    try {
        if (now - statSync(name(window - 1)).mtimeMs < span) {
            return false;
        }
    } catch {
        // No claim in the previous window: the normal case.
    }

    try {
        // "wx" never follows an existing link; the folder is checked like every other private tree.
        const refused = makePrivateDir(dir);

        if (refused) {
            throw new Error(refused);
        }

        writeFileSync(name(window), String(now), { flag: "wx", mode: 0o600 });
        return true;
    } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") {
            hookDiag("Could not claim the unpushed reminder", { err, root });
        }

        return false;
    }
}

/** `1h45m`, `12m`, `3d4h`. */
export function shortAge(ms: number): string {
    const minutes = Math.max(0, Math.floor(ms / 60_000));

    if (minutes < 60) {
        return `${minutes}m`;
    }

    const hours = Math.floor(minutes / 60);

    if (hours < 24) {
        return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
    }

    return `${Math.floor(hours / 24)}d${hours % 24 ? `${hours % 24}h` : ""}`;
}

function clock(ms: number): string {
    const at = new Date(ms);

    return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

export function reminderLine(state: UnpushedState, now: number): string {
    const commits = state.count === 1 ? "1 commit" : `${state.count} commits`;
    const pushed = state.lastPushMs === null ? "" : `, last push ${clock(state.lastPushMs)}`;

    return `⬆ ${basename(state.root)} ${state.branch}: ${commits} not pushed, oldest ${shortAge(now - state.oldestMs)}${pushed}. Push when ready for review.`;
}

/** The reminder lines for these roots, each one claimed. Never throws, never pushes. */
export function unpushedReminders(roots: string[], config: UnpushedConfig, now = Date.now()): string[] {
    if (!config.enabled) {
        return [];
    }

    const lines: string[] = [];

    for (const root of roots) {
        try {
            const state = unpushedState(root);

            if (state && isDue(state, config, now) && claimReminder(root, config.remindEveryMinutes, now)) {
                lines.push(reminderLine(state, now));
            }
        } catch (err) {
            hookDiag("The unpushed check failed for one root", { err, root });
        }
    }

    return lines;
}
