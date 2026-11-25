import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    pruneScratch,
    recordGitMove,
    recordPostWriteHashes,
    scratchDir,
    scratchHarnessSession,
    scratchRoot,
    sessionScratchRoot,
    writeBackup,
} from "./backup-and-rollback";
import { journalHome } from "./journal";

// Every session on a machine shares one scratch root, because a worker inherits its lead's TMPDIR. These tests pin
// that an ordinary run (the CLI's exit-handler prune passes no scope) touches only its own session's folder, and that
// a sweep across sessions takes an explicit `all-sessions`. Every fixture lives under a private TMPDIR made per test.
// They use only names the layout before sessions also exported, so the file runs against that code as well.

const ENV_KEYS = [
    "TMPDIR",
    "FABLE_REPLACE_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CODEX_THREAD_ID",
    "FABLE_REPLACE_HOME",
    "FABLE_REPLACE_HARNESS",
    "FABLE_REPLACE_SCRATCH_ROOT",
];
const SESSION_KEYS = ["FABLE_REPLACE_SESSION", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"];
/** Past the 12 h prune TTL. */
const OLD_MS = 25 * 60 * 60 * 1000;
const CLI = path.join(import.meta.dir, "cli.ts");
const JOURNAL = path.join("home", ".genesis-tools", "fable-replace", "journal.jsonl");

let saved: Record<string, string | undefined> = {};
let base = "";
let temp = "";

const setEnv = (key: string, value: string | undefined): void => {
    if (value === undefined) {
        delete process.env[key];
    } else {
        process.env[key] = value;
    }
};

/** Run as this session: FABLE_REPLACE_SESSION is the only session variable set. */
const asSession = (key: string | undefined): void => {
    for (const name of SESSION_KEYS) {
        setEnv(name, undefined);
    }

    setEnv("FABLE_REPLACE_SESSION", key);
};

const aged = (dir: string): string => {
    const then = new Date(Date.now() - OLD_MS);
    fs.utimesSync(dir, then, then);
    return dir;
};

/** What a finished backup holds: an original and the manifest, the proof that this tool wrote the dir. */
const finished = (dir: string): string => {
    fs.writeFileSync(path.join(dir, "0000-a.ts"), "x".repeat(100));
    fs.writeFileSync(path.join(dir, "fable-replace-manifest.json"), "{}");
    return dir;
};

const unproven = (dir: string): string => {
    fs.writeFileSync(path.join(dir, "notes.txt"), "keep");
    return dir;
};

/** Every file under the fixture base, by relative path, with its content. */
const snapshot = (): Map<string, string> => {
    const files = new Map<string, string>();
    for (const rel of fs.readdirSync(base, { recursive: true, encoding: "utf8" })) {
        const full = path.join(base, rel);
        if (fs.statSync(full).isFile()) {
            files.set(rel, fs.readFileSync(full, "utf8"));
        }
    }

    return files;
};

beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    base = fs.mkdtempSync(path.join(os.tmpdir(), "scratch-scope-"));
    temp = path.join(base, "tmp");
    fs.mkdirSync(temp);
    setEnv("TMPDIR", temp);
    setEnv("FABLE_REPLACE_HOME", undefined);
    // Set by a caller that knows better than the environment; no case here inherits them.
    setEnv("FABLE_REPLACE_HARNESS", undefined);
    setEnv("FABLE_REPLACE_SCRATCH_ROOT", undefined);
});

afterEach(() => {
    for (const key of ENV_KEYS) {
        setEnv(key, saved[key]);
    }

    fs.rmSync(base, { recursive: true, force: true });
});

describe("fable-replace scratch stays inside the session that wrote it", () => {
    test("an ordinary prune in session A removes A's old backup but never a long-lived session B's", () => {
        asSession("session-b");
        const foreign = aged(finished(scratchDir("cli")));
        asSession("session-a");
        const own = aged(finished(scratchDir("cli")));

        const report = pruneScratch();

        expect(fs.existsSync(own)).toBe(false);
        expect(fs.existsSync(foreign)).toBe(true);
        expect(report.removed).toBe(1);
        expect(report.roots).toEqual([path.join(temp, "fable-replace", "session-a")]);
    });

    test("all-sessions sweeps every session's folder and the legacy layout, but keeps young and unproven dirs", () => {
        const legacy = aged(finished(fs.mkdtempSync(path.join(temp, "fable-replace-legacy-"))));
        const swept = [legacy];
        const kept: string[] = [];
        for (const session of ["session-a", "session-b"]) {
            asSession(session);
            swept.push(aged(finished(scratchDir("cli"))));
            kept.push(finished(scratchDir("cli")), aged(unproven(scratchDir("notes"))));
        }

        asSession("session-a");
        const report = pruneScratch({ scope: "all-sessions" });

        expect(swept.filter((dir) => fs.existsSync(dir))).toEqual([]);
        expect(kept.filter((dir) => !fs.existsSync(dir))).toEqual([]);
        expect(report.removed).toBe(3);
        expect(report.roots).toEqual([path.join(temp, "fable-replace")]);
    });

    test("a symlinked session folder is never followed: its target's old backups survive either scope", () => {
        // An old, finished backup outside the scratch root, reachable only through a link inside it.
        const outside = path.join(base, "outside");
        fs.mkdirSync(outside);
        const target = aged(finished(fs.mkdtempSync(path.join(outside, "cli-"))));
        fs.mkdirSync(scratchRoot(), { recursive: true });
        fs.symlinkSync(outside, path.join(scratchRoot(), "linked-session"));

        asSession("session-a");
        pruneScratch({ scope: "all-sessions" });
        expect(fs.existsSync(target)).toBe(true);

        // The session's own folder is the link: an ordinary prune must not list through it either.
        asSession("linked-session");
        pruneScratch();
        expect(fs.existsSync(target)).toBe(true);
        expect(fs.lstatSync(path.join(scratchRoot(), "linked-session")).isSymbolicLink()).toBe(true);
    });

    test("two session ids that sanitize or truncate to the same text keep separate folders", () => {
        const long = "x".repeat(80);
        for (const [first, second] of [
            ["lead/worker", "lead_worker"],
            [`${long}-alpha`, `${long}-beta`],
        ]) {
            asSession(first);
            const foreign = aged(finished(scratchDir("cli")));
            asSession(second);
            const own = aged(finished(scratchDir("cli")));

            pruneScratch();

            expect(path.dirname(own)).not.toBe(path.dirname(foreign));
            expect(fs.existsSync(own)).toBe(false);
            expect(fs.existsSync(foreign)).toBe(true);
        }
    });

    test("all-sessions never descends through a symlink, so an old backup outside the scratch root survives", () => {
        const outside = path.join(base, "outside");
        fs.mkdirSync(outside);
        const external = aged(finished(fs.mkdtempSync(path.join(outside, "backup-"))));
        fs.mkdirSync(path.join(temp, "fable-replace"), { recursive: true });
        const link = path.join(temp, "fable-replace", "linked-session");
        fs.symlinkSync(outside, link);
        const legacyLink = path.join(temp, "fable-replace-legacy-link");
        fs.symlinkSync(external, legacyLink);

        pruneScratch({ scope: "all-sessions" });

        expect(fs.existsSync(external)).toBe(true);
        expect(fs.existsSync(path.join(external, "fable-replace-manifest.json"))).toBe(true);
        expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
        expect(fs.lstatSync(legacyLink).isSymbolicLink()).toBe(true);
    });

    test("an inherited TMPDIR with no session variable keys the folder by the parent process", () => {
        asSession(undefined);

        const dir = scratchDir("cli");

        expect(scratchRoot()).toBe(path.join(temp, "fable-replace"));
        expect(path.dirname(dir)).toBe(path.join(temp, "fable-replace", `ppid-${process.ppid}`));
    });

    test("FABLE_REPLACE_SESSION wins over the harness ids, and an unsafe key stays one folder name", () => {
        const folder = (): string => path.relative(scratchRoot(), path.dirname(scratchDir("cli")));
        // A harness id with a session names a harness session, whose folder follows it to /tmp/<agent dir>. An
        // explicit root keeps the folder under the shared root, so this case stays about the key alone.
        setEnv("FABLE_REPLACE_SCRATCH_ROOT", path.join(temp, "fable-replace"));
        setEnv("CODEX_THREAD_ID", "codex-thread-1");
        setEnv("CLAUDE_CODE_SESSION_ID", "claude-session-1");
        setEnv("FABLE_REPLACE_SESSION", "lead/worker 2");
        // An unsafe key keeps a readable prefix plus a digest of the whole id, so it can never equal a safe key.
        expect(folder()).toMatch(/^lead_worker_2~[0-9a-f]{16}$/);
        setEnv("FABLE_REPLACE_SESSION", undefined);
        expect(folder()).toBe("claude-session-1");
        setEnv("CLAUDE_CODE_SESSION_ID", undefined);
        expect(folder()).toBe("codex-thread-1");
    });

    test("FABLE_REPLACE_HOME alone moves the journal, never the scratch root", () => {
        const home = path.join(base, "home");
        setEnv("FABLE_REPLACE_HOME", home);
        asSession("session-a");

        expect(journalHome()).toBe(path.join(home, ".genesis-tools", "fable-replace"));
        expect(scratchRoot()).toBe(path.join(temp, "fable-replace"));
        expect(path.dirname(scratchDir("cli"))).toBe(path.join(temp, "fable-replace", "session-a"));
    });

    test("a CLI edit with only an inherited TMPDIR and FABLE_REPLACE_HOME changes its file, its own session folder and the journal", async () => {
        const work = path.join(base, "work");
        fs.mkdirSync(work);
        fs.writeFileSync(path.join(work, "a.ts"), "const a = 1;\n");
        fs.writeFileSync(path.join(work, "b.ts"), "const b = 1;\n");
        // The CLI is a child of this process, so with no session variable its folder is keyed by our pid.
        const ownKey = `ppid-${process.pid}`;
        asSession(ownKey);
        const ownOld = aged(finished(scratchDir("cli")));
        asSession("session-b");
        const foreignOld = aged(finished(scratchDir("cli")));
        const legacy = aged(finished(fs.mkdtempSync(path.join(temp, "fable-replace-legacy-"))));
        const before = snapshot();

        const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: temp, FABLE_REPLACE_HOME: path.join(base, "home") };
        for (const name of SESSION_KEYS) {
            delete env[name];
        }

        // Awaited, not spawnSync: on the Linux CI runner Bun 1.4.2's spawnSync can lose its child's exit
        // inside a long-lived test worker (oven-sh/bun#34069) and spin until the 30 s timeout, which this
        // case did in two PR runs on 2026-11-02.
        const proc = Bun.spawn([process.execPath, CLI], {
            cwd: work,
            stdin: new Blob(["@@ a.ts\n<<<\nconst a = 1;\n===\nconst a = 2;\n>>>\n"]),
            env,
            stdout: "pipe",
            stderr: "pipe",
            timeout: 30_000,
        });
        const [stdout, stderr, status] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        const child = { status, stdout, stderr };
        const after = snapshot();
        if (child.status !== 0) {
            console.error(child.stdout, child.stderr);
        }

        expect(child.status).toBe(0);
        const ownFolder = path.join("tmp", "fable-replace", ownKey);
        const ownOldRel = path.relative(base, ownOld);
        const added = [...after.keys()].filter((rel) => !before.has(rel));
        const gone = [...before.keys()].filter((rel) => !after.has(rel));
        const changed = [...after.keys()].filter((rel) => before.has(rel) && before.get(rel) !== after.get(rel));
        expect(changed).toEqual([path.join("work", "a.ts")]);
        expect(added.filter((rel) => rel !== JOURNAL && !rel.startsWith(`${ownFolder}${path.sep}`))).toEqual([]);
        expect(added).toContain(JOURNAL);
        // The positive control: the exit-handler prune did run, and took this session's own old backup.
        expect(gone.length).toBeGreaterThan(0);
        expect(gone.filter((rel) => !rel.startsWith(`${ownOldRel}${path.sep}`))).toEqual([]);
        expect(fs.existsSync(foreignOld)).toBe(true);
        expect(fs.existsSync(legacy)).toBe(true);
        expect(child.stdout).toContain("pruned 1 stale scratch dir(s)");
    }, 30_000);
});

// The harness session layout: with a harness and its session id known, the folder is the session's own scratch folder
// that `tools rm` cleans, `/tmp/<agent dir>/<project>/<session>/fable-replace` (hooks/session-scratch.ts). One git
// fixture checkout serves the CLI case and the git-move case; every git and CLI child is awaited, never spawnSync.
describe("fable-replace scratch follows a harness session into its session folder", () => {
    const unique = `${process.pid}-${Date.now().toString(36)}`;
    const project = `demo-${unique}`;
    let holder = "";
    let repo = "";

    const run = async (
        argv: string[],
        { cwd, stdin, env }: { cwd: string; stdin?: string; env?: NodeJS.ProcessEnv }
    ): Promise<{ status: number; out: string }> => {
        const proc = Bun.spawn(argv, {
            cwd,
            stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
            env: env ?? process.env,
            stdout: "pipe",
            stderr: "pipe",
            timeout: 30_000,
        });
        const [stdout, stderr, status] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        return { status, out: `${stdout}\n${stderr}` };
    };

    const git = async (...args: string[]): Promise<string> => {
        const quiet = [
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.com",
            "-c",
            "core.hooksPath=/dev/null",
        ];
        const result = await run(["git", ...quiet, "-c", "commit.gpgsign=false", ...args], { cwd: repo });
        if (result.status !== 0) {
            throw new Error(`git ${args.join(" ")}: ${result.out}`);
        }

        return result.out.trim();
    };

    /** The CLI with a clean environment: only what a case passes names a session, a harness or a root. */
    const cliEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => {
        const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: temp, FABLE_REPLACE_HOME: path.join(base, "home") };
        for (const name of [...SESSION_KEYS, "FABLE_REPLACE_HARNESS", "FABLE_REPLACE_SCRATCH_ROOT"]) {
            delete env[name];
        }

        return { ...env, ...extra };
    };

    beforeAll(async () => {
        holder = fs.mkdtempSync(path.join(os.tmpdir(), "scratch-scope-repo-"));
        repo = path.join(holder, project);
        fs.mkdirSync(repo);
        fs.writeFileSync(path.join(repo, "demo.ts"), "export const demo = 1;\n");
        fs.writeFileSync(path.join(repo, "old-name.ts"), "export const named = 1;\n");
        await git("init", "-q");
        await git("add", "demo.ts", "old-name.ts");
        await git("commit", "-q", "-m", "fixture");
    });

    afterAll(() => {
        fs.rmSync(holder, { recursive: true, force: true });
        fs.rmSync(path.join("/tmp", "cc", project), { recursive: true, force: true });
    });

    test("the harness and the session come from the context, then FABLE_REPLACE_*, then the harness's own variable", () => {
        asSession(undefined);
        expect(scratchHarnessSession()).toBeNull();
        // FABLE_REPLACE_SESSION alone names no harness: the folder stays under the shared root, as before.
        asSession("named-only");
        expect(scratchHarnessSession()).toBeNull();
        setEnv("CODEX_THREAD_ID", "thread-1");
        expect(scratchHarnessSession()).toEqual({ harness: "codex", sessionId: "named-only" });
        setEnv("FABLE_REPLACE_SESSION", undefined);
        expect(scratchHarnessSession()).toEqual({ harness: "codex", sessionId: "thread-1" });
        setEnv("CLAUDE_CODE_SESSION_ID", "claude-1");
        expect(scratchHarnessSession()).toEqual({ harness: "claude", sessionId: "claude-1" });
        setEnv("FABLE_REPLACE_HARNESS", "codex");
        expect(scratchHarnessSession()).toEqual({ harness: "codex", sessionId: "thread-1" });
        // Grok sets no session variable, so it needs a session named for it.
        setEnv("FABLE_REPLACE_HARNESS", "grok");
        expect(scratchHarnessSession()).toBeNull();
        expect(scratchHarnessSession({ sessionId: "grok-1" })).toEqual({ harness: "grok", sessionId: "grok-1" });
        expect(scratchHarnessSession({ harness: "claude" })).toEqual({ harness: "claude", sessionId: "claude-1" });
    });

    test("a cwd inside the session's own scratch folder keeps that folder's project, git repository or not", async () => {
        const session = `scratch-around-${unique}`;
        const own = path.join("/tmp", "cc", project, session);
        const plain = path.join(own, "fixture-plain");
        const nested = path.join(own, "deep", "fixture-repo");
        fs.mkdirSync(plain, { recursive: true });
        fs.mkdirSync(nested, { recursive: true });
        const init = await run(["git", "init", "-q"], { cwd: nested });
        expect(init.status).toBe(0);
        asSession(undefined);
        setEnv("CLAUDE_CODE_SESSION_ID", session);

        expect(sessionScratchRoot({ cwd: plain })).toBe(path.join(own, "fable-replace"));
        expect(sessionScratchRoot({ cwd: nested })).toBe(path.join(own, "fable-replace"));
        // Another session's folder is not this session's: the fixture's own name is the project there, as before.
        setEnv("CLAUDE_CODE_SESSION_ID", `${session}-other`);
        expect(sessionScratchRoot({ cwd: plain })).toBe(
            path.join("/tmp", "cc", "fixture-plain", `${session}-other`, "fable-replace")
        );
    });

    test("FABLE_REPLACE_SCRATCH_ROOT wins over a harness session and over TMPDIR", () => {
        const root = path.join(base, "explicit-root");
        asSession(undefined);
        setEnv("CLAUDE_CODE_SESSION_ID", "claude-1");
        setEnv("FABLE_REPLACE_SCRATCH_ROOT", root);

        const dir = scratchDir("cli", { cwd: repo });

        expect(scratchRoot()).toBe(root);
        expect(sessionScratchRoot({ cwd: repo })).toBe(path.join(root, "claude-1"));
        expect(path.dirname(dir)).toBe(path.join(root, "claude-1"));
        aged(finished(dir));
        const report = pruneScratch({ scratch: { cwd: repo } });
        expect(report.roots).toEqual([path.join(root, "claude-1")]);
        expect(fs.existsSync(dir)).toBe(false);
        expect(fs.existsSync(path.join(temp, "fable-replace"))).toBe(false);
    });

    test("a CLI run in a Claude session backs up into /tmp/cc/<project>/<session>/fable-replace, and --rollback restores", async () => {
        const session = `scratch-scope-${unique}`;
        const env = cliEnv({ CLAUDE_CODE_SESSION_ID: session });
        const demo = path.join(repo, "demo.ts");
        const spec = "@@ demo.ts\n<<<\nexport const demo = 1;\n===\nexport const demo = 2;\n>>>\n";

        // The child starts outside the checkout: only --cwd can name the project.
        const swept = await run([process.execPath, CLI, "--cwd", repo], { cwd: base, stdin: spec, env });
        const folder = path.join("/tmp", "cc", project, session, "fable-replace");
        const backupDir = swept.out.match(/Backed up 1 path\(s\) to (\S+)/)?.[1];

        expect(swept.status).toBe(0);
        expect(swept.out).toContain(`Backed up 1 path(s) to ${folder}${path.sep}cli-`);
        expect(fs.readFileSync(demo, "utf8")).toBe("export const demo = 2;\n");
        expect(fs.existsSync(path.join(temp, "fable-replace"))).toBe(false);
        const undone = await run([process.execPath, CLI, "--rollback", backupDir ?? "missing"], { cwd: repo, env });
        expect(undone.status).toBe(0);
        expect(fs.readFileSync(demo, "utf8")).toBe("export const demo = 1;\n");
        expect(await git("status", "--porcelain")).toBe("");
    }, 30_000);

    test("a manifest with a git move rolls back to an empty git status", async () => {
        const from = path.join(repo, "old-name.ts");
        const to = path.join(repo, "new-name.ts");
        const backupDir = path.join(base, "backup");
        writeBackup({ dir: backupDir, files: [from, to] });
        await git("mv", "old-name.ts", "new-name.ts");
        recordGitMove(backupDir, { from, to });
        fs.writeFileSync(to, "export const renamed = 2;\n");
        recordPostWriteHashes(backupDir);
        // The positive control: the sweep left a staged rename with a changed target.
        expect(await git("status", "--porcelain")).toBe("RM old-name.ts -> new-name.ts");

        // Through the CLI, so the git reset runs in a child and never in this test worker.
        const undone = await run([process.execPath, CLI, "--rollback", backupDir], { cwd: repo, env: cliEnv({}) });

        expect(undone.status).toBe(0);
        expect(undone.out).toContain("unstaged the git move");
        expect(await git("status", "--porcelain")).toBe("");
        expect(fs.readFileSync(from, "utf8")).toBe("export const named = 1;\n");
        expect(fs.existsSync(to)).toBe(false);
    }, 30_000);
});
