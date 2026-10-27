import { type Dirent, existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { nativeHome } from "@genesiscz/utils/providers/session-paths";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { pendingAsideDirs, pendingAsideFor, sessionScratchRoots } from "./aside";
import type { RmConfig, RmPreset } from "./config";
import {
    canonicalPath,
    isInside,
    isMountPoint,
    isSameOrInside,
    pathSegments,
    realOrSelf,
    VOLUME_TRASH_DIR,
} from "./paths";
import { matchPreset, presetsFor } from "./presets";

export type RmVerdictKind = "allow" | "ask" | "deny";

export interface RmVerdict {
    kind: RmVerdictKind;
    /** The rule that decided, e.g. `preset`, `session-scratch`, `hard-deny`. */
    rule: string;
    reason: string;
    presetId?: string;
}

export type RmTargetKind = "file" | "dir" | "symlink" | "missing";

export interface RmTarget {
    input: string;
    /** Absolute, lexical. */
    path: string;
    /** The realpath of the parent plus the name: a symlink names the link. */
    canonical: string;
    kind: RmTargetKind;
}

/** Who asks. `sessionId` scopes the session's own scratch folder and its own files. */
export interface RmCaller {
    agent: string;
    sessionId: string | null;
    isInAgent: boolean;
    sessionTitle?: string | null;
    /** The model the session runs, read from its transcript when this machine has it. */
    model?: string | null;
    /** The project folder name (the main checkout's). */
    project?: string | null;
    /** The operating-system user that ran the command. */
    user?: string;
}

export interface RmGitFacts {
    /** The work tree that contains the target (not the target itself), or null. */
    workTree: string | null;
    tracked: number;
    untracked: number;
    /** Set when the target is a clone with work that exists nowhere else. */
    unsavedClone: string | null;
    /** Set when the target is a linked worktree that git still lists. */
    linkedWorktreeOf: string | null;
}

export interface RmRuleContext {
    config: RmConfig;
    caller: RmCaller;
    cwd: string;
    home: string;
    presets: readonly RmPreset[];
    /** Files the calling session wrote, by absolute path. */
    ownFiles: ReadonlySet<string>;
    /** The per-session scratch root (`/tmp/cc`). */
    scratchRoots: readonly string[];
    /** The pending request whose aside folder the target is, holds, or sits in; null when none. */
    asidePending: (target: RmTarget) => string | null;
    git: (target: RmTarget) => RmGitFacts;
    nestedRepos: (target: RmTarget) => string[];
}

export function resolveTarget(input: string, cwd: string): RmTarget {
    const path = resolve(cwd, input);
    let kind: RmTargetKind = "missing";

    try {
        const stat = lstatSync(path);
        kind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "dir" : "file";
    } catch {
        kind = "missing";
    }

    return { input, path, canonical: canonicalPath(path), kind };
}

const POSIX_DENY_EXACT = [
    "/",
    "/Users",
    "/home",
    "/Volumes",
    "/Applications",
    "/Library",
    "/System",
    "/private",
    "/private/tmp",
    "/private/var",
    "/private/var/folders",
    "/tmp",
    "/var",
    "/opt",
    "/opt/homebrew",
    "/usr/local",
    "/cores",
];

const POSIX_DENY_INSIDE = ["/System", "/usr", "/bin", "/sbin", "/etc", "/private/etc", "/dev", "/Library/Apple"];

/** Paths whose loss costs data no rebuild returns: agent transcripts, the history index, keychains, cloud folders. */
function builtinProtected(home: string): string[] {
    return [
        genesisToolsDir("claude-history"),
        join(nativeHome("claude", home), "projects"),
        join(nativeHome("codex", home), "sessions"),
        nativeHome("grok", home),
        join(home, "Library", "Keychains"),
        join(home, "Library", "Mail"),
        join(home, "Library", "Messages"),
        join(home, "Library", "Mobile Documents"),
        join(home, "Library", "CloudStorage"),
    ];
}

/** Why no rule and no approval may delete `target`, or null. */
export function hardDenyReason(target: RmTarget, ctx: Pick<RmRuleContext, "config" | "cwd" | "home">): string | null {
    const p = target.canonical;

    if (target.kind === "missing") {
        return "it does not exist";
    }

    if (!isAbsolute(p) || pathSegments(p).length < 3) {
        return "too close to the root of the disk";
    }

    if (process.platform === "win32") {
        const root = parse(p).root;
        const windowsDeny = ["Windows", "Program Files", "Program Files (x86)", "ProgramData", "Users"].map((d) =>
            join(root, d)
        );

        if (windowsDeny.some((d) => isSameOrInside(p, d) && pathSegments(p).length <= 3)) {
            return "a system folder";
        }
    } else {
        if (POSIX_DENY_EXACT.includes(p)) {
            return "a system folder";
        }

        if (POSIX_DENY_INSIDE.some((d) => isSameOrInside(p, d))) {
            return "inside a system folder";
        }
    }

    const home = realOrSelf(ctx.home);

    if (p === home || isInside(home, p)) {
        return "the home folder or a folder that contains it";
    }

    if (dirname(p) === home) {
        return "directly in the home folder";
    }

    const cwd = realOrSelf(ctx.cwd);

    if (p === cwd || isInside(cwd, p)) {
        return "the current folder or a folder that contains it";
    }

    const trashRoot = realOrSelf(ctx.config.trashRoot);

    if (isSameOrInside(trashRoot, p) || isInside(p, trashRoot) || basename(p) === VOLUME_TRASH_DIR) {
        return "the trash itself (the drain empties it)";
    }

    for (const raw of [...builtinProtected(ctx.home), ...ctx.config.protect]) {
        const guarded = realOrSelf(raw);

        if (isSameOrInside(p, guarded) || isInside(guarded, p)) {
            return `protected: ${guarded}`;
        }
    }

    if (target.kind === "dir" && isMountPoint(p)) {
        return "the root of a volume";
    }

    return null;
}

/** The session's own scratch folder, `<root>/<project>/<session id>/` under any of its scratch roots. */
function inSessionScratch(target: RmTarget, caller: RmCaller, roots: readonly string[]): boolean {
    if (!caller.sessionId) {
        return false;
    }

    return roots.some((root) => {
        const scratchRoot = realOrSelf(root);

        if (!isInside(target.canonical, scratchRoot)) {
            return false;
        }

        const parts = pathSegments(relative(scratchRoot, target.canonical));
        return parts.length >= 2 && parts[1] === caller.sessionId;
    });
}

interface RmRule {
    id: string;
    evaluate: (target: RmTarget, ctx: RmRuleContext, git: () => RmGitFacts) => RmVerdict | null;
}

/** The rules, in order; the first that answers decides. */
export const RM_RULES: readonly RmRule[] = [
    {
        id: "hard-deny",
        evaluate: (target, ctx) => {
            const reason = hardDenyReason(target, ctx);
            return reason ? { kind: "deny", rule: "hard-deny", reason } : null;
        },
    },
    {
        // Before session-scratch: the aside folder sits in the session's scratch, and deleting it would skip the user.
        id: "aside-pending",
        evaluate: (target, ctx) => {
            const requestId = ctx.asidePending(target);
            return requestId
                ? {
                      kind: "deny",
                      rule: "aside-pending",
                      reason: `holds paths moved aside for the user's decision (request ${requestId}): approve or deny it`,
                  }
                : null;
        },
    },
    {
        id: "registered-worktree",
        evaluate: (_target, _ctx, git) => {
            const owner = git().linkedWorktreeOf;
            return owner
                ? {
                      kind: "deny",
                      rule: "registered-worktree",
                      reason: `a linked worktree of ${owner}: use git worktree remove, which refuses uncommitted work`,
                  }
                : null;
        },
    },
    {
        id: "git-tracked",
        evaluate: (_target, _ctx, git) => {
            const facts = git();
            return facts.tracked > 0
                ? {
                      kind: "ask",
                      rule: "git-tracked",
                      reason: `${facts.tracked} file(s) tracked by git in ${facts.workTree}: use git rm, or ask the user`,
                  }
                : null;
        },
    },
    {
        id: "unsaved-clone",
        evaluate: (_target, _ctx, git) => {
            const unsaved = git().unsavedClone;
            return unsaved ? { kind: "ask", rule: "unsaved-clone", reason: unsaved } : null;
        },
    },
    {
        id: "session-scratch",
        evaluate: (target, ctx) =>
            ctx.config.allowSessionScratch && inSessionScratch(target, ctx.caller, ctx.scratchRoots)
                ? { kind: "allow", rule: "session-scratch", reason: "inside this session's scratch folder" }
                : null,
    },
    {
        id: "own-files",
        evaluate: (target, ctx) =>
            ctx.config.allowOwnFiles &&
            target.kind === "file" &&
            (ctx.ownFiles.has(target.path) || ctx.ownFiles.has(target.canonical))
                ? { kind: "allow", rule: "own-files", reason: "a file this session wrote, not tracked by git" }
                : null,
    },
    {
        id: "git-untracked",
        evaluate: (_target, _ctx, git) => {
            const facts = git();
            return facts.untracked > 0
                ? {
                      kind: "ask",
                      rule: "git-untracked",
                      reason: `${facts.untracked} untracked file(s) git does not ignore in ${facts.workTree}: may be new work`,
                  }
                : null;
        },
    },
    {
        id: "nested-repos",
        evaluate: (target, ctx) => {
            const repos = target.kind === "dir" ? ctx.nestedRepos(target) : [];
            return repos.length > 0
                ? {
                      kind: "ask",
                      rule: "nested-repos",
                      reason: `holds ${repos.length} git repositor${repos.length === 1 ? "y" : "ies"}, e.g. ${repos[0]}`,
                  }
                : null;
        },
    },
    {
        id: "preset",
        evaluate: (target, ctx) => {
            const preset = target.kind === "dir" ? matchPreset(target.path, ctx.presets) : null;
            return preset
                ? {
                      kind: "allow",
                      rule: "preset",
                      reason: `preset ${preset.id}: ${preset.description}`,
                      presetId: preset.id,
                  }
                : null;
        },
    },
    {
        id: "root",
        evaluate: (target, ctx) => {
            const root = ctx.config.roots.find((r) => isInside(target.canonical, realOrSelf(r.path)));
            return root ? { kind: "allow", rule: "root", reason: `inside the trusted root ${root.path}` } : null;
        },
    },
    {
        id: "default",
        evaluate: () => ({
            kind: "ask",
            rule: "default",
            reason: "no rule allows it: a preset, this session's scratch or own files, or a trusted root",
        }),
    },
];

export function evaluateTarget(target: RmTarget, ctx: RmRuleContext): RmVerdict {
    let facts: RmGitFacts | undefined;
    const git = (): RmGitFacts => {
        facts ??= target.kind === "missing" ? NO_GIT : ctx.git(target);
        return facts;
    };

    for (const rule of RM_RULES) {
        const verdict = rule.evaluate(target, ctx, git);

        if (verdict) {
            logger.debug({ path: target.path, rule: verdict.rule, kind: verdict.kind }, "rm: verdict");
            return verdict;
        }
    }

    return { kind: "ask", rule: "default", reason: "no rule answered" };
}

const NO_GIT: RmGitFacts = { workTree: null, tracked: 0, untracked: 0, unsavedClone: null, linkedWorktreeOf: null };

function git(cwd: string, args: string[]): string | null {
    const proc = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });

    if (proc.exitCode !== 0) {
        return null;
    }

    return new TextDecoder().decode(proc.stdout);
}

function countZ(output: string | null): number {
    return output ? output.split("\0").filter(Boolean).length : 0;
}

/** What git knows about a target: the work tree around it, its tracked and untracked files, unsaved clone work. */
export function probeGit(target: RmTarget): RmGitFacts {
    const facts: RmGitFacts = { ...NO_GIT };
    const dotGit = join(target.path, ".git");
    const isRepoRoot = target.kind === "dir" && existsSync(dotGit);

    if (isRepoRoot) {
        const linked = linkedWorktreeOwner(dotGit);

        if (linked) {
            facts.linkedWorktreeOf = linked;
            return facts;
        }

        facts.unsavedClone = unsavedCloneWork(target.path);
    }

    const around = target.kind === "dir" && !isRepoRoot ? target.path : dirname(target.path);
    const top = git(around, ["rev-parse", "--show-toplevel"])?.trim();

    if (!top || isSameOrInside(realOrSelf(top), target.canonical)) {
        return facts;
    }

    const rel = relative(realOrSelf(top), target.canonical);
    facts.workTree = top;
    facts.tracked = countZ(git(top, ["ls-files", "-z", "--", rel]));
    facts.untracked = countZ(git(top, ["ls-files", "-z", "--others", "--exclude-standard", "--", rel]));
    logger.debug({ path: target.path, top, tracked: facts.tracked, untracked: facts.untracked }, "rm: git facts");
    return facts;
}

/** For a `.git` FILE that points into `<common>/worktrees/<name>`, the repository that still lists it. */
function linkedWorktreeOwner(dotGit: string): string | null {
    try {
        if (!lstatSync(dotGit).isFile()) {
            return null;
        }

        const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
        const gitdir = match?.[1]?.trim();

        if (!gitdir || !/[\\/]worktrees[\\/]/.test(gitdir)) {
            return null;
        }

        const absolute = resolve(dirname(dotGit), gitdir);
        return existsSync(absolute) ? dirname(dirname(absolute)) : null;
    } catch (error) {
        logger.debug({ dotGit, error }, "rm: cannot read a .git file");
        return null;
    }
}

function unsavedCloneWork(repo: string): string | null {
    const status = git(repo, ["status", "--porcelain", "--untracked-files=normal"]);

    if (status === null) {
        return "a git repository git cannot read";
    }

    if (status.trim()) {
        return `a clone with uncommitted changes (${status.trim().split("\n").length} path(s))`;
    }

    const unpushed = git(repo, ["log", "--branches", "--not", "--remotes", "-1", "--format=%h"]);

    if (unpushed?.trim()) {
        return `a clone with commits on no remote (e.g. ${unpushed.trim()})`;
    }

    return null;
}

const NESTED_SKIP = new Set(["node_modules", ".build", "target", "Pods"]);

/** Git repositories inside a folder, bounded: 4 levels and 5000 folders, so a huge tree is not walked whole. */
export function findNestedRepos(target: RmTarget, maxDepth = 4, maxDirs = 5000): string[] {
    const found: string[] = [];
    let visited = 0;
    const queue: Array<{ dir: string; depth: number }> = [{ dir: target.path, depth: 0 }];

    while (queue.length > 0 && visited < maxDirs && found.length < 20) {
        const next = queue.shift();

        if (!next) {
            break;
        }

        visited++;
        let entries: Dirent[];

        try {
            entries = readdirSync(next.dir, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (entry.name === ".git") {
                found.push(next.dir);
                continue;
            }

            if (entry.isDirectory() && next.depth < maxDepth && !NESTED_SKIP.has(entry.name)) {
                queue.push({ dir: join(next.dir, entry.name), depth: next.depth + 1 });
            }
        }
    }

    return found;
}

/** The files a Claude session wrote, from its modified-file journal (`track-session-files` hook). */
export function sessionOwnFiles(caller: RmCaller): Set<string> {
    if (caller.agent !== "claude-code" || !caller.sessionId) {
        return new Set();
    }

    const journal = genesisToolsDir("claude-code", "sessions", `${caller.sessionId}.json`);

    try {
        const parsed: unknown = SafeJSON.parse(readFileSync(journal, "utf8"));
        const files =
            typeof parsed === "object" && parsed !== null && "files" in parsed && Array.isArray(parsed.files)
                ? parsed.files.filter((f: unknown): f is string => typeof f === "string")
                : [];
        return new Set(files.flatMap((f) => [f, canonicalPath(f)]));
    } catch (error) {
        logger.debug({ journal, error }, "rm: no modified-file journal for this session");
        return new Set();
    }
}

export function defaultRuleContext(config: RmConfig, caller: RmCaller, cwd: string): RmRuleContext {
    const pending = pendingAsideDirs();
    return {
        config,
        caller,
        cwd,
        home: homedir(),
        presets: presetsFor(config),
        ownFiles: sessionOwnFiles(caller),
        scratchRoots: sessionScratchRoots(caller),
        asidePending: (target) => pendingAsideFor(target.canonical, pending),
        git: probeGit,
        nestedRepos: (target) => findNestedRepos(target),
    };
}
