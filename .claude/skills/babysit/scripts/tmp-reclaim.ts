#!/usr/bin/env bun
/**
 * Reclaim disk from /tmp and $TMPDIR only, safely enough to run unattended next to live agent sessions.
 * (Martin, 2026-10-14: "a SAFE bun script ... which removes anything from the /tmp/ or $TMPDIR/ that can reclaim
 * your space - just dont forget about the live sessions"; first run freed 10.1 GB.)
 *
 * Two phases. A dry run (the default) lists the candidates and writes a plan file. `--apply --plan <file>` removes
 * ONLY what that plan names, only when the plan is at most 30 minutes old, and re-checks every entry first: it must
 * still be the same inode, still old enough, and still not open. A removal is a rename into a scratch folder in the
 * same root, then a delete of that folder, so a half-deleted tree never sits at its old path. That folder is
 * `.tmp-reclaim-<pid>-XXXXXX`; an apply killed before its final delete leaves it behind, and a later run lists it as
 * an ordinary candidate once its pid is gone (an older unnamed one once it is old enough). A session folder keeps its
 * `cc/<project>/<session>` place inside that folder, so the later run still knows its SwiftPM clones (below), and the
 * apply that removes a left-behind folder deletes it where it is. An apply then deletes the plan it ran and every
 * plan in `/tmp/cc` older than the 30 minutes a plan may be applied for.
 *
 * Candidates are the top-level entries of /tmp and $TMPDIR, plus each `/tmp/cc/<project>/<session>` folder (agent
 * scratch). An entry is NEVER a candidate when:
 * - it names a live session: a Claude session whose process runs (Claude Code's registry `~/.claude/sessions`), an
 *   agent transcript changed in the last --live-hours (default 12; for ~/.claude/projects only while that registry
 *   cannot be read, because a Claude session that exited is over however recent its transcript), the run card's
 *   session, or a `--protect <id>`;
 * - it is, contains, or lies within a canonical `--protect <path>`;
 * - it is a system or service entry (com.apple.*, launchd, tmux-*, ssh-*, the Claude harness folders, sockets);
 * - anything inside it is a socket or a FIFO (a live service), or a `.git` (a repository or worktree: remove those
 *   with `git worktree remove` / the worktree-lock release, never by deleting files). The one exception is SwiftPM's
 *   own dependency clone, `<scratch>/checkouts/<package>/.git`, in a dead session's folder, and in the `cc/` folder of
 *   a left-behind apply folder, where only session folders judged that way were moved;
 * - a running process holds a file open inside it (lsof is refreshed before every removal; a failed listing stops apply);
 * - it is, holds or lies in the aside folder of a `tools rm` request that waits for a person (re-read right before
 *   every removal, own-session plans included);
 * - anything inside it changed in the last --min-age-hours (default 6; newest mtime or ctime in the tree);
 * - it is a symlink, belongs to another user, or lives on another device;
 * - its tree could not be scanned within the time budget.
 *
 *   bun tmp-reclaim.ts [--run <dir>] [--min-age-hours 6] [--live-hours 12] [--protect <id|path> ...]
 *   bun tmp-reclaim.ts --own-session <session uuid> [--min-age-minutes 10] [--run <dir>]
 *   bun tmp-reclaim.ts --apply --plan <plan.json> [--run <dir>]
 *
 * `--own-session` is for the session that runs it, which the live-session guard otherwise always shields
 * (2026-10-18: a lead's own `/tmp/cc/GenesisTools/<session>/` held 14 GB of SwiftPM scratch builds while the disk was
 * full). It lists BUILD OUTPUT only, inside `/tmp/cc/<project>/<that session>/`: a SwiftPM triple folder
 * (`arm64-apple-macosx`, `x86_64-apple-macosx`), a SwiftPM scratch folder (`.build` or a `--scratch-path`) that holds
 * nothing but SwiftPM's own entries, and a Swift or clang module cache (only `.pcm`, `.swiftmodule`, `.timestamp`,
 * `.modulevalidation` and `.lock` files). Notes, logs, reply files, patches, briefs, worktrees' sources and the
 * `removals/` folder are never listed. Every other guard stays: no open file, socket, FIFO or `.git` inside, same
 * owner and device, not changed in the last --min-age-minutes (default 10, because the session is live), and on
 * apply the same inode and the same build-output class again. An own-session apply quarantines inside the session
 * folder, which the regular run never opens while the session lives, so the own-session dry run also lists a
 * private `.tmp-reclaim-*` folder directly in the session folder, whole, once the pid in its name is gone.
 */
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    type Stats,
    writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { claudeSessionsDir, liveClaudeSessionIds } from "@genesiscz/utils/claude/peer-message";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { isProcessAlive } from "@genesiscz/utils/process-alive";
import { nativeSessionRoots, nativeTranscriptMaxDepth } from "@genesiscz/utils/providers/session-paths";
import { type PendingAside, pendingAsideDirs, pendingAsideFor } from "@genesiscz/utils/rm/pending-aside";
import { appendEvent } from "./ledger";
import { flag, has } from "./run";

interface Candidate {
    path: string;
    ino: number;
    bytes: number;
    newest: number;
}

interface Plan {
    createdAt: number;
    minAgeHours: number;
    candidates: Candidate[];
    /** Set by an `--own-session` dry run: the apply re-checks each entry as that session's build output. */
    ownSession?: { id: string; dirs: string[]; minAgeMinutes: number };
}

export type BuildOutputKind = "swiftpm-triple" | "swiftpm-scratch" | "module-cache";

const SWIFTPM_TRIPLES = new Set(["arm64-apple-macosx", "x86_64-apple-macosx"]);
/** What SwiftPM itself writes into a scratch path; a folder holding anything else is not pure build output. */
const SWIFTPM_SCRATCH_ENTRIES = new Set([
    ...SWIFTPM_TRIPLES,
    ".lock",
    "artifacts",
    "build.db",
    "checkouts",
    "debug",
    "debug.yaml",
    "index-build",
    "manifest.db",
    "manifest.db-shm",
    "manifest.db-wal",
    "plugin-tools.yaml",
    "plugins",
    "prebuilts",
    "registry",
    "release",
    "release.yaml",
    "repositories",
    "workspace-state.json",
]);
/** What SwiftPM writes into a triple folder: one folder per build configuration. */
const SWIFTPM_TRIPLE_ENTRIES = new Set(["debug", "release"]);
/** What only a SwiftPM scratch path holds; a triple folder counts only beside one of these (or inside `.build`). */
const SWIFTPM_SCRATCH_MARKERS = ["workspace-state.json", "build.db", "debug.yaml", "release.yaml"];
const MODULE_CACHE_FILES = [".pcm", ".swiftmodule", ".timestamp", ".modulevalidation", ".lock"];
const MODULE_CACHE_MARKERS = [".pcm", ".swiftmodule", "modules.timestamp"];
/** Never walked in an own-session scan: dependency trees, repositories and moved-aside files a user may restore. */
/** `rm-aside` holds what `tools rm` set aside for a person: the build output an agent moved there is not its own. */
const OWN_SESSION_SKIP = new Set(["node_modules", ".git", "removals", "rm-aside"]);
const OWN_SESSION_MAX_DEPTH = 12;
const SESSION_UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

const PLAN_MAX_AGE_MS = 30 * 60_000;
const SCAN_BUDGET_MS = 20_000;
const SYSTEM_PREFIXES = ["com.apple.", "launchd", "tmux-", "ssh-", "claude-", "cc-socks", "powerlog", ".X"];
/** An apply's scratch folder for the entries it removes: `.tmp-reclaim-<pid>-XXXXXX` (before 2026-11-01 without pid). */
const QUARANTINE_PREFIX = ".tmp-reclaim-";
/** The whole name `mkdtempSync` gives that folder, with or without the pid. */
const QUARANTINE_NAME = /^\.tmp-reclaim-(?:\d+-)?[A-Za-z0-9]{6}$/;
/**
 * The folder of a regular apply's quarantine that holds the session folders it moved, as `cc/<project>/<session>`.
 * Every other moved entry is named `<n>-<name>`, so this name is never a moved entry.
 */
const QUARANTINE_SESSIONS = "cc";

/** True while the apply that made this quarantine still runs; an orphan, an old unnamed one or another name is false. */
export function isLiveQuarantine(name: string, alive: (pid: number) => boolean = isProcessAlive): boolean {
    const pid = /^\.tmp-reclaim-(\d+)-/.exec(name)?.[1];
    return pid !== undefined && alive(Number(pid));
}
function validAge(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`${label} must be a finite nonnegative number of hours`);
    }
    return value;
}

function ageFlag(name: string, fallback: number): number {
    const raw = flag(name);
    if (has(name) && (raw === undefined || raw.trim() === "")) {
        throw new Error(`${name} must be a finite nonnegative number of hours`);
    }
    return validAge(Number(raw ?? fallback), name);
}

const USAGE = `usage: bun tmp-reclaim.ts [--run <dir>] [--min-age-hours 6] [--live-hours 12] [--protect <id|path> ...]
       bun tmp-reclaim.ts --own-session <session uuid> [--min-age-minutes 10] [--run <dir>]
       bun tmp-reclaim.ts --apply --plan <plan.json> [--run <dir>]

Without --apply it is a dry run: it lists the candidates and writes a plan file. --apply removes only what that
plan names, when the plan is at most 30 minutes old.`;
/** Each flag that takes a value, with what its value is, for the usage error when the value is missing. */
const VALUE_FLAGS = new Map([
    ["--run", "a run folder"],
    ["--min-age-hours", "a number of hours"],
    ["--live-hours", "a number of hours"],
    ["--protect", "a session id or a path"],
    ["--own-session", "the full session uuid"],
    ["--min-age-minutes", "a number of minutes"],
    ["--plan", "a plan file"],
]);

/** An option token, not a value. A negative number such as "-1" stays a value, so its own check names it. */
function isOptionToken(value: string): boolean {
    return value.startsWith("--") || value === "-h";
}

/**
 * Help, an unknown flag and a value flag with no value exit before any scan, so none of them runs a dry run or
 * writes a plan. A value flag never consumes the next option as its value: `--protect --help` or `--run --typo`
 * would otherwise skip that option's own check.
 */
function checkArgs(args: string[]): void {
    for (let i = 0; i < args.length; i++) {
        const arg = args[i] ?? "";

        if (arg === "--help" || arg === "-h") {
            console.log(USAGE);
            process.exit(0);
        }

        const needs = VALUE_FLAGS.get(arg);
        if (needs !== undefined) {
            const value = args[i + 1];
            // Exit 2 like this tool's other usage errors (a bad --own-session, --apply without --plan).
            if (value === undefined || isOptionToken(value)) {
                console.error(`✖ ${arg} needs ${needs}\n\n${USAGE}`);
                process.exit(2);
            }

            i++;
            continue;
        }

        if (arg !== "--apply") {
            console.error(`✖ unknown argument ${arg}\n\n${USAGE}`);
            process.exit(1);
        }
    }
}

if (import.meta.main) {
    checkArgs(process.argv.slice(2));
}

let minAgeHours = ageFlag("--min-age-hours", 6);
const liveHours = ageFlag("--live-hours", 12);
const runDir = flag("--run") ?? env.get("BABYSIT_RUN");
const uid = process.getuid?.() ?? -1;
const roots = [...new Set(["/tmp", env.get("TMPDIR") ?? "/tmp"].map((root) => realpathSync(root)))];

interface Protection {
    ids: string[];
    paths: string[];
}

function canonicalProtection(path: string): string {
    const tail: string[] = [];
    let current = resolve(path);
    while (!existsSync(current)) {
        const parent = dirname(current);
        if (parent === current) {
            throw new Error("cannot canonicalize protected path: " + path);
        }
        tail.unshift(basename(current));
        current = parent;
    }
    return join(realpathSync(current), ...tail);
}

function containsPath(parent: string, child: string): boolean {
    const suffix = relative(parent, child);
    return suffix === "" || (suffix !== ".." && !suffix.startsWith("../") && !isAbsolute(suffix));
}

function protectedEntries(): Protection {
    const explicit = process.argv.flatMap((a, i) => (process.argv[i - 1] === "--protect" ? [a] : []));
    const paths: string[] = [];
    const ids: string[] = [];
    for (const value of explicit) {
        // A bare word stays an id (matched anywhere in a path) even when a file of that name sits in the cwd,
        // so a session id that happens to name a local file never loses its wider protection.
        if (isAbsolute(value) || value.includes("/")) {
            paths.push(canonicalProtection(value));
        } else {
            ids.push(value);
            if (existsSync(value)) {
                paths.push(canonicalProtection(value));
            }
        }
    }
    const cutoff = Date.now() - liveHours * 3_600_000;
    // A running Claude session is live however long it idles, and one that exited is over however recent its
    // transcript: the registry answers for the projects folder beside it. Codex and Grok keep no such registry.
    // Each id goes in as its first 8 hex digits, as the transcript scan below does: a path that names only that
    // short form (`scratch-1b4001ba`) is shielded too, and the full id contains it.
    const runningClaude = liveClaudeSessionIds();
    const registryProjects = runningClaude ? join(dirname(claudeSessionsDir()), "projects") : null;
    ids.push(...[...(runningClaude ?? [])].map((id) => id.slice(0, 8).toLowerCase()));
    const transcriptDirs = (["claude", "codex", "grok"] as const).flatMap((kind) =>
        nativeSessionRoots(kind)
            .filter((top) => resolve(top) !== registryProjects)
            .map((top) => ({ kind, top, depthLimit: nativeTranscriptMaxDepth(kind) }))
    );

    for (const { kind, top, depthLimit } of transcriptDirs) {
        const stack: Array<{ dir: string; depth: number }> = [{ dir: top, depth: 0 }];

        while (stack.length) {
            const { dir, depth } = stack.pop() as { dir: string; depth: number };
            let names: string[] = [];

            try {
                names = readdirSync(dir);
            } catch {
                continue;
            }

            for (const name of names) {
                const path = join(dir, name);
                let st: ReturnType<typeof lstatSync>;

                try {
                    st = lstatSync(path);
                } catch {
                    continue;
                }

                if (st.isDirectory() && depth < depthLimit) {
                    stack.push({ dir: path, depth: depth + 1 });
                } else if (st.isFile() && st.mtimeMs >= cutoff) {
                    // Grok stores chat_history/updates inside the UUID directory; other providers name the file.
                    const identity = kind === "grok" ? basename(dirname(path)) : name;
                    const id = /([0-9a-f]{8})-?[0-9a-f-]{20,}/i.exec(identity)?.[1];

                    if (id) {
                        ids.push(id.toLowerCase());
                    }
                }
            }
        }
    }

    return { ids: [...new Set(ids)], paths: [...new Set(paths)] };
}

export function openPaths(): string[] {
    // lint-rules-ignore: a deletion guard needs every open AND mapped file (lsof's mem rows), which the process layer does not read
    const p = Bun.spawnSync(["lsof", "-n", "-Fn", "-w"], { stdout: "pipe", stderr: "pipe" });
    const out = p.stdout.toString();

    if (p.exitCode !== 0 || p.stderr.length > 0 || !out.includes("\nn/")) {
        throw new Error(`lsof listing incomplete (exit ${p.exitCode}): refusing to judge what is open`);
    }

    return out
        .split("\n")
        .filter((line) => line.startsWith("n/"))
        .map((line) => line.slice(1));
}

/**
 * True for `<scratch>/checkouts/<package>/.git` when `<scratch>` is a SwiftPM scratch path: a `.build`, a folder with
 * one of SwiftPM's own state files, or a folder whose `repositories/` the clone takes its objects from (a resolve
 * killed before SwiftPM wrote its state files). SwiftPM clones its dependencies there; the user never works in them.
 */
function isSwiftpmCheckoutGit(gitPath: string): boolean {
    const checkouts = dirname(dirname(gitPath));

    if (basename(checkouts) !== "checkouts") {
        return false;
    }

    const scratch = dirname(checkouts);
    const names = childNames(scratch) ?? [];

    if (basename(scratch) === ".build" || names.some((n) => SWIFTPM_SCRATCH_MARKERS.includes(n))) {
        return true;
    }

    // Anyone can name a folder `repositories`, so it counts only for a clone SwiftPM made from it: SwiftPM runs
    // `git clone --shared` from `repositories/<package>-<hash>`, which names that folder's objects in the alternates.
    return names.includes("repositories") && borrowsObjectsFrom(gitPath, join(scratch, "repositories"));
}

/** True when a clone borrows objects (`objects/info/alternates`) and every store it borrows from lies inside `dir`. */
function borrowsObjectsFrom(gitPath: string, dir: string): boolean {
    try {
        if (!lstatSync(dir).isDirectory()) {
            return false;
        }

        const real = realpathSync(dir);
        const objects = join(gitPath, "objects");
        const stores = readFileSync(join(objects, "info", "alternates"), "utf8")
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== "" && !line.startsWith("#"));
        return (
            stores.length > 0 && stores.every((store) => realpathSync(resolve(objects, store)).startsWith(`${real}/`))
        );
    } catch {
        return false;
    }
}

/** True for `<tmp root>/cc/<project>/<session>`, the folder of one agent session's scratch. */
function isSessionScratch(path: string): boolean {
    const root = roots[0];

    if (root === undefined || !path.startsWith(`${root}/`)) {
        return false;
    }

    const parts = relative(root, path).split("/");
    return parts.length === 3 && parts[0] === "cc";
}

/** A regular apply's quarantine: a private (0700) folder of mkdtemp's name directly in /tmp, where session folders go. */
function isRegularQuarantine(path: string, st: Stats): boolean {
    return (
        dirname(path) === roots[0] &&
        QUARANTINE_NAME.test(basename(path)) &&
        st.isDirectory() &&
        (st.mode & 0o777) === 0o700
    );
}

/**
 * Which `.git` folders in a top-level entry are a dead session's SwiftPM dependency clones, which scan lets through:
 * - in a session's scratch folder, one that isSwiftpmCheckoutGit proves SwiftPM made;
 * - in a killed regular apply's quarantine, one of SwiftPM's shape `checkouts/<package>/.git` inside its `cc/` folder.
 *   Apply moves only session folders there, each judged by the first rule just before the move, and the delete that
 *   was killed may since have taken the state files that rule reads. A `.git` anywhere else in the quarantine (in a
 *   moved top-level entry) still refuses it.
 */
function swiftpmClones(path: string, st: Stats): (gitPath: string) => boolean {
    if (isSessionScratch(path)) {
        return isSwiftpmCheckoutGit;
    }

    if (isRegularQuarantine(path, st)) {
        const sessions = join(path, QUARANTINE_SESSIONS);
        return (gitPath) => containsPath(sessions, gitPath) && basename(dirname(dirname(gitPath))) === "checkouts";
    }

    return () => false;
}

/**
 * Newest change time and size of a tree, symlinks not followed; null when the tree must not be touched.
 * `swiftpmClone` names the `.git` folders that are SwiftPM's own dependency clones (swiftpmClones); every other one
 * refuses the tree.
 */
function scan(
    path: string,
    rootDev: number,
    swiftpmClone: (gitPath: string) => boolean = () => false
): { newest: number; bytes: number } | { refuse: string } {
    const deadline = Date.now() + SCAN_BUDGET_MS;
    let newest = 0;
    let bytes = 0;
    const stack = [path];

    while (stack.length) {
        if (Date.now() > deadline) {
            return { refuse: "too-big-to-scan" };
        }

        const p = stack.pop() as string;
        let st: ReturnType<typeof lstatSync>;

        try {
            st = lstatSync(p);
        } catch {
            return { refuse: "unreadable" };
        }

        if (st.dev !== rootDev) {
            return { refuse: "other-device" };
        }

        if (st.isSocket() || st.isFIFO()) {
            return { refuse: "socket" };
        }

        if (basename(p) === ".git" && !swiftpmClone(p)) {
            return { refuse: "git-checkout" };
        }

        newest = Math.max(newest, st.mtimeMs, st.ctimeMs);
        bytes += st.isFile() ? st.blocks * 512 : 0;

        if (st.isDirectory()) {
            try {
                for (const name of readdirSync(p)) {
                    stack.push(join(p, name));
                }
            } catch {
                return { refuse: "unreadable" };
            }
        }
    }

    return { newest, bytes };
}

/**
 * A candidate, or why `path` is not one. `pending` holds the aside folders of the `tools rm` requests that still wait
 * for a person: a folder that is one, holds one or sits in one is never listed, since its copy is the only one left.
 */
export function judge(
    path: string,
    protection: Protection,
    open: string[],
    pending: readonly PendingAside[] = pendingAsideDirs()
): Candidate | string {
    const name = basename(path);
    let st: ReturnType<typeof lstatSync>;

    try {
        st = lstatSync(path);
    } catch {
        return "gone";
    }

    if (st.isSymbolicLink()) {
        return "symlink";
    }

    if (st.uid !== uid) {
        return "other-user";
    }

    // A per-user macOS daemon keeps its scratch in $TMPDIR under its own name (mobiletimerd, studentd).
    if (SYSTEM_PREFIXES.some((prefix) => name.startsWith(prefix)) || /^[a-z]+d$/.test(name)) {
        return "system";
    }

    if (isLiveQuarantine(name)) {
        return "live-quarantine";
    }

    const run = runDir && existsSync(runDir) ? realpathSync(runDir) : null;

    if (
        protection.ids.some((id) => path.toLowerCase().includes(id.toLowerCase())) ||
        protection.paths.some(
            (protectedPath) => containsPath(path, protectedPath) || containsPath(protectedPath, path)
        ) ||
        (run && (run === path || run.startsWith(`${path}/`)))
    ) {
        return "live-session";
    }

    // b9gbg4 (2026-11-01): a reclaim plan named a session folder that held a pending aside copy, and the copy was
    // deleted without a person. Only `tools rm` checked that guard before.
    let real: string;

    try {
        real = realpathSync(path);
    } catch {
        return "gone";
    }

    if (pendingAsideFor(real, pending) || pendingAsideFor(path, pending)) {
        return "aside-pending";
    }

    if (open.some((o) => o === path || o.startsWith(`${path}/`))) {
        return "open-file";
    }

    const root = roots.find((r) => path.startsWith(`${r}/`)) ?? path;
    const tree = scan(path, lstatSync(root).dev, swiftpmClones(path, st));

    if ("refuse" in tree) {
        return tree.refuse;
    }

    if (Date.now() - tree.newest < minAgeHours * 3_600_000) {
        return "recent";
    }

    return { path, ino: st.ino, bytes: tree.bytes, newest: tree.newest };
}

function childNames(path: string): string[] | null {
    try {
        return readdirSync(path);
    } catch {
        return null;
    }
}

/** True when every file of the tree is a module-cache file and at least one is a compiled module. */
function isModuleCache(path: string): boolean {
    const deadline = Date.now() + SCAN_BUDGET_MS;
    const stack = [path];
    let modules = 0;

    while (stack.length) {
        if (Date.now() > deadline) {
            return false;
        }

        const p = stack.pop() as string;
        const st = lstatSync(p, { throwIfNoEntry: false });

        if (!st || st.isSymbolicLink()) {
            return false;
        }

        if (st.isDirectory()) {
            const names = childNames(p);

            if (!names) {
                return false;
            }

            stack.push(...names.map((name) => join(p, name)));
            continue;
        }

        if (!st.isFile() || !MODULE_CACHE_FILES.some((ext) => p.endsWith(ext))) {
            return false;
        }

        if (p.endsWith(".pcm") || p.endsWith(".swiftmodule")) {
            modules++;
        }
    }

    return modules > 0;
}

/** Which kind of regenerable build output a folder is, or null when it is anything else. */
export function buildOutputKind(path: string): BuildOutputKind | null {
    const st = lstatSync(path, { throwIfNoEntry: false });

    if (!st?.isDirectory() || st.isSymbolicLink()) {
        return null;
    }

    const name = basename(path);

    if (SWIFTPM_TRIPLES.has(name)) {
        // The name alone proves nothing: a saved or moved-aside folder can carry it. SwiftPM made it only when it sits
        // in a scratch path and holds nothing but configuration folders.
        const parent = dirname(path);
        const children = childNames(path) ?? [];
        const inScratch =
            basename(parent) === ".build" ||
            (childNames(parent) ?? []).some((child) => SWIFTPM_SCRATCH_MARKERS.includes(child));
        const onlyConfigs = children.length > 0 && children.every((child) => SWIFTPM_TRIPLE_ENTRIES.has(child));
        return inScratch && onlyConfigs ? "swiftpm-triple" : null;
    }

    const names = childNames(path) ?? [];

    if (
        names.length > 0 &&
        names.every((child) => SWIFTPM_SCRATCH_ENTRIES.has(child)) &&
        (name === ".build" || names.includes("workspace-state.json") || names.some((n) => SWIFTPM_TRIPLES.has(n)))
    ) {
        return "swiftpm-scratch";
    }

    if (names.some((child) => MODULE_CACHE_MARKERS.some((m) => child.endsWith(m))) && isModuleCache(path)) {
        return "module-cache";
    }

    return null;
}

/** The scratch folders of one session: every `<ccRoot>/<project>/<session uuid>` that is a real folder. */
export function ownSessionDirs(id: string, ccRoot: string): string[] {
    if (!SESSION_UUID.test(id)) {
        throw new Error(`--own-session needs the full session uuid, got ${SafeJSON.stringify(id)}`);
    }

    // `/tmp/cc` also holds plain files (a stray install log): `lstat` of `<file>/<id>` throws ENOTDIR,
    // which `throwIfNoEntry` does not cover, so only real project folders are joined.
    return (childNames(ccRoot) ?? [])
        .filter((project) => lstatSync(join(ccRoot, project), { throwIfNoEntry: false })?.isDirectory() === true)
        .map((project) => join(ccRoot, project, id))
        .filter((dir) => {
            const st = lstatSync(dir, { throwIfNoEntry: false });
            return Boolean(st?.isDirectory() && !st.isSymbolicLink());
        });
}

/**
 * The build output inside one session folder. A SwiftPM scratch folder whose tree the guards refuse (its
 * `checkouts/` are git clones) is not listed whole; its triple folders below it are.
 */
export function ownBuildOutput(sessionDir: string): string[] {
    const out: string[] = [];
    const rootDev = lstatSync(sessionDir).dev;
    const stack: Array<{ dir: string; depth: number }> = [{ dir: sessionDir, depth: 0 }];

    while (stack.length) {
        const { dir, depth } = stack.pop() as { dir: string; depth: number };

        for (const name of childNames(dir) ?? []) {
            const path = join(dir, name);
            const st = lstatSync(path, { throwIfNoEntry: false });

            if (!st?.isDirectory() || st.isSymbolicLink() || OWN_SESSION_SKIP.has(name)) {
                continue;
            }

            // An own-session apply quarantines in the session folder itself: such a folder is listed whole, and
            // judgeOwn decides whether its apply still runs. Its moved entries (`0-arm64-apple-macosx`) are never
            // listed one by one.
            if (depth === 0 && QUARANTINE_NAME.test(name)) {
                out.push(path);
                continue;
            }

            const kind = buildOutputKind(path);

            if (kind === "swiftpm-scratch" && "refuse" in scan(path, rootDev)) {
                stack.push({ dir: path, depth: depth + 1 });
                continue;
            }

            if (kind) {
                out.push(path);
                continue;
            }

            if (depth < OWN_SESSION_MAX_DEPTH) {
                stack.push({ dir: path, depth: depth + 1 });
            }
        }
    }

    return out.sort();
}

/**
 * The guards for one entry of an own-session plan; the live-session guard is the one it leaves out. A pending
 * `tools rm` aside folder is refused here too: the session that runs the reclaim is the one that asked.
 */
export function judgeOwn(
    path: string,
    options: { sessionDirs: string[]; open: string[]; minAgeMinutes: number; pending?: readonly PendingAside[] }
): Candidate | string {
    const st = lstatSync(path, { throwIfNoEntry: false });

    if (!st) {
        return "gone";
    }

    if (st.isSymbolicLink()) {
        return "symlink";
    }

    if (st.uid !== uid) {
        return "other-user";
    }

    const real = realpathSync(path);
    const sessionDir = options.sessionDirs
        .filter((dir) => existsSync(dir))
        .map((dir) => realpathSync(dir))
        .find((dir) => real.startsWith(`${dir}/`));

    if (!sessionDir) {
        return "outside-session";
    }

    if (
        relative(sessionDir, real)
            .split("/")
            .some((part) => OWN_SESSION_SKIP.has(part))
    ) {
        return "skipped-folder";
    }

    const pending = options.pending ?? pendingAsideDirs();

    if (pendingAsideFor(real, pending) || pendingAsideFor(path, pending)) {
        return "aside-pending";
    }

    // The quarantine a killed own-session apply left in the session folder: a private (0700) folder of mkdtemp's
    // name, holding only entries that apply judged. It goes whole once the apply's pid is gone.
    const quarantine =
        dirname(real) === sessionDir &&
        QUARANTINE_NAME.test(basename(real)) &&
        st.isDirectory() &&
        (st.mode & 0o777) === 0o700;

    if (quarantine && isLiveQuarantine(basename(real))) {
        return "live-quarantine";
    }

    if (!quarantine && !buildOutputKind(path)) {
        return "not-build-output";
    }

    if (options.open.some((o) => o === path || o.startsWith(`${path}/`) || o === real || o.startsWith(`${real}/`))) {
        return "open-file";
    }

    const tree = scan(path, lstatSync(sessionDir).dev);

    if ("refuse" in tree) {
        return tree.refuse;
    }

    if (Date.now() - tree.newest < options.minAgeMinutes * 60_000) {
        return "recent";
    }

    return { path, ino: st.ino, bytes: tree.bytes, newest: tree.newest };
}

/**
 * Why apply must not move `path` now, or null. Read fresh, immediately before the irreversible move, for both plan
 * kinds: scanning earlier candidates may take minutes, and a `tools rm` run can put an aside copy under the entry or
 * a process can open a file in it meanwhile. The pending asides are read after the slow lsof listing, so they are the
 * last thing read before the rename; both the lexical and the canonical path are checked. A failed lsof listing
 * throws and stops apply: an old snapshot cannot authorize a deletion. Tests pass `open` and `pending`.
 */
export function moveBlocker(
    path: string,
    fresh: { open?: readonly string[]; pending?: readonly PendingAside[] } = {}
): string | null {
    const open = fresh.open ?? openPaths();
    let real: string;

    try {
        real = realpathSync(path);
    } catch {
        return "gone";
    }

    const inside = (o: string) => o === path || o.startsWith(`${path}/`) || o === real || o.startsWith(`${real}/`);

    if (open.some(inside)) {
        return "open-file";
    }

    const pending = fresh.pending ?? pendingAsideDirs();

    if (pendingAsideFor(real, pending) || pendingAsideFor(path, pending)) {
        return "aside-pending";
    }

    return null;
}

/** The session folder an own-session entry sits in (canonical paths only): its quarantine goes there, on one volume. */
function ownRoot(path: string, sessionDirs: string[]): string | null {
    if (typeof path !== "string" || resolve(path) !== path || realpathSync(path) !== path) {
        return null;
    }

    return (
        sessionDirs
            .filter((dir) => existsSync(dir))
            .map((dir) => realpathSync(dir))
            .find((dir) => path.startsWith(`${dir}/`)) ?? null
    );
}

/** Only canonical paths (realpath equal, so no symlink anywhere in them) with the planner's shapes may be reclaimed. */
function candidateRoot(path: string): string | null {
    if (typeof path !== "string" || resolve(path) !== path) {
        return null;
    }

    const root = roots.find((r) => path.startsWith(r + "/"));
    if (!root) {
        return null;
    }

    const parts = relative(root, path).split("/");
    const session = root === roots[0] && parts.length === 3 && parts[0] === "cc";
    if ((!session && (parts.length !== 1 || parts[0] === "cc")) || realpathSync(path) !== path) {
        return null;
    }

    return root;
}

function entries(): string[] {
    const out: string[] = [];

    for (const root of roots) {
        for (const name of readdirSync(root)) {
            const path = join(root, name);

            // Agent scratch is judged per session folder, so one live session does not shield every dead one.
            if (path === join(roots[0] ?? "/tmp", "cc")) {
                if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) {
                    continue;
                }

                for (const project of readdirSync(path)) {
                    const projectPath = join(path, project);

                    if (lstatSync(projectPath).isDirectory()) {
                        out.push(...readdirSync(projectPath).map((session) => join(projectPath, session)));
                    }
                }

                continue;
            }

            out.push(path);
        }
    }

    return out;
}

/**
 * An own-session plan as the dry run writes it: a full uuid, each folder a canonical `<tmp root>/cc/<project>/<uuid>`,
 * and a finite nonnegative age. A hand-edited or stale plan must not point apply at a `.build` outside `/tmp/cc`.
 */
function validOwnSession(own: unknown): own is NonNullable<Plan["ownSession"]> {
    const { id, dirs, minAgeMinutes } = (typeof own === "object" && own !== null ? own : {}) as Record<string, unknown>;
    if (typeof id !== "string" || !SESSION_UUID.test(id) || !Array.isArray(dirs) || dirs.length === 0) {
        return false;
    }

    if (typeof minAgeMinutes !== "number" || !Number.isFinite(minAgeMinutes) || minAgeMinutes < 0) {
        return false;
    }

    return dirs.every(
        (dir) =>
            typeof dir === "string" &&
            basename(dir) === id &&
            roots.some((root) => dirname(dirname(dir)) === join(root, "cc")) &&
            existsSync(dir) &&
            realpathSync(dir) === dir
    );
}

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(2)} GB`;

function ownSessionDryRun(id: string): void {
    if (!SESSION_UUID.test(id)) {
        console.error(`✖ --own-session needs the full session uuid, got ${SafeJSON.stringify(id)}`);
        process.exit(2);
    }

    const rawAge = flag("--min-age-minutes");
    const minAgeMinutes = has("--min-age-minutes") && !rawAge?.trim() ? Number.NaN : Number(rawAge ?? 10);

    if (!Number.isFinite(minAgeMinutes) || minAgeMinutes < 1) {
        console.error("✖ --min-age-minutes must be at least 1");
        process.exit(2);
    }

    const dirs = ownSessionDirs(id, join(roots[0] ?? "/tmp", "cc"));

    if (dirs.length === 0) {
        console.error(`✖ no /tmp/cc/<project>/${id} folder`);
        process.exit(2);
    }

    const open = openPaths();
    const candidates: Candidate[] = [];
    const skipped: Record<string, number> = {};

    for (const path of dirs.flatMap((dir) => ownBuildOutput(dir))) {
        const verdict = judgeOwn(path, { sessionDirs: dirs, open, minAgeMinutes });

        if (typeof verdict === "string") {
            skipped[verdict] = (skipped[verdict] ?? 0) + 1;
        } else {
            candidates.push(verdict);
        }
    }

    candidates.sort((a, b) => b.bytes - a.bytes);

    for (const c of candidates.slice(0, 40)) {
        const age = ((Date.now() - c.newest) / 60_000).toFixed(0);
        console.log(`${(c.bytes / 1e6).toFixed(0).padStart(7)} MB  ${age.padStart(6)} min  ${c.path}`);
    }

    const total = candidates.reduce((sum, c) => sum + c.bytes, 0);
    const planDir = runDir ? join(runDir, "logs") : join(roots[0] ?? "/tmp", "cc");
    mkdirSync(planDir, { recursive: true });
    const planPath = join(planDir, `tmp-reclaim-plan-${Date.now()}.json`);
    const plan: Plan = { createdAt: Date.now(), minAgeHours: 0, candidates, ownSession: { id, dirs, minAgeMinutes } };
    writeFileSync(planPath, SafeJSON.stringify(plan, null, 2));
    console.log(
        `${candidates.length} build-output candidates of session ${id}, ${gb(total)}; skipped ${SafeJSON.stringify(skipped)}`
    );
    console.log(`plan: ${planPath}\napply it within 30 minutes: bun tmp-reclaim.ts --apply --plan ${planPath}`);
    process.exit(0);
}

function main(): void {
    // A missing or empty value (an unset "$SESSION") is refused, never read as "no session": the regular run lists
    // every other session's entries.
    if (!has("--apply") && has("--own-session")) {
        ownSessionDryRun(flag("--own-session") ?? "");
    }

    if (!has("--apply")) {
        const protection = protectedEntries();
        const open = openPaths();
        const pending = pendingAsideDirs();
        const candidates: Candidate[] = [];
        const skipped: Record<string, number> = {};

        for (const path of entries()) {
            const verdict = judge(path, protection, open, pending);

            if (typeof verdict === "string") {
                skipped[verdict] = (skipped[verdict] ?? 0) + 1;
            } else {
                candidates.push(verdict);
            }
        }

        candidates.sort((a, b) => b.bytes - a.bytes);

        for (const c of candidates.slice(0, 40)) {
            const age = ((Date.now() - c.newest) / 3_600_000).toFixed(1);
            console.log(`${(c.bytes / 1e6).toFixed(0).padStart(7)} MB  ${age.padStart(6)} h  ${c.path}`);
        }

        const total = candidates.reduce((sum, c) => sum + c.bytes, 0);
        const planDir = runDir ? join(runDir, "logs") : join(roots[0] ?? "/tmp", "cc");
        mkdirSync(planDir, { recursive: true });
        const planPath = join(planDir, `tmp-reclaim-plan-${Date.now()}.json`);
        const plan: Plan = { createdAt: Date.now(), minAgeHours, candidates };
        writeFileSync(planPath, SafeJSON.stringify(plan, null, 2));
        console.log(
            `${candidates.length} candidates, ${gb(total)}; protected ids ${protection.ids.length}, paths ${protection.paths.length}; skipped ${SafeJSON.stringify(skipped)}`
        );
        console.log(`plan: ${planPath}\napply it within 30 minutes: bun tmp-reclaim.ts --apply --plan ${planPath}`);
        process.exit(0);
    }

    const planPath = flag("--plan");

    if (!planPath || !existsSync(planPath)) {
        console.error("✖ --apply needs --plan <file> from a dry run");
        process.exit(2);
    }

    const plan = SafeJSON.parse(readFileSync(planPath, "utf8"), { strict: true }) as Plan;

    const age = Date.now() - plan.createdAt;
    if (
        typeof plan.createdAt !== "number" ||
        !Number.isFinite(plan.createdAt) ||
        !Number.isFinite(age) ||
        age < 0 ||
        age > PLAN_MAX_AGE_MS
    ) {
        console.error("✖ the plan needs a finite numeric createdAt within the last 30 minutes: run the dry run again");
        process.exit(2);
    }

    // The dry run decided with its own threshold; the re-check uses the same one.
    minAgeHours = validAge(plan.minAgeHours, "plan.minAgeHours");

    const own = plan.ownSession;
    if (own !== undefined && !validOwnSession(own)) {
        console.error(
            "✖ the plan's ownSession needs a full session uuid, folders <tmp>/cc/<project>/<that uuid> and a finite nonnegative minAgeMinutes"
        );
        process.exit(2);
    }

    // An own-session plan is re-checked by judgeOwn, which needs no live-session list (that scan reads every
    // agent's transcript folders).
    const protection = own ? null : protectedEntries();
    const open = openPaths();
    let freed = 0;
    let removed = 0;
    const refused: Record<string, number> = {};

    // Only these exclusively created, private (0700) directories belong to this run.
    const quarantines = new Map<string, string>();
    try {
        for (const planned of plan.candidates) {
            let root: string | null = null;
            try {
                root = own ? ownRoot(planned.path, own.dirs) : candidateRoot(planned.path);
            } catch {
                // A vanished or unreadable path is no longer a candidate either.
            }

            if (!root) {
                refused["invalid-path"] = (refused["invalid-path"] ?? 0) + 1;
                continue;
            }

            const now = own
                ? judgeOwn(planned.path, { sessionDirs: own.dirs, open, minAgeMinutes: own.minAgeMinutes })
                : judge(planned.path, protection ?? protectedEntries(), open);

            if (typeof now === "string" || now.ino !== planned.ino) {
                const why = typeof now === "string" ? now : "replaced";
                refused[why] = (refused[why] ?? 0) + 1;
                continue;
            }

            const blocker = moveBlocker(planned.path);
            if (blocker) {
                refused[blocker] = (refused[blocker] ?? 0) + 1;
                continue;
            }

            // A killed apply's quarantine is out of the way already, so it is deleted where it is. Moved into this
            // run's quarantine, its session folders would leave its `cc/` folder, and a second killed apply would
            // strand their SwiftPM clones behind the `.git` guard.
            const plannedSt = lstatSync(planned.path, { throwIfNoEntry: false });
            if (!own && plannedSt && isRegularQuarantine(planned.path, plannedSt)) {
                try {
                    rmSync(planned.path, { recursive: true, force: true });
                    removed++;
                    freed += now.bytes;
                } catch (error) {
                    console.error(`could not delete ${planned.path}: ${String(error)}`);
                }
                continue;
            }

            let trash = quarantines.get(root);
            if (!trash) {
                trash = mkdtempSync(join(root, `${QUARANTINE_PREFIX}${process.pid}-`));
                quarantines.set(root, trash);
            }

            try {
                // A session folder keeps its `cc/<project>/<session>` place, so a run after a killed apply still
                // knows its SwiftPM clones (swiftpmClones). Every other entry is `<n>-<name>`.
                const target =
                    !own && isSessionScratch(planned.path)
                        ? join(trash, relative(root, planned.path))
                        : join(trash, `${removed}-${basename(planned.path)}`);
                mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
                renameSync(planned.path, target);
                removed++;
                freed += now.bytes;
            } catch (error) {
                console.error(`could not move ${planned.path}: ${String(error)}`);
            }
        }
    } finally {
        for (const trash of quarantines.values()) {
            rmSync(trash, { recursive: true, force: true });
        }
    }

    const summary = `removed ${removed} of ${plan.candidates.length} planned entries, about ${gb(freed)}; refused at apply ${SafeJSON.stringify(refused)}`;
    console.log(summary);
    removeSpentPlans(planPath);

    if (runDir) {
        appendEvent(runDir, { kind: "note", text: `tmp-reclaim: ${summary} (plan ${planPath})` });
    }
}

/**
 * The plan just applied, and every plan in the default `/tmp/cc` folder past the 30 minutes an apply accepts: none of
 * them can authorize anything any more. A plan under `--run <dir>/logs` stays, as part of that run's record.
 */
function removeSpentPlans(appliedPlan: string): void {
    const planDir = join(roots[0] ?? "/tmp", "cc");
    const isPlan = (name: string) => /^tmp-reclaim-plan-\d+\.json$/.test(name);
    // `planDir` is canonical (`/private/tmp/cc` on macOS), so the applied plan is compared by its canonical folder:
    // `--plan /tmp/cc/<plan>` or a relative path names the same file.
    let applied = resolve(appliedPlan);
    try {
        applied = join(realpathSync(dirname(applied)), basename(applied));
    } catch {
        // Its folder went away after the apply read it: nothing in planDir can be that plan then.
    }

    for (const name of childNames(planDir) ?? []) {
        const path = join(planDir, name);
        const st = isPlan(name) ? lstatSync(path, { throwIfNoEntry: false }) : undefined;

        if (st?.isFile() && st.uid === uid && (path === applied || Date.now() - st.mtimeMs > PLAN_MAX_AGE_MS)) {
            rmSync(path, { force: true });
        }
    }
}

if (import.meta.main) {
    main();
}
