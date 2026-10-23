// The checkouts a session works in, for the git band: the git root of each file the session writes, and of each
// folder where it changes git state (`git -C <dir> commit`, `cd <dir> && git rebase`). A file git ignores does not
// count, so a plan a worktree session writes into the main checkout's `.claude/plans/` leaves the main checkout out.
// Reads and read-only git (status, log, diff) count nothing.
//
// Each session's list lives in the plugin store, so it outlives a hot reload and a resume; the 40 sessions touched
// last are kept. A session with no list yet starts from the GenesisTools file journal
// (`~/.genesis-tools/claude-code/sessions/<id>.json`), each checkout dated by the newest change to one of its files.
//
// The person can also add a folder by hand (`/mod-git add <folder>`, the Git sidebar's field): its checkout shows
// in this session's band until removed. `folderSuggestions` proposes folders for that, from zoxide when it is
// installed (`GenesisPlayg` finds the GenesisPlayground path) and from the folder a typed `/` or `~/` path names.
import type { FsEntry } from "claude-code";
import type { Host } from "./shared";

export interface Touch {
    root: string;
    at: number;
}

const STORE_KEY = "git-band-checkouts";
const ADDED_KEY = "git-band-added";
const ZOXIDE_TTL_MS = 60_000;
const KEEP_SESSIONS = 40;
const KEEP_ROOTS = 12;
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
const rootByDir = new Map<string, string | null>();

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

/** A shell word without its quotes. */
function unquote(word: string): string {
    return /^(["']).*\1$/s.test(word) ? word.slice(1, -1) : word;
}

/**
 * The folders a Bash command changes git state in: `git -C <dir> <verb>`, or `git <verb>` after `cd <dir>` in the
 * same command, for a verb that writes (commit, rebase, stash, push…). Only absolute and `~/` folders count, since
 * the shell's own folder is not known here.
 */
export function gitWriteDirs(command: string, home: string | undefined): string[] {
    const dirs: string[] = [];
    let here: string | undefined;

    for (const part of command.split(/&&|\|\||[;|\n]/)) {
        const words = (part.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(unquote);

        while (words[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
            words.shift();
        }

        if (words[0] === "cd") {
            here = words[1] ? absolute(words[1], home) : undefined;
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
                const value = words[at + 1] ?? "";

                if (flag === "-C") {
                    dir = absolute(value, home) ?? (dir && !value.startsWith("/") ? `${dir}/${value}` : undefined);
                }

                at += 2;
            } else {
                at += 1;
            }
        }

        if (dir && GIT_WRITES.has(words[at] ?? "")) {
            dirs.push(dir);
        }
    }

    return [...new Set(dirs)];
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
    const value = await host.storeGet(key).catch(() => undefined);
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

    await host.storeSet(key, Object.fromEntries(kept)).catch(() => undefined);
}

async function load(host: Host, session: string): Promise<Touch[]> {
    const stored = (await readLedger(host))[session];

    if (stored && stored.length > 0) {
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
    held = { session, touches };

    return touches;
}

/**
 * Records the checkouts a finished tool call worked in. True when one of them was not already the newest, so the
 * band's rows may have moved.
 */
export async function noteToolCall(host: Host, input: unknown): Promise<boolean> {
    const home = await host.env("HOME");
    const files = writtenFiles(input);
    const command = isRecord(input) && input.tool === "Bash" && typeof input.command === "string" ? input.command : "";
    const dirs = command ? gitWriteDirs(command, home) : [];

    if (files.length === 0 && dirs.length === 0) {
        return false;
    }

    const now = Date.now();
    const fromFiles = (await datedRoots(host, files)).map((touch) => touch.root);
    const fromDirs = await Promise.all(dirs.map((dir) => rootAbove(host, dir)));
    const roots = [...new Set([...fromFiles, ...fromDirs.filter((root): root is string => root !== null)])];

    if (roots.length === 0) {
        return false;
    }

    const before = await sessionCheckouts(host);
    const touches = [
        ...roots.map((root) => ({ root, at: now })),
        ...before.filter((touch) => !roots.includes(touch.root)),
    ].slice(0, KEEP_ROOTS);
    const session = await host.sessionId();

    held = { session, touches };
    await save(host, session, touches);

    return roots.some((root) => before[0]?.root !== root);
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
    const session = await host.sessionId();
    const touches = (await sessionCheckouts(host)).filter((touch) => touch.root !== root);

    held = { session, touches };
    await save(host, session, touches);
}

/** The folders this session added by hand, newest first, as git roots. */
export async function addedCheckouts(host: Host): Promise<string[]> {
    const session = await host.sessionId();

    if (added?.session !== session) {
        const stored = (await readLedger(host, ADDED_KEY))[session] ?? [];
        added = { session, roots: stored.map((touch) => touch.root) };
    }

    return added.roots;
}

async function saveAdded(host: Host, roots: string[]): Promise<void> {
    const session = await host.sessionId();
    const now = Date.now();

    added = { session, roots };
    await save(
        host,
        session,
        roots.map((root) => ({ root, at: now })),
        ADDED_KEY
    );
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

    await saveAdded(host, [root, ...(await addedCheckouts(host)).filter((held) => held !== root)]);

    return { root };
}

/** Removes a folder added by hand, named by its path or its folder name; false when none matches. */
export async function removeAdded(host: Host, typed: string): Promise<string | undefined> {
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
    rootByDir.clear();
}
