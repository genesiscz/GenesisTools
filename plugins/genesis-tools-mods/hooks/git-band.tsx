// The git band: one line above the prompt per checkout the session works in (`checkouts.ts`: the ones it wrote
// files in or changed git state in, the last first, up to `mods.git.checkouts`), each with the branch, unpushed and
// unpulled commits, the dirty count, and the pull requests that matter there (the branch's, plus the ones
// `/mod-git pr add` tracks) with their CI counts. A session that has worked in no checkout yet shows its own
// folder; `mods.git.cwd: always` shows that folder first in every session. It refreshes when the session starts,
// after a Bash call that ran git or gh, after a call that works in another checkout, every 3 minutes, and on
// `/mod-git refresh`; `gh` answers are reused for 2 minutes. `/mod-git on|off|toggle` switches it for this
// session, `mods.git.enabled` for every session. Each refresh and command goes to `mods-log/git.jsonl`.
//
// `/mod-git add <folder>` (the prompt's typeahead proposes folders, zoxide's too) and the sidebar's field put any
// checkout in this session's band; `remove` takes it out, the sidebar's `hide` drops a worked-in one until the
// session works there again. A PR's `track` keeps it in its checkout's row after a branch switch; the branch's own
// PR shows anyway, so its `hide` is what takes it out of the band.
//
// With `mods.git.earlier: show` (the default) the work stays visible after it left the checkout: a branch the session
// made, pushed or worked on there and then switched away from keeps its PR in the row, and a worktree the session
// removed keeps its row (`worktree removed`), with its branch and PRs read in the main checkout. A row is named by
// `mods.git.name`: `Kalendora/enhancements` for a linked worktree (`repo-folder`), `Kalendora`, or `enhancements`.
import type { ElementTable, RenderElement, ToolCallInput } from "claude-code";
import type { BandCheck, BandPr, GitBand, GitBandRows, GitBandSwitch } from "../types";
import {
    addCheckout,
    addedCheckouts,
    type FolderSuggestion,
    folderSuggestions,
    headOf,
    hideCheckout,
    isBranchName,
    noteToolCall,
    pickRoots,
    removeAdded,
    sessionCheckouts,
    type Touch,
} from "./checkouts";
import { type GenesisProbe, genesisProbe, hubLink } from "./genesis";
import { liveAgo } from "./live";
import { type Feature, type Host, isRecord, logMod, settingsOf } from "./shared";
import { sharedRun } from "./shared-run";
import {
    actionButton,
    buttonsWidth,
    divider,
    type Kit,
    line,
    listRow,
    type Pressable,
    plural,
    pressed,
    sidebarFrame,
    wrapWords,
} from "./sidebar";

export const GIT_PANE = "mods-git";

/** The last refresh, one row per checkout; empty until one finished. */
let rows: GitBandRows = [];
/** The git root of the session's own folder at the last refresh. */
let ownRoot: string | undefined;
/** `/mod-git on|off` for this session; null follows `mods.git.enabled`. */
let turnedOn: GitBandSwitch = null;

const GH_TTL_MS = 2 * 60_000;
const GH_TTL_S = String(GH_TTL_MS / 1000);

/** The `checks` array of a `tools github pr --include checks` answer, as `gh pr checks --json` prints it. */
function checksText(stdout: string): string {
    try {
        const answer: unknown = JSON.parse(stdout);

        return isRecord(answer) && Array.isArray(answer.checks) ? JSON.stringify(answer.checks) : "";
    } catch {
        return "";
    }
}
const EVERY_MS = 3 * 60_000;
/** The earlier branches of a checkout whose PRs a row looks up, the last first. */
const EARLIER_PRS = 3;
const ghCache = new Map<string, { at: number; ttlMs: number; pr: BandPr | null }>();
/**
 * How long a branch's PR answer holds. An open PR keeps `GH_TTL_MS` (pushes and CI move it); a branch with no PR, or a
 * merged or closed one, changes rarely: on 2026-10-27, 90 of 133 shared answers were "no PR", each asked again every
 * 2 minutes by 21 sessions. The band's refresh press and `/mod-git refresh` still read them at once.
 */
const GH_NO_PR_TTL_MS = 10 * 60_000;
const GH_CLOSED_TTL_MS = 30 * 60_000;

function prTtl(pr: BandPr | null): number {
    if (!pr) {
        return GH_NO_PR_TTL_MS;
    }

    return pr.state === "OPEN" ? GH_TTL_MS : GH_CLOSED_TTL_MS;
}

function parsedPr(text: string | undefined, viaTools: boolean, tracked: boolean): BandPr | null {
    try {
        const answer: unknown = text ? JSON.parse(text) : undefined;
        const parsed: unknown = viaTools && isRecord(answer) ? answer.pr : answer;

        if (isRecord(parsed) && typeof parsed.number === "number") {
            return {
                number: parsed.number,
                title: String(parsed.title ?? ""),
                url: String(parsed.url ?? ""),
                state: String(parsed.state ?? ""),
                draft: parsed.isDraft === true,
                tracked,
                own: false,
                hidden: false,
                ...checkCounts(parsed.statusCheckRollup),
                checks: checksOf(parsed.statusCheckRollup),
            };
        }
    } catch {
        return null;
    }

    return null;
}
let refreshing: Promise<void> | undefined;
let requestedRefresh = 0;
let completedRefresh = 0;
/** Checkouts a tool call changed since the last refresh: the next refresh asks git fresh for these only. */
const changedRoots = new Set<string>();
/** A tool call's refresh waiting for the gap below; the 5 s tick or the next tool call starts it. */
let toolRefreshDue: "tool" | "checkout" | undefined;
let lastToolRefreshAt = 0;
/**
 * One refresh after tool calls per this gap. On 2026-10-27 one session with subagents refreshed every row on each of
 * its git commands, 219 times in 30 minutes (444 `git status` runs), because every subagent's call reaches this hook.
 */
const TOOL_REFRESH_GAP_MS = 10_000;
const TOOLS_THAT_WRITE = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash"]);

async function run(host: Host, argv: string[], cwd: string): Promise<string | undefined> {
    const done = await host.run(argv, { cwd, timeoutMs: 15_000 }).catch(() => undefined);

    return done?.exitCode === 0 ? done.stdout : undefined;
}

async function cwdRoot(host: Host): Promise<string | undefined> {
    const cwd = await host.cwd();

    return (await run(host, ["git", "rev-parse", "--show-toplevel"], cwd))?.trim() || undefined;
}

/** The checkouts the band shows now, with why: the added ones, then the ones the session worked in, the last first. */
async function bandRoots(host: Host): Promise<{ root: string; why: GitBand["why"] }[]> {
    ownRoot = await cwdRoot(host);
    const settings = (await settingsOf(host)).git;
    const all = await sessionCheckouts(host);
    // With `earlier: hide` a removed worktree takes no row, so it leaves its place to one that is there.
    const there = await Promise.all(all.map((touch) => host.exists(touch.root).catch(() => true)));
    const touches = settings.earlier === "show" ? all : all.filter((_, index) => there[index]);
    const added = await addedCheckouts(host);

    return pickRoots(touches, ownRoot, settings, added).map((root) => ({
        root,
        why: added.includes(root) ? "added" : touches.some((touch) => touch.root === root) ? "worked" : "folder",
    }));
}

/** The checkout `/mod-git pr` acts on: the band's first row. */
async function firstRoot(host: Host): Promise<string | undefined> {
    return rows[0]?.root ?? (await bandRoots(host))[0]?.root;
}

/** A path with the home as `~`. */
function tilde(path: string, home: string | undefined): string {
    return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** A checkout's folder name: `shop-web-marketplace-2.0-poc`. */
export function checkoutName(root: string): string {
    return root.slice(root.lastIndexOf("/") + 1) || root;
}

/**
 * A row's name by `mods.git.name`: `repo-folder` gives a linked worktree as `Kalendora/enhancements` and a main
 * checkout as `Kalendora`; `repo` gives the main checkout's name alone; `folder` the checkout's own folder.
 */
export function labelOf(band: Pick<GitBand, "root" | "repo">, name: "repo-folder" | "repo" | "folder"): string {
    const folder = checkoutName(band.root);
    const repo = band.repo ? checkoutName(band.repo) : folder;

    if (name === "folder") {
        return folder;
    }

    return name === "repo" || repo === folder ? repo : `${repo}/${folder}`;
}

const storeKey = (root: string) => `git-band-prs:${root}`;

const hiddenKey = (root: string) => `git-band-hidden-prs:${root}`;

async function numbersAt(host: Host, key: string): Promise<number[]> {
    const held = await host.storeGet(key);

    return Array.isArray(held) ? held.filter((n): n is number => typeof n === "number") : [];
}

export function trackedPrs(host: Host, root: string): Promise<number[]> {
    return numbersAt(host, storeKey(root));
}

/** The branch PRs the sidebar's `hide` took out of a checkout's band row. */
function hiddenPrs(host: Host, root: string): Promise<number[]> {
    return numbersAt(host, hiddenKey(root));
}

const PASSED = ["SUCCESS", "NEUTRAL", "SKIPPED"];
const FAILED = ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"];

/** Each check of `statusCheckRollup`: a check run has `name` and `conclusion`, a commit status `context` and `state`. */
export function checksOf(rollup: unknown): BandCheck[] {
    return (Array.isArray(rollup) ? rollup : []).filter(isRecord).map((check) => {
        const verdict = String(check.conclusion || check.state || "").toUpperCase();

        return {
            name: String(check.name || check.context || "check"),
            verdict: PASSED.includes(verdict) ? "pass" : FAILED.includes(verdict) ? "fail" : "pending",
            description: typeof check.description === "string" ? check.description : "",
            link: String(check.detailsUrl || check.targetUrl || ""),
        };
    });
}

/**
 * The checks out of `gh pr checks --json name,description,link,bucket`: one per check (a re-run counts once), with
 * the description a commit status carries, which `statusCheckRollup` leaves out. Undefined when it is not that list.
 */
export function prChecksOf(stdout: string): BandCheck[] | undefined {
    let parsed: unknown;

    try {
        parsed = JSON.parse(stdout);
    } catch {
        return undefined;
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
        return undefined;
    }

    return parsed.filter(isRecord).map((check) => {
        const bucket = String(check.bucket ?? "");

        return {
            name: String(check.name || "check"),
            verdict: bucket === "fail" || bucket === "cancel" ? "fail" : bucket === "pending" ? "pending" : "pass",
            description: typeof check.description === "string" ? check.description : "",
            link: typeof check.link === "string" ? check.link : "",
        };
    });
}

/** CI counts out of a list of checks. */
export function countChecks(checks: readonly BandCheck[]): { passed: number; failed: number; pending: number } {
    return {
        passed: checks.filter((check) => check.verdict === "pass").length,
        failed: checks.filter((check) => check.verdict === "fail").length,
        pending: checks.filter((check) => check.verdict === "pending").length,
    };
}

/** CI counts out of `statusCheckRollup`. */
export function checkCounts(rollup: unknown): { passed: number; failed: number; pending: number } {
    return countChecks(checksOf(rollup));
}

/**
 * A PR from `gh pr view` in `root`: `which` is a number or a branch, or "" for the checked-out branch, whose answer is
 * kept under `branch` so a switch does not show the last branch's PR for the next 2 minutes.
 */
async function prOf(
    host: Host,
    ask: { root: string; which: string; tracked: boolean; branch?: string }
): Promise<BandPr | null> {
    const { root, which, tracked } = ask;
    const key = `${root}|${which || `@${ask.branch ?? ""}`}`;
    const held = ghCache.get(key);

    if (held && Date.now() - held.at < held.ttlMs) {
        return held.pr ? { ...held.pr, tracked } : null;
    }

    // With the GenesisTools CLI, `tools github pr --include` answers from a cache every tool on the Mac shares;
    // without it, gh. Either way the plugin's own shared file serves every session for the TTL without a process.
    const viaTools = (await genesisProbe(host)).tools && (which || ask.branch);
    const fields = "number,title,url,state,isDraft,statusCheckRollup";
    const argv = viaTools
        ? ["tools", "github", "pr", which || String(ask.branch), "--include", fields, "--max-cache-age", GH_TTL_S]
        : ["gh", "pr", "view", ...(which ? [which] : []), "--json", fields];
    // The longest hold first; an answer that turns out to be an open PR is read again under the short one, which
    // reruns the command only when the shared file is older than that.
    const run = { argv, cwd: root, timeoutMs: 15_000 };
    let viewed = await sharedRun(host, { ...run, ttlMs: GH_CLOSED_TTL_MS });
    let pr = viewed?.exitCode === 0 ? parsedPr(viewed.stdout, Boolean(viaTools), tracked) : null;

    if (!viewed || viewed.exitCode !== 0 || prTtl(pr) < GH_CLOSED_TTL_MS) {
        viewed = await sharedRun(host, { ...run, ttlMs: viewed?.exitCode === 0 ? prTtl(pr) : GH_TTL_MS });
        pr = viewed?.exitCode === 0 ? parsedPr(viewed.stdout, Boolean(viaTools), tracked) : null;
    }

    // A PR with a check to look at gets `gh pr checks`, which says why a status failed (`Deployment was blocked`)
    // and counts a re-run once. It exits 1 with a failed check and 8 with a pending one, so its exit code says nothing.
    if (pr && (pr.failed > 0 || pr.pending > 0)) {
        const done = await sharedRun(host, {
            argv: viaTools
                ? ["tools", "github", "pr", String(pr.number), "--include", "checks", "--max-cache-age", GH_TTL_S]
                : ["gh", "pr", "checks", String(pr.number), "--json", "name,description,link,bucket"],
            cwd: root,
            ttlMs: GH_TTL_MS,
            timeoutMs: 15_000,
        });
        const checks = done ? prChecksOf(viaTools ? checksText(done.stdout) : done.stdout) : undefined;

        if (checks) {
            pr = { ...pr, ...countChecks(checks), checks };
        }
    }

    ghCache.set(key, { at: Date.now(), ttlMs: viewed?.exitCode === 0 ? prTtl(pr) : GH_TTL_MS, pr });

    return pr;
}

/** `## branch...origin/branch [ahead 2, behind 1]` and one line per changed path, from `git status --porcelain --branch`. */
export function parseStatus(text: string): Pick<GitBand, "branch" | "ahead" | "behind" | "dirty"> {
    const [head = "", ...rest] = text.split("\n");
    const branch = /^## (?:No commits yet on )?([^.\s]+(?:\.(?!\.)[^.\s]*)*)/.exec(head)?.[1] ?? "?";

    return {
        branch: branch === "HEAD" ? "detached" : branch,
        ahead: Number(/ahead (\d+)/.exec(head)?.[1] ?? 0),
        behind: Number(/behind (\d+)/.exec(head)?.[1] ?? 0),
        dirty: rest.filter((row) => row.trim()).length,
    };
}

/** The line totals of `git diff --numstat HEAD`; a binary file (`-`) counts no lines. */
export function parseNumstat(text: string): Pick<GitBand, "added" | "removed"> {
    let added = 0;
    let removed = 0;

    for (const row of text.split("\n")) {
        const [plus = "", minus = ""] = row.split("\t");
        added += /^\d+$/.test(plus) ? Number(plus) : 0;
        removed += /^\d+$/.test(minus) ? Number(minus) : 0;
    }

    return { added, removed };
}

async function isOn(host: Host): Promise<boolean> {
    const held = turnedOn;

    return held ?? (await settingsOf(host)).git.enabled;
}

/**
 * The PRs a row shows: the branch's own (`which` names it, or "" for the checked-out branch), the tracked ones, then
 * the ones of the branches the session worked on in the checkout before (`touch.branches`), each marked `from`.
 */
async function rowPrs(
    host: Host,
    at: { cwd: string; root: string; which: string; branch: string; touch?: Touch }
): Promise<BandPr[]> {
    const tracked = await trackedPrs(host, at.root);
    const hidden = await hiddenPrs(host, at.root);
    const own = await prOf(host, { root: at.cwd, which: at.which, tracked: false, branch: at.branch });
    const others = await Promise.all(
        tracked
            .filter((n) => n !== own?.number)
            .map((n) => prOf(host, { root: at.cwd, which: String(n), tracked: true }))
    );
    const mine = own
        ? { ...own, own: true, tracked: tracked.includes(own.number), hidden: hidden.includes(own.number) }
        : null;
    const prs = [mine, ...others].filter((pr): pr is BandPr => pr !== null);
    const names = (at.touch?.branches ?? [])
        .filter((name) => name !== at.branch && isBranchName(name))
        .slice(0, EARLIER_PRS);
    const earlier = await Promise.all(names.map((name) => prOf(host, { root: at.cwd, which: name, tracked: false })));

    earlier.forEach((pr, index) => {
        if (pr && !prs.some((held) => held.number === pr.number)) {
            prs.push({ ...pr, from: names[index], hidden: hidden.includes(pr.number) });
        }
    });

    return prs;
}

/**
 * The row of a worktree the session removed: the branch it had last, that branch's PRs and the earlier ones, read in
 * the main checkout; null when the branch has no local ref and no PR left to show.
 */
async function goneRow(host: Host, root: string, touch: Touch): Promise<GitBand | null> {
    const branch = touch.branches?.[0];
    const repo = touch.repo;

    if (!branch || !repo || repo === root) {
        return null;
    }

    const ref = await run(
        host,
        ["git", "for-each-ref", "--format=%(refname:short)%09%(upstream:track)", `refs/heads/${branch}`],
        repo
    );
    const sync = ref?.split("\t")[1] ?? "";
    const prs = await rowPrs(host, { cwd: repo, root, which: branch, branch, touch });

    if (!ref?.trim() && prs.length === 0) {
        return null;
    }

    return {
        root,
        why: "worked",
        at: Date.now(),
        branch,
        ahead: Number(/ahead (\d+)/.exec(sync)?.[1] ?? 0),
        behind: Number(/behind (\d+)/.exec(sync)?.[1] ?? 0),
        dirty: 0,
        added: 0,
        removed: 0,
        prs,
        repo,
        gone: true,
    };
}

/**
 * One checkout's row: undefined when git cannot read it this time (the last row stays), null when its folder is gone
 * and there is nothing left to show.
 */
/**
 * The git answers of a timer's refresh are shared by every session that shows the checkout for this long; a refresh
 * after this session's own tool call or a press asks git and shares its answer. A shared hit starts no process: on
 * 2026-10-27, 26 sessions ran 3047 `git status` and 2420 `git diff` in two hours, mostly for the same checkouts, and a
 * `tools git status` would cost a Bun start (0.2-0.4 s on that Mac) for the 0.15-0.4 s git itself takes.
 */
const SHARED_GIT_MS = 30_000;

async function gitText(host: Host, argv: string[], root: string, shared: boolean): Promise<string | undefined> {
    const done = await sharedRun(host, { argv, cwd: root, ttlMs: shared ? SHARED_GIT_MS : 0, timeoutMs: 15_000 });

    return done?.exitCode === 0 ? done.stdout : undefined;
}

async function readRow(
    host: Host,
    root: string,
    why: GitBand["why"],
    shared: boolean
): Promise<GitBand | null | undefined> {
    const status = await gitText(host, ["git", "status", "--porcelain", "--branch"], root, shared);
    const earlier = (await settingsOf(host)).git.earlier === "show";
    const touch = earlier ? (await sessionCheckouts(host)).find((held) => held.root === root) : undefined;

    if (status === undefined) {
        if (await host.exists(root).catch(() => true)) {
            return undefined;
        }

        return touch ? goneRow(host, root, touch) : null;
    }

    const numstat = parseNumstat((await gitText(host, ["git", "diff", "--numstat", "HEAD"], root, shared)) ?? "");
    const state = parseStatus(status);
    const prs = await rowPrs(host, { cwd: root, root, which: "", branch: state.branch, touch });
    const { repo } = await headOf(host, root);

    return { root, why, at: Date.now(), ...state, ...numstat, prs, repo };
}

async function refreshNow(host: Host, why: string): Promise<void> {
    const started = Date.now();
    const roots = await bandRoots(host);
    // A timer reads the answers other sessions share; a tool's refresh asks git fresh only for the checkouts it
    // changed; a press or a command asks fresh for all.
    const fresh = new Set(changedRoots);
    changedRoots.clear();
    const shared = (root: string) => why === "timer" || why === "start" || (why === "tool" && !fresh.has(root));
    const read = await Promise.all(roots.map((at) => readRow(host, at.root, at.why, shared(at.root))));
    // A checkout git could not read this time keeps its last row; one whose folder is gone with nothing to show goes.
    const next = roots
        .map(({ root }, index) => {
            const row = read[index];

            return row === null ? undefined : (row ?? rows.find((held) => held.root === root));
        })
        .filter((row): row is GitBand => row !== undefined);

    rows = next;
    host.redraw();
    await logMod(host, "git", {
        event: "refresh",
        why,
        rows: next.map((band) => ({
            root: band.root,
            branch: band.branch,
            ahead: band.ahead,
            behind: band.behind,
            dirty: band.dirty,
            added: band.added,
            removed: band.removed,
            gone: band.gone,
            prs: band.prs.map((pr) => ({
                n: pr.number,
                from: pr.from,
                passed: pr.passed,
                failed: pr.failed,
                pending: pr.pending,
            })),
        })),
        ms: Date.now() - started,
    });
}

/** One reader at a time; a request made during a read also waits for a pass that includes that request. */
export async function refresh(host: Host, why: string): Promise<void> {
    const requested = ++requestedRefresh;

    while (completedRefresh < requested) {
        refreshing ??= (async () => {
            const through = requestedRefresh;
            await refreshNow(host, why);
            completedRefresh = through;
        })().finally(() => {
            refreshing = undefined;
        });
        await refreshing;
    }
}

const READ_ONLY_STEP =
    /^(?:cd|ls|cat|head|tail|wc|rg|grep|find|fd|echo|pwd|which|date|stat|file|du|df|jq|sort|uniq|tr|cut|true|sed -n|git (?:status|log|diff|show|rev-parse|branch --show-current|blame|ls-files|remote -v)|gh (?:pr|issue|run) (?:view|list|checks|diff)|tools (?:ts|json) )\b/;

/** Whether every step of a shell command only reads: `cd x && git status | head` does, `bun x.ts` might not. */
export function onlyReads(command: string): boolean {
    return command
        .split(/&&|\|\||[;|\n]/)
        .map((step) => step.trim().replace(/^git -C \S+ /, "git "))
        .filter(Boolean)
        .every((step) => READ_ONLY_STEP.test(step));
}

/** The shown checkouts a tool call can have changed: those holding a path it names, else the session's own. */
function rootsOfCall(e: ToolCallInput, cwdRoot: string | undefined): string[] {
    const text = JSON.stringify(e);
    const named = rows.map((row) => row.root).filter((root) => text.includes(root));

    return named.length > 0 ? named : cwdRoot ? [cwdRoot] : [];
}

/** Starts the waiting tool refresh once the gap since the last one has passed. */
function runDueToolRefresh(host: Host): void {
    if (!toolRefreshDue || Date.now() - lastToolRefreshAt < TOOL_REFRESH_GAP_MS) {
        return;
    }

    const why = toolRefreshDue;
    toolRefreshDue = undefined;
    lastToolRefreshAt = Date.now();
    backgroundRefresh(host, why);
}

function backgroundRefresh(host: Host, why: string): void {
    void refresh(host, why).catch(async (error: unknown) => {
        await logMod(host, "git", { event: "refresh-failed", why, error: String(error) });
        host.toast(`Could not refresh this session's checkouts: ${String(error)}`);
    });
}

const USAGE =
    "/mod-git [show] | on | off | toggle | refresh | status | add <folder> | remove <folder> | pr add <n…> | pr rm <n…> | pr list";

/** The answer to `/mod-git <args>`. */
async function command(host: Host, args: string): Promise<string> {
    const [verb = "show", sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);

    if (verb === "show") {
        await host.togglePane(GIT_PANE, "Git", "command");

        return "";
    }

    if (verb === "on" || verb === "off" || verb === "toggle") {
        const now = verb === "toggle" ? !(await isOn(host)) : verb === "on";
        turnedOn = now;
        host.redraw();

        if (now) {
            await refresh(host, "command");
        }

        return `Git band ${now ? "on" : "off"} for this session.`;
    }

    if (verb === "refresh") {
        ghCache.clear();
        await refresh(host, "command");

        return "Git band refreshed.";
    }

    if (verb === "add" || verb === "remove") {
        const folder = args.trim().slice(verb.length).trim();

        if (!folder) {
            return USAGE;
        }

        if (verb === "add") {
            const done = await addCheckout(host, folder);

            if ("error" in done) {
                return `Not added: ${done.error}.`;
            }

            await refresh(host, "add");

            return `${checkoutName(done.root)} (${done.root}) is in this session's git band.`;
        }

        const gone = await removeAdded(host, folder);
        const added = await addedCheckouts(host);

        if (!gone) {
            return `No added folder ${folder}. Added here: ${added.map(checkoutName).join(", ") || "none"}.`;
        }

        await refresh(host, "remove");

        return `${checkoutName(gone)} is out of this session's git band.`;
    }

    const root = await firstRoot(host);

    if (!root) {
        return "Not in a git repository.";
    }

    const where = checkoutName(root);

    if (verb === "pr") {
        const numbers = rest.map((n) => Number(n.replace(/^#/, ""))).filter((n) => Number.isInteger(n) && n > 0);
        const held = await trackedPrs(host, root);

        if (sub === "list" || sub === undefined) {
            return held.length
                ? `Tracked in ${where}: ${held.map((n) => `#${n}`).join(", ")}`
                : `No tracked PRs in ${where}.`;
        }

        if ((sub !== "add" && sub !== "rm") || numbers.length === 0) {
            return USAGE;
        }

        const next = sub === "add" ? [...new Set([...held, ...numbers])] : held.filter((n) => !numbers.includes(n));
        await host.storeSet(storeKey(root), next);
        await refresh(host, `pr ${sub}`);

        return `Tracked in ${where}: ${next.length ? next.map((n) => `#${n}`).join(", ") : "none"}`;
    }

    if (verb === "status") {
        const band = rows[0];
        const on = await isOn(host);
        const name = (await settingsOf(host)).git.name;
        const shown = rows.length ? `; checkouts ${rows.map((row) => labelOf(row, name)).join(", ")}` : "";

        return `Git band ${on ? "on" : "off"}; last refresh ${band ? new Date(band.at).toLocaleTimeString() : "never"}${shown}.`;
    }

    return USAGE;
}

export const gitBand: Feature = {
    async start(host) {
        host.every(EVERY_MS, () => {
            void isOn(host).then((yes) => {
                if (yes) {
                    backgroundRefresh(host, "timer");
                }
            });
        });
        // A burst of tool calls makes one refresh, at most one per gap, the last one after the burst.
        host.every(5_000, () => {
            runDueToolRefresh(host);
        });

        if (await isOn(host)) {
            backgroundRefresh(host, "start");
        }
    },
    commands: [
        {
            name: "mod-git",
            description:
                "The git band: no argument opens its sidebar; add <folder> and remove <folder> put a checkout in this session's band; on, off, toggle, refresh, status, pr add <n>, pr rm <n>, pr list",
            argumentHint: "add <folder>|remove <folder>|on|off|refresh|pr add <n>",
            async run(host, args) {
                try {
                    const text = await command(host, args);
                    await logMod(host, "git", { event: "command", args, answer: text });

                    return text ? { text } : {};
                } catch (error) {
                    await logMod(host, "git", { event: "command-failed", args, error: String(error) });
                    return { text: `Git command failed: ${String(error)}` };
                }
            },
        },
    ],
    sidebars: [{ id: GIT_PANE, title: "Git", draw: gitPane }],
    async autocomplete(host, e) {
        const head = /^\/mod-git\s+(add|remove)\s+/.exec(e.text);

        if (!head || e.start < head[0].length || !(await isOn(host))) {
            return [];
        }

        const home = await host.env("HOME");

        if (head[1] === "remove") {
            const needle = e.token.toLowerCase();

            return (await addedCheckouts(host))
                .filter((root) => root.toLowerCase().includes(needle))
                .map((root) => ({ text: root, label: tilde(root, home), description: "added to this session's band" }));
        }

        return (await folderSuggestions(host, e.token)).map((found) => ({
            text: found.path,
            label: tilde(found.path, home),
            description: `${found.isGit ? "git checkout" : "not in git"} · ${found.from}`,
        }));
    },
    async afterTool(host, e) {
        if (!(await isOn(host))) {
            return;
        }

        try {
            const moved = await noteToolCall(host, e);

            // Read, Grep, Glob and the like, and a shell command that only reads, change nothing git shows.
            if (!moved && (!TOOLS_THAT_WRITE.has(e.tool) || (e.tool === "Bash" && onlyReads(e.command)))) {
                return;
            }

            for (const root of rootsOfCall(e, ownRoot)) {
                changedRoots.add(root);
            }

            toolRefreshDue = moved || toolRefreshDue === "checkout" ? "checkout" : "tool";
            runDueToolRefresh(host);
        } catch (error) {
            await logMod(host, "git", { event: "checkout-failed", error: String(error) });
            host.toast(`Could not save or refresh this session's checkouts: ${String(error)}`);
        }
    },
};

function ciText(pr: BandPr): string {
    const parts = [
        pr.passed ? `✓${pr.passed}` : "",
        pr.failed ? `✗${pr.failed}` : "",
        pr.pending ? `…${pr.pending}` : "",
    ];

    return parts.filter(Boolean).join(" ") || "no CI";
}

function prColor(pr: BandPr): string {
    return pr.failed ? "red" : pr.pending ? "yellow" : pr.state === "MERGED" ? "magenta" : "green";
}

function prNote(pr: BandPr): string {
    return `${pr.draft ? " draft" : ""}${pr.state === "OPEN" ? "" : ` ${pr.state.toLowerCase()}`} ${ciText(pr)}`;
}

/** The hub link for a GitHub PR (`hub?pr=owner%2Frepo%23507`); undefined for another forge or where it opens nothing. */
export function hubUrlOf(probe: GenesisProbe, pr: Pick<BandPr, "url" | "number">): string | undefined {
    const slug = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(pr.url)?.[1];

    return slug ? hubLink(probe, { pr: `${slug}#${pr.number}` }) : undefined;
}

/** The share of the room left for the name and the branch that the checkout name may take when both cannot fit. */
const NAME_SHARE = 0.4;
/** The shortest a cut name or branch gets. */
const LABEL_MIN = 8;

/** `feat/2026-10-13-enhancements-unified` as `feat/2026-10-13…ements-unified` at 30. */
export function middleCut(text: string, max: number): string {
    if (text.length <= max) {
        return text;
    }

    const head = Math.ceil((max - 1) / 2);

    return `${text.slice(0, head)}…${text.slice(text.length - (max - 1 - head))}`;
}

/** Whether the rows name their checkout: always, unless the one row is the session's own folder. */
export function namesCheckouts(shown: readonly Pick<GitBand, "root">[], own: string | undefined): boolean {
    return shown.length > 1 || (shown.length === 1 && shown[0]?.root !== own);
}

/** Columns a text takes in the terminal: one per character, as every symbol the band draws is narrow. */
function widthOf(text: string): number {
    return [...text].length;
}

/**
 * The checkout name and the branch, cut to `room` columns together. Both fit whole when they can; else the name
 * keeps up to 40% of the room and the branch the rest, each keeping its start and end.
 */
export function fitLabels(name: string | undefined, branch: string, room: number): { name?: string; branch: string } {
    const nameWidth = name === undefined ? 0 : widthOf(name);

    if (nameWidth + widthOf(branch) <= room) {
        return { name, branch };
    }

    const nameRoom = name === undefined ? 0 : Math.min(nameWidth, Math.max(LABEL_MIN, Math.floor(room * NAME_SHARE)));

    return {
        name: name === undefined ? undefined : middleCut(name, nameRoom),
        branch: middleCut(branch, Math.max(LABEL_MIN, room - nameRoom)),
    };
}

/** The PRs a band row shows: all but the ones the sidebar's `hide` took out. */
function shownPrs(band: GitBand): BandPr[] {
    return band.prs.filter((pr) => !pr.hidden);
}

/** How much a band row says after the branch: words, signs only, or signs with bare PR numbers. */
type Wording = "full" | "signs" | "bare";

/** The texts after the branch, in order: unpushed and unpulled, the changed files, their lines, then each PR. */
function countsOf(band: GitBand, wording: Wording): { sync: string; dirty: string; lines: string; prs: string[] } {
    const words = wording === "full";

    return {
        sync: [
            band.ahead ? `↑${band.ahead}${words ? " to push" : ""}` : "",
            band.behind ? `↓${band.behind}${words ? " to pull" : ""}` : "",
        ]
            .filter(Boolean)
            .join(words ? " · " : " "),
        dirty: band.gone
            ? words
                ? "worktree removed"
                : "removed"
            : band.dirty
              ? words
                  ? `${plural(band.dirty, "file")} changed`
                  : `●${band.dirty}`
              : "clean",
        lines: band.dirty && (band.added || band.removed) ? `+${band.added} −${band.removed}` : "",
        prs: shownPrs(band).map((pr) => `#${pr.number}${wording === "bare" ? "" : prNote(pr)}`),
    };
}

/** The columns a row's counts take: one of gap before each part, then `⎇ ` and the space after a name. */
function countsWidth(counts: ReturnType<typeof countsOf>, named: boolean): number {
    const parts = [counts.sync, counts.dirty, counts.lines, ...counts.prs].filter(Boolean);

    return parts.reduce((sum, part) => sum + widthOf(part) + 1, 0) + 2 + (named ? 1 : 0);
}

/**
 * The fullest wording whose counts leave the name and the branch their shortest cut: words when they fit
 * (`mods.git.labels: full`), else signs (`↑27 ↓2 ●13`), else signs with the PRs as bare numbers.
 */
export function wordingFor(band: GitBand, room: number, named: boolean, labelled: boolean): Wording {
    const need = LABEL_MIN * (named ? 2 : 1);
    const tries: Wording[] = labelled ? ["full", "signs", "bare"] : ["signs", "bare"];

    return tries.find((wording) => room - countsWidth(countsOf(band, wording), named) >= need) ?? "bare";
}

/**
 * The band's git rows, one per checkout; none while the band is off or has nothing yet. Each row fits `columns`,
 * the first one less `firstReserve` (the hooks chip beside it): the counts keep their width, in words while they
 * fit, else in signs, and the checkout name and the branch are cut to what is left. A row still too wide is cut at
 * the right edge; nothing wraps. Each PR is a Button (it inverts under the pointer, so it reads as one) that opens
 * the Git sidebar; the sidebar opens the PR in the browser or the hub.
 */
export async function gitRows(
    host: Host,
    ui: ElementTable,
    room: { columns: number; firstReserve: number }
): Promise<RenderElement[]> {
    const shown = rows;

    if (shown.length === 0 || !(await isOn(host))) {
        return [];
    }

    const { Box, Button, Text } = ui;
    const git = (await settingsOf(host)).git;
    const labelled = git.labels === "full";
    const named = namesCheckouts(shown, ownRoot);
    const open = () => void host.togglePane(GIT_PANE, "Git");

    const widthAt = (index: number) => room.columns - (index === 0 ? room.firstReserve : 0);
    // Every row says its counts the same way: the shortest wording any row needs.
    const order: Wording[] = ["full", "signs", "bare"];
    const wording =
        order[
            Math.max(...shown.map((band, index) => order.indexOf(wordingFor(band, widthAt(index), named, labelled))))
        ] ?? "bare";

    return shown.map((band, index) => {
        const width = widthAt(index);
        const counts = countsOf(band, wording);
        const labels = fitLabels(
            named ? labelOf(band, git.name) : undefined,
            band.branch,
            width - countsWidth(counts, named)
        );

        return (
            <Box key={`git-${band.root}`} flexDirection="row" gap={1} overflow="hidden">
                <Box flexShrink={0}>
                    <Button key="git-branch" plain onPress={open}>
                        {labels.name === undefined ? null : <Text color="cyan">{`${labels.name} `}</Text>}
                        <Text dimColor>⎇ </Text>
                        <Text bold>{labels.branch}</Text>
                    </Button>
                </Box>
                {counts.sync ? (
                    <Text color="yellow" wrap="truncate-end">
                        {counts.sync}
                    </Text>
                ) : null}
                <Text color={band.dirty ? "magenta" : undefined} dimColor={!band.dirty} wrap="truncate-end">
                    {counts.dirty}
                </Text>
                {counts.lines ? (
                    <Text wrap="truncate-end">
                        <Text color="green">{`+${band.added}`}</Text>
                        <Text> </Text>
                        <Text color="red">{`−${band.removed}`}</Text>
                    </Text>
                ) : null}
                {shownPrs(band).map((pr) => (
                    <Box key={`pr-${pr.number}`} flexShrink={0}>
                        <Button key={`pr-${pr.number}`} plain onPress={open}>
                            <Text color={prColor(pr)} underline>{`#${pr.number}`}</Text>
                            {wording === "bare" ? null : <Text color={prColor(pr)}>{prNote(pr)}</Text>}
                        </Button>
                    </Box>
                ))}
            </Box>
        );
    });
}

/** What the add field holds, and the folders it proposes for it. */
let addQuery = "";
let addFound: FolderSuggestion[] = [];
let addAsked = 0;

async function proposeFolders(host: Host, typed: string): Promise<void> {
    const asked = ++addAsked;
    const found = await folderSuggestions(host, typed, 5);

    if (asked === addAsked) {
        addFound = found;
        host.redraw();
    }
}

/** Adds what the field holds: the folder typed, or else the first one proposed. */
async function addFolder(host: Host, typed: string): Promise<void> {
    try {
        await addFolderNow(host, typed);
    } catch (error) {
        await logMod(host, "git", { event: "add-failed", path: typed, error: String(error) });
        await pressed(host, "git-add", `Not added: ${String(error)}`, "error");
    }
}

async function addFolderNow(host: Host, typed: string): Promise<void> {
    const text = typed.trim();

    if (!text) {
        return;
    }

    await pressed(host, "git-add", `Adding ${text}…`, "busy");
    let done = await addCheckout(host, text);

    if ("error" in done && addFound[0]) {
        done = await addCheckout(host, addFound[0].path);
    }

    if ("error" in done) {
        await pressed(host, "git-add", `Not added: ${done.error}.`, "error");
        return;
    }

    addQuery = "";
    addFound = [];

    try {
        await refresh(host, "sidebar add");
    } catch (error) {
        await logMod(host, "git", { event: "refresh-failed", root: done.root, error: String(error) });
        await pressed(
            host,
            "git-add",
            `Added ${checkoutName(done.root)}, but refresh failed: ${String(error)}`,
            "error"
        );
        return;
    }

    await pressed(host, "git-add", `Added ${checkoutName(done.root)} (${done.root}) to this session's band.`);
}

/** Runs `open` on a URL or a folder and says how it went. */
async function openAndSay(host: Host, key: string, target: string, done: string): Promise<void> {
    const run = await host.openUrl(target).catch((error: unknown) => error);
    const code = isRecord(run) && typeof run.exitCode === "number" ? run.exitCode : -1;

    await pressed(host, key, code === 0 ? done : `open ${target} failed (exit ${code}).`, code === 0 ? "ok" : "error");
}

/** Why a checkout is in the band, in two or three words. */
function whyText(band: GitBand): string {
    return band.why === "added" ? "added by hand" : band.why === "worked" ? "worked in" : "own folder";
}

/** A checkout's state in short: `↑24 to push · ↓2 to pull · 16 changed +643 −1359`, or `clean`; zeros left out. */
function stateParts(band: GitBand): { text: string; color?: string }[] {
    const parts: { text: string; color?: string }[] = [];

    if (band.ahead) {
        parts.push({ text: `↑${band.ahead} to push`, color: "yellow" });
    }

    if (band.behind) {
        parts.push({ text: `↓${band.behind} to pull`, color: "yellow" });
    }

    if (band.dirty) {
        parts.push({ text: `${band.dirty} changed`, color: "magenta" });

        if (band.added || band.removed) {
            parts.push({ text: `+${band.added}`, color: "green" }, { text: `−${band.removed}`, color: "red" });
        }
    }

    if (band.gone) {
        parts.push({ text: "worktree removed" });
    }

    return parts.length ? parts : [{ text: "clean" }];
}

/** A sidebar toggle changes its row only after persistence succeeds, then reads git again. */
export async function toggle(
    host: Host,
    key: string,
    work: { busy: string; flip: () => void; store: () => Promise<unknown>; done: string }
): Promise<void> {
    await pressed(host, key, work.busy, "busy");

    try {
        await work.store();
    } catch (error) {
        await logMod(host, "git", { event: "toggle-failed", key, error: String(error) });
        await pressed(host, key, `Not saved: ${String(error)}`, "error");
        return;
    }

    work.flip();
    host.redraw();

    try {
        await refresh(host, "sidebar");
        await pressed(host, key, work.done);
    } catch (error) {
        await logMod(host, "git", { event: "refresh-failed", key, error: String(error) });
        await pressed(host, key, `Saved, but refresh failed: ${String(error)}`, "error");
    }
}

/** The Git sidebar's actions for one checkout: Finder while its folder is there, and remove or hide. */
function checkoutActions(host: Host, band: GitBand, at: string, name: string): Pressable[] {
    const finder: Pressable = {
        key: `${at}-finder`,
        label: "Finder",
        isDim: true,
        hint: `Show ${band.root} in Finder.`,
        onPress: () => void openAndSay(host, `${at}-finder`, band.root, `Opened ${band.root} in Finder.`),
    };

    if (band.why === "added") {
        return [
            finder,
            {
                key: `${at}-remove`,
                label: "remove",
                isDim: true,
                hint: `Take ${name} out of this session's band. You added it by hand.`,
                onPress: () =>
                    void toggle(host, `${at}-remove`, {
                        busy: `Removing ${name}…`,
                        flip: () => {
                            rows = rows.filter((row) => row.root !== band.root);
                        },
                        store: () => removeAdded(host, band.root),
                        done: `Removed ${name} from this session's band.`,
                    }),
            },
        ];
    }

    if (band.why === "worked") {
        return [
            ...(band.gone ? [] : [finder]),
            {
                key: `${at}-hide`,
                label: "hide",
                isDim: true,
                hint: `Hide ${name} until this session writes a file or changes git there again.`,
                onPress: () =>
                    void toggle(host, `${at}-hide`, {
                        busy: `Hiding ${name}…`,
                        flip: () => {
                            rows = rows.filter((row) => row.root !== band.root);
                        },
                        store: () => hideCheckout(host, band.root),
                        done: `Hid ${name}. It comes back when this session works there.`,
                    }),
            },
        ];
    }

    return [finder];
}

/** Flips one flag of one PR in the rows the band and the sidebar draw, before git is read again. */
function flipPr(root: string, n: number, flag: "tracked" | "hidden"): void {
    rows = rows.map((row) =>
        row.root === root
            ? { ...row, prs: row.prs.map((pr) => (pr.number === n ? { ...pr, [flag]: !pr[flag] } : pr)) }
            : row
    );
}

/** The Git sidebar's actions for one PR: open, hub, copy link, track or untrack, and hide or show for the branch's own. */
function prActions(host: Host, band: GitBand, pr: BandPr, at: string, lists: Lists): Pressable[] {
    const n = pr.number;
    const name = lists.label;
    const link = `[#${n} (${pr.title})](${pr.url})`;
    const hub = hubUrlOf(lists.probe, pr);
    const store = (key: string, list: number[], on: boolean) => async () => {
        await host.storeSet(key, on ? [...new Set([...list, n])] : list.filter((held) => held !== n));
        await logMod(host, "git", {
            event: key.startsWith("git-band-hidden") ? "hide" : "track",
            on,
            n,
            root: band.root,
        });
    };
    const trackHint = pr.own
        ? pr.tracked
            ? `Stop keeping #${n} after a branch switch. It still shows while ${band.branch} is checked out.`
            : `Keep #${n} in ${name}'s row even after ${name} switches to another branch.`
        : `Take #${n} out of ${name}'s row.`;
    const actions: Pressable[] = [
        {
            key: `${at}-open`,
            label: "open",
            isPrimary: true,
            hint: `Open #${n} in the browser: ${pr.url}`,
            onPress: () => void openAndSay(host, `${at}-open`, pr.url, `Opened #${n} in the browser.`),
        },
        ...(hub
            ? [
                  {
                      key: `${at}-hub`,
                      label: "hub",
                      hint: `Open #${n} in the GenesisTools hub.`,
                      onPress: () => void openAndSay(host, `${at}-hub`, hub, `Opened #${n} in the hub.`),
                  },
              ]
            : []),
        {
            key: `${at}-copy`,
            label: "copy link",
            isDim: true,
            hint: `Copy ${link}`,
            onPress: () =>
                void host
                    .copy(link)
                    .then((result) =>
                        pressed(
                            host,
                            `${at}-copy`,
                            result.isCopied ? `Copied ${link}` : `Not copied: ${result.reason}.`,
                            result.isCopied ? "ok" : "error"
                        )
                    ),
        },
    ];

    // An earlier branch's PR shows as long as the session remembers the branch; `hide` is what takes it out.
    if (!pr.from) {
        actions.push({
            key: `${at}-track`,
            label: pr.tracked ? "untrack" : "track",
            isDim: true,
            hint: trackHint,
            onPress: () =>
                void toggle(host, `${at}-track`, {
                    busy: pr.tracked ? `Untracking #${n}…` : `Tracking #${n}…`,
                    flip: () => flipPr(band.root, n, "tracked"),
                    store: store(storeKey(band.root), lists.tracked, !pr.tracked),
                    done: pr.tracked
                        ? pr.own
                            ? `#${n} is no longer kept after a branch switch.`
                            : `#${n} is out of ${name}'s row.`
                        : `#${n} stays in ${name}'s row after a branch switch.`,
                }),
        });
    }

    if (pr.own || pr.from) {
        actions.push({
            key: `${at}-hide`,
            label: pr.hidden ? "show" : "hide",
            isDim: true,
            hint: pr.hidden
                ? `Put #${n} back in the band.`
                : `Take #${n} out of the band. It stays listed here, with show.`,
            onPress: () =>
                void toggle(host, `${at}-hide`, {
                    busy: pr.hidden ? `Showing #${n}…` : `Hiding #${n}…`,
                    flip: () => flipPr(band.root, n, "hidden"),
                    store: store(hiddenKey(band.root), lists.hidden, !pr.hidden),
                    done: pr.hidden ? `#${n} is back in the band.` : `#${n} is out of the band.`,
                }),
        });
    }

    return actions;
}

/** Which checkouts the person opened or folded in the sidebar; the rest follow `mods.git.expand`. */
const opened = new Set<string>();
const folded = new Set<string>();

function isOpen(root: string, index: number, expand: "first" | "all" | "none"): boolean {
    if (opened.has(root)) {
        return true;
    }

    if (folded.has(root)) {
        return false;
    }

    return expand === "all" || (expand === "first" && index === 0);
}

/** What one checkout's sidebar lines read: the link probe, its PR lists, its name and the home for `~`. */
type Lists = { probe: GenesisProbe; tracked: number[]; hidden: number[]; label: string; home?: string };

/** A checkout's state in signs for its folded line: `↑24 ●16`, `clean`. */
function stateSigns(band: GitBand): { text: string; color?: string }[] {
    const parts: { text: string; color?: string }[] = [];

    if (band.ahead) {
        parts.push({ text: `↑${band.ahead}`, color: "yellow" });
    }

    if (band.behind) {
        parts.push({ text: `↓${band.behind}`, color: "yellow" });
    }

    if (band.dirty) {
        parts.push({ text: `●${band.dirty}`, color: "magenta" });
    }

    if (band.gone) {
        parts.push({ text: "removed" });
    } else if (parts.length === 0) {
        parts.push({ text: "clean" });
    }

    for (const pr of band.prs.filter((held) => !held.hidden)) {
        parts.push({ text: `#${pr.number} ${ciText(pr)}`, color: prColor(pr) });
    }

    return parts;
}

/**
 * A checkout's first line, one Button the width of the pane: the fold mark, its name and branch at the left, and at
 * the right why it is here (open) or its state in signs (folded). The branch gives way first when the line is full.
 */
function checkoutLine(
    host: Host,
    kit: Kit,
    band: GitBand,
    at: string,
    isOpenNow: boolean,
    name: string
): RenderElement {
    const { Button, Text } = kit.ui;
    const right = isOpenNow ? [{ text: whyText(band) }] : stateSigns(band);
    const rightText = right.map((part) => part.text).join(" ");
    const room = kit.columns - widthOf(rightText) - 1;
    const labels = fitLabels(name, band.branch, room - 3);
    const left = `${isOpenNow ? "▾" : "▸"} ${labels.name ?? name} ${labels.branch}`;
    const pad = " ".repeat(Math.max(1, kit.columns - widthOf(left) - widthOf(rightText)));
    const row: Pressable = {
        key: `${at}-fold`,
        label: name,
        hint: isOpenNow ? `Fold ${name} to one line.` : `Open ${name}: its state, its actions and its pull requests.`,
        onPress: () => {
            if (isOpenNow) {
                opened.delete(band.root);
                folded.add(band.root);
            } else {
                folded.delete(band.root);
                opened.add(band.root);
            }

            host.redraw();
        },
    };
    kit.pressables?.push(row);

    return line(
        kit,
        at,
        <Button key={row.key} plain onPress={row.onPress}>
            <Text dimColor>{isOpenNow ? "▾ " : "▸ "}</Text>
            <Text color="cyan" bold>{`${labels.name ?? name} `}</Text>
            <Text bold>{labels.branch}</Text>
            <Text>{pad}</Text>
            {right.map((part, index) => (
                <Text key={`r-${index}`} color={part.color} dimColor={!part.color}>
                    {`${index ? " " : ""}${part.text}`}
                </Text>
            ))}
        </Button>
    );
}

/** One failing or pending check, one line: its name, what it said, and a press that opens its page. */
function checkLine(host: Host, kit: Kit, check: BandCheck, key: string): RenderElement {
    const { Button, Text } = kit.ui;
    const failed = check.verdict === "fail";
    const row: Pressable = {
        key,
        label: check.name,
        hint: check.link ? `Open the ${check.name} check: ${check.link}` : `${check.name} has no page to open.`,
        onPress: () =>
            void (check.link
                ? openAndSay(host, key, check.link, `Opened the ${check.name} check.`)
                : pressed(host, key, `${check.name} has no page to open.`, "error")),
    };
    kit.pressables?.push(row);

    return line(
        kit,
        key,
        <Button key={key} plain onPress={row.onPress}>
            <Text>{"    "}</Text>
            <Text color={failed ? "red" : "yellow"}>{`${failed ? "✗" : "…"} ${check.name}`}</Text>
            {check.description ? <Text dimColor>{` · ${check.description}`}</Text> : null}
        </Button>
    );
}

/** A row of Buttons, indented, as the lines it takes: wrapped the way flex wraps them, greedily. */
function buttonLines(kit: Kit, actions: Pressable[], key: string, indent: number): RenderElement[] {
    const { Box } = kit.ui;
    const room = kit.columns - indent;
    const rowsOf: Pressable[][] = [];

    for (const action of actions) {
        const last = rowsOf.at(-1);

        if (last && buttonsWidth([...last, action]) <= room) {
            last.push(action);
        } else {
            rowsOf.push([action]);
        }
    }

    return rowsOf.map((held, index) =>
        line(
            kit,
            `${key}-${index}`,
            <Box paddingLeft={indent} flexDirection="row" columnGap={1}>
                {held.map((action) => actionButton(kit, action))}
            </Box>
        )
    );
}

/** One PR under its open checkout, as lines: number and title (two lines at most), its state, its checks, its actions. */
function prLines(host: Host, kit: Kit, band: GitBand, pr: BandPr, at: string, lists: Lists): RenderElement[] {
    const { Text } = kit.ui;
    const failing = pr.checks.filter((check) => check.verdict === "fail");
    const pending = pr.checks.filter((check) => check.verdict === "pending");
    const why = [
        pr.own ? "this branch's PR" : pr.from ? "earlier branch" : "tracked",
        pr.own && pr.tracked ? "kept after a switch" : "",
        pr.hidden ? "hidden from the band" : "",
    ]
        .filter(Boolean)
        .join(" · ");
    const number = `#${pr.number} `;
    const titleLines = wrapWords(`${number}${pr.title}`, kit.columns - 2, 2);
    const out: RenderElement[] = [line(kit, `${at}-gap`, null)];

    titleLines.forEach((text, index) => {
        out.push(
            line(
                kit,
                `${at}-title-${index}`,
                index === 0 ? (
                    <Text>
                        <Text>{"  "}</Text>
                        <Text color={prColor(pr)} bold>
                            {number}
                        </Text>
                        <Text bold={!pr.hidden} dimColor={pr.hidden}>
                            {text.slice(number.length)}
                        </Text>
                    </Text>
                ) : (
                    <Text bold={!pr.hidden} dimColor={pr.hidden}>{`  ${text}`}</Text>
                )
            )
        );
    });
    out.push(
        line(
            kit,
            `${at}-state`,
            <Text dimColor>{`  ${pr.state.toLowerCase()}${pr.draft ? " draft" : ""} · ${ciText(pr)} · ${why}`}</Text>
        )
    );

    // Its own line, since a sidebar is too narrow to keep a branch name at the end of the state line.
    if (pr.from) {
        const from = middleCut(pr.from, Math.max(LABEL_MIN, kit.columns - 9));
        out.push(line(kit, `${at}-from`, <Text dimColor>{`  branch ${from}`}</Text>));
    }
    failing.forEach((check, index) => {
        out.push(checkLine(host, kit, check, `${at}-fail-${index}`));
    });
    pending.slice(0, 3).forEach((check, index) => {
        out.push(checkLine(host, kit, check, `${at}-pending-${index}`));
    });

    if (pending.length > 3) {
        out.push(line(kit, `${at}-more`, <Text dimColor>{`    … ${pending.length - 3} more pending`}</Text>));
    }

    out.push(...buttonLines(kit, prActions(host, band, pr, at, lists), `${at}-actions`, 2));

    return out;
}

/** An open checkout's lines under its first one: its state with its actions at the right, then its PRs. */
function openLines(host: Host, kit: Kit, band: GitBand, at: string, lists: Lists): RenderElement[] {
    const { Box, Text } = kit.ui;
    const actions = checkoutActions(host, band, at, lists.label);
    const state = stateParts(band);
    const stateWidth = widthOf(state.map((part) => part.text).join(" ")) + 2;
    const fits = stateWidth + 1 + buttonsWidth(actions) <= kit.columns;
    const stateText = (
        <Box flexShrink={1} minWidth={0}>
            <Text wrap="truncate-end">
                <Text>{"  "}</Text>
                {state.map((part, index) => (
                    <Text key={`s-${index}`} color={part.color} dimColor={!part.color}>
                        {`${index ? " " : ""}${part.text}`}
                    </Text>
                ))}
            </Text>
        </Box>
    );
    const out: RenderElement[] = fits
        ? [
              line(
                  kit,
                  `${at}-state`,
                  <Box flexDirection="row" flexGrow={1}>
                      {stateText}
                      <Box flexGrow={1} />
                      <Box flexDirection="row" columnGap={1} flexShrink={0}>
                          {actions.map((action) => actionButton(kit, action))}
                      </Box>
                  </Box>
              ),
          ]
        : [line(kit, `${at}-state`, stateText), ...buttonLines(kit, actions, `${at}-actions`, 2)];

    // A linked worktree says where it is, since its name alone does not (`/tmp/cc/<project>/<session>/worktrees/x`).
    if (band.repo && band.repo !== band.root) {
        const where = band.gone ? "was at" : "worktree at";
        const path = middleCut(tilde(band.root, lists.home), Math.max(LABEL_MIN, kit.columns - where.length - 3));
        out.push(line(kit, `${at}-where`, <Text dimColor>{`  ${where} ${path}`}</Text>));
    }

    if (band.prs.length === 0) {
        out.push(line(kit, `${at}-nopr`, <Text dimColor>{"  No pull request for this branch."}</Text>));
    }

    for (const pr of band.prs) {
        out.push(...prLines(host, kit, band, pr, `${at}-pr-${pr.number}`, lists));
    }

    return out;
}

/**
 * The Git sidebar, one row per line so the status bar can sit pinned at the pane's foot (`sidebar.tsx`): a header
 * with when git was read and `refresh`, the add field with the folders it proposes, then each checkout, folded to
 * one line or open with its state, actions and PRs. What the focused Button does, and what a press did, show in the
 * status bar, so the focus ring moves nothing.
 */
async function gitPane(host: Host, kit: Kit): Promise<RenderElement> {
    const { Box, Text } = kit.ui;
    // Every surface but the mobile app draws a field.
    const Input = "Input" in kit.ui ? kit.ui.Input : undefined;
    const shown = rows;
    const home = await host.env("HOME");
    const git = (await settingsOf(host)).git;
    const readAt = Math.max(0, ...shown.map((band) => band.at));
    const reload: Pressable = {
        key: "git-refresh",
        label: "refresh",
        isDim: true,
        hint: "Read every checkout's git state and pull requests again.",
        onPress: () => {
            ghCache.clear();
            void pressed(host, "git-refresh", `Reading ${plural(rows.length, "checkout")}…`, "busy")
                .then(() => refresh(host, "sidebar"))
                .then(() => pressed(host, "git-refresh", `Read ${plural(rows.length, "checkout")} again.`))
                .catch((error: unknown) =>
                    pressed(host, "git-refresh", `Could not refresh: ${String(error)}`, "error")
                );
        },
    };
    const field: Pressable = {
        key: "git-add",
        label: "add a folder",
        hint: "Type a path (/ or ~/) or part of a folder name. Enter adds it, or the first match below it.",
        onPress: () => undefined,
    };
    kit.pressables?.push(field);
    const probe = await genesisProbe(host);
    const lines: RenderElement[] = [
        line(
            kit,
            "git-head",
            <Box flexDirection="row" flexGrow={1}>
                <Box flexShrink={1} minWidth={0}>
                    <Text wrap="truncate-end">
                        <Text bold>Git</Text>
                        <Text dimColor>
                            {shown.length
                                ? ` · ${plural(shown.length, "checkout")} · read ${liveAgo(readAt)}`
                                : " · no reading yet"}
                        </Text>
                    </Text>
                </Box>
                <Box flexGrow={1} />
                <Box flexShrink={0}>{actionButton(kit, reload)}</Box>
            </Box>
        ),
        line(kit, "git-gap", null),
        line(
            kit,
            "git-field",
            Input ? (
                <Input
                    key="git-add"
                    label="add a folder"
                    placeholder="a path, or part of a folder name"
                    value={addQuery}
                    submitLabel="add"
                    onInput={(value: string) => {
                        addQuery = value;
                        void proposeFolders(host, value);
                    }}
                    onSubmit={(value: string) => void addFolder(host, value)}
                />
            ) : (
                <Text dimColor>/mod-git add &lt;folder&gt; in the prompt adds a folder.</Text>
            )
        ),
    ];

    addFound.forEach((found, index) => {
        const row: Pressable = {
            key: `git-add-${index}`,
            label: tilde(found.path, home),
            isDim: true,
            hint: found.isGit
                ? `Add ${found.path} to this session's band.`
                : `${found.path} is in no git checkout, so the band cannot show it.`,
            onPress: () => void addFolder(host, found.path),
        };
        lines.push(
            line(
                kit,
                `git-found-${index}`,
                listRow(
                    kit,
                    row,
                    <Text color={found.isGit ? "green" : undefined} dimColor={!found.isGit}>
                        {`${found.isGit ? "git" : "not in git"} · ${found.from}`}
                    </Text>
                )
            )
        );
    });

    for (const [index, band] of shown.entries()) {
        const at = `git-${index}`;
        const isOpenNow = isOpen(band.root, index, git.expand);
        const label = labelOf(band, git.name);

        lines.push(line(kit, `${at}-rule`, divider(kit)), checkoutLine(host, kit, band, at, isOpenNow, label));

        if (isOpenNow) {
            lines.push(
                ...openLines(host, kit, band, at, {
                    probe,
                    tracked: await trackedPrs(host, band.root),
                    hidden: await hiddenPrs(host, band.root),
                    label,
                    home,
                })
            );
        }
    }

    return sidebarFrame(kit, <Box flexDirection="column">{lines}</Box>, lines.length);
}
