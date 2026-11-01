import { type Dirent, existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import type { TranscriptAnchor } from "@genesiscz/utils/agent/source-anchor";
import { formatBytes, formatCount } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { nativeHome } from "@genesiscz/utils/providers/session-paths";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { asideRootFor, pendingAsideDirs, pendingAsideFor, sessionScratchRoots } from "./aside";
import { isRootActive, type RmConfig, type RmPreset } from "./config";
import {
    canonicalPath,
    identityOf,
    isInside,
    isMountPoint,
    isSameOrInside,
    pathSegments,
    realOrSelf,
    sharedTempRoot,
    VOLUME_TRASH_DIR,
} from "./paths";
import { allPresets, matchPreset, presetsFor } from "./presets";
import { scratchRootNames } from "./scratch-dirs";
import {
    defaultTempRoots,
    isSystemTempName,
    measureTempTree,
    scratchSessionLive,
    type TempTreeFacts,
    userTempDir,
} from "./temp-rule";

export type RmVerdictKind = "allow" | "ask" | "deny";

export interface RmVerdict {
    kind: RmVerdictKind;
    /** The rule that decided, e.g. `preset`, `session-scratch`, `hard-deny`. */
    rule: string;
    reason: string;
    presetId?: string;
    /**
     * Set on an ask: the path holds work that exists nowhere else (history, uncommitted or untracked changes, a
     * clone's unpushed commits), so an aside move into /tmp, which a reboot clears, would risk it.
     */
    unsaved?: boolean;
    /**
     * Set on an ask whose path must not move while it waits, and why: a cache an opt-in preset names (off) may be read
     * by another install right now, so an aside move would break it. The run leaves it where it is.
     */
    stayInPlace?: string;
}

export type RmTargetKind = "file" | "dir" | "symlink" | "missing";

export interface RmTarget {
    input: string;
    /** Absolute, lexical. */
    path: string;
    /** The realpath of the parent plus the name: a symlink names the link. */
    canonical: string;
    kind: RmTargetKind;
    /**
     * The device and inode the checks saw (`dev:ino`), or null when missing. The move refuses a path that names
     * anything else by then: a file swapped in, or a parent turned into a symlink.
     */
    identity: string | null;
    /**
     * Where the content is when it moved away from `path` (a copy set aside for a person): the rules judge the
     * place by `path` and the content (size, repositories inside, birthtime) here. Unset: the content is at `path`.
     */
    content?: string;
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
    /** `AI_AGENT` as the harness sets it, e.g. `claude-code_2-1-296_agent`. */
    aiAgent?: string | null;
    repoRoot?: string;
    branch?: string | null;
    commitSha?: string | null;
    worktreePath?: string | null;
    /** Where in the session's transcript the command was received, as the question log stamps its entries. */
    transcriptAnchor?: TranscriptAnchor;
}

export interface RmGitFacts {
    /** The work tree that contains the target (not the target itself), or null. */
    workTree: string | null;
    tracked: number;
    /** Tracked files under the target with changes git has not committed, staged or not. */
    dirty: number;
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
    /**
     * When a Bash command of the calling session last recorded writing `path` (an ISO time), or null: the agents
     * change log, read by the GenesisTools caller (`bashWriteLookup`), so this package parses no tool's format.
     */
    ownBashWrite: (path: string) => string | null;
    /** The per-session scratch root (`/tmp/cc`). */
    scratchRoots: readonly string[];
    /** The pending request whose aside folder the target is, holds, or sits in; null when none. */
    asidePending: (target: RmTarget) => string | null;
    git: (target: RmTarget) => RmGitFacts;
    nestedRepos: (target: RmTarget) => string[];
    /** The temp roots the tmp-small rule covers, resolved (`/private/tmp`, the per-user temp folder). */
    tempRoots: readonly string[];
    /** One bounded walk of a temp path: its size up to the limit, the repositories in it, a socket. */
    tempTree: (path: string, limitBytes: number) => TempTreeFacts;
    /** Whether another session's `/tmp/<agent dir>/<project>/<session>` scratch belongs to a session still running. */
    scratchLive: (session: string, dir: string) => boolean;
    /** Commands a reason may name, passed in by the GenesisTools caller (`src/utils/genesis-tools/tools/hints.ts`). */
    hints?: RmRuleHints;
}

export interface RmRuleHints {
    /** The command that turns an opt-in preset on. */
    enablePreset?: (id: string) => string;
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

    return { input, path, canonical: canonicalPath(path), kind, identity: identityOf(path) };
}

/**
 * Why `pinned` no longer names what was checked, or null: its parent resolves elsewhere now (a folder swapped for a
 * symlink), or the path holds another file or folder (another device and inode).
 */
export function targetChangeReason(pinned: RmTarget): string | null {
    if (pinned.identity === null) {
        return "it did not exist when it was checked";
    }

    if (canonicalPath(pinned.path) !== pinned.canonical) {
        return `its folder now resolves to ${dirname(canonicalPath(pinned.path))}`;
    }

    const now = identityOf(pinned.path);

    // Two approve windows of one request (dvzu7k, 2026-10-31) logged "another file" for paths the other one had
    // already moved to the trash; the person read it as "something replaced my folder".
    if (now === null) {
        return "it is gone now (moved or deleted since the check)";
    }

    if (now !== pinned.identity) {
        return "another file or folder is there now";
    }

    return null;
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
        // Secrets: keys and credentials no rebuild returns.
        join(home, ".ssh"),
        join(home, ".gnupg"),
        join(home, ".aws"),
        join(home, ".kube"),
        join(home, ".password-store"),
        genesisToolsDir("security"),
        genesisToolsDir("ai"),
        // Virtual-machine disks: containers' volumes live there with no snapshot.
        join(home, ".orbstack"),
        join(home, "Library", "Group Containers", "HUX3Z3SN6R.dev.orbstack"),
        join(home, "Library", "Containers", "com.docker.docker"),
        join(home, ".colima"),
        join(home, ".minikube"),
        join(home, ".lima"),
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
        // Before session-scratch: a scratch folder may hold a linked worktree or a clone whose work is nowhere else.
        id: "nested-work",
        evaluate: (target, ctx) => nestedWorkVerdict(target, ctx),
    },
    {
        id: "git-history",
        // The .git folder or anything in it (objects, HEAD, refs): git cannot see a work tree from in there.
        evaluate: (target) =>
            pathSegments(target.path).includes(".git") || pathSegments(target.canonical).includes(".git")
                ? {
                      kind: "ask",
                      rule: "git-history",
                      reason: "a repository's .git folder: its history and every unpushed commit go with it",
                  }
                : null,
    },
    {
        id: "git-tracked",
        evaluate: (_target, _ctx, git) => {
            const facts = git();
            return facts.tracked > 0
                ? {
                      kind: "ask",
                      rule: "git-tracked",
                      reason: `${formatCount(facts.tracked, "file")} tracked by git in ${facts.workTree}: use git rm, or ask the user`,
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
        evaluate: (target, ctx) => {
            if (!ctx.config.allowOwnFiles || target.kind !== "file") {
                return null;
            }

            if (ctx.ownFiles.has(target.path) || ctx.ownFiles.has(target.canonical)) {
                return { kind: "allow", rule: "own-files", reason: "a file this session wrote, not tracked by git" };
            }

            return ctx.config.ownFilesFromBash && madeByBash(target, ctx)
                ? {
                      kind: "allow",
                      rule: "own-files",
                      reason: "a file a Bash command of this session made, not tracked by git",
                  }
                : null;
        },
    },
    {
        id: "git-untracked",
        evaluate: (_target, _ctx, git) => {
            const facts = git();
            return facts.untracked > 0
                ? {
                      kind: "ask",
                      rule: "git-untracked",
                      reason: `${formatCount(facts.untracked, "untracked file")} git does not ignore in ${facts.workTree}: may be new work`,
                  }
                : null;
        },
    },
    {
        // After every rule that asks for unsaved work: what reaches it is untracked, outside a work tree's new files
        // and no unsaved clone. Before nested-repos: a clean, pushed repository inside is no reason to ask.
        id: "tmp-small",
        evaluate: (target, ctx, git) => tmpSmallVerdict(target, ctx, git),
    },
    {
        id: "nested-repos",
        evaluate: (target, ctx) => {
            const repos = target.kind === "dir" ? ctx.nestedRepos(target) : [];
            return repos.length > 0
                ? {
                      kind: "ask",
                      rule: "nested-repos",
                      reason: `holds ${formatCount(repos.length, "git repository", "git repositories")}, e.g. ${repos[0]}`,
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
            const root = ctx.config.roots.find(
                (r) => isRootActive(r, ctx.caller.sessionId) && isInside(target.canonical, realOrSelf(r.path))
            );
            return root ? { kind: "allow", rule: "root", reason: `inside the trusted root ${root.path}` } : null;
        },
    },
    {
        id: "default",
        evaluate: (target, ctx) => ({
            kind: "ask",
            rule: "default",
            reason: defaultAskReason(target, ctx),
            ...(offOptInPreset(target, ctx) ? { stayInPlace: "a live cache: another install may read it" } : {}),
        }),
    },
];

/** A Bash command runs at most 10 minutes in the harnesses; the row is written once it ended. */
const BASH_COMMAND_WINDOW_MS = 15 * 60_000;

/**
 * Whether a Bash command of the session made `target`: the change log names the path, and the file was born inside
 * that command (up to 15 minutes before its row, a minute of clock slack after). A file a command only moved keeps
 * its old birthtime (`mv ~/notes.txt ./scratch.txt`), so it never counts, and neither does one swapped in later.
 */
function madeByBash(target: RmTarget, ctx: RmRuleContext): boolean {
    const at = ctx.ownBashWrite(target.path) ?? ctx.ownBashWrite(target.canonical);

    if (!at) {
        return false;
    }

    let born: number;

    try {
        born = lstatSync(target.content ?? target.path).birthtimeMs;
    } catch (error) {
        logger.debug({ path: target.path, error }, "rm: cannot read a birthtime");
        return false;
    }

    const wrote = Date.parse(at);
    return born > 0 && born >= wrote - BASH_COMMAND_WINDOW_MS && born <= wrote + 60_000;
}

/**
 * The tmp-small rule (owner, 2026-11-01:
/**
 * The tmp-small rule (owner, 2026-11-01: "the size limit for deleting a temp path without a request ... when a path
 * falls under such a rule, tools rm must never ask the person"): a path inside a temp root, at most `tmpSmallMB`,
 * holding no socket and no repository with unsaved work at any depth, is deleted without a request. A scratch root
 * or a project folder under it holds every session's scratch and never matches; a session's scratch folder matches
 * only once that session has ended. The system's and running services' folders at the top of a temp root stay.
 */
function tmpSmallVerdict(target: RmTarget, ctx: RmRuleContext, git: () => RmGitFacts): RmVerdict | null {
    const limitMB = ctx.config.tmpSmallMB;

    if (limitMB <= 0 || target.kind === "missing") {
        return null;
    }

    const root = ctx.tempRoots.find((tempRoot) => isInside(target.canonical, tempRoot));

    if (!root) {
        return null;
    }

    const [top, project, session] = pathSegments(relative(root, target.canonical));

    if (!top || isSystemTempName(top)) {
        return null;
    }

    if (scratchRootNames().has(top)) {
        if (!project || !session) {
            return null;
        }

        // The caller's own scratch is the session-scratch rule's, which a profile may have turned off.
        if (session === ctx.caller.sessionId || ctx.scratchLive(session, join(root, top, project, session))) {
            return null;
        }
    }

    const facts = ctx.tempTree(target.content ?? target.path, limitMB * 1024 * 1024);

    if (facts.over || facts.refuse) {
        return null;
    }

    for (const repo of facts.repos) {
        const inside = ctx.git(resolveTarget(repo, ctx.cwd));

        if (inside.unsavedClone || inside.linkedWorktreeOf) {
            return null;
        }
    }

    const around = git();

    if (around.tracked > 0 || around.untracked > 0) {
        return null;
    }

    const where = root === realOrSelf(sharedTempRoot()) ? "/tmp" : root === userTempDir() ? "per-user temp" : root;
    return {
        kind: "allow",
        rule: "tmp-small",
        reason: `${where} path, ${formatBytes(facts.bytes)} under ${limitMB} MB, not git-tracked, no unsaved repo inside`,
    };
}

/** The general reason of the default rule; the listing hides it on every row and prints its legend once. */
const DEFAULT_ASK_REASON = "no rule allows it: a preset, this session's scratch or own files, or a trusted root";

/** The opt-in preset that names `target` while it is off (the user has not turned it on), or null. */
function offOptInPreset(target: RmTarget, ctx: RmRuleContext): RmPreset | null {
    if (target.kind !== "dir") {
        return null;
    }

    const enabled = new Set(ctx.presets.map((preset) => preset.id));
    return matchPreset(
        target.path,
        allPresets(ctx.config).filter((preset) => preset.optIn && !enabled.has(preset.id))
    );
}

/** A full session id as the harnesses write it: a UUID. */
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Why no rule allowed `target`, naming what nearly matched: agents guessed wrong from the general sentence (one blamed
 * curl when the cause was a scratch folder named with an 8-character id). The verdict stays `ask`; only words change.
 */
function defaultAskReason(target: RmTarget, ctx: RmRuleContext): string {
    const { caller } = ctx;
    const sessionId = caller.isInAgent ? caller.sessionId : null;

    if (sessionId) {
        for (const root of ctx.scratchRoots) {
            const scratchRoot = realOrSelf(root);

            if (!isInside(target.canonical, scratchRoot)) {
                continue;
            }

            const [project, level] = pathSegments(relative(scratchRoot, target.canonical));
            // Named the way an agent writes it (/tmp/cc/...), not resolved (/private/tmp/...).
            const own = `${join(root, project ?? "", sessionId)}/`;

            if (level && level !== sessionId && level.length >= 4 && sessionId.startsWith(level)) {
                return `the scratch folder must use the full session id: ${own}`;
            }

            if (level && level !== sessionId && SESSION_UUID.test(level)) {
                return `another session's scratch (${level.slice(0, 8)}): only that session deletes there without asking`;
            }

            if (level !== sessionId) {
                return `no session folder: write scratch to ${own}`;
            }
        }

        const tempRoots = new Set([realOrSelf(sharedTempRoot()), realOrSelf(tmpdir())]);

        if (tempRoots.has(dirname(target.canonical))) {
            const what = target.kind === "dir" ? "folder" : "file";
            return `a loose temp ${what}: write scratch to ${dirname(asideRootFor(caller))}/ next time`;
        }
    }

    const preset = offOptInPreset(target, ctx);

    if (preset) {
        const command = ctx.hints?.enablePreset?.(preset.id);
        return `matches the opt-in preset ${preset.id}, which is off; the user can turn it on${command ? `: ${command}` : ""}`;
    }

    if (sessionId && ctx.config.allowOwnFiles && target.kind === "file") {
        return ctx.config.ownFilesFromBash
            ? "only files the Write, Edit or NotebookEdit tool wrote, or a Bash command of this session made, count as its own files"
            : "only files written with the Write, Edit or NotebookEdit tool count as this session's own files";
    }

    return DEFAULT_ASK_REASON;
}

/**
 * The repositories inside a folder (not the folder itself): a linked worktree git still lists is refused, as it is
 * at the top, and a clone with work that exists nowhere else needs the user. Clean, pushed clones pass.
 */
function nestedWorkVerdict(target: RmTarget, ctx: RmRuleContext): RmVerdict | null {
    if (target.kind !== "dir") {
        return null;
    }

    let unsaved: RmVerdict | null = null;

    for (const repo of ctx.nestedRepos(target)) {
        if (canonicalPath(repo) === target.canonical) {
            continue;
        }

        const facts = ctx.git(resolveTarget(repo, ctx.cwd));

        if (facts.linkedWorktreeOf) {
            return {
                kind: "deny",
                rule: "registered-worktree",
                reason: `holds ${repo}, a linked worktree of ${facts.linkedWorktreeOf}: use git worktree remove first`,
            };
        }

        if (facts.unsavedClone && !unsaved) {
            unsaved = { kind: "ask", rule: "nested-repos", reason: `holds ${repo}: ${facts.unsavedClone}` };
        }
    }

    return unsaved;
}

/** The rules whose ask always means unsaved work. */
const UNSAVED_RULES = new Set(["git-history", "git-untracked", "unsaved-clone", "nested-repos"]);

/**
 * Whether an asked path holds work that exists nowhere else, whichever rule answered first: a tracked folder can
 * hold edits git has not committed, untracked files, or a repository of its own.
 */
function holdsUnsavedWork(verdict: RmVerdict, target: RmTarget, ctx: RmRuleContext, git: () => RmGitFacts): boolean {
    if (UNSAVED_RULES.has(verdict.rule)) {
        return true;
    }

    const facts = git();

    if (facts.dirty > 0 || facts.untracked > 0 || facts.unsavedClone) {
        return true;
    }

    return target.kind === "dir" && ctx.nestedRepos(target).length > 0;
}

/**
 * Why no approval may delete `target`, or null: the hard-deny rules, plus a linked worktree git still lists at the
 * target or inside it. An approval overrides an ask, never these, so they are checked again once the person answers.
 */
export function approvalDenyReason(target: RmTarget, ctx: RmRuleContext): string | null {
    const hard = hardDenyReason(target, ctx);

    if (hard) {
        return hard;
    }

    const owner = target.kind === "missing" ? null : ctx.git(target).linkedWorktreeOf;

    if (owner) {
        return `a linked worktree of ${owner}: use git worktree remove, which refuses uncommitted work`;
    }

    const nested = nestedWorkVerdict(target, ctx);
    return nested?.kind === "deny" ? nested.reason : null;
}

/**
 * After a wait for a person: why `pinned` must not be acted on now, or null. It must still name what was checked,
 * and what it names now must pass `deny` (`approvalDenyReason` for a deletion).
 */
export function recheckAfterWait(
    pinned: RmTarget,
    ctx: RmRuleContext,
    deny: (target: RmTarget, ctx: RmRuleContext) => string | null = approvalDenyReason
): string | null {
    const changed = targetChangeReason(pinned);

    if (changed) {
        return `changed while waiting: ${changed}`;
    }

    return deny(resolveTarget(pinned.path, ctx.cwd), ctx);
}

export function evaluateTarget(target: RmTarget, ctx: RmRuleContext): RmVerdict {
    let facts: RmGitFacts | undefined;
    const git = (): RmGitFacts => {
        facts ??= target.kind === "missing" ? NO_GIT : ctx.git(target);
        return facts;
    };
    let nested: string[] | undefined;
    const once: RmRuleContext = {
        ...ctx,
        nestedRepos: (t) => {
            if (t !== target) {
                return ctx.nestedRepos(t);
            }

            nested ??= ctx.nestedRepos(t);
            return nested;
        },
    };

    for (const rule of RM_RULES) {
        const verdict = rule.evaluate(target, once, git);

        if (verdict) {
            logger.debug({ path: target.path, rule: verdict.rule, kind: verdict.kind }, "rm: verdict");
            return verdict.kind === "ask"
                ? { ...verdict, unsaved: holdsUnsavedWork(verdict, target, once, git) }
                : verdict;
        }
    }

    return { kind: "ask", rule: "default", reason: "no rule answered" };
}

const NO_GIT: RmGitFacts = {
    workTree: null,
    tracked: 0,
    dirty: 0,
    untracked: 0,
    unsavedClone: null,
    linkedWorktreeOf: null,
};

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
    // One call for both counts: `-t` tags each path, `? ` for untracked and a letter (`H`, `S`, ...) for tracked.
    // Literal: `--` ends the options but not the pathspec magic, so `:draft.txt` would name `draft.txt`.
    const listed = (
        git(top, ["--literal-pathspecs", "ls-files", "-z", "-t", "-c", "-o", "--exclude-standard", "--", rel]) ?? ""
    )
        .split("\0")
        .filter(Boolean);
    facts.untracked = listed.filter((entry) => entry.startsWith("? ")).length;
    facts.tracked = listed.length - facts.untracked;
    facts.dirty =
        facts.tracked > 0
            ? countZ(
                  git(top, ["--literal-pathspecs", "status", "--porcelain", "-z", "--untracked-files=no", "--", rel])
              )
            : 0;
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
        return `a clone with uncommitted changes (${formatCount(status.trim().split("\n").length, "path")})`;
    }

    // HEAD too: a commit made on a detached HEAD is on no branch, and no remote has it either.
    const unpushed = git(repo, ["log", "HEAD", "--branches", "--not", "--remotes", "-1", "--format=%h"]);

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
    const queue: Array<{ dir: string; depth: number }> = [{ dir: target.content ?? target.path, depth: 0 }];

    // A read index, not `shift()`: shifting a 5000-entry array moves every element each time.
    for (let head = 0; head < queue.length && visited < maxDirs && found.length < 20; head++) {
        const next = queue[head];
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

export function defaultRuleContext(
    config: RmConfig,
    caller: RmCaller,
    cwd: string,
    extra: { hints?: RmRuleHints; ownBashWrite?: (path: string) => string | null } = {}
): RmRuleContext {
    const pending = pendingAsideDirs();
    const live = new Map<string, boolean>();
    return {
        config,
        caller,
        cwd,
        home: homedir(),
        presets: presetsFor(config),
        ownFiles: sessionOwnFiles(caller),
        ownBashWrite: extra.ownBashWrite ?? (() => null),
        scratchRoots: sessionScratchRoots(caller),
        asidePending: (target) => pendingAsideFor(target.canonical, pending),
        git: probeGit,
        nestedRepos: (target) => findNestedRepos(target),
        tempRoots: defaultTempRoots(),
        tempTree: measureTempTree,
        scratchLive: (session, dir) => {
            const known = live.get(dir) ?? scratchSessionLive(session, dir);
            live.set(dir, known);
            return known;
        },
        hints: extra.hints,
    };
}

/**
 * Minutes a moved item waits before the drain. A folder a preset matches (a build or an install recreates it) gets
 * the preset grace whichever rule allowed it, e.g. a node_modules in the session's scratch. The session's own
 * scratch gets the scratch grace: throwaway output that hid 11 GB for the hour of the other grace on a full disk
 * (2026-11-01). The rest waits longer.
 */
export function graceMinutesFor(
    item: { target: RmTarget; verdict: RmVerdict },
    ctx: RmRuleContext,
    override?: number
): number {
    if (override !== undefined) {
        return override;
    }

    const isPreset =
        item.verdict.rule === "preset" ||
        (item.target.kind === "dir" && matchPreset(item.target.path, ctx.presets) !== null);

    if (isPreset) {
        return ctx.config.grace.presetMinutes;
    }

    return item.verdict.rule === "session-scratch" ? ctx.config.grace.scratchMinutes : ctx.config.grace.otherMinutes;
}
