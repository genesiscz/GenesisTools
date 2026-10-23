#!/usr/bin/env bun
/**
 * Reclaim disk from /tmp and $TMPDIR only, safely enough to run unattended next to live agent sessions.
 * (Martin, 2026-10-14: "a SAFE bun script ... which removes anything from the /tmp/ or $TMPDIR/ that can reclaim
 * your space - just dont forget about the live sessions"; first run freed 10.1 GB.)
 *
 * Two phases. A dry run (the default) lists the candidates and writes a plan file. `--apply --plan <file>` removes
 * ONLY what that plan names, only when the plan is at most 30 minutes old, and re-checks every entry first: it must
 * still be the same inode, still old enough, and still not open. A removal is a rename into a scratch folder in the
 * same root, then a delete of that folder, so a half-deleted tree never sits at its old path.
 *
 * Candidates are the top-level entries of /tmp and $TMPDIR, plus each `/tmp/cc/<project>/<session>` folder (agent
 * scratch). An entry is NEVER a candidate when:
 * - it names a live session: an agent transcript (~/.claude/projects, ~/.codex/sessions, ~/.grok) changed in the
 *   last --live-hours (default 12), the run card's session, or a `--protect <id>`;
 * - it is, contains, or lies within a canonical `--protect <path>`;
 * - it is a system or service entry (com.apple.*, launchd, tmux-*, ssh-*, the Claude harness folders, sockets);
 * - anything inside it is a socket or a FIFO (a live service), or a `.git` (a repository or worktree: remove those
 *   with `git worktree remove` / the worktree-lock release, never by deleting files);
 * - a running process holds a file open inside it (lsof is refreshed before every removal; a failed listing stops apply);
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
 * apply the same inode and the same build-output class again.
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
    writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { nativeSessionRoots, nativeTranscriptMaxDepth } from "@genesiscz/utils/providers/session-paths";
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
const OWN_SESSION_SKIP = new Set(["node_modules", ".git", "removals"]);
const OWN_SESSION_MAX_DEPTH = 12;
const SESSION_UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

const PLAN_MAX_AGE_MS = 30 * 60_000;
const SCAN_BUDGET_MS = 20_000;
const SYSTEM_PREFIXES = [
    "com.apple.",
    "launchd",
    "tmux-",
    "ssh-",
    "claude-",
    "cc-socks",
    "powerlog",
    ".X",
    ".tmp-reclaim-",
];
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
    const transcriptDirs = (["claude", "codex", "grok"] as const).flatMap((kind) =>
        nativeSessionRoots(kind).map((top) => ({ kind, top, depthLimit: nativeTranscriptMaxDepth(kind) }))
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

/** Newest change time and size of a tree, symlinks not followed; null when the tree must not be touched. */
function scan(path: string, rootDev: number): { newest: number; bytes: number } | { refuse: string } {
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

        if (basename(p) === ".git") {
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

function judge(path: string, protection: Protection, open: string[]): Candidate | string {
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

    if (open.some((o) => o === path || o.startsWith(`${path}/`))) {
        return "open-file";
    }

    const root = roots.find((r) => path.startsWith(`${r}/`)) ?? path;
    const tree = scan(path, lstatSync(root).dev);

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

/** The guards for one entry of an own-session plan; the live-session guard is the one it leaves out. */
export function judgeOwn(
    path: string,
    options: { sessionDirs: string[]; open: string[]; minAgeMinutes: number }
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

    const kind = buildOutputKind(path);

    if (!kind) {
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
        const candidates: Candidate[] = [];
        const skipped: Record<string, number> = {};

        for (const path of entries()) {
            const verdict = judge(path, protection, open);

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

            // Scanning earlier candidates may take minutes. Refresh immediately before the irreversible move.
            // A failed listing throws and stops apply; an old snapshot cannot authorize a deletion.
            const freshOpen = openPaths();
            if (freshOpen.some((path) => path === planned.path || path.startsWith(planned.path + "/"))) {
                refused["open-file"] = (refused["open-file"] ?? 0) + 1;
                continue;
            }

            let trash = quarantines.get(root);
            if (!trash) {
                trash = mkdtempSync(join(root, ".tmp-reclaim-"));
                quarantines.set(root, trash);
            }

            try {
                renameSync(planned.path, join(trash, `${removed}-${basename(planned.path)}`));
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

    if (runDir) {
        appendEvent(runDir, { kind: "note", text: `tmp-reclaim: ${summary} (plan ${planPath})` });
    }
}

if (import.meta.main) {
    main();
}
