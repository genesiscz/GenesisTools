// The checkouts a session works in, for the git band: the git root of each file the session writes, and of each
// folder where it changes git state (`git -C <dir> commit`, `cd <dir> && git rebase`). A file git ignores does not
// count, so a plan a worktree session writes into the main checkout's `.claude/plans/` leaves the main checkout out.
// Reads and read-only git (status, log, diff) count nothing. A folder in a shell variable the same command set
// (`W=/tmp/x` then `git -C "$W" commit`) counts, and `git worktree add <path>` counts the new worktree.
//
// Each checkout keeps the branches the session worked on there: the one checked out at each write, and each one a
// command made or pushed (`switch -c`, `checkout -b`, `worktree add -b`, `push origin <branch>`), with the main
// checkout it belongs to. So a worktree the session removed, or a branch it switched away from, still has its PR.
//
// Each session's list lives in the plugin store, so it outlives a hot reload and a resume; the 40 sessions touched
// last are kept. A session with no list yet starts from the GenesisTools file journal
// (`~/.genesis-tools/claude-code/sessions/<id>.json`), each checkout dated by the newest change to one of its files.
//
// The person can also add a folder by hand (`/mod-git add <folder>`, the Git sidebar's field): its checkout shows
// in this session's band until removed. `folderSuggestions` proposes folders for that, from zoxide when it is
// installed (`GenesisPlayg` finds the GenesisPlayground path) and from the folder a typed `/` or `~/` path names.
import type { FsEntry } from "claude-code";
import { type Host, logMod } from "./shared";

export interface Touch {
    root: string;
    at: number;
    /** The main checkout: the root itself, or for a linked worktree the folder that holds its `.git`. */
    repo?: string;
    /** The branches the session worked on here, the last first, at most `KEEP_BRANCHES`. */
    branches?: string[];
}

/** One folder a command changes git state in, with the branches it names as made or pushed. */
export interface GitWrite {
    dir: string;
    branches: string[];
}

const STORE_KEY = "git-band-checkouts";
const ADDED_KEY = "git-band-added";
const ZOXIDE_TTL_MS = 60_000;
const KEEP_SESSIONS = 40;
const KEEP_ROOTS = 12;
const KEEP_BRANCHES = 6;
/** The journal's newest files the first list is built from. */
const SEED_FILES = 200;
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const GIT_WRITES = new Set([
    "add",
    "am",
    "apply",
    "checkout",
    "cherry-pick",
    "commit",
    "merge",
    "mv",
    "pull",
    "push",
    "rebase",
    "reset",
    "restore",
    "revert",
    "rm",
    "stash",
    "switch",
]);

type Ledger = Record<string, Touch[]>;

/** This session's list, newest first, while this module lives; the store holds it across reloads. */
let held: { session: string; touches: Touch[] } | undefined;
/** The folders this session added by hand, newest first, as git roots. */
let added: { session: string; roots: string[] } | undefined;
let zoxide: { at: number; dirs: string[] } | undefined;
let loading: Promise<Touch[]> | undefined;
let mutations: Promise<unknown> = Promise.resolve();
const rootByDir = new Map<string, string | null>();

/** Merge against the latest state and save in order across concurrent tool completions and sidebar actions. */
function mutateCheckouts<T>(change: () => Promise<T>): Promise<T> {
    const work = mutations.then(change);
    mutations = work.catch(() => undefined);

    return work;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parentOf(path: string): string {
    return path.slice(0, path.lastIndexOf("/")) || "/";
}

function absolute(path: string, home: string | undefined): string | undefined {
    if (path.startsWith("/")) {
        return path.replace(/\/+$/, "") || "/";
    }

    return home && path.startsWith("~/") ? `${home}/${path.slice(2)}`.replace(/\/+$/, "") : undefined;
}

/** The absolute files a tool call wrote: `file_path` of Edit, Write and MultiEdit, `notebook_path` of NotebookEdit. */
export function writtenFiles(input: unknown): string[] {
    if (!isRecord(input) || typeof input.tool !== "string" || !WRITE_TOOLS.has(input.tool)) {
        return [];
    }

    return [input.file_path, input.notebook_path].filter(
        (path): path is string => typeof path === "string" && path.startsWith("/")
    );
}

/**
 * A shell word without its quotes. Outside single quotes `$NAME` and `${NAME}` take the value the command set
 * before; a name it did not set stays as written, so the word is no folder.
 */
function shellWord(word: string, vars: ReadonlyMap<string, string>): string {
    if (/^'.*'$/s.test(word)) {
        return word.slice(1, -1);
    }

    const bare = /^".*"$/s.test(word) ? word.slice(1, -1) : word;

    return bare.replace(
        /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
        (all: string, braced?: string, plain?: string) => vars.get(braced ?? plain ?? "") ?? all
    );
}

/** A folder from a command's word: absolute, `~/`, or relative to the folder the command is in; `..` resolved. */
function resolveIn(value: string, dir: string | undefined, home: string | undefined): string | undefined {
    const path = absolute(value, home) ?? (dir && value && !value.startsWith("$") ? `${dir}/${value}` : undefined);

    if (!path) {
        return undefined;
    }

    const parts: string[] = [];

    for (const part of path.split("/")) {
        if (part === "..") {
            parts.pop();
        } else if (part && part !== ".") {
            parts.push(part);
        }
    }

    return `/${parts.join("/")}`;
}

/** The branch name of a ref a push or a switch names: `refs/heads/x` and `+x` as `x`; `HEAD` and tags as none. */
function branchOf(ref: string): string | undefined {
    const name = ref.replace(/^\+/, "").replace(/^refs\/heads\//, "");

    return !name || name === "HEAD" || name.startsWith("refs/") || name.startsWith("-") ? undefined : name;
}

/** The branches a git command makes or pushes: `switch -c x`, `checkout -b x`, `push origin x` or `HEAD:x`. */
function namedBranches(verb: string, args: readonly string[]): string[] {
    if (verb === "switch" || verb === "checkout") {
        const at = args.findIndex((arg) => ["-c", "-C", "-b", "-B", "--create", "--force-create"].includes(arg));
        const made = at >= 0 ? branchOf(args[at + 1] ?? "") : undefined;

        return made ? [made] : [];
    }

    if (verb !== "push" || args.some((arg) => arg === "-d" || arg === "--delete" || arg === "--tags")) {
        return [];
    }

    const valued = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);
    const positional: string[] = [];

    for (let at = 0; at < args.length; at += 1) {
        const arg = args[at] ?? "";

        if (valued.has(arg)) {
            at += 1;
        } else if (!arg.startsWith("-")) {
            positional.push(arg);
        }
    }

    // The first word is the remote; each later one a refspec, `src:dst` pushing into `dst`, `:dst` deleting it.
    return positional
        .slice(1)
        .filter((spec) => !spec.startsWith(":"))
        .map((spec) => branchOf(spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : spec))
        .filter((name): name is string => name !== undefined);
}

/** `git worktree add [-b <branch>] <path> [<commit>]`: the new worktree's path as written, and the branch it makes. */
function worktreeAdd(args: readonly string[]): { path?: string; branch?: string } {
    const valued = new Set(["-b", "-B", "--reason"]);
    let branch: string | undefined;

    for (let at = 0; at < args.length; at += 1) {
        const arg = args[at] ?? "";

        if (valued.has(arg)) {
            branch = arg === "--reason" ? branch : branchOf(args[at + 1] ?? "");
            at += 1;
        } else if (!arg.startsWith("-")) {
            return { path: arg, branch };
        }
    }

    return { branch };
}

/**
 * The folders a Bash command changes git state in: `git -C <dir> <verb>`, or `git <verb>` after `cd <dir>` in the
 * same command, for a verb that writes (commit, rebase, stash, push…), and the path of `git worktree add`. A folder
 * counts when it is absolute, `~/`, or in a variable the command set before it (`W=/tmp/x` then `git -C "$W"`);
 * the shell's own folder is not known here. Each folder comes with the branches the command made or pushed there.
 */
export function gitWrites(command: string, home: string | undefined): GitWrite[] {
    const writes = new Map<string, Set<string>>();
    const vars = new Map<string, string>(home ? [["HOME", home]] : []);
    let here: string | undefined;
    const note = (dir: string, branches: readonly string[]) => {
        writes.set(dir, new Set([...(writes.get(dir) ?? []), ...branches]));
    };

    for (const part of command.split(/&&|\|\||[;|\n]/)) {
        const raw = part.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
        let start = raw[0] === "export" ? 1 : 0;
        const sets: [string, string][] = [];

        while (raw[start] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw[start] ?? "")) {
            const word = raw[start] ?? "";
            const eq = word.indexOf("=");
            sets.push([word.slice(0, eq), shellWord(word.slice(eq + 1), vars)]);
            start += 1;
        }

        const words = raw.slice(start).map((word) => shellWord(word, vars));

        // `W=/x` alone sets W for the rest of the command; `W=/x git …` sets it for that one command only.
        if (words.length === 0) {
            for (const [name, value] of sets) {
                vars.set(name, value);
            }

            continue;
        }

        if (words[0] === "cd") {
            here = words[1] ? resolveIn(words[1], here, home) : undefined;
            continue;
        }

        if (words[0] !== "git") {
            continue;
        }

        let dir = here;
        let at = 1;

        while (words[at]?.startsWith("-")) {
            const flag = words[at];

            if (flag === "-C" || flag === "-c") {
                if (flag === "-C") {
                    dir = resolveIn(words[at + 1] ?? "", dir, home);
                }

                at += 2;
            } else {
                at += 1;
            }
        }

        const verb = words[at] ?? "";
        const args = words.slice(at + 1);

        if (verb === "worktree" && args[0] === "add") {
            const added = worktreeAdd(args.slice(1));
            const path = added.path ? resolveIn(added.path, dir, home) : undefined;

            if (path) {
                note(path, added.branch ? [added.branch] : []);
            }
        } else if (dir && GIT_WRITES.has(verb)) {
            note(dir, namedBranches(verb, args));
        }
    }

    return [...writes].map(([dir, branches]) => ({ dir, branches: [...branches] }));
}

/** The folders of `gitWrites`, without their branches. */
export function gitWriteDirs(command: string, home: string | undefined): string[] {
    return gitWrites(command, home).map((write) => write.dir);
}

/** The git root above a file or folder: the nearest folder holding `.git` (a folder, or a worktree's file). */
async function rootAbove(host: Host, start: string): Promise<string | null> {
    const walked: string[] = [];
    let dir = start;
    let found: string | null = null;

    while (dir !== "/") {
        const known = rootByDir.get(dir);

        if (known !== undefined) {
            found = known;
            break;
        }

        walked.push(dir);

        if (await host.exists(`${dir}/.git`).catch(() => false)) {
            found = dir;
            break;
        }

        dir = parentOf(dir);
    }

    for (const each of walked) {
        rootByDir.set(each, found);
    }

    return found;
}

/** The files of `root` git does not ignore, in one `git check-ignore --stdin`. */
async function notIgnored(host: Host, root: string, files: string[]): Promise<string[]> {
    const run = await host
        .run(["git", "-C", root, "check-ignore", "--stdin"], { stdin: `${files.join("\n")}\n`, timeoutMs: 10_000 })
        .catch(() => undefined);

    // 0: some are ignored, listed one per line. 1: none is. Anything else: git failed, so the root does not count.
    if (run?.exitCode === 1) {
        return files;
    }

    if (run?.exitCode !== 0) {
        return [];
    }

    const ignored = new Set(run.stdout.split("\n").filter(Boolean));

    return files.filter((file) => !ignored.has(file));
}

/** Each checkout of these files, dated by the newest change to a file of it that git does not ignore. */
async function datedRoots(host: Host, files: string[]): Promise<Touch[]> {
    const byRoot = new Map<string, string[]>();

    for (const file of files) {
        const root = await rootAbove(host, parentOf(file));

        if (root) {
            byRoot.set(root, [...(byRoot.get(root) ?? []), file]);
        }
    }

    const touches = await Promise.all(
        [...byRoot].map(async ([root, held]): Promise<Touch | undefined> => {
            const kept = await notIgnored(host, root, [...new Set(held)]);
            const times = await Promise.all(
                kept.map((file) =>
                    host.stat(file).then(
                        (stat) => stat.mtimeMs,
                        () => 0
                    )
                )
            );
            const at = Math.max(0, ...times);

            return at > 0 ? { root, at } : undefined;
        })
    );

    return touches.filter((touch): touch is Touch => touch !== undefined).sort((a, b) => b.at - a.at);
}

/** The first list of a session the store has none for: the checkouts of the files its GenesisTools journal names. */
async function fromJournal(host: Host, session: string): Promise<Touch[]> {
    const home = (await host.env("GENESIS_TOOLS_HOME")) ?? (await host.env("HOME"));
    const text = home
        ? await host.read(`${home}/.genesis-tools/claude-code/sessions/${session}.json`).catch(() => undefined)
        : undefined;
    let files: string[] = [];

    try {
        const parsed: unknown = text ? JSON.parse(text) : undefined;

        if (isRecord(parsed) && Array.isArray(parsed.files)) {
            files = parsed.files
                .filter((file): file is string => typeof file === "string")
                .slice(-SEED_FILES)
                .map((file) => {
                    try {
                        return decodeURIComponent(file);
                    } catch {
                        return file;
                    }
                })
                .filter((file) => file.startsWith("/"));
        }
    } catch {
        files = [];
    }

    return (await datedRoots(host, files)).slice(0, KEEP_ROOTS);
}

async function readLedger(host: Host, key = STORE_KEY): Promise<Ledger> {
    const value = await host.storeGet(key).catch(async (error: unknown) => {
        await logMod(host, "git", { event: "store-read-failed", key, error: String(error) });
        throw error;
    });
    const ledger: Ledger = {};

    if (isRecord(value)) {
        for (const [session, list] of Object.entries(value)) {
            if (Array.isArray(list)) {
                ledger[session] = list.filter(
                    (touch): touch is Touch =>
                        isRecord(touch) && typeof touch.root === "string" && typeof touch.at === "number"
                );
            }
        }
    }

    return ledger;
}

async function save(host: Host, session: string, touches: Touch[], key = STORE_KEY): Promise<void> {
    const ledger = { ...(await readLedger(host, key)), [session]: touches };
    const newest = (list: Touch[]) => Math.max(0, ...list.map((touch) => touch.at));
    const kept = Object.entries(ledger)
        .sort((a, b) => newest(b[1]) - newest(a[1]))
        .slice(0, KEEP_SESSIONS);

    await host.storeSet(key, Object.fromEntries(kept)).catch(async (error: unknown) => {
        await logMod(host, "git", { event: "store-write-failed", key, session, error: String(error) });
        throw error;
    });
}

async function load(host: Host, session: string): Promise<Touch[]> {
    const stored = (await readLedger(host))[session];

    if (stored !== undefined) {
        return stored;
    }

    const seeded = await fromJournal(host, session);

    if (seeded.length > 0) {
        await save(host, session, seeded);
    }

    return seeded;
}

/** This session's checkouts, the one it worked in last first. */
export async function sessionCheckouts(host: Host): Promise<Touch[]> {
    const session = await host.sessionId();

    if (held?.session === session) {
        return held.touches;
    }

    loading ??= load(host, session).finally(() => {
        loading = undefined;
    });
    const touches = await loading;

    if (held?.session === session) {
        return held.touches;
    }

    held = { session, touches };

    return touches;
}

/**
 * A checkout's main checkout and the branch it has checked out, from its `.git` files without running git: a linked
 * worktree's `.git` file points into `<main>/.git/worktrees/<name>`, whose `HEAD` names the branch.
 */
export async function headOf(host: Host, root: string): Promise<{ repo: string; branch?: string }> {
    const dotGit = `${root}/.git`;
    let gitDir = dotGit;
    let repo = root;

    if ((await host.stat(dotGit).catch(() => undefined))?.kind === "file") {
        const pointed = /^gitdir:\s*(.+)$/m.exec(await host.read(dotGit).catch(() => ""))?.[1]?.trim();

        if (pointed) {
            gitDir = resolveIn(pointed, root, undefined) ?? pointed;
            const at = gitDir.indexOf("/.git/worktrees/");
            repo = at > 0 ? gitDir.slice(0, at) : repo;
        }
    }

    const head = await host.read(`${gitDir}/HEAD`).catch(() => "");

    return { repo, branch: /^ref: refs\/heads\/(.+)$/m.exec(head)?.[1]?.trim() };
}

/** The branches first, then the ones before them, each once, at most `KEEP_BRANCHES`. */
function withBranches(first: readonly (string | undefined)[], before: readonly string[] = []): string[] {
    const names = first.filter((name): name is string => name !== undefined);

    return [...new Set([...names, ...before])].slice(0, KEEP_BRANCHES);
}

/**
 * Records the checkouts a finished tool call worked in, each with its branch and the branches the command made or
 * pushed there. True when one of them was not already the newest, so the band's rows may have moved.
 */
export async function noteToolCall(host: Host, input: unknown): Promise<boolean> {
    const home = await host.env("HOME");
    const files = writtenFiles(input);
    const command = isRecord(input) && input.tool === "Bash" && typeof input.command === "string" ? input.command : "";
    const writes = command ? gitWrites(command, home) : [];

    if (files.length === 0 && writes.length === 0) {
        return false;
    }

    const now = Date.now();
    const named = new Map<string, string[]>();

    for (const touch of await datedRoots(host, files)) {
        named.set(touch.root, []);
    }

    for (const write of writes) {
        const root = await rootAbove(host, write.dir);

        if (root !== null) {
            named.set(root, [...(named.get(root) ?? []), ...write.branches]);
        }
    }

    const roots = [...named.keys()];

    if (roots.length === 0) {
        return false;
    }

    const heads = await Promise.all(roots.map((root) => headOf(host, root)));

    return mutateCheckouts(async () => {
        const before = await sessionCheckouts(host);
        const fresh = roots.map((root, index): Touch => {
            const head = heads[index];
            const previous = before.find((touch) => touch.root === root);

            return {
                root,
                at: now,
                repo: head.repo,
                branches: withBranches([head.branch, ...(named.get(root) ?? [])], previous?.branches),
            };
        });
        const touches = [...fresh, ...before.filter((touch) => !roots.includes(touch.root))].slice(0, KEEP_ROOTS);
        const session = await host.sessionId();

        await save(host, session, touches);
        held = { session, touches };

        return roots.some((root) => before[0]?.root !== root);
    });
}

/**
 * The checkouts the band shows: the session's own folder while it has worked in no checkout (or always, with
 * `cwd: "always"`), the folders added by hand, then up to `checkouts` the session worked in, the last first.
 */
export function pickRoots(
    touches: readonly Touch[],
    cwdRoot: string | undefined,
    settings: { checkouts: number; cwd: "touched" | "always" },
    addedRoots: readonly string[] = []
): string[] {
    const worked = touches
        .map((touch) => touch.root)
        .filter((root) => !addedRoots.includes(root))
        .slice(0, settings.checkouts);
    const own = cwdRoot && (settings.cwd === "always" || worked.length === 0) ? [cwdRoot] : [];

    return [...new Set([...own, ...addedRoots, ...worked])];
}

/** Drops a checkout the session worked in from its band, until the session works there again. */
export async function hideCheckout(host: Host, root: string): Promise<void> {
    return mutateCheckouts(async () => {
        const session = await host.sessionId();
        const touches = (await sessionCheckouts(host)).filter((touch) => touch.root !== root);

        await save(host, session, touches);
        held = { session, touches };
    });
}

/** The folders this session added by hand, newest first, as git roots. */
export async function addedCheckouts(host: Host): Promise<string[]> {
    const session = await host.sessionId();

    if (added?.session === session) {
        return added.roots;
    }

    const stored = (await readLedger(host, ADDED_KEY))[session] ?? [];

    if (added?.session === session) {
        return added.roots;
    }

    added = { session, roots: stored.map((touch) => touch.root) };
    return added.roots;
}

async function saveAdded(host: Host, roots: string[]): Promise<void> {
    const session = await host.sessionId();
    const now = Date.now();

    await save(
        host,
        session,
        roots.map((root) => ({ root, at: now })),
        ADDED_KEY
    );
    added = { session, roots };
}

/** A typed folder as an absolute path: `~/x` under the home, a bare relative one under the session's folder. */
async function expand(host: Host, typed: string): Promise<string> {
    const home = await host.env("HOME");
    const path = absolute(typed.trim(), home);

    return path ?? `${await host.cwd()}/${typed.trim()}`.replace(/\/+$/, "");
}

/** Adds the checkout of a folder to this session's band; the error says why not. */
export async function addCheckout(host: Host, typed: string): Promise<{ root: string } | { error: string }> {
    const path = await expand(host, typed);
    const stat = await host.stat(path).catch(() => undefined);

    if (stat?.kind !== "dir") {
        return { error: `${path} is not a folder` };
    }

    const root = await rootAbove(host, path);

    if (!root) {
        return { error: `${path} is in no git checkout` };
    }

    await mutateCheckouts(async () => {
        await saveAdded(host, [root, ...(await addedCheckouts(host)).filter((held) => held !== root)]);
    });

    return { root };
}

/** Removes a folder added by hand, named by its path or its folder name; false when none matches. */
export async function removeAdded(host: Host, typed: string): Promise<string | undefined> {
    return mutateCheckouts(async () => {
        const roots = await addedCheckouts(host);
        const path = await expand(host, typed);
        const match = roots.find((root) => root === path || root.slice(root.lastIndexOf("/") + 1) === typed.trim());

        if (match) {
            await saveAdded(
                host,
                roots.filter((root) => root !== match)
            );
        }

        return match;
    });
}

export interface FolderSuggestion {
    /** The folder with the casing it has on disk. */
    path: string;
    from: "zoxide" | "folder";
    /** It is in a git checkout, so `/mod-git add` takes it. */
    isGit: boolean;
}

/** zoxide's folders, best first; none without zoxide. One `zoxide query --list` per minute. */
async function zoxideDirs(host: Host): Promise<string[]> {
    if (zoxide && Date.now() - zoxide.at < ZOXIDE_TTL_MS) {
        return zoxide.dirs;
    }

    const run = await host.run(["zoxide", "query", "--list"], { timeoutMs: 3_000 }).catch(() => undefined);
    const dirs = run?.exitCode === 0 ? run.stdout.split("\n").filter((dir) => dir.startsWith("/")) : [];

    zoxide = { at: Date.now(), dirs };

    return dirs;
}

/** zoxide's folders that match a name: the folder name starting with it first, then holding it, then the path. */
export function rankByName(dirs: readonly string[], typed: string): string[] {
    const needle = typed.toLowerCase();
    const nameOf = (dir: string) => dir.slice(dir.lastIndexOf("/") + 1).toLowerCase();
    const tier = (dir: string) =>
        nameOf(dir).startsWith(needle)
            ? 0
            : nameOf(dir).includes(needle)
              ? 1
              : dir.toLowerCase().includes(needle)
                ? 2
                : 3;

    return dirs
        .map((dir, index) => ({ dir, index, tier: tier(dir) }))
        .filter((entry) => entry.tier < 3)
        .sort((a, b) => a.tier - b.tier || a.index - b.index)
        .map((entry) => entry.dir);
}

/**
 * The folder as it is on disk: the casing of each name, from its parent's listing, since zoxide keeps whatever casing
 * a `cd` typed (`ReservineBack` and `Reservineback` on a case-blind disk). Undefined when it is gone.
 */
async function onDisk(
    host: Host,
    path: string,
    listings: Map<string, Promise<FsEntry[]>>
): Promise<string | undefined> {
    const parent = parentOf(path);
    const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();

    if (!listings.has(parent)) {
        listings.set(
            parent,
            host.list(parent).catch(() => [])
        );
    }

    const entry = (await listings.get(parent))?.find(
        (held) => held.name.toLowerCase() === name && (held.kind === "dir" || held.kind === "other")
    );

    return entry ? `${parent === "/" ? "" : parent}/${entry.name}` : undefined;
}

/**
 * Folders for what the person typed: for a `/` or `~/` path, the folders in the folder it names that start with
 * its last part, then zoxide's under it; for a name, zoxide's folders that match it. Each with its casing on disk,
 * once, and gone ones left out.
 */
export async function folderSuggestions(host: Host, typed: string, limit = 8): Promise<FolderSuggestion[]> {
    const text = typed.trim();

    if (!text) {
        return [];
    }

    const home = await host.env("HOME");
    const path = absolute(text, home);
    const found: { path: string; from: FolderSuggestion["from"] }[] = [];

    if (path) {
        const dir = text.endsWith("/") ? path : parentOf(path);
        const start = text.endsWith("/") ? "" : path.slice(path.lastIndexOf("/") + 1).toLowerCase();
        const entries = await host.list(dir).catch(() => []);

        for (const entry of entries) {
            const name = entry.name.toLowerCase();

            if (entry.kind === "dir" && name.startsWith(start) && (start.startsWith(".") || !name.startsWith("."))) {
                found.push({ path: `${dir === "/" ? "" : dir}/${entry.name}`, from: "folder" });
            }
        }

        found.sort((a, b) => a.path.localeCompare(b.path));

        for (const zdir of await zoxideDirs(host)) {
            if (zdir.toLowerCase().startsWith(path.toLowerCase()) && zdir !== path) {
                found.push({ path: zdir, from: "zoxide" });
            }
        }
    } else {
        for (const zdir of rankByName(await zoxideDirs(host), text)) {
            found.push({ path: zdir, from: "zoxide" });
        }
    }

    const listings = new Map<string, Promise<FsEntry[]>>();
    const seen = new Set<string>();
    const out: FolderSuggestion[] = [];

    for (const candidate of found) {
        if (out.length >= limit) {
            break;
        }

        const real = candidate.from === "folder" ? candidate.path : await onDisk(host, candidate.path, listings);

        if (!real || seen.has(real.toLowerCase())) {
            continue;
        }

        seen.add(real.toLowerCase());
        out.push({ path: real, from: candidate.from, isGit: (await rootAbove(host, real)) !== null });
    }

    return out;
}

/** Forgets this module's memory: a test sets up another session. */
export function forgetCheckouts(): void {
    held = undefined;
    added = undefined;
    zoxide = undefined;
    loading = undefined;
    mutations = Promise.resolve();
    rootByDir.clear();
}
