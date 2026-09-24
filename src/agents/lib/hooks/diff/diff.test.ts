import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { DEFAULT_HOOKS_CONFIG } from "../config";
import { callDir, sessionDir } from "../paths";
import type { HookPayload } from "../payload";
import { beforeCopy } from "./before";
import { capturePre, captureRoots } from "./capture";
import { changedFiles } from "./collect";
import { hunkRange, renderPatch } from "./render";
import { runDiffPost } from "./run";

let repo: string;
let calls = 0;

function git(args: string[]): void {
    spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: process.env });
}

/** A fresh tool-call id per capture, so no two cases share a before-state. */
function payload(overrides: Partial<HookPayload> = {}): HookPayload {
    return {
        event: "PostToolUse",
        tool: "Bash",
        cwd: repo,
        sessionId: "gt-diff-test",
        toolUseId: `call-${calls}`,
        command: "true",
        model: "",
        harness: "claude",
        nativeDiffFiles: [],
        raw: {},
        ...overrides,
    };
}

function begin(overrides: Partial<HookPayload> = {}): HookPayload {
    calls += 1;

    const next = payload(overrides);

    capturePre(next, DEFAULT_HOOKS_CONFIG.diff);

    return next;
}

beforeAll(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "gt-capture-")));
    git(["init", "-q"]);
    git(["config", "user.email", "probe@local"]);
    git(["config", "user.name", "probe"]);
    writeFileSync(join(repo, "kept.ts"), "alpha\nbravo\ncharlie\ndelta\necho\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "init"]);
});

afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(sessionDir("claude", "gt-diff-test"), { recursive: true, force: true });
});

describe("capturePre", () => {
    it("captures a dirty file so the post phase can diff against it", () => {
        writeFileSync(join(repo, "kept.ts"), "alpha\nDIRTY\ncharlie\ndelta\necho\n");

        const current = begin();
        const dir = callDir(current.harness, current.sessionId ?? "", current.toolUseId ?? "");

        expect(existsSync(join(dir, "1.tar"))).toBe(true);
        expect(existsSync(join(dir, "stamp"))).toBe(true);

        git(["checkout", "--", "kept.ts"]);
    });

    it("finds the repository root of the cwd and stops at maxRoots", () => {
        const current = begin();
        const dir = callDir(current.harness, current.sessionId ?? "", current.toolUseId ?? "");

        expect(existsSync(join(dir, "roots.txt"))).toBe(true);
    });
});

describe("changedFiles", () => {
    it("expands a wholly untracked directory into its files", () => {
        mkdirSync(join(repo, "scratch"), { recursive: true });
        writeFileSync(join(repo, "scratch/deep.ts"), "one\n");

        const found = changedFiles(repo, Date.now() - 60_000, DEFAULT_HOOKS_CONFIG.diff);

        expect(found.map((file) => file.path)).toContain(join(repo, "scratch/deep.ts"));
        expect(found.find((file) => file.path.endsWith("deep.ts"))?.untracked).toBe(true);
    });

    it("ignores a file older than the stamp", () => {
        const found = changedFiles(repo, Date.now() + 60_000, DEFAULT_HOOKS_CONFIG.diff);

        expect(found.filter((file) => !file.deleted)).toEqual([]);
    });
});

describe("renderPatch", () => {
    it("counts additions and removals and keeps context", () => {
        const patch = [
            "diff --git a/x b/x",
            "--- a/x",
            "+++ b/x",
            "@@ -1,3 +1,3 @@",
            " one",
            "-two",
            "+TWO",
            " three",
        ].join("\n");

        const rendered = renderPatch(patch, [], DEFAULT_HOOKS_CONFIG.diff);

        expect(rendered.added).toBe(1);
        expect(rendered.removed).toBe(1);
        expect(rendered.body.length).toBe(4);
    });

    it("returns an empty body when there is no hunk", () => {
        expect(renderPatch("", [], DEFAULT_HOOKS_CONFIG.diff).body).toEqual([]);
    });
});

describe("beforeCopy", () => {
    it("extracts a file captured inside a wholly untracked directory", () => {
        mkdirSync(join(repo, "scratch"), { recursive: true });
        writeFileSync(join(repo, "scratch/deep.ts"), "one\ntwo\nthree\n");

        const current = begin();
        const dir = callDir(current.harness, current.sessionId ?? "", current.toolUseId ?? "");

        writeFileSync(join(repo, "scratch/deep.ts"), "one\nTWO-EDIT\nthree\n");

        const copy = beforeCopy(dir, repo, join(repo, "scratch/deep.ts"));

        expect(copy).not.toBeNull();
        expect(readFileSync(copy as string, "utf8")).toBe("one\ntwo\nthree\n");
    });

    it("answers null for a file that was clean when the command began", () => {
        const current = begin();
        const dir = callDir(current.harness, current.sessionId ?? "", current.toolUseId ?? "");

        expect(beforeCopy(dir, repo, join(repo, "kept.ts"))).toBeNull();
    });
});

describe("runDiffPost", () => {
    const plain = { ...DEFAULT_HOOKS_CONFIG, diff: { ...DEFAULT_HOOKS_CONFIG.diff, highlight: "none" as const } };

    it("reports only what this command changed", () => {
        const current = begin();

        writeFileSync(join(repo, "kept.ts"), "alpha\nAFTER\ncharlie\ndelta\necho\n");

        const decision = runDiffPost(current, plain);

        expect(decision.decision).toBe("emitted");
        expect(decision.message).toContain("AFTER");
        expect(decision.message).toContain("(+1 -1)");
    });

    it("does not blame this command for a change that was already in the worktree", () => {
        writeFileSync(join(repo, "kept.ts"), "alpha\nPRE-EXISTING\ncharlie\ndelta\necho\n");

        const current = begin();

        writeFileSync(join(repo, "kept.ts"), "alpha\nPRE-EXISTING\ncharlie\ndelta\nECHO-NEW\n");

        const decision = runDiffPost(current, plain);

        expect(decision.message).toContain("ECHO-NEW");
        expect(decision.message).toContain("(+1 -1)");

        git(["checkout", "--", "kept.ts"]);
    });

    it("stands down for a file the harness already rendered", () => {
        const current = begin({ nativeDiffFiles: [join(repo, "kept.ts")] });

        writeFileSync(join(repo, "kept.ts"), "alpha\nAGAIN\ncharlie\ndelta\necho\n");

        const decision = runDiffPost(current, plain);

        expect(decision.decision).toBe("silent");
        expect(decision.reason).toContain("already rendered natively");

        git(["checkout", "--", "kept.ts"]);
    });

    it("still reports when the native payload is present but empty", () => {
        const current = begin({ nativeDiffFiles: [] });

        writeFileSync(join(repo, "kept.ts"), "alpha\nEMPTY-PAYLOAD\ncharlie\ndelta\necho\n");

        const decision = runDiffPost(current, plain);

        expect(decision.decision).toBe("emitted");
        expect(decision.message).toContain("EMPTY-PAYLOAD");

        git(["checkout", "--", "kept.ts"]);
    });

    it("says nothing when the command changed no file", () => {
        const current = begin();

        expect(runDiffPost(current, plain).decision).toBe("silent");
    });

    it("shows a new file whole once, then only its delta", () => {
        const first = begin();

        writeFileSync(join(repo, "fresh.ts"), "one\ntwo\nthree\n");

        const initial = runDiffPost(first, plain);

        expect(initial.message).toContain("Added");
        expect(initial.message).toContain("two");

        const second = begin();

        writeFileSync(join(repo, "fresh.ts"), "one\nTWO-CHANGED\nthree\n");

        const delta = runDiffPost(second, plain);

        expect(delta.message).toContain("Updated");
        expect(delta.message).toContain("TWO-CHANGED");
        expect(delta.message).toContain("(+1 -1)");
    });

    it("reports an edit to a file inside a wholly untracked directory", () => {
        // 🛑 Known defect 1 in the prototype: the log showed one candidate and then
        // `decision: silent`. git collapses such a directory to one `?? scratch/` entry,
        // and appending inside it does not change the directory's mtime.
        mkdirSync(join(repo, "deep"), { recursive: true });
        writeFileSync(join(repo, "deep/nested.ts"), "one\ntwo\nthree\n");

        const first = begin();

        writeFileSync(join(repo, "deep/nested.ts"), "one\ntwo\nthree\nfour\n");
        expect(runDiffPost(first, plain).message).toContain("four");

        const second = begin();

        writeFileSync(join(repo, "deep/nested.ts"), "one\nTWO-EDIT\nthree\nfour\n");

        const delta = runDiffPost(second, plain);

        expect(delta.decision).toBe("emitted");
        expect(delta.message).toContain("TWO-EDIT");
        expect(delta.message).toContain("(+1 -1)");
    });

    it("reports a staged deletion, which a plain `git diff` cannot see", () => {
        const current = begin();

        git(["rm", "-qf", "kept.ts"]);

        const decision = runDiffPost(current, plain);

        expect(decision.decision).toBe("emitted");
        expect(decision.message).toContain("Deleted");

        git(["checkout", "HEAD", "--", "kept.ts"]);
    });
});

describe("paths git would C-quote", () => {
    const plain = { ...DEFAULT_HOOKS_CONFIG, diff: { ...DEFAULT_HOOKS_CONFIG.diff, highlight: "none" as const } };

    it("reports an edit to a path with a space in its name", () => {
        // `git status --porcelain` renders this as `?? "a file.ts"`. Reading that string as
        // a path looks for a file whose name starts with a quote, finds nothing, and the
        // hook goes silent on a file that plainly changed. `-z` never quotes.
        writeFileSync(join(repo, "a file.ts"), "one\ntwo\n");

        const first = begin();

        writeFileSync(join(repo, "a file.ts"), "one\nTWO-EDITED\n");

        const decision = runDiffPost(first, plain);

        expect(decision.decision).toBe("emitted");
        expect(decision.files).toContain(join(repo, "a file.ts"));
        expect(decision.message).toContain("TWO-EDITED");
        expect(decision.message).toContain("(+1 -1)");

        rmSync(join(repo, "a file.ts"), { force: true });
    });

    it("reports an edit to a path with a non-ASCII name", () => {
        writeFileSync(join(repo, "příliš.ts"), "one\ntwo\n");

        const first = begin();

        writeFileSync(join(repo, "příliš.ts"), "one\nZLUTOUCKY\n");

        const decision = runDiffPost(first, plain);

        expect(decision.decision).toBe("emitted");
        expect(decision.message).toContain("ZLUTOUCKY");

        rmSync(join(repo, "příliš.ts"), { force: true });
    });
});

describe("a command that edits a sibling repository", () => {
    const plain = { ...DEFAULT_HOOKS_CONFIG, diff: { ...DEFAULT_HOOKS_CONFIG.diff, highlight: "none" as const } };
    let other: string;

    beforeAll(() => {
        other = realpathSync(mkdtempSync(join(tmpdir(), "gt-sibling-")));

        const run = (args: string[]) =>
            spawnSync("git", ["-C", other, ...args], { encoding: "utf8", env: process.env });

        run(["init", "-q"]);
        run(["config", "user.email", "probe@local"]);
        run(["config", "user.name", "probe"]);
        writeFileSync(join(other, "sibling.ts"), "one\ntwo\nthree\n");
        run(["add", "-A"]);
        run(["commit", "-qm", "init"]);
    });

    afterAll(() => {
        rmSync(other, { recursive: true, force: true });
    });

    it("finds the second repository the command names and reports its absolute path", () => {
        // The harness's own renderer snapshots the CWD repository only, so a `cd` into a
        // sibling repo is exactly the case it renders nothing for.
        const current = begin({ command: `cd ${other} && python3 - <<'PY'\nPY` });

        writeFileSync(join(other, "sibling.ts"), "one\nTWO-IN-SIBLING\nthree\n");

        const decision = runDiffPost(current, plain);

        expect(decision.decision).toBe("emitted");
        expect(decision.files).toContain(join(other, "sibling.ts"));
        expect(decision.message).toContain("TWO-IN-SIBLING");
    });
});

describe("the emergency stop", () => {
    it("AGENTS_HOOKS_DISABLE=1 makes the PreToolUse entrypoint do nothing at all", () => {
        const entry = join(import.meta.dir, "..", "..", "..", "bin", "hook-pre.ts");
        const payload = SafeJSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            cwd: repo,
            session_id: "disabled-probe",
            tool_use_id: "disabled-call",
            tool_input: { command: "git checkout -- kept.ts" },
        });
        const run = spawnSync("bun", [entry], {
            input: payload,
            encoding: "utf8",
            env: { ...process.env, AGENTS_HOOKS_DISABLE: "1" },
        });

        expect(run.status).toBe(0);
        expect(run.stdout).toBe("");
        expect(existsSync(callDir("claude", "disabled-probe", "disabled-call"))).toBe(false);
    });

    it("without it, the same payload is denied", () => {
        const entry = join(import.meta.dir, "..", "..", "..", "bin", "hook-pre.ts");
        const home = mkdtempSync(join(tmpdir(), "gt-stop-home-"));

        mkdirSync(join(home, ".genesis-tools", "agents"), { recursive: true });
        writeFileSync(join(home, ".genesis-tools", "agents", "hooks.json"), SafeJSON.stringify({ shadow: false }));

        const run = spawnSync("bun", [entry], {
            input: SafeJSON.stringify({
                hook_event_name: "PreToolUse",
                tool_name: "Bash",
                cwd: repo,
                session_id: "stop-probe",
                tool_use_id: "stop-call",
                tool_input: { command: "git checkout -- kept.ts" },
            }),
            encoding: "utf8",
            env: { ...process.env, GENESIS_TOOLS_HOME: home, AGENTS_HOOKS_DISABLE: "" },
        });

        expect(run.stdout).toContain('"permissionDecision":"deny"');
        expect(run.stdout).toContain("git-checkout-overwrites-file");

        rmSync(home, { recursive: true, force: true });
    });
});

describe("the capture is private and option-safe", () => {
    it("creates the capture directory 0700 and its files 0600", () => {
        writeFileSync(join(repo, "kept.ts"), "alpha\nMODE-PROBE\ncharlie\ndelta\necho\n");

        const current = begin();
        const dir = callDir(current.harness, current.sessionId ?? "", current.toolUseId ?? "");

        // A capture holds copies of dirty files, which can include a `.env` a command just
        // wrote. On Linux and in CI `tmpdir()` is a world-readable /tmp, so the platform
        // cannot be relied on for this.
        expect(statSync(dir).mode & 0o777).toBe(0o700);
        expect(statSync(join(dir, "1.tar")).mode & 0o777).toBe(0o600);
        expect(statSync(join(dir, "stamp")).mode & 0o777).toBe(0o600);

        git(["checkout", "--", "kept.ts"]);
    });

    it("captures a file whose name looks like a tar option", () => {
        // Any writer of the repository can create a file called `-C`. Without a `--`
        // terminator tar reads it as an option, and `-C /` re-roots the archive.
        writeFileSync(join(repo, "-C"), "one\ntwo\n");

        const first = begin();

        writeFileSync(join(repo, "-C"), "one\nTWO-EDITED\n");

        const decision = runDiffPost(first, {
            ...DEFAULT_HOOKS_CONFIG,
            diff: { ...DEFAULT_HOOKS_CONFIG.diff, highlight: "none" },
        });

        expect(decision.decision).toBe("emitted");
        expect(decision.message).toContain("TWO-EDITED");

        rmSync(join(repo, "-C"), { force: true });
    });
});

describe("captureRoots", () => {
    it("ignores a cd that only appears inside a quoted string", () => {
        const roots = captureRoots({ ...payload(), command: `echo "cd /etc" && ls` }, DEFAULT_HOOKS_CONFIG.diff);

        expect(roots).toEqual([repo]);
    });

    it("still takes a real cd target", () => {
        const roots = captureRoots({ ...payload(), command: `cd ${repo} && ls` }, DEFAULT_HOOKS_CONFIG.diff);

        expect(roots).toEqual([repo]);
    });

    it("takes a RELATIVE cd target, resolved against the cwd", () => {
        // `cd ../other-repo && …` is the ordinary way to reach a sibling, and an
        // absolute-only regex rendered nothing for the tree the command actually mutated.
        const nested = join(repo, "sub");

        mkdirSync(nested, { recursive: true });

        const roots = captureRoots({ ...payload(), cwd: nested, command: "cd .. && ls" }, DEFAULT_HOOKS_CONFIG.diff);

        expect(roots).toEqual([repo]);

        rmSync(nested, { recursive: true, force: true });
    });

    it("takes EVERY cd target, not just the first", () => {
        const roots = captureRoots(
            { ...payload(), command: `cd /nonexistent-aaa && cd ${repo} && ls` },
            DEFAULT_HOOKS_CONFIG.diff
        );

        expect(roots).toEqual([repo]);
    });

    it("reads a quoted target with a space in it", () => {
        const spaced = join(repo, "a dir");

        mkdirSync(spaced, { recursive: true });

        const roots = captureRoots({ ...payload(), command: `cd "${spaced}" && ls` }, DEFAULT_HOOKS_CONFIG.diff);

        expect(roots).toEqual([repo]);

        rmSync(spaced, { recursive: true, force: true });
    });

    it("skips `cd -` and a variable target rather than guessing", () => {
        const roots = captureRoots({ ...payload(), command: "cd - && cd $HOME && ls" }, DEFAULT_HOOKS_CONFIG.diff);

        expect(roots).toEqual([repo]);
    });

    it("never returns more roots than maxRoots", () => {
        const roots = captureRoots(
            { ...payload(), command: `cd ${repo} && cd /tmp && cd /usr && cd /var && cd /etc && ls` },
            { ...DEFAULT_HOOKS_CONFIG.diff, maxRoots: 1 }
        );

        expect(roots).toHaveLength(1);
    });
});

describe("hunkRange", () => {
    it("spans every hunk in the patch", () => {
        const patch = ["@@ -1,3 +1,3 @@", " a", "-b", "+B", " c", "@@ -40,2 +40,5 @@", " x", "+y"].join("\n");

        expect(hunkRange(patch)).toEqual({ from: 1, to: 44 });
    });

    it("treats a hunk with no count as one line", () => {
        expect(hunkRange("@@ -7 +7 @@")).toEqual({ from: 7, to: 7 });
    });

    it("is null when there is no hunk, so nothing is highlighted", () => {
        expect(hunkRange("")).toBeNull();
    });
});

describe("a staged deletion does not cost the root its capture", () => {
    it("still reports an edit made in the same command as a `git rm`", () => {
        // `git status` lists a staged deletion, but the file is gone from disk, so `tar`
        // cannot stat it and exits 1 — and one such entry used to discard the WHOLE archive,
        // leaving every other file in the root with no before-state. Observed live on
        // 2026-09-20 by the diagnostic this PR added.
        writeFileSync(join(repo, "doomed.ts"), "gone\n");
        git(["add", "-A"]);
        git(["commit", "-qm", "doomed"]);
        git(["rm", "-qf", "doomed.ts"]);
        // A dirty file beside the deletion, which is what the capture must not lose.
        writeFileSync(join(repo, "kept.ts"), "alpha\nDIRTY-BEFORE\ncharlie\ndelta\necho\n");

        const current = begin();
        const dir = callDir(current.harness, current.sessionId ?? "", current.toolUseId ?? "");

        expect(existsSync(join(dir, "1.tar"))).toBe(true);

        writeFileSync(join(repo, "kept.ts"), "alpha\nSURVIVES-THE-DELETION\ncharlie\ndelta\necho\n");

        const decision = runDiffPost(current, {
            ...DEFAULT_HOOKS_CONFIG,
            diff: { ...DEFAULT_HOOKS_CONFIG.diff, highlight: "none" },
        });

        expect(decision.message).toContain("SURVIVES-THE-DELETION");
        expect(decision.message).toContain("(+1 -1)");

        git(["checkout", "--", "kept.ts"]);
        git(["reset", "-q", "--hard", "HEAD"]);
    });
});

describe("an ambiguous cd target is refused, not guessed", () => {
    // `nextRawArgument` is a naive quote matcher over raw text. Handing a path the shell
    // never meant to `git -C` is worse than missing one root, so these are all skipped.
    const refused = [
        `cd 'a'b'c' && ls`,
        `cd "a""b" && ls`,
        "cd \\ /etc && ls",
        "cd $(cat dir) && ls",
        "cd `pwd` && ls",
        "cd $HOME && ls",
        "cd - && ls",
    ];

    it.each(refused)("refuses %j and keeps only the cwd root", (command) => {
        expect(captureRoots({ ...payload(), command }, DEFAULT_HOOKS_CONFIG.diff)).toEqual([repo]);
    });

    it("skips a target that does not exist rather than spawning git for it", () => {
        expect(
            captureRoots({ ...payload(), command: "cd /nonexistent-zzz-9 && ls" }, DEFAULT_HOOKS_CONFIG.diff)
        ).toEqual([repo]);
    });
});

describe("a wholly untracked directory is counted file by file", () => {
    it("is expanded before the caps, so a big one is refused rather than archived whole", () => {
        mkdirSync(join(repo, "bulk"), { recursive: true });

        for (const n of [1, 2, 3]) {
            writeFileSync(join(repo, `bulk/f${n}.txt`), "x\n");
        }

        calls += 1;

        const current = payload();
        const result = capturePre(current, { ...DEFAULT_HOOKS_CONFIG.diff, maxCaptureFiles: 2 });
        const dir = callDir(current.harness, current.sessionId ?? "", current.toolUseId ?? "");

        expect(result.skipped.join("\n")).toContain("more than 2 dirty files");
        expect(existsSync(join(dir, "1.tar"))).toBe(false);

        rmSync(join(repo, "bulk"), { recursive: true, force: true });
    });

    it("archives its files, not the directory, so an ignored file inside stays out", () => {
        mkdirSync(join(repo, "cache"), { recursive: true });
        writeFileSync(join(repo, "cache/.gitignore"), "ignored.log\n");
        writeFileSync(join(repo, "cache/keep.ts"), "keep\n");
        writeFileSync(join(repo, "cache/ignored.log"), "secret-ish\n");

        const current = begin();
        const dir = callDir(current.harness, current.sessionId ?? "", current.toolUseId ?? "");
        const listing = spawnSync("tar", ["-tf", join(dir, "1.tar")], { encoding: "utf8", env: process.env }).stdout;

        expect(listing).toContain("cache/keep.ts");
        expect(listing).not.toContain("ignored.log");

        rmSync(join(repo, "cache"), { recursive: true, force: true });
    });
});

describe("a deletion that was already there when the command began", () => {
    const plain = { ...DEFAULT_HOOKS_CONFIG, diff: { ...DEFAULT_HOOKS_CONFIG.diff, highlight: "none" as const } };

    it("is not reported again after a later command", () => {
        writeFileSync(join(repo, "old-gone.ts"), "old\n");
        git(["add", "-A"]);
        git(["commit", "-qm", "old-gone"]);
        git(["rm", "-qf", "old-gone.ts"]);

        const current = begin();

        writeFileSync(join(repo, "kept.ts"), "alpha\nLATER-COMMAND\ncharlie\ndelta\necho\n");

        const decision = runDiffPost(current, plain);

        expect(decision.message).toContain("LATER-COMMAND");
        expect(decision.message).not.toContain("old-gone.ts");

        git(["reset", "-q", "--hard", "HEAD"]);
    });

    it("is still reported when this command made it", () => {
        writeFileSync(join(repo, "fresh-gone.ts"), "fresh\n");
        git(["add", "-A"]);
        git(["commit", "-qm", "fresh-gone"]);

        const current = begin();

        git(["rm", "-qf", "fresh-gone.ts"]);

        const decision = runDiffPost(current, plain);

        expect(decision.message).toContain("Deleted");
        expect(decision.message).toContain("fresh-gone.ts");

        git(["reset", "-q", "--hard", "HEAD"]);
    });
});

describe("a path with glob characters", () => {
    it("gets its captured before-state back, so an existing file is not blamed on the command", () => {
        mkdirSync(join(repo, "app"), { recursive: true });
        writeFileSync(join(repo, "app/[id].ts"), "one\ntwo\n");
        git(["add", "-A"]);
        git(["commit", "-qm", "bracket file"]);
        writeFileSync(join(repo, "app/[id].ts"), "one\nDIRTY-BEFORE\n");

        const current = begin();
        const dir = callDir(current.harness, current.sessionId ?? "", current.toolUseId ?? "");
        const before = beforeCopy(dir, repo, join(repo, "app/[id].ts"));

        expect(before).not.toBeNull();
        expect(readFileSync(before ?? "", "utf8")).toBe("one\nDIRTY-BEFORE\n");

        git(["reset", "-q", "--hard", "HEAD"]);
    });
});

describe("a capture directory another user could control", () => {
    it("is refused when a directory in its chain is a symlink", () => {
        const elsewhere = mkdtempSync(join(tmpdir(), "gt-capture-elsewhere-"));
        const planted = sessionDir("claude", "gt-diff-planted");

        mkdirSync(join(planted, ".."), { recursive: true });
        symlinkSync(elsewhere, planted);

        try {
            calls += 1;

            const result = capturePre(payload({ sessionId: "gt-diff-planted" }), DEFAULT_HOOKS_CONFIG.diff);

            expect(result.skipped.join("\n")).toContain("is not a plain directory");
            expect(existsSync(join(elsewhere, "diff", `call-${calls}`, "stamp"))).toBe(false);
        } finally {
            rmSync(planted, { force: true });
            rmSync(elsewhere, { recursive: true, force: true });
        }
    });
});
