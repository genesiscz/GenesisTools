import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pruneScratch, scratchDir, scratchRoot } from "./backup-and-rollback";
import { journalHome } from "./journal";

// Every session on a machine shares one scratch root, because a worker inherits its lead's TMPDIR. These tests pin
// that an ordinary run (the CLI's exit-handler prune passes no scope) touches only its own session's folder, and that
// a sweep across sessions takes an explicit `all-sessions`. Every fixture lives under a private TMPDIR made per test.
// They use only names the layout before sessions also exported, so the file runs against that code as well.

const ENV_KEYS = ["TMPDIR", "FABLE_REPLACE_SESSION", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "FABLE_REPLACE_HOME"];
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

    test("an inherited TMPDIR with no session variable keys the folder by the parent process", () => {
        asSession(undefined);

        const dir = scratchDir("cli");

        expect(scratchRoot()).toBe(path.join(temp, "fable-replace"));
        expect(path.dirname(dir)).toBe(path.join(temp, "fable-replace", `ppid-${process.ppid}`));
    });

    test("FABLE_REPLACE_SESSION wins over the harness ids, and an unsafe key stays one folder name", () => {
        const folder = (): string => path.relative(scratchRoot(), path.dirname(scratchDir("cli")));
        setEnv("CODEX_THREAD_ID", "codex-thread-1");
        setEnv("CLAUDE_CODE_SESSION_ID", "claude-session-1");
        setEnv("FABLE_REPLACE_SESSION", "lead/worker 2");
        expect(folder()).toBe("lead_worker_2");
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

    test("a CLI edit with only an inherited TMPDIR and FABLE_REPLACE_HOME changes its file, its own session folder and the journal", () => {
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

        const child = spawnSync(process.execPath, [CLI], {
            cwd: work,
            input: "@@ a.ts\n<<<\nconst a = 1;\n===\nconst a = 2;\n>>>\n",
            encoding: "utf8",
            env,
            timeout: 30_000,
        });
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
