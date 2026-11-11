import { spawnSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { assertPrivateFile, makePrivateDir } from "./diff/private-dir";
import { hookDiag } from "./log";
import { unpushedRoot } from "./paths";
import type { UnpushedConfig } from "./sections/unpushed";

/**
 * At most two git processes per repository, one on a cache hit. rev-parse snapshots HEAD,
 * upstream, their merge bases and every remote tip; log walks only HEAD --not --remotes.
 * Boundary records name the remote parents a local merge brings without counting them.
 * Push/rebase evidence comes from reflog files. Missing upstreams and detached HEADs stay quiet.
 */

export interface UnpushedState {
    root: string;
    branch: string;
    count: number;
    /** Committer time of the oldest unpushed commit, in ms. */
    oldestMs: number;
    /** When the upstream last moved by a push from this clone, in ms, when the reflog says. */
    lastPushMs: number | null;
    history: History;
}

interface History {
    diverged: boolean;
    rebased: boolean;
    merges: { oid: string; subject: string; brings: string[] }[];
}

const GIT_TIMEOUT_MS = 3_000;

function git(root: string, args: string[]): string | null {
    const run = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS });

    return run.status === 0 && typeof run.stdout === "string" ? run.stdout : null;
}

function keyOf(root: string): string {
    return Bun.hash(root).toString(36);
}

interface RevisionPair {
    commonDir: string;
    gitDir: string;
    branch: string;
    upstreamRef: string;
    headOid: string;
    upstreamOid: string;
}

interface Cached {
    key: string;
    count: number;
    oldestMs: number;
    history: History;
    /** Absent in the old upstream-only cache; its first read recomputes the answer. */
    revisions?: RevisionPair;
}

/** A files-backend preflight only. Git still verifies the snapshot before we reuse ancestry. */
function unchangedPair(cached: Cached | null): boolean {
    const pair = cached?.revisions;

    if (!pair) {
        return false;
    }

    try {
        if (readFileSync(join(pair.gitDir, "HEAD"), "utf8").trim() !== `ref: refs/heads/${pair.branch}`) {
            return false;
        }

        const readRef = (ref: string): string | undefined => {
            try {
                return readFileSync(join(pair.commonDir, ref), "utf8").trim();
            } catch {
                // Packed refs are the fallback only when a loose ref is absent.
                return readFileSync(join(pair.commonDir, "packed-refs"), "utf8")
                    .split("\n")
                    .find((line) => line.endsWith(` ${ref}`))
                    ?.split(" ")[0];
            }
        };

        return readRef(`refs/heads/${pair.branch}`) === pair.headOid && readRef(pair.upstreamRef) === pair.upstreamOid;
    } catch {
        // Unknown layouts/backends and unreadable refs require Git's merge-base expansion.
        return false;
    }
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

/** A branch rebase which replaced the current upstream tip, with its result still unpushed. */
function recordedRebase({
    reflog,
    upstreamOid,
    ownOids,
}: {
    reflog: string;
    upstreamOid: string;
    ownOids: Set<string>;
}): boolean {
    try {
        const descendants = new Set([upstreamOid]);

        for (const line of readFileSync(reflog, "utf8").split("\n")) {
            const [oldOid, newOid] = line.split(" ", 2);
            const message = line.split("\t")[1] ?? "";

            if (descendants.has(oldOid) && /^(?:commit:|merge )/.test(message)) {
                descendants.add(newOid);
            }

            if (descendants.has(oldOid) && ownOids.has(newOid) && message.startsWith("rebase (finish):")) {
                return true;
            }
        }

        return false;
    } catch {
        // Reflogs can be disabled or expired. Divergence alone does not prove a rebase.
        return false;
    }
}

/** What is unpushed on the current branch of `root`, or `null` for the quiet cases. Never throws. */
export function unpushedState(root: string): UnpushedState | null {
    let cached = readCache(root);
    const reuseAncestry = unchangedPair(cached);
    const head = git(root, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
        "--git-dir",
        "HEAD",
        "@{u}",
        ...(reuseAncestry ? [] : ["HEAD...@{u}"]),
        "--remotes",
        "--symbolic-full-name",
        "@{u}",
        "--abbrev-ref",
        "HEAD",
    ]);

    if (head === null) {
        return null;
    }

    const fields = head.trim().split("\n");
    const [commonDir, gitDir, headOid, upstreamOid] = fields;
    const upstreamRef = fields.at(-2);
    const branch = fields.at(-1);

    if (!commonDir || !gitDir || !headOid || !upstreamOid || !upstreamRef || !branch || branch === "HEAD") {
        return null;
    }

    const revisions = { commonDir, gitDir, branch, upstreamRef, headOid, upstreamOid };

    const revisionKeys = ["commonDir", "gitDir", "branch", "upstreamRef", "headOid", "upstreamOid"] as const;

    if (reuseAncestry && revisionKeys.some((key) => cached?.revisions?.[key] !== revisions[key])) {
        // A ref changed during preflight. Try again next turn rather than guess or spawn a third Git.
        return null;
    }

    const expanded = fields.slice(4, -2);
    const bases = expanded.filter((field) => field.startsWith("^"));
    const diverged = reuseAncestry
        ? cached!.history.diverged
        : !bases.includes(`^${headOid}`) && !bases.includes(`^${upstreamOid}`);
    const remoteOids = reuseAncestry ? expanded : expanded.slice(2).filter((field) => !field.startsWith("^"));
    // v2 invalidates the old upstream-only count. Every remote OID participates in this key.
    const key = `v2:${commonDir}:${gitDir}:${branch}:${upstreamRef}:${headOid}:${upstreamOid}:${remoteOids.join(":")}`;

    if (cached?.key !== key) {
        const log = git(root, [
            "log",
            "--boundary",
            "--decorate=full",
            "--format=%m%x00%H%x00%P%x00%ct%x00%s%x00%D",
            "HEAD",
            "--not",
            "--remotes",
        ]);

        if (log === null) {
            return null;
        }

        const commits = log
            .split("\n")
            .filter(Boolean)
            .map((line) => {
                const [mark, oid, parents, seconds, subject, refs] = line.split("\0");
                return {
                    boundary: mark === "-",
                    oid,
                    parents: parents.split(" ").filter(Boolean),
                    ms: Number(seconds) * 1000,
                    subject,
                    refs,
                };
            });
        const own = commits.filter((commit) => !commit.boundary);
        const byOid = new Map(commits.map((commit) => [commit.oid, commit]));
        const merges = own
            .filter((commit) => commit.parents.length > 1)
            .map((commit) => ({
                oid: commit.oid,
                subject: commit.subject,
                brings: commit.parents.slice(1).map((parent) => {
                    const imported = byOid.get(parent);
                    const remote = imported?.refs.split(", ").find((ref) => ref.startsWith("refs/remotes/"));
                    return `${remote?.replace("refs/remotes/", "") ?? imported?.subject ?? "commit"} at ${parent.slice(0, 7)}`;
                }),
            }));
        const rebased =
            diverged &&
            recordedRebase({
                reflog: join(commonDir, "logs", "refs", "heads", branch),
                upstreamOid,
                ownOids: new Set(own.map((commit) => commit.oid)),
            });
        cached = {
            key,
            count: own.length,
            oldestMs: own.length === 0 ? 0 : own.reduce((oldest, commit) => Math.min(oldest, commit.ms), Infinity),
            history: { diverged, rebased, merges },
            revisions,
        };
        writeCache(root, cached);
    }

    return {
        root,
        branch,
        count: cached.count,
        oldestMs: cached.count === 0 ? 0 : cached.oldestMs,
        lastPushMs: lastPush(join(commonDir, "logs", upstreamRef)),
        history: cached.history,
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

    const merges = state.history.merges
        .map((merge) => `, merge ${merge.oid.slice(0, 7)} "${merge.subject}" brings ${merge.brings.join(" and ")}`)
        .join("");
    const advice = state.history.rebased
        ? "Branch rebased, push with --force-with-lease when ready for review."
        : state.history.diverged
          ? "Branch diverged from upstream; reconcile before pushing."
          : "Push when ready for review.";

    return `⬆ ${basename(state.root)} ${state.branch}: ${commits} not pushed, oldest ${shortAge(now - state.oldestMs)}${pushed}${merges}. ${advice}`;
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
