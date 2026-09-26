import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { listAgentSessionRows, POLLED_LISTING_REUSE_MS } from "@app/ai/lib/sessions/agent-session-rows";
import { scanWithCFfi } from "@app/du/lib/engine";
import { detectWorktreeExcludes } from "@app/du/lib/worktrees";
import { type CollectContext, collectRefReport } from "@app/git/lib/merged/collect";
import type { How, Verdict } from "@app/git/lib/merged/verdict";
import { createGit, type DetectedBase, detectBase, loadRepoConfig } from "@genesiscz/utils/git";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { readParentPid, readProcessCwd } from "@genesiscz/utils/process/cwd";
import { listPsRows, processBasename } from "@genesiscz/utils/process/ps";
import { Storage } from "@genesiscz/utils/storage";

const log = logger.child({ component: "hub/worktrees" });

/** A session touched within this many minutes still counts as using its folder. */
export const DEFAULT_LIVE_MINUTES = 30;
const SAMPLE = 8;
/** Four repositories at a time, four worktrees each: at most 16 git processes (175 worktrees in 6.7 s). */
const REPO_CONCURRENCY = 4;
const ENTRY_CONCURRENCY = 4;
const WORKTREE_REMOVE_TIMEOUT_MS = 120_000;

/** Order-preserving map with at most `limit` calls in flight; a slow item never stalls a batch. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

export type BlockerKind =
    | "unmerged"
    | "verdict-error"
    | "status-error"
    | "changed"
    | "untracked"
    | "stash"
    | "process"
    | "session"
    | "locked"
    | "missing"
    | "recent";

export interface Blocker {
    kind: BlockerKind;
    /** One sentence for the row and the refusal. */
    text: string;
}

export interface LiveProcess {
    pid: number;
    name: string;
}

export interface LiveSession {
    provider: string;
    sessionId: string;
    title: string | null;
    /** Epoch ms of the session file's last write. */
    mtime: number;
}

/** Everything the "is it safe to remove" rules read about one linked worktree. */
export interface WorktreeFacts {
    path: string;
    /** The main checkout of its repository. */
    repoRoot: string;
    repo: string;
    branch: string | null;
    head: string;
    /** The folder exists on disk. */
    present: boolean;
    locked: string | null;
    prunable: string | null;
    /** `tools git merged` verdict against `base`; null when it could not be computed. */
    verdict: Verdict | null;
    how: How | null;
    verdictError: string | null;
    /** `git status` failed: nothing is known about uncommitted work. */
    statusError: string | null;
    base: string | null;
    /** Tracked changes (staged or not), and the first few paths. */
    changedCount: number;
    changed: string[];
    untrackedCount: number;
    untracked: string[];
    /** Ignored top-level entries `git worktree remove` deletes with the folder (node_modules/, .env). */
    ignored: string[];
    /** Stash entries made on this branch, or on this worktree's detached HEAD. */
    stashes: string[];
    processes: LiveProcess[];
    sessions: LiveSession[];
    /** The agent sessions could not be read, so no session can be ruled out. */
    sessionsError: string | null;
    /** Epoch ms of the HEAD commit. */
    lastCommitAt: number | null;
    /** Epoch ms of the newest of: the HEAD commit, the worktree's reflog, its index. */
    lastActivityAt: number | null;
}

export interface WorktreeCleanupRow extends WorktreeFacts {
    removable: boolean;
    blockers: Blocker[];
}

export interface WorktreeCleanupReport {
    rows: WorktreeCleanupRow[];
    /** The base each repository was judged against. */
    bases: Array<{ repoRoot: string; base: string; source: string; detail: string }>;
    warnings: string[];
    elapsedMs: number;
}

function plural(count: number, one: string, many: string): string {
    return `${count} ${count === 1 ? one : many}`;
}

function sample(items: string[]): string {
    const shown = items.slice(0, 3).join(", ");
    return items.length > 3 ? `${shown}, …` : shown;
}

/**
 * The removal rules, as data. A linked worktree is removable only when its branch is in the base
 * (merged by any route, or never had commits), nothing in it is uncommitted or untracked, no stash
 * names it, nothing runs in it, no agent session wrote in it recently, and git has it unlocked and
 * on disk. Ignored files never block: `git worktree remove` deletes them, and the confirmation
 * lists them. With `olderThanDays`, a worktree whose last activity is newer than that also stays.
 */
export function cleanupBlockers(facts: WorktreeFacts, rules: AgeRule = {}): Blocker[] {
    const blockers: Blocker[] = [];

    if (facts.prunable || !facts.present) {
        blockers.push({ kind: "missing", text: "The folder is gone; `git worktree prune` clears the entry" });
    }

    if (facts.locked) {
        blockers.push({ kind: "locked", text: `Locked: ${facts.locked}` });
    }

    if (facts.verdict === null) {
        blockers.push({ kind: "verdict-error", text: `Merge state unknown: ${facts.verdictError ?? "no verdict"}` });
    } else if (facts.verdict !== "MERGED" && facts.verdict !== "EMPTY") {
        const why = facts.verdict === "STALE" ? "stale, not merged" : "not merged";
        const what = facts.branch === null ? `Detached HEAD ${facts.head.slice(0, 9)} is` : "The branch is";
        blockers.push({ kind: "unmerged", text: `${what} ${why} into ${facts.base ?? "the base"}` });
    }

    if (facts.statusError) {
        blockers.push({ kind: "status-error", text: `Uncommitted work unknown: ${facts.statusError}` });
    }

    if (facts.changedCount > 0) {
        blockers.push({
            kind: "changed",
            text: `${plural(facts.changedCount, "uncommitted change", "uncommitted changes")}: ${sample(facts.changed)}`,
        });
    }

    if (facts.untrackedCount > 0) {
        blockers.push({
            kind: "untracked",
            text: `${plural(facts.untrackedCount, "untracked entry", "untracked entries")}: ${sample(facts.untracked)}`,
        });
    }

    if (facts.stashes.length > 0) {
        blockers.push({ kind: "stash", text: `A stash names it: ${sample(facts.stashes)}` });
    }

    if (facts.processes.length > 0) {
        const names = facts.processes.map((p) => `${p.name} (${p.pid})`);
        blockers.push({ kind: "process", text: `Running in it: ${sample(names)}` });
    }

    if (facts.sessions.length > 0) {
        const names = facts.sessions.map((s) => `${s.provider} ${s.title ?? s.sessionId.slice(0, 8)}`);
        blockers.push({ kind: "session", text: `A recent agent session works here: ${sample(names)}` });
    } else if (facts.sessionsError) {
        blockers.push({
            kind: "session",
            text: `Agent sessions unreadable, none can be ruled out: ${facts.sessionsError}`,
        });
    }

    const recent = recentBlocker(facts, rules);

    if (recent) {
        blockers.push(recent);
    }

    return blockers;
}

/** `--older-than <days>`: only worktrees idle at least this long count as removable. */
export interface AgeRule {
    olderThanDays?: number;
    /** Epoch ms; tests pin it. */
    now?: number;
}

const DAY_MS = 86_400_000;

function recentBlocker(facts: WorktreeFacts, { olderThanDays = 0, now = Date.now() }: AgeRule): Blocker | null {
    if (olderThanDays <= 0) {
        return null;
    }

    const last = facts.lastActivityAt ?? facts.lastCommitAt;

    if (last === null) {
        return { kind: "recent", text: `Its age is unknown, so it cannot be shown older than ${olderThanDays} days` };
    }

    const days = (now - last) / DAY_MS;

    if (days >= olderThanDays) {
        return null;
    }

    const shown = days < 1 ? `${Math.max(0, Math.round(days * 24))} h` : `${Math.floor(days)} days`;
    return { kind: "recent", text: `Last activity ${shown} ago, newer than the ${olderThanDays}-day threshold` };
}

export function toRow(facts: WorktreeFacts, rules: AgeRule = {}): WorktreeCleanupRow {
    const blockers = cleanupBlockers(facts, rules);
    return { ...facts, removable: blockers.length === 0, blockers };
}

// ---------------------------------------------------------------------------
// Live users: processes and recent agent sessions whose folder is inside a worktree

export interface LiveUsers {
    processes: Array<{ pid: number; name: string; cwd: string }>;
    sessions: Array<LiveSession & { cwd: string }>;
    sessionsError: string | null;
}

/**
 * The canonical path, the way git prints worktree paths. A folder that is gone keeps its name under
 * its nearest existing parent's real path: `/tmp/x/gone` must still match git's `/private/tmp/x/gone`.
 */
function realpathOr(path: string): string {
    const absolute = resolve(path);

    try {
        return realpathSync(absolute);
    } catch (err) {
        const parent = dirname(absolute);

        if (parent === absolute) {
            return absolute;
        }

        log.debug({ err, path }, "realpath failed, resolving the nearest existing parent");
        return join(realpathOr(parent), basename(absolute));
    }
}

function inside(child: string, parent: string): boolean {
    return child === parent || child.startsWith(`${parent}/`);
}

/** The deepest worktree containing `cwd`: a worktree nested in another owns its own users. */
export function ownerOf(cwd: string, worktreePaths: string[]): string | null {
    let best: string | null = null;

    for (const path of worktreePaths) {
        if (inside(cwd, path) && (best === null || path.length > best.length)) {
            best = path;
        }
    }

    return best;
}

/** This process and its ancestors: the hub's own `tools` call must not count as a user. */
function ownLineage(): Set<number> {
    const own = new Set<number>();
    let pid: number | null = process.pid;

    while (pid !== null && pid > 1 && !own.has(pid) && own.size < 32) {
        own.add(pid);
        pid = readParentPid(pid);
    }

    return own;
}

/** One `ps`, then libproc for each cwd (microseconds each), plus the agent sessions of the last hour. */
export async function readLiveUsers({ liveMinutes }: { liveMinutes: number }): Promise<LiveUsers> {
    const own = ownLineage();
    const processes: LiveUsers["processes"] = [];

    for (const row of await listPsRows({ timeoutMs: 10_000 })) {
        if (own.has(row.pid)) {
            continue;
        }

        const cwd = readProcessCwd(row.pid);

        if (cwd && cwd !== "/") {
            processes.push({ pid: row.pid, name: processBasename(row.command), cwd });
        }
    }

    const cutoff = Date.now() - liveMinutes * 60_000;
    const hours = Math.max(1, Math.ceil(liveMinutes / 60));
    let sessions: LiveUsers["sessions"] = [];
    let sessionsError: string | null = null;

    try {
        sessions = (await listAgentSessionRows({ hours, withUsage: false, maxDiscoveryAgeMs: POLLED_LISTING_REUSE_MS }))
            .filter((row) => row.mtime >= cutoff && row.cwd)
            .map((row) => ({
                provider: row.provider,
                sessionId: row.sessionId,
                title: row.title,
                mtime: row.mtime,
                cwd: realpathOr(row.cwd),
            }));
    } catch (err) {
        log.warn({ err }, "agent sessions unreadable; every row stays blocked on the session rule");
        sessionsError = err instanceof Error ? err.message : String(err);
    }

    log.debug({ processes: processes.length, sessions: sessions.length, liveMinutes }, "live users read");
    return { processes, sessions, sessionsError };
}

// ---------------------------------------------------------------------------
// Per-repository facts

interface StashEntry {
    ref: string;
    firstParent: string;
    branch: string | null;
}

/** `On <branch>: msg` (git stash push -m) or `WIP on <branch>: <sha> <subject>`. */
export function stashBranch(subject: string): string | null {
    const match = /^(?:WIP on|On) (.+?): /.exec(subject);

    if (!match || match[1] === "(no branch)") {
        return null;
    }

    return match[1];
}

export function parseStashList(stdout: string): StashEntry[] {
    const entries: StashEntry[] = [];

    for (const line of stdout.split("\n")) {
        if (!line) {
            continue;
        }

        const [ref, parents, subject] = line.split("\0");
        entries.push({ ref, firstParent: (parents ?? "").split(" ")[0] ?? "", branch: stashBranch(subject ?? "") });
    }

    return entries;
}

/** A branch's own stashes; a detached worktree owns only detached-HEAD stashes made on its commit. */
export function stashesFor(stashes: StashEntry[], branch: string | null, head: string): string[] {
    return stashes
        .filter((s) => (branch !== null ? s.branch === branch : s.branch === null && s.firstParent === head))
        .map((s) => s.ref);
}

/** The worktree's own git dir, from its `.git` file. */
function worktreeGitDir(path: string): string | null {
    try {
        const text = readFileSync(`${path}/.git`, "utf8");
        const match = /^gitdir: (.+)$/m.exec(text);

        if (!match) {
            return null;
        }

        return isAbsolute(match[1]) ? match[1] : resolve(path, match[1]);
    } catch (err) {
        log.debug({ err, path }, "no readable .git file");
        return null;
    }
}

function mtimeMs(path: string): number | null {
    try {
        return statSync(path).mtimeMs;
    } catch (err) {
        log.debug({ err, path }, "no mtime");
        return null;
    }
}

interface StatusFacts {
    changed: string[];
    untracked: string[];
}

/** Tracked changes and untracked entries (folders collapsed); the status takes no optional locks. */
async function statusFacts(path: string): Promise<StatusFacts> {
    const { entries } = await createGit({ cwd: path }).status({ cwd: path, untracked: "normal", timeout: 60_000 });
    const untracked = entries.filter((e) => e.index === "?").map((e) => e.path);
    const changed = entries.filter((e) => e.index !== "?" && e.index !== "!").map((e) => e.path);
    return { changed, untracked };
}

/**
 * Ignored entries at the top of the worktree (node_modules, .env, dist): `git worktree remove`
 * deletes them without asking, so the confirmation names them. One `check-ignore` over the
 * top-level names; a full `status --ignored` walk cost 1.4 s per worktree (93 s for 68).
 */
async function ignoredTopLevel(path: string): Promise<string[]> {
    const names = readdirSync(path).filter((name) => name !== ".git");

    if (names.length === 0) {
        return [];
    }

    const res = await createGit({ cwd: path }).executor.exec(["check-ignore", "--", ...names], { cwd: path });

    // Exit 1 with no output means "nothing ignored"; anything on stderr is a real failure.
    if (!res.success && res.stderr.trim()) {
        throw new Error(`git check-ignore failed in ${path}: ${res.stderr.trim()}`);
    }

    return res.stdout.split("\n").filter(Boolean).sort();
}

async function commitEpochs(repoRoot: string, heads: string[]): Promise<Map<string, number>> {
    const epochs = new Map<string, number>();
    const unique = [...new Set(heads.filter(Boolean))];

    if (unique.length === 0) {
        return epochs;
    }

    const res = await createGit({ cwd: repoRoot }).executor.exec(["show", "-s", "--format=%H %ct", ...unique]);

    if (!res.success) {
        log.debug({ repoRoot, stderr: res.stderr }, "commit dates unreadable");
        return epochs;
    }

    for (const line of res.stdout.split("\n")) {
        const [sha, ct] = line.trim().split(" ");

        if (sha && ct) {
            epochs.set(sha, Number(ct) * 1000);
        }
    }

    return epochs;
}

export interface ScanOptions {
    /** Any folder inside each repository; several worktrees of one repository count once. */
    repos: string[];
    liveMinutes?: number;
    /** Judge every repository against this ref instead of its detected base. */
    base?: string;
    /** Only these worktree paths (the re-check before a removal). */
    only?: string[];
    /** Tests inject the live users; production reads them. */
    live?: LiveUsers;
    /** A worktree active more recently than this many days stays (blocker `recent`); 0 or absent: off. */
    olderThanDays?: number;
    /** Epoch ms for the age rule; tests pin it. */
    now?: number;
}

interface RepoScan {
    repoRoot: string;
    base: DetectedBase | null;
    facts: WorktreeFacts[];
    warnings: string[];
}

async function scanRepo({
    repoRoot,
    live,
    base: baseFlag,
    only,
}: {
    repoRoot: string;
    live: LiveUsers;
    base?: string;
    only?: Set<string>;
}): Promise<RepoScan> {
    const git = createGit({ cwd: repoRoot });
    const warnings: string[] = [];
    const all = await git.worktrees();
    const allPaths = all.map((w) => realpathOr(w.path));
    const entries = all.filter((w) => !w.isMain && !w.isBare && (!only || only.has(realpathOr(w.path))));

    if (entries.length === 0) {
        return { repoRoot, base: null, facts: [], warnings };
    }

    let base: DetectedBase | null = null;
    let baseError = "no base branch";

    try {
        const loaded = await loadRepoConfig(repoRoot);
        base = await detectBase({ cwd: repoRoot, flag: baseFlag, config: loaded.config });
    } catch (err) {
        baseError = `no base branch (${err instanceof Error ? err.message : String(err)})`;
        warnings.push(`${repoRoot}: ${baseError}`);
    }

    const stashRes = await git.executor.exec(["stash", "list", "--format=%gd%x00%P%x00%gs"]);
    const stashes = stashRes.success ? parseStashList(stashRes.stdout) : [];
    const epochs = await commitEpochs(
        repoRoot,
        entries.map((e) => e.head)
    );
    const ctx: CollectContext | null = base
        ? {
              repoRoot,
              // Empty on purpose: the verdict skips its own status call, statusFacts runs the one we need.
              worktrees: [],
              base,
              driver: null,
              wantPr: false,
              staleDays: 30,
              nowEpoch: Math.floor(Date.now() / 1000),
          }
        : null;
    const repo = realpathOr(repoRoot).split("/").pop() ?? repoRoot;

    const results = await mapPool(entries, ENTRY_CONCURRENCY, async (entry): Promise<WorktreeFacts> => {
        const path = realpathOr(entry.path);
        const present = existsSync(path);
        let verdict: Verdict | null = null;
        let how: How | null = null;
        let verdictError: string | null = base ? null : baseError;

        if (ctx) {
            try {
                const report = await collectRefReport(ctx, entry.branch ?? entry.head);
                verdict = report.verdict;
                how = report.how;
            } catch (err) {
                verdictError = err instanceof Error ? err.message : String(err);
            }
        }

        let status: StatusFacts = { changed: [], untracked: [] };
        let statusError: string | null = null;
        let ignored: string[] = [];
        // An unmerged branch stays whatever its tree holds, and the status walk is the scan's
        // cost (175 worktrees: 18 s with it on every row).
        const merged = verdict === "MERGED" || verdict === "EMPTY";

        if (present && merged) {
            try {
                status = await statusFacts(path);
                ignored = await ignoredTopLevel(path);
            } catch (err) {
                statusError = err instanceof Error ? err.message : String(err);
            }
        }

        const gitDir = present ? worktreeGitDir(path) : null;
        const commitAt = epochs.get(entry.head) ?? null;
        const activity = [
            commitAt,
            gitDir ? mtimeMs(`${gitDir}/logs/HEAD`) : null,
            gitDir ? mtimeMs(`${gitDir}/index`) : null,
        ].filter((v): v is number => v !== null);

        const facts: WorktreeFacts = {
            path,
            repoRoot,
            repo,
            branch: entry.branch,
            head: entry.head,
            present,
            locked: entry.locked,
            prunable: entry.prunable,
            verdict,
            how,
            verdictError,
            statusError,
            base: base?.ref ?? null,
            changedCount: status.changed.length,
            changed: status.changed.slice(0, SAMPLE),
            untrackedCount: status.untracked.length,
            untracked: status.untracked.slice(0, SAMPLE),
            ignored,
            stashes: stashesFor(stashes, entry.branch, entry.head),
            processes: live.processes
                .filter((p) => ownerOf(p.cwd, allPaths) === path)
                .map(({ pid, name }) => ({ pid, name })),
            sessions: live.sessions
                .filter((s) => ownerOf(s.cwd, allPaths) === path)
                .map(({ cwd: _cwd, ...rest }) => rest),
            sessionsError: live.sessionsError,
            lastCommitAt: commitAt,
            lastActivityAt: activity.length > 0 ? Math.max(...activity) : null,
        };
        return facts;
    });

    return { repoRoot, base, facts: results, warnings };
}

/** The main checkout of the repository holding `path`, or null outside git. */
async function mainCheckoutOf(path: string): Promise<string | null> {
    if (!existsSync(path)) {
        return null;
    }

    const res = await createGit({ cwd: path }).executor.exec([
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
    ]);

    if (!res.success) {
        return null;
    }

    const common = res.stdout.trim();
    return common.endsWith("/.git") ? realpathOr(dirname(common)) : realpathOr(common);
}

/**
 * The cleanup list: every linked worktree of the given repositories with its facts and the rules'
 * answer. Read-only: status runs without optional locks, nothing is fetched or written.
 */
export async function scanWorktrees(options: ScanOptions): Promise<WorktreeCleanupReport> {
    const started = performance.now();
    const liveMinutes = options.liveMinutes ?? DEFAULT_LIVE_MINUTES;
    const warnings: string[] = [];
    const roots = new Set<string>();

    for (const repo of options.repos) {
        const root = await mainCheckoutOf(repo);

        if (root) {
            roots.add(root);
        } else {
            warnings.push(`${repo}: not inside a git repository`);
        }
    }

    const live = options.live ?? (await readLiveUsers({ liveMinutes }));
    const only = options.only ? new Set(options.only.map(realpathOr)) : undefined;
    const scans = await mapPool([...roots], REPO_CONCURRENCY, async (repoRoot): Promise<RepoScan> => {
        try {
            return await scanRepo({ repoRoot, live, base: options.base, only });
        } catch (err) {
            log.warn({ err, repoRoot }, "worktree scan failed");
            return {
                repoRoot,
                base: null,
                facts: [],
                warnings: [`${repoRoot}: ${err instanceof Error ? err.message : String(err)}`],
            };
        }
    });

    const rows: WorktreeCleanupRow[] = [];
    const bases: WorktreeCleanupReport["bases"] = [];

    const rules: AgeRule = { olderThanDays: options.olderThanDays, now: options.now };

    for (const scan of scans) {
        rows.push(...scan.facts.map((facts) => toRow(facts, rules)));
        warnings.push(...scan.warnings);

        if (scan.base) {
            bases.push({
                repoRoot: scan.repoRoot,
                base: scan.base.ref,
                source: scan.base.source,
                detail: scan.base.detail,
            });
        }
    }

    rows.sort((a, b) => a.repo.localeCompare(b.repo) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
    const elapsedMs = Math.round(performance.now() - started);
    log.info(
        { repos: roots.size, rows: rows.length, removable: rows.filter((r) => r.removable).length, elapsedMs },
        "worktree cleanup scan"
    );
    return { rows, bases, warnings, elapsedMs };
}

/** `--base <ref>` that resolved in none of the scanned repositories: every row is "merge state unknown". */
export function unresolvedBase(report: WorktreeCleanupReport, base: string | undefined): string | null {
    if (!base || report.rows.length === 0 || report.bases.length > 0) {
        return null;
    }

    return `--base ${base} does not resolve in any scanned repository`;
}

// ---------------------------------------------------------------------------
// Removal

export interface RemoveOutcome {
    path: string;
    removed: boolean;
    /** Why it was refused or what git said; empty when removed. */
    reasons: string[];
    branch: string | null;
}

/**
 * Remove worktrees the rules still call removable, re-checked right before each removal. Only
 * `git worktree remove <path>`: never `--force`, never a recursive delete. The branch stays.
 */
export async function removeWorktrees({
    paths,
    liveMinutes,
    base,
    live,
    olderThanDays,
}: {
    paths: string[];
    liveMinutes?: number;
    base?: string;
    live?: LiveUsers;
    olderThanDays?: number;
}): Promise<RemoveOutcome[]> {
    const wanted = [...new Set(paths.map(realpathOr))];
    const fresh = await scanWorktrees({
        repos: wanted.map((p) => (existsSync(p) ? p : dirname(p))),
        liveMinutes,
        base,
        only: wanted,
        live,
        olderThanDays,
    });
    const byPath = new Map(fresh.rows.map((row) => [row.path, row]));
    const outcomes: RemoveOutcome[] = [];

    for (const path of wanted) {
        const row = byPath.get(path);

        if (!row) {
            const reason = existsSync(path)
                ? "Not a linked worktree of a known repository (the main checkout is never removed)"
                : "The folder does not exist; `git worktree prune` in its repository clears a stale entry";
            outcomes.push({ path, removed: false, reasons: [reason], branch: null });
            continue;
        }

        if (!row.removable) {
            outcomes.push({ path, removed: false, reasons: row.blockers.map((b) => b.text), branch: row.branch });
            continue;
        }

        const res = await createGit({ cwd: row.repoRoot }).executor.exec(["worktree", "remove", path], {
            cwd: row.repoRoot,
            timeout: WORKTREE_REMOVE_TIMEOUT_MS,
        });
        const gone = !existsSync(path);
        log.info({ path, branch: row.branch, success: res.success, gone, stderr: res.stderr }, "git worktree remove");
        outcomes.push({
            path,
            removed: res.success && gone,
            reasons: res.success && gone ? [] : [res.stderr.trim() || "git worktree remove failed"],
            branch: row.branch,
        });
    }

    return outcomes;
}

// ---------------------------------------------------------------------------
// Move aside: the repository's no-delete convention for a worktree that may go

export interface MoveAsideOutcome {
    path: string;
    moved: boolean;
    /** Where it went; null when it stayed. */
    to: string | null;
    /** The command that puts it back (git keeps it a working worktree at its new place). */
    restore: string | null;
    /** Why it stayed; empty when moved. */
    reasons: string[];
    branch: string | null;
    /** Set when the move worked but its journal line did not: `restore` is then the only record. */
    journalError?: string;
}

/** One line of `moved-aside.jsonl`: what went where, and how to put it back. */
export interface MoveAsideRecord {
    from: string;
    to: string;
    repoRoot: string;
    branch: string | null;
    head: string;
    restore: string;
    at: string;
}

function pad(value: number): string {
    return String(value).padStart(2, "0");
}

/** `/tmp/<YYYYMMDD>-agents-removals/hub-worktrees`: the day's move-aside folder, cleared at reboot. */
export function moveAsideRoot(now = new Date()): string {
    return join(
        "/tmp",
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-agents-removals`,
        "hub-worktrees"
    );
}

export function moveAsideJournalPath(): string {
    return join(new Storage("hub").getBaseDir(), "moved-aside.jsonl");
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The first of `<base>`, `<base>-2`, `<base>-3`… that does not exist yet. */
function freeDestination(base: string): string {
    let candidate = base;

    for (let n = 2; existsSync(candidate); n++) {
        candidate = `${base}-${n}`;
    }

    return candidate;
}

/** Same filesystem, so the move is a rename: a move across volumes would copy gigabytes instead. */
function sameVolume(a: string, b: string): boolean {
    try {
        return statSync(a).dev === statSync(b).dev;
    } catch (err) {
        log.debug({ err, a, b }, "volume check failed; treating as different volumes");
        return false;
    }
}

/**
 * Move the worktrees the rules still call removable into the day's move-aside folder with
 * `git worktree move`, re-checked right before each move. Nothing is deleted: git keeps each one a
 * working worktree at its new path (branch, index and ignored files included), `restore` moves it
 * back, and the space returns when the machine clears /tmp. Refuses a move across volumes.
 */
export async function moveAsideWorktrees({
    paths,
    liveMinutes,
    base,
    live,
    olderThanDays,
    destRoot = moveAsideRoot(),
    journal = moveAsideJournalPath(),
    now = new Date(),
}: {
    paths: string[];
    liveMinutes?: number;
    base?: string;
    live?: LiveUsers;
    olderThanDays?: number;
    destRoot?: string;
    journal?: string;
    now?: Date;
}): Promise<MoveAsideOutcome[]> {
    const wanted = [...new Set(paths.map(realpathOr))];
    const fresh = await scanWorktrees({
        repos: wanted.map((p) => (existsSync(p) ? p : dirname(p))),
        liveMinutes,
        base,
        only: wanted,
        live,
        olderThanDays,
        now: now.getTime(),
    });
    const byPath = new Map(fresh.rows.map((row) => [row.path, row]));
    const outcomes: MoveAsideOutcome[] = [];

    for (const path of wanted) {
        const row = byPath.get(path);
        const stay = (reasons: string[], branch: string | null = row?.branch ?? null) =>
            outcomes.push({ path, moved: false, to: null, restore: null, reasons, branch });

        if (!row) {
            stay([
                existsSync(path)
                    ? "Not a linked worktree of a known repository (the main checkout never moves)"
                    : "The folder does not exist",
            ]);
            continue;
        }

        if (!row.removable) {
            stay(row.blockers.map((blocker) => blocker.text));
            continue;
        }

        const parent = join(destRoot, row.repo);
        mkdirSync(parent, { recursive: true });

        if (!sameVolume(path, parent)) {
            stay([`${parent} is on another volume: a move there would copy the whole folder, so it stays`]);
            continue;
        }

        const to = freeDestination(join(realpathOr(parent), basename(path)));
        const res = await createGit({ cwd: row.repoRoot }).executor.exec(["worktree", "move", path, to], {
            cwd: row.repoRoot,
            timeout: WORKTREE_REMOVE_TIMEOUT_MS,
        });
        const moved = res.success && existsSync(to) && !existsSync(path);
        log.info(
            { path, to, branch: row.branch, success: res.success, moved, stderr: res.stderr },
            "git worktree move"
        );

        if (!moved) {
            stay([res.stderr.trim() || "git worktree move failed"]);
            continue;
        }

        const restore = `git -C ${shellQuote(row.repoRoot)} worktree move ${shellQuote(to)} ${shellQuote(path)}`;
        const record: MoveAsideRecord = {
            from: path,
            to,
            repoRoot: row.repoRoot,
            branch: row.branch,
            head: row.head,
            restore,
            at: now.toISOString(),
        };

        let journalError: string | undefined;

        try {
            mkdirSync(dirname(journal), { recursive: true });
            appendFileSync(journal, `${SafeJSON.stringify(record)}\n`);
        } catch (err) {
            journalError = err instanceof Error ? err.message : String(err);
            log.warn(
                { err, journal },
                "move-aside journal write failed; the outcome still carries the restore command"
            );
        }

        outcomes.push({
            path,
            moved: true,
            to,
            restore,
            reasons: [],
            branch: row.branch,
            ...(journalError ? { journalError } : {}),
        });
    }

    return outcomes;
}

// ---------------------------------------------------------------------------
// Disk size (the `tools du` core)

export interface WorktreeSize {
    path: string;
    /** Clone-deduplicated allocated bytes inside the worktree (what `tools du` reports). */
    bytes: number;
    /** The floor of what removing it frees: bytes no clone elsewhere shares. */
    freeableBytes: number | null;
    files: number;
    elapsedMs: number;
    error?: string;
}

/**
 * One clone-aware scan per worktree through the `tools du` C core (bun:ffi, its own threads).
 * Other worktrees nested inside are excluded. Sequential on purpose: each scan already uses
 * every core, and two at once only fight over the disk.
 */
export async function worktreeSizes(paths: string[]): Promise<WorktreeSize[]> {
    const storage = new Storage("du");
    await storage.ensureDirs();
    const cacheDir = storage.getCacheDir();
    const sizes: WorktreeSize[] = [];

    for (const given of paths) {
        const path = realpathOr(given);
        const started = performance.now();

        if (!existsSync(path)) {
            // The du core reports an empty tree for a missing folder: 0 bytes would read as measured.
            sizes.push({
                path,
                bytes: 0,
                freeableBytes: null,
                files: 0,
                elapsedMs: 0,
                error: "The folder does not exist",
            });
            continue;
        }

        try {
            const exclude = await detectWorktreeExcludes(path);
            // Half the cores: the hub keeps drawing (and agents keep building) while sizes fill in.
            const threads = Math.max(2, Math.floor(availableParallelism() / 2));
            const result = scanWithCFfi({ path, exclude, freeable: true, cacheDir, threads });
            sizes.push({
                path,
                bytes: result.unique_allocated_bytes ?? result.unique_bytes,
                freeableBytes: result.private_sum_bytes ?? null,
                files: result.files_scanned,
                elapsedMs: Math.round(performance.now() - started),
            });
        } catch (err) {
            log.warn({ err, path }, "worktree size scan failed");
            sizes.push({
                path,
                bytes: 0,
                freeableBytes: null,
                files: 0,
                elapsedMs: Math.round(performance.now() - started),
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    log.info({ count: sizes.length, ms: sizes.map((s) => s.elapsedMs) }, "worktree sizes");
    return sizes;
}
