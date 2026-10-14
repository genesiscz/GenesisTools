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
 *   last --live-hours (default 12), the run card's session, or a `--protect <id-or-path>`;
 * - it is a system or service entry (com.apple.*, launchd, tmux-*, ssh-*, the Claude harness folders, sockets);
 * - anything inside it is a socket or a FIFO (a live service), or a `.git` (a repository or worktree: remove those
 *   with `git worktree remove` / the worktree-lock release, never by deleting files);
 * - a running process holds a file open inside it (one lsof listing; if lsof fails, the whole run stops);
 * - anything inside it changed in the last --min-age-hours (default 6; newest mtime or ctime in the tree);
 * - it is a symlink, belongs to another user, or lives on another device;
 * - its tree could not be scanned within the time budget.
 *
 *   bun tmp-reclaim.ts [--run <dir>] [--min-age-hours 6] [--live-hours 12] [--protect <id|path> ...]
 *   bun tmp-reclaim.ts --apply --plan <plan.json> [--run <dir>]
 */
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
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
}

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
let minAgeHours = Number(flag("--min-age-hours") ?? 6);
const liveHours = Number(flag("--live-hours") ?? 12);
const runDir = flag("--run") ?? process.env.BABYSIT_RUN;
const uid = process.getuid?.() ?? -1;
const roots = [...new Set(["/tmp", process.env.TMPDIR ?? "/tmp"].map((root) => realpathSync(root)))];

function protectedIds(): string[] {
    const ids = process.argv.flatMap((a, i) => (process.argv[i - 1] === "--protect" ? [a] : []));
    const cutoff = Date.now() - liveHours * 3_600_000;
    const transcriptDirs = [
        join(homedir(), ".claude/projects"),
        join(homedir(), ".codex/sessions"),
        join(homedir(), ".grok"),
    ];

    for (const top of transcriptDirs) {
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

                if (st.isDirectory() && depth < 4) {
                    stack.push({ dir: path, depth: depth + 1 });
                } else if (st.isFile() && st.mtimeMs >= cutoff) {
                    // A session id is a UUID-like token in the file name; its first 8 characters name scratch folders.
                    const id = /([0-9a-f]{8})-?[0-9a-f-]{20,}/i.exec(name)?.[1];

                    if (id) {
                        ids.push(id.toLowerCase());
                    }
                }
            }
        }
    }

    return [...new Set(ids)];
}

function openPaths(): string[] {
    // lint-rules-ignore: a deletion guard needs every open AND mapped file (lsof's mem rows), which the process layer does not read
    const p = Bun.spawnSync(["lsof", "-n", "-Fn", "-w"], { stdout: "pipe", stderr: "pipe" });
    const out = p.stdout.toString();

    // lsof exits 1 when some processes could not be read, but then still lists the rest. An empty listing is a
    // failure: deleting under a blind check is exactly what this script must never do.
    if (!out.includes("\nn/")) {
        console.error(`✖ lsof gave no listing (exit ${p.exitCode}): refusing to judge what is open`);
        process.exit(1);
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
            continue;
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

function judge(path: string, ids: string[], open: string[]): Candidate | string {
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
        ids.some((id) => path.toLowerCase().includes(id.toLowerCase())) ||
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

function entries(): string[] {
    const out: string[] = [];

    for (const root of roots) {
        for (const name of readdirSync(root)) {
            const path = join(root, name);

            // Agent scratch is judged per session folder, so one live session does not shield every dead one.
            if (path === join(roots[0] ?? "/tmp", "cc")) {
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

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(2)} GB`;

if (!has("--apply")) {
    const ids = protectedIds();
    const open = openPaths();
    const candidates: Candidate[] = [];
    const skipped: Record<string, number> = {};

    for (const path of entries()) {
        const verdict = judge(path, ids, open);

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
        `${candidates.length} candidates, ${gb(total)}; protected ids ${ids.length}; skipped ${SafeJSON.stringify(skipped)}`
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

if (Date.now() - plan.createdAt > PLAN_MAX_AGE_MS) {
    console.error("✖ the plan is older than 30 minutes: run the dry run again");
    process.exit(2);
}

// The dry run decided with its own threshold; the re-check uses the same one.
minAgeHours = plan.minAgeHours;

const ids = protectedIds();
const open = openPaths();
let freed = 0;
let removed = 0;
const refused: Record<string, number> = {};

for (const planned of plan.candidates) {
    const now = judge(planned.path, ids, open);

    if (typeof now === "string" || now.ino !== planned.ino) {
        const why = typeof now === "string" ? now : "replaced";
        refused[why] = (refused[why] ?? 0) + 1;
        continue;
    }

    const root = roots.find((r) => planned.path.startsWith(`${r}/`));

    if (!root) {
        refused["outside-roots"] = (refused["outside-roots"] ?? 0) + 1;
        continue;
    }

    const trash = join(root, `.tmp-reclaim-${process.pid}`);
    mkdirSync(trash, { recursive: true });

    try {
        renameSync(planned.path, join(trash, `${removed}-${basename(planned.path)}`));
        removed++;
        freed += now.bytes;
    } catch (error) {
        console.error(`could not move ${planned.path}: ${String(error)}`);
    }
}

for (const root of roots) {
    const trash = join(root, `.tmp-reclaim-${process.pid}`);

    if (existsSync(trash)) {
        rmSync(trash, { recursive: true, force: true });
    }
}

const summary = `removed ${removed} of ${plan.candidates.length} planned entries, about ${gb(freed)}; refused at apply ${SafeJSON.stringify(refused)}`;
console.log(summary);

if (runDir) {
    appendEvent(runDir, { kind: "note", text: `tmp-reclaim: ${summary} (plan ${planPath})` });
}
