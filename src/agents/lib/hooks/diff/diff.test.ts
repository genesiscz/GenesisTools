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
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { DEFAULT_HOOKS_CONFIG, type DiffConfig } from "../config";
import { isDeleted, statusEntries, untrackedFilesIn } from "../git";
import { callDir, claimsRoot, sessionDir } from "../paths";
import type { HookPayload } from "../payload";
import { beforeCopy } from "./before";
import { capturePre, captureRoots } from "./capture";
import { claimChange, claimFileName } from "./claim";
import { classifyChange, type DiffCategory } from "./classify";
import { changedFiles } from "./collect";
import { commandDirs, namedArguments } from "./command-paths";
import { assembleMessage, type DiffBlock, hasContext, highlightRange, hunkRange, renderPatch } from "./render";
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

function begin(overrides: Partial<HookPayload> = {}, diff: DiffConfig = DEFAULT_HOOKS_CONFIG.diff): HookPayload {
    calls += 1;

    const next = payload(overrides);

    capturePre(next, diff);

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

        const rendered = renderPatch(patch);

        expect(rendered.added).toBe(1);
        expect(rendered.removed).toBe(1);
        expect(rendered.body.length).toBe(4);
    });

    it("returns an empty body when there is no hunk", () => {
        expect(renderPatch("").body).toEqual([]);
    });

    it("tags which lines are the change, because that is what the budget spends on first", () => {
        const patch = ["@@ -1,3 +1,3 @@", " one", "-two", "+TWO", " three"].join("\n");
        const rendered = renderPatch(patch);

        expect(rendered.body.map((line) => line.changed)).toEqual([false, true, true, false]);
        // A context line carries its absolute number, which is how colour is found later.
        expect(rendered.body.map((line) => line.at)).toEqual([1, null, null, 3]);
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

describe("files the command NAMES rather than works in", () => {
    // Both shapes below were measured on 2026-09-21 producing a silent
    // `no change since this command began` while the file really had changed.
    const plain = { ...DEFAULT_HOOKS_CONFIG, diff: { ...DEFAULT_HOOKS_CONFIG.diff, highlight: "none" as const } };
    let vault: string;
    let outside: string;

    beforeAll(() => {
        vault = realpathSync(mkdtempSync(join(tmpdir(), "gt-vault-")));

        const run = (args: string[]) =>
            spawnSync("git", ["-C", vault, ...args], { encoding: "utf8", env: process.env });

        run(["init", "-q"]);
        run(["config", "user.email", "probe@local"]);
        run(["config", "user.name", "probe"]);
        writeFileSync(join(vault, "wrapup.md"), "alpha\nbravo\ncharlie\n");
        run(["add", "-A"]);
        run(["commit", "-qm", "init"]);

        outside = realpathSync(mkdtempSync(join(tmpdir(), "gt-outside-")));
        writeFileSync(join(outside, "MEMORY.md"), "one\ntwo\nthree\n");
    });

    afterAll(() => {
        rmSync(vault, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
    });

    it("renders an edit to a repository the command names but never enters", () => {
        const note = join(vault, "wrapup.md");
        const current = begin({ command: `bun /x/resolve.ts log "${note}"` });

        writeFileSync(note, "alpha\nBRAVO-NAMED\ncharlie\n");

        const decision = runDiffPost(current, plain);

        expect(decision.decision).toBe("emitted");
        expect(decision.files).toContain(note);
        expect(decision.message).toContain("BRAVO-NAMED");
        expect(decision.message).toContain("Updated");
    });

    it("renders an edit in a directory that is not a git repository at all", () => {
        const note = join(outside, "MEMORY.md");
        const current = begin({ command: `bun /x/cli.ts --out=${note}` });

        writeFileSync(note, "one\nTWO-OUTSIDE-GIT\nthree\n");

        expect(runDiffPost(current, plain).message).toContain("TWO-OUTSIDE-GIT");
    });

    it("stays quiet about a scratch file the command created, and prints it when asked", () => {
        // Two consecutive calls writing /tmp reports each got a 30-line block of a file the
        // command had just described in its own output. A creation found only through a
        // named path is off by default; an edit to a file that already existed still prints.
        const quiet = join(outside, "created-quiet.md");
        const off = begin({ command: `bun /x/cli.ts ${quiet}` });

        writeFileSync(quiet, "brand\nnew\n");

        expect(runDiffPost(off, plain).files).not.toContain(quiet);

        const loud = join(outside, "created-loud.md");
        const diff = { ...DEFAULT_HOOKS_CONFIG.diff, highlight: "none" as const, namedPathsShowCreated: true };
        const on = begin({ command: `bun /x/cli.ts ${loud}` }, diff);

        writeFileSync(loud, "brand\nnew\n");

        const decision = runDiffPost(on, { ...plain, diff });

        expect(decision.message).toContain("Added");
        expect(decision.message).toContain("brand");
    });

    it("renders a file the command removes as Deleted, with its lines", () => {
        const doomed = join(outside, "doomed.md");

        writeFileSync(doomed, "gone\nsoon\n");

        const current = begin({ command: `bun /x/cli.ts ${doomed}` });

        rmSync(doomed);

        const decision = runDiffPost(current, plain);

        expect(decision.message).toContain("Deleted");
        expect(decision.message).toContain("gone");
    });

    it("stays silent when the named file did not change", () => {
        const current = begin({ command: `bun /x/cli.ts ${join(vault, "wrapup.md")}` });

        expect(runDiffPost(current, plain).decision).toBe("silent");
    });

    it("stands down for a named file the harness already rendered", () => {
        const note = join(vault, "wrapup.md");
        const current = begin({ command: `bun /x/cli.ts ${note}`, nativeDiffFiles: [note] });

        writeFileSync(note, "alpha\nNATIVE-ALREADY\ncharlie\n");

        const decision = runDiffPost(current, plain);

        expect(decision.decision).toBe("silent");
        expect(decision.reason).toContain("already rendered natively");
    });

    it("renders a file inside the cwd repository only once", () => {
        const tracked = join(repo, "kept.ts");
        const current = begin({ command: `bun /x/cli.ts ${tracked}` });

        writeFileSync(tracked, "alpha\nONCE-ONLY\ncharlie\ndelta\necho\n");

        const decision = runDiffPost(current, plain);

        expect(decision.files.filter((path) => path === tracked)).toHaveLength(1);
        expect(decision.message?.match(/ONCE-ONLY/g)).toHaveLength(1);

        git(["checkout", "--", "kept.ts"]);
    });

    it("watchNamedPaths:false turns the pass off, and true is what turns it on", () => {
        const note = join(vault, "wrapup.md");
        const run = (watchNamedPaths: boolean, marker: string) => {
            const diff = { ...DEFAULT_HOOKS_CONFIG.diff, highlight: "none" as const, watchNamedPaths };
            const current = begin({ command: `bun /x/cli.ts ${note}` }, diff);

            writeFileSync(note, `alpha\n${marker}\ncharlie\n`);

            return runDiffPost(current, { ...plain, diff });
        };

        // The ON arm is the positive control: without it, a pass that never ran at all would
        // pass the OFF assertion.
        expect(run(true, "WATCHED").message).toContain("WATCHED");
        expect(run(false, "NOT-WATCHED").files).toEqual([]);
    });

    it("records an oversize named file as skipped instead of copying it", () => {
        const big = join(outside, "big.md");

        writeFileSync(big, "x".repeat(4096));

        const current = payload({ command: `tee ${big}` });

        calls += 1;
        current.toolUseId = `call-big-${calls}`;

        const result = capturePre(current, { ...DEFAULT_HOOKS_CONFIG.diff, maxNamedPathMB: 0.001 });

        expect(result.named).toBe(0);
        expect(result.skipped.join(" ")).toContain("named-path cap");
    });

    it("does not read a path out of a heredoc BODY", () => {
        const note = join(vault, "wrapup.md");

        expect(namedArguments(`bun /x/cli.ts <<'EOF'\n- see ${note}\nEOF`, [vault])).not.toContain(note);
    });

    it("finds a quoted path, which the scanner blanks out of the token stream", () => {
        const note = join(vault, "wrapup.md");

        expect(namedArguments(`bun /x/cli.ts log "${note}"`, [vault])).toContain(note);
    });

    it.each([
        ["a URL", "curl https://example.com/a/b"],
        ["a variable", 'bun x "$HOME/note.md"'],
    ])("refuses %s", (_label, command) => {
        expect(namedArguments(command, [vault])).toEqual([]);
    });

    it("never turns a command substitution into a path that exists", () => {
        // The scanner lifts `$( … )` into its own unit, so what is left of the token can
        // still look like a path. It must never resolve onto a real file.
        const found = namedArguments(`bun x $(cat which)/wrapup.md`, [vault]);

        expect(found).not.toContain(join(vault, "wrapup.md"));
        expect(found.filter((path) => existsSync(path))).toEqual([]);
    });
});

describe("two sessions sharing one repository", () => {
    // Three Claude sessions routinely write into one Obsidian vault. A file session B writes
    // during session A's command window is newer than A's stamp, so without a claim every
    // session prints every session's edits.
    const plain = { ...DEFAULT_HOOKS_CONFIG, diff: { ...DEFAULT_HOOKS_CONFIG.diff, highlight: "none" as const } };
    let shared: string;

    beforeAll(() => {
        shared = join(repo, "shared.ts");
        writeFileSync(shared, "one\ntwo\nthree\n");
        git(["add", "-A"]);
        git(["commit", "-qm", "shared"]);
    });

    afterAll(() => {
        for (const session of ["gt-diff-a", "gt-diff-b", "gt-diff-c"]) {
            rmSync(sessionDir("claude", session), { recursive: true, force: true });
        }
    });

    it("prints the change once, not once per session", () => {
        const a = begin({ sessionId: "gt-diff-a", toolUseId: "share-1" });
        const b = begin({ sessionId: "gt-diff-b", toolUseId: "share-1" });

        writeFileSync(shared, "one\nSHARED-ONCE\nthree\n");

        const first = runDiffPost(a, plain);
        const second = runDiffPost(b, plain);

        expect(first.files).toContain(shared);
        expect(first.message).toContain("SHARED-ONCE");
        expect(second.files).not.toContain(shared);
        expect(second.message ?? "").not.toContain("SHARED-ONCE");
    });

    it("prints the NEXT change to the same file again", () => {
        const c = begin({ sessionId: "gt-diff-c", toolUseId: "share-2" });

        writeFileSync(shared, "one\nSHARED-SECOND-EDIT\nthree\n");

        expect(runDiffPost(c, plain).message).toContain("SHARED-SECOND-EDIT");
    });

    it("prints a later edit by the same session, then not the unchanged state again", () => {
        const again = begin({ sessionId: "gt-diff-c", toolUseId: "share-3" });

        writeFileSync(shared, "one\nSAME-SESSION-AGAIN\nthree\n");

        expect(runDiffPost(again, plain).message).toContain("SAME-SESSION-AGAIN");

        const retry = begin({ sessionId: "gt-diff-c", toolUseId: "share-4" });

        // No further edit, so the mtime is older than this call's stamp. This is the `since`
        // filter, NOT the claim: the claim's own behaviour is pinned in "the render claim,
        // on its own", because an edit always moves the mtime and never repeats a key.
        expect(runDiffPost(retry, plain).files).not.toContain(shared);
    });

    it("dedupeAcrossSessions:false lets both sessions print it", () => {
        const diff = { ...DEFAULT_HOOKS_CONFIG.diff, highlight: "none" as const, dedupeAcrossSessions: false };
        const a = begin({ sessionId: "gt-diff-a", toolUseId: "loose-1" }, diff);
        const b = begin({ sessionId: "gt-diff-b", toolUseId: "loose-1" }, diff);

        writeFileSync(shared, "one\nBOTH-PRINT\nthree\n");

        expect(runDiffPost(a, { ...plain, diff }).message).toContain("BOTH-PRINT");
        expect(runDiffPost(b, { ...plain, diff }).message).toContain("BOTH-PRINT");

        git(["checkout", "--", "shared.ts"]);
    });
});

describe("a tree too dirty to capture whole", () => {
    // Measured 2026-09-21 on the Obsidian vault: 64 dirty entries, 43 MB, 8 MB cap, of which
    // three data files were 34 MB. The old all-or-nothing rule cost a 30 KB note its
    // before-state, and the post phase then printed the whole note as `Added` on every call.
    const plain = { ...DEFAULT_HOOKS_CONFIG, diff: { ...DEFAULT_HOOKS_CONFIG.diff, highlight: "none" as const } };
    let big: string;
    let small: string;

    beforeAll(() => {
        big = realpathSync(mkdtempSync(join(tmpdir(), "gt-bigtree-")));

        const run = (args: string[]) => spawnSync("git", ["-C", big, ...args], { encoding: "utf8", env: process.env });

        run(["init", "-q"]);
        run(["config", "user.email", "probe@local"]);
        run(["config", "user.name", "probe"]);
        writeFileSync(join(big, "seed.txt"), "seed\n");
        run(["add", "-A"]);
        run(["commit", "-qm", "init"]);

        // One blob far over the budget, beside the small note that matters.
        writeFileSync(join(big, "blob.bin"), "x".repeat(400_000));
        small = join(big, "note.md");
        writeFileSync(small, "alpha\nbravo\ncharlie\n");
    });

    afterAll(() => {
        rmSync(big, { recursive: true, force: true });
    });

    it("still captures the small file, so its diff is a delta and not the whole file", () => {
        const diff = { ...DEFAULT_HOOKS_CONFIG.diff, highlight: "none" as const, maxCaptureMB: 0.1 };
        const current = begin({ cwd: big, toolUseId: "bigtree-1" }, diff);

        writeFileSync(small, "alpha\nBRAVO-DELTA\ncharlie\n");

        const decision = runDiffPost(current, { ...plain, diff });

        expect(decision.message).toContain("BRAVO-DELTA");
        expect(decision.message).toContain("Updated");
        expect(decision.message).not.toContain("Added");
        expect(decision.message).toContain("(+1 -1)");
    });

    it("never reports a file it could not capture as one the command created", () => {
        // Budget below even the small file, so nothing in this root has a before-state.
        const diff = { ...DEFAULT_HOOKS_CONFIG.diff, highlight: "none" as const, maxCaptureMB: 0.000001 };
        const current = begin({ cwd: big, toolUseId: "bigtree-2" }, diff);

        writeFileSync(small, "alpha\nNOT-ADDED\ncharlie\n");

        const decision = runDiffPost(current, { ...plain, diff });

        expect(decision.decision).toBe("silent");
        expect(decision.reason).toContain("no captured before-state");
    });
});

describe("a path with a non-ASCII name", () => {
    // 🛑 git reports NFC, macOS tar stores NFD. Measured 2026-09-21 on a note in an accented
    // directory: `tar -xOf` with git's NFC name exits 1 with no output, with the NFD name it
    // returns all 54 KB. The before-state was therefore always missing, and every accented
    // note printed IN FULL as `Added` on every command, nine times on one file before it was
    // caught.
    const plain = { ...DEFAULT_HOOKS_CONFIG, diff: { ...DEFAULT_HOOKS_CONFIG.diff, highlight: "none" as const } };
    let accented: string;

    beforeAll(() => {
        mkdirSync(join(repo, "Ünïcöde"), { recursive: true });
        accented = join(repo, "Ünïcöde", "Ärchiv-Nöte.md");
        writeFileSync(accented, "alpha\nbravo\ncharlie\n");
    });

    it("keeps the before-state of an untracked file, so it is Updated and not re-Added", () => {
        const current = begin({ toolUseId: "accented-1" });

        writeFileSync(accented, "alpha\nBRAVO-DIACRITICS\ncharlie\n");

        const decision = runDiffPost(current, plain);

        expect(decision.files).toContain(accented);
        expect(decision.message).toContain("BRAVO-DIACRITICS");
        expect(decision.message).toContain("Updated");
        expect(decision.message).not.toContain("Added");
        expect(decision.message).toContain("(+1 -1)");
    });

    it("extracts the same bytes the capture put in", () => {
        writeFileSync(accented, "one\ntwo\n");

        const current = begin({ toolUseId: "accented-2" });
        const dir = callDir(current.harness, current.sessionId ?? "", current.toolUseId ?? "");

        writeFileSync(accented, "one\nTWO-CHANGED\n");

        const copy = beforeCopy(dir, repo, accented);

        expect(copy).not.toBeNull();
        expect(readFileSync(copy as string, "utf8")).toBe("one\ntwo\n");
    });
});

describe("the capture budget sees what an entry really weighs", () => {
    // 🛑 A wholly-untracked DIRECTORY is ONE status entry and a whole tree on disk, and
    // `statSync` reports the inode. Measured 2026-09-21: an 11.2 MB untracked directory
    // weighed in at 704 bytes and sailed through a cap of eight million, which is how a
    // budgeted capture still wrote tens of megabytes per command.
    let tree: string;

    beforeAll(() => {
        tree = realpathSync(mkdtempSync(join(tmpdir(), "gt-budget-")));

        const run = (args: string[]) => spawnSync("git", ["-C", tree, ...args], { encoding: "utf8", env: process.env });

        run(["init", "-q"]);
        run(["config", "user.email", "probe@local"]);
        run(["config", "user.name", "probe"]);
        writeFileSync(join(tree, "seed.txt"), "seed\n");
        run(["add", "-A"]);
        run(["commit", "-qm", "init"]);

        // One untracked directory that is small by inode and large by contents.
        mkdirSync(join(tree, "bulk"), { recursive: true });
        writeFileSync(join(tree, "bulk", "big.bin"), "x".repeat(300_000));
        writeFileSync(join(tree, "note.md"), "alpha\nbravo\n");
    });

    afterAll(() => {
        rmSync(tree, { recursive: true, force: true });
    });

    it("leaves a heavy untracked directory out and still captures the small file beside it", () => {
        const diff = { ...DEFAULT_HOOKS_CONFIG.diff, highlight: "none" as const, maxCaptureFileMB: 0.1 };
        const current = begin({ cwd: tree, toolUseId: "budget-1" }, diff);

        writeFileSync(join(tree, "note.md"), "alpha\nBRAVO-SMALL\n");

        const decision = runDiffPost(current, { ...DEFAULT_HOOKS_CONFIG, diff });

        expect(decision.message).toContain("BRAVO-SMALL");
        expect(decision.message).toContain("Updated");
    });

    it("reports the heavy directory as left out rather than silently capturing it", () => {
        const diff = { ...DEFAULT_HOOKS_CONFIG.diff, maxCaptureFileMB: 0.1 };
        const current = payload({ cwd: tree, toolUseId: "budget-2" });

        calls += 1;

        const result = capturePre(current, diff);

        expect(result.skipped.join(" ")).toContain("per-entry");
        expect(result.skipped.join(" ")).toContain("1 of 2 dirty entries left out");
    });

    it("does not blame the command for earlier edits to a large tracked file it left out", () => {
        const big = join(tree, "big.txt");
        const lines = Array.from({ length: 6000 }, (_, index) => `line ${index} ${"y".repeat(40)}`);

        writeFileSync(big, `${lines.join("\n")}\n`);
        spawnSync("git", ["-C", tree, "add", "big.txt"], { encoding: "utf8", env: process.env });
        spawnSync("git", ["-C", tree, "commit", "-qm", "big"], { encoding: "utf8", env: process.env });
        // An EARLIER command left it dirty; this is not the current command's change.
        writeFileSync(big, `EARLIER-EDIT\n${lines.join("\n")}\n`);

        const diff = { ...DEFAULT_HOOKS_CONFIG.diff, highlight: "none" as const, maxCaptureFileMB: 0.1 };
        const current = begin({ cwd: tree, toolUseId: "budget-4" }, diff);

        writeFileSync(big, `EARLIER-EDIT\n${lines.join("\n")}\nTHIS-COMMAND\n`);

        const decision = runDiffPost(current, { ...DEFAULT_HOOKS_CONFIG, diff });

        expect(decision.message ?? "").not.toContain("EARLIER-EDIT");
        expect(decision.files).not.toContain(big);
        spawnSync("git", ["-C", tree, "checkout", "--", "big.txt"], { encoding: "utf8", env: process.env });
    });

    it("never archives an ignored file that sits inside an untracked directory", () => {
        mkdirSync(join(tree, "scratch"), { recursive: true });
        writeFileSync(join(tree, ".gitignore"), "*.env\n");
        writeFileSync(join(tree, "scratch", "draft.md"), "draft\n");
        writeFileSync(join(tree, "scratch", "secret.env"), "TOKEN=not-real\n");

        const current = payload({ cwd: tree, toolUseId: "budget-3" });

        calls += 1;
        capturePre(current, DEFAULT_HOOKS_CONFIG.diff);

        const call = callDir(current.harness, "gt-diff-test", "budget-3");
        const members = spawnSync("tar", ["-tf", join(call, "1.tar")], { encoding: "utf8", env: process.env }).stdout;

        expect(members).toContain("scratch/draft.md");
        expect(members).not.toContain("secret.env");
        rmSync(call, { recursive: true, force: true });
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

describe("a dirty submodule", () => {
    let outer: string;
    let inner: string;

    beforeAll(() => {
        inner = realpathSync(mkdtempSync(join(tmpdir(), "gt-sub-inner-")));
        outer = realpathSync(mkdtempSync(join(tmpdir(), "gt-sub-outer-")));

        const run = (dir: string, args: string[]) =>
            spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: process.env });

        for (const dir of [inner, outer]) {
            run(dir, ["init", "-q"]);
            run(dir, ["config", "user.email", "probe@local"]);
            run(dir, ["config", "user.name", "probe"]);
            writeFileSync(join(dir, "seed.txt"), "seed\n");
            run(dir, ["add", "-A"]);
            run(dir, ["commit", "-qm", "init"]);
        }

        run(outer, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "child"]);
        run(outer, ["commit", "-qm", "child"]);
        writeFileSync(join(outer, "child", "scratch.txt"), "inside the submodule\n");
        writeFileSync(join(outer, "seed.txt"), "seed\nedited\n");
    });

    afterAll(() => {
        rmSync(outer, { recursive: true, force: true });
        rmSync(inner, { recursive: true, force: true });
    });

    it("is never archived as a directory, while the dirty file beside it still is", () => {
        const current = begin({ cwd: outer, toolUseId: `submodule-${calls}` });
        const dir = callDir(current.harness, current.sessionId ?? "", current.toolUseId ?? "");
        const listing = spawnSync("tar", ["-tf", join(dir, "1.tar")], { encoding: "utf8", env: process.env }).stdout;

        // The precondition, asserted rather than assumed: git reports `child` as a dirty submodule.
        const status = spawnSync("git", ["-C", outer, "status", "--porcelain=v2"], {
            encoding: "utf8",
            env: process.env,
        });

        expect(status.stdout).toMatch(/^1 \S+ S\S* .* child$/m);
        expect(listing).toContain("seed.txt");
        expect(listing).not.toContain("child");
    });
});

describe("what KIND of change it is", () => {
    // A jest run redirected into a scratch log, truncated by the next run, rendered as 27
    // lines of stack trace. A formatter pass renders as a wall of lines that say what they
    // said before. Neither is a change anyone asked to see.
    const cases: [string, string, DiffCategory][] = [
        ["a scratch log", "/tmp/z1.log", "log"],
        ["a log by extension", "/repo/run.out", "log"],
        ["a file in a logs directory", "/repo/logs/today.txt", "log"],
        ["a lockfile", "/repo/bun.lock", "generated"],
        ["a snapshot", "/repo/__snapshots__/a.snap", "generated"],
        ["a build artifact", "/repo/dist/index.js", "generated"],
        ["a junit report", "/repo/junit.xml", "generated"],
        ["plain source", "/repo/src/index.ts", "source"],
        ["a logger module is NOT a log", "/repo/src/logger/logs.ts", "source"],
    ];

    it.each(cases)("calls %s %s", (_label, path, expected) => {
        expect(classifyChange(path, "@@ -1 +1 @@\n-one\n+two\n")).toBe(expected);
    });

    it("calls a reindentation formatting, and a real edit source", () => {
        const reindented = "@@ -1,2 +1,2 @@\n-  const a = 1;\n-\tconst b = 2;\n+    const a = 1;\n+    const b = 2;\n";
        const reordered =
            "@@ -1,2 +1,2 @@\n-import b from 'b';\n-import a from 'a';\n+import a from 'a';\n+import b from 'b';\n";
        const real = "@@ -1,2 +1,2 @@\n-const a = 1;\n-const b = 2;\n+const a = 1;\n+const b = 99;\n";

        expect(classifyChange("/repo/src/x.ts", reindented)).toBe("formatting");
        expect(classifyChange("/repo/src/x.ts", reordered)).toBe("formatting");
        expect(classifyChange("/repo/src/x.ts", real)).toBe("source");
    });

    it("tests the directories below the repository root, never the root's own ancestors", () => {
        const patch = "@@ -1 +1 @@\n-one\n+two\n";

        expect(classifyChange("/home/u/build/app/src/x.ts", patch, "/home/u/build/app")).toBe("source");
        expect(classifyChange("/home/u/dev/logs/tool/src/x.ts", patch, "/home/u/dev/logs/tool")).toBe("source");
        expect(classifyChange("/home/u/build/app/dist/x.js", patch, "/home/u/build/app")).toBe("generated");
        expect(classifyChange("/tmp/z1.log", patch, "/tmp")).toBe("log");
    });

    it("never calls a brand new file formatting, however tidy it is", () => {
        expect(classifyChange("/repo/src/new.ts", "@@ -0,0 +1,2 @@\n+const a = 1;\n+const b = 2;\n")).toBe("source");
    });
});

describe("hiding a kind of change", () => {
    const base = { ...DEFAULT_HOOKS_CONFIG, diff: { ...DEFAULT_HOOKS_CONFIG.diff, highlight: "none" as const } };
    let scratch: string;

    beforeAll(() => {
        scratch = realpathSync(mkdtempSync(join(tmpdir(), "gt-kinds-")));
    });

    afterAll(() => {
        rmSync(scratch, { recursive: true, force: true });
    });

    /** One command that rewrites a log the way a redirected test run does. */
    function runOver(log: string, categories: Partial<Record<string, boolean>>) {
        writeFileSync(log, "console.error\n  at saga.ts:33:13\n  at next\n");

        const diff = {
            ...DEFAULT_HOOKS_CONFIG.diff,
            highlight: "none" as const,
            categories: { ...DEFAULT_HOOKS_CONFIG.diff.categories, ...categories },
        };
        const current = begin({ command: `bun /x/jest.ts > ${log}`, toolUseId: `kind-${calls}` }, diff);

        writeFileSync(log, "console.error\n");

        return runDiffPost(current, { ...base, diff });
    }

    it("hides a scratch log by default and says so, and prints it when asked", () => {
        const quiet = runOver(join(scratch, "z1.log"), {});

        expect(quiet.files).toEqual([]);
        expect(quiet.reason).toContain("a kind this config hides");
        expect(quiet.reason).toContain("log");

        const loud = runOver(join(scratch, "z2.log"), { log: true });

        expect(loud.decision).toBe("emitted");
        expect(loud.message).toContain("z2.log");
    });

    it("names the kind in the header, so a block that is on sufferance says why", () => {
        const loud = runOver(join(scratch, "z3.log"), { log: true });

        expect(loud.message).toContain("· log");
    });

    it("leaves a plain source block untagged", () => {
        const note = join(scratch, "plain.ts");

        writeFileSync(note, "one\ntwo\n");

        const current = begin({ command: `bun /x/cli.ts ${note}`, toolUseId: `kind-src-${calls}` });

        writeFileSync(note, "one\nTWO-REAL\n");

        const decision = runDiffPost(current, base);

        expect(decision.message).toContain("TWO-REAL");
        expect(decision.message).not.toContain("·");
    });
});

describe("a command that edits AND commits in the same call", () => {
    // Measured 2026-09-21 in a live session: five commands edited the same file, four of them
    // finished with `git commit` and rendered nothing, the one that did not commit rendered.
    // `git status` is silent about a file the command just committed, because it is clean.
    const plain = { ...DEFAULT_HOOKS_CONFIG, diff: { ...DEFAULT_HOOKS_CONFIG.diff, highlight: "none" as const } };
    let repo2: string;

    const run = (args: string[]) => spawnSync("git", ["-C", repo2, ...args], { encoding: "utf8", env: process.env });

    beforeAll(() => {
        repo2 = realpathSync(mkdtempSync(join(tmpdir(), "gt-commits-")));
        run(["init", "-q"]);
        run(["config", "user.email", "probe@local"]);
        run(["config", "user.name", "probe"]);
        writeFileSync(join(repo2, "note.md"), "one\ntwo\nthree\n");
        run(["add", "-A"]);
        run(["commit", "-qm", "init"]);
    });

    afterAll(() => {
        rmSync(repo2, { recursive: true, force: true });
    });

    it("renders the edit even though the commit made the file clean again", () => {
        const note = join(repo2, "note.md");
        const current = begin({ cwd: repo2, toolUseId: "commit-1" });

        writeFileSync(note, "one\nEDIT-THEN-COMMIT\nthree\n");
        run(["add", "-A"]);
        run(["commit", "-qm", "same call"]);

        const decision = runDiffPost(current, plain);

        expect(decision.files).toContain(note);
        expect(decision.message).toContain("EDIT-THEN-COMMIT");
        expect(decision.message).toContain("(+1 -1)");
    });

    it("renders a file ONCE when the command commits it and then edits it again", () => {
        // Such a file is in the committed list AND still in `git status`, so it used to be
        // collected twice and rendered twice. `dedupeAcrossSessions` is off on purpose: the
        // claim ledger would mask the duplicate, and this pins the collector itself.
        const diff = { ...plain.diff, dedupeAcrossSessions: false };
        const twice = join(repo2, "twice.md");

        writeFileSync(twice, "one\ntwo\n");
        run(["add", "-A"]);
        run(["commit", "-qm", "seed twice"]);

        const current = begin({ cwd: repo2, toolUseId: "commit-4" }, diff);

        writeFileSync(twice, "one\nCOMMITTED-EDIT\n");
        run(["add", "-A"]);
        run(["commit", "-qm", "commit inside the call"]);
        writeFileSync(twice, "one\nCOMMITTED-EDIT\nAND-AGAIN\n");

        const decision = runDiffPost(current, { ...plain, diff });

        expect(decision.files.filter((path) => path === twice)).toHaveLength(1);
    });

    it("does not blame the command for a commit that only moved HEAD", () => {
        // A commit of something staged by an EARLIER command: the file's mtime predates this
        // capture, so the mtime filter keeps it out.
        const older = join(repo2, "staged-earlier.md");

        writeFileSync(older, "old\ncontent\n");
        run(["add", "-A"]);

        const past = Date.now() / 1000 - 3600;

        utimesSync(older, past, past);

        const current = begin({ cwd: repo2, toolUseId: "commit-2" });

        run(["commit", "-qm", "commit only"]);

        expect(runDiffPost(current, plain).files).not.toContain(older);
    });

    it("still works in a repository that has no commits at all", () => {
        const empty = realpathSync(mkdtempSync(join(tmpdir(), "gt-empty-")));

        spawnSync("git", ["-C", empty, "init", "-q"], { encoding: "utf8", env: process.env });

        const current = begin({ cwd: empty, toolUseId: "commit-3" });

        writeFileSync(join(empty, "fresh.md"), "brand\nnew\n");

        const decision = runDiffPost(current, plain);

        expect(decision.message).toContain("brand");

        rmSync(empty, { recursive: true, force: true });
    });
});

describe("a deletion that is still sitting in `git status`", () => {
    // `git status` reports a deletion until it is committed, and a deletion has no mtime, so
    // the `since` filter that gates every edit cannot gate it. Measured 2026-09-21 on one
    // `git rm --cached`: 14 renders over seven minutes, one per later command in that
    // repository, 13 of them spurious.
    const plain = { ...DEFAULT_HOOKS_CONFIG, diff: { ...DEFAULT_HOOKS_CONFIG.diff, highlight: "none" as const } };

    beforeAll(() => {
        writeFileSync(join(repo, "doomed.ts"), "one\ntwo\nthree\n");
        git(["add", "-A"]);
        git(["commit", "-qm", "doomed"]);
    });

    afterAll(() => {
        git(["checkout", "--", "doomed.ts"]);
        rmSync(sessionDir("claude", "gt-diff-gone"), { recursive: true, force: true });
    });

    it("renders the removal once, on the command that made it", () => {
        const removing = begin({ sessionId: "gt-diff-gone", toolUseId: "gone-1" }, plain.diff);

        rmSync(join(repo, "doomed.ts"));

        const decision = runDiffPost(removing, plain);

        expect(decision.message).toContain("Deleted");
        expect(decision.message).toContain("two");
    });

    it("says nothing on the next command, though git still reports the deletion", () => {
        // The precondition, asserted rather than assumed: git has not forgotten it.
        expect(statusEntries(repo).some((entry) => entry.path === "doomed.ts" && isDeleted(entry))).toBe(true);

        const later = begin({ sessionId: "gt-diff-gone", toolUseId: "gone-2" }, plain.diff);
        const decision = runDiffPost(later, plain);

        expect(decision.decision).toBe("silent");
        expect(decision.reason).toContain("already happened before this command began");
    });

    it("renders a LATER deletion of the same path, after a restore the hook never rendered", () => {
        // `git checkout` leaves the file clean, so no render ever replaced the first deletion's
        // claim. A fixed deletion key made this second, separate deletion read as rendered.
        git(["checkout", "--", "doomed.ts"]);

        const again = begin({ sessionId: "gt-diff-gone", toolUseId: "gone-3" }, plain.diff);

        rmSync(join(repo, "doomed.ts"));

        const decision = runDiffPost(again, plain);

        expect(decision.decision).toBe("emitted");
        expect(decision.message).toContain("Deleted");
    });
});

describe("the render claim, on its own", () => {
    const solo = "gt-diff-claim-solo";
    // NOT `join(repo, …)`: `repo` is assigned in a `beforeAll`, so a describe body reading it
    // throws at collection time. `claimChange` only ever hashes the path, never stats it.
    const one = join(tmpdir(), "gt-claim-unit-one.ts");
    const two = join(tmpdir(), "gt-claim-unit-two.ts");

    const three = join(tmpdir(), "gt-claim-unit-three.ts");
    const keys = [
        { path: one, mtimeMs: 1_700_000_000_000, size: 42 },
        { path: two, mtimeMs: 1, size: 10 },
        { path: two, mtimeMs: 2, size: 10 },
        { path: three, mtimeMs: 1, size: 5 },
        { path: three, mtimeMs: 2, size: 5 },
    ];

    afterAll(() => {
        for (const key of keys) {
            rmSync(join(claimsRoot(), claimFileName(key)), { force: true });
        }
    });

    it("lets exactly one session claim a NEWER state of a path another session already printed", () => {
        // The takeover of an older claim used to be a read and then a plain write, so two
        // sessions arriving at the same new state could both win. Now each state is its own
        // exclusive create.
        expect(claimChange({ path: three, mtimeMs: 1, size: 5 }, "gt-claim-a")).toBe(true);
        expect(claimChange({ path: three, mtimeMs: 2, size: 5 }, "gt-claim-b")).toBe(true);
        expect(claimChange({ path: three, mtimeMs: 2, size: 5 }, "gt-claim-c")).toBe(false);
        expect(claimFileName({ path: three, mtimeMs: 1, size: 5 })).not.toBe(
            claimFileName({ path: three, mtimeMs: 2, size: 5 })
        );
    });

    it("does not let ONE session print the same state twice", () => {
        const key = { path: one, mtimeMs: 1_700_000_000_000, size: 42 };

        expect(claimChange(key, solo)).toBe(true);
        expect(claimChange(key, solo)).toBe(false);
    });

    it("still prints the NEXT state of that same path", () => {
        expect(claimChange({ path: two, mtimeMs: 1, size: 10 }, solo)).toBe(true);
        expect(claimChange({ path: two, mtimeMs: 2, size: 10 }, solo)).toBe(true);
    });
});

describe("one message, fitted to what the harness will actually show", () => {
    // Measured 2026-09-21 over 206 PostToolUse messages in one session: the largest shown
    // whole was 9814 bytes, the smallest cut was about 10138, and 13 of the 206 were cut. A
    // cut message keeps the first file and loses the last, silently.
    const block = (name: string, lines: number): DiffBlock => ({
        head: `head ${name}`,
        body: Array.from({ length: lines }, (_, index) => ({
            text: `${name} line ${index} ${"x".repeat(40)}`,
            changed: false,
            at: index + 1,
        })),
    });
    const budget = (bytes: number) => ({ ...DEFAULT_HOOKS_CONFIG.diff, maxMessageBytes: bytes });

    it("never exceeds maxMessageBytes", () => {
        expect(assembleMessage([block("a", 60), block("b", 60)], budget(600)).length).toBeLessThanOrEqual(600);
    });

    it("counts the budget in UTF-8 bytes, so accented text cannot overrun it", () => {
        const accented: DiffBlock = {
            head: "head č",
            body: Array.from({ length: 60 }, (_, index) => ({
                text: `řádek ${index} ${"č".repeat(40)}`,
                changed: true,
                at: index + 1,
            })),
        };
        const message = assembleMessage([accented, block("b", 10)], budget(600));

        expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(600);
    });

    it("keeps EVERY header, because losing the last file is the bug being fixed", () => {
        const message = assembleMessage([block("a", 200), block("b", 1)], budget(400));

        expect(message).toContain("head a");
        expect(message).toContain("head b");
    });

    it("does not let a large diff starve a one-line change listed after it", () => {
        expect(assembleMessage([block("big", 200), block("small", 1)], budget(900))).toContain("small line 0");
    });

    it("says how many lines it dropped", () => {
        expect(assembleMessage([block("a", 50)], budget(300))).toMatch(/… \d+ more lines/);
    });

    it("leaves a message that already fits completely alone", () => {
        const message = assembleMessage([block("a", 3)], budget(9_000));

        expect(message).toContain("a line 2");
        expect(message).not.toMatch(/more lines/);
    });

    it("still caps one file at maxLinesPerFile", () => {
        const message = assembleMessage([block("a", 200)], { ...budget(500_000), maxLinesPerFile: 4 });

        expect(message.split("\n").filter((line) => line.startsWith("a line")).length).toBe(4);
    });
});

describe("a harness that cannot show a diff", () => {
    const plain = { ...DEFAULT_HOOKS_CONFIG, diff: { ...DEFAULT_HOOKS_CONFIG.diff, highlight: "none" as const } };

    it("renders nothing for grok, on a call that really did change a file", () => {
        const current = begin({ harness: "grok" });

        writeFileSync(join(repo, "kept.ts"), "alpha\nGROK-EDIT\ncharlie\ndelta\necho\n");

        const decision = runDiffPost(current, plain);

        expect(decision.decision).toBe("skip");
        expect(decision.message).toBeUndefined();

        git(["checkout", "--", "kept.ts"]);
        rmSync(sessionDir("grok", "gt-diff-test"), { recursive: true, force: true });
    });

    it("still renders the same change for claude, so the gate is the harness and nothing else", () => {
        const current = begin();

        writeFileSync(join(repo, "kept.ts"), "alpha\nCLAUDE-EDIT\ncharlie\ndelta\necho\n");

        const decision = runDiffPost(current, plain);

        expect(decision.decision).toBe("emitted");
        expect(decision.message).toContain("CLAUDE-EDIT");

        git(["checkout", "--", "kept.ts"]);
    });
});

describe("the budget buys the change before the context", () => {
    // One four-line edit, rendered the way git emits it: context lines FIRST. Every line is
    // about 95 bytes, so a budget can be set to a whole number of them.
    const edit = (name: string): DiffBlock => ({
        head: `head ${name}`,
        body: [
            { text: `${name} context one ${"x".repeat(80)}`, changed: false, at: 1 },
            { text: `${name} context two ${"x".repeat(80)}`, changed: false, at: 2 },
            { text: `${name} context three ${"x".repeat(78)}`, changed: false, at: 3 },
            { text: `${name} CHANGED plus ${"x".repeat(78)}`, changed: true, at: null },
            { text: `${name} CHANGED minus ${"x".repeat(77)}`, changed: true, at: null },
            { text: `${name} context four ${"x".repeat(79)}`, changed: false, at: 4 },
        ],
    });
    const budget = (bytes: number) => ({ ...DEFAULT_HOOKS_CONFIG.diff, maxMessageBytes: bytes });

    it("prints the added and removed lines and not the context around them", () => {
        const message = assembleMessage([edit("a")], budget(300));

        expect(message).toContain("CHANGED plus");
        expect(message).toContain("CHANGED minus");
        expect(message).not.toContain("context");
    });

    it("gives EVERY file of a wide sweep a real change line", () => {
        // The measured failure, 2026-09-22: 15 parity contracts, each a four-line edit, and
        // every block printed two context lines and elided all eight of its changed lines.
        const names = Array.from({ length: 15 }, (_, index) => `f${String(index + 1).padStart(2, "0")}`);
        const message = assembleMessage(
            names.map((name) => edit(name)),
            budget(2_200)
        );

        for (const name of names) {
            expect(message).toContain(`${name} CHANGED plus`);
            expect(message).not.toContain(`${name} context`);
        }
    });

    it("does not buy syntax colour for a context line the budget will not print", () => {
        const one = edit("a");
        let spawns = 0;

        one.colour = () => {
            spawns += 1;
            return [];
        };

        assembleMessage([one], budget(300));

        expect(spawns).toBe(0);
    });

    it("refuses the spawn when context prints but the colour would not fit beside it", () => {
        const one = edit("a");
        let spawns = 0;

        one.colour = () => {
            spawns += 1;
            return [];
        };

        // A budget that fits every plain line and nothing more. `bat` adds at least 22 bytes
        // per line, so the spawn could only be refused line by line afterwards.
        const message = assembleMessage([one], budget(650));

        expect(message).toContain("context one");
        expect(message).not.toMatch(/more lines/);
        expect(spawns).toBe(0);
    });

    it("does buy it, once, for the context lines that do print", () => {
        const one = edit("a");
        let spawns = 0;

        one.colour = () => {
            spawns += 1;
            return ["TINTED one", "TINTED two", "TINTED three", "TINTED four"];
        };

        const message = assembleMessage([one], budget(100_000));

        expect(spawns).toBe(1);
        expect(message).toContain("TINTED one");
    });
});

describe("a `cd` through a variable the command set itself", () => {
    // Measured 2026-09-22: a sweep written as `P=<worktree>` then `cd "$P"` left the hook
    // watching the session cwd, which was a DIFFERENT checkout. Two edited files produced no
    // diff, and the decision log recorded the wrong repository as the only root.
    let other: string;

    beforeAll(() => {
        other = realpathSync(mkdtempSync(join(tmpdir(), "gt-cdvar-")));
    });

    afterAll(() => {
        rmSync(other, { recursive: true, force: true });
    });

    it("follows a double-quoted reference", () => {
        expect(commandDirs(`P=${other}\ncd "$P" && bun x`, repo)).toEqual([repo, other]);
    });

    it("follows a bare and a braced reference", () => {
        expect(commandDirs(`P=${other}\ncd $P && bun x`, repo)).toEqual([repo, other]);
        expect(commandDirs(`P=${other}\ncd \${P} && bun x`, repo)).toEqual([repo, other]);
    });

    it("follows chained relative cds from where the previous one landed", () => {
        mkdirSync(join(other, "packages", "api"), { recursive: true });

        const packages = join(other, "packages");
        const api = join(packages, "api");

        expect(commandDirs(`cd ${other} && cd packages && cd api && bun x`, repo)).toEqual([
            repo,
            other,
            packages,
            api,
        ]);
        expect(commandDirs(`cd ${api} && cd .. && bun x`, repo)).toEqual([repo, api, packages]);
    });

    it("refuses a SINGLE-quoted reference, which the shell does not expand", () => {
        expect(commandDirs(`P=${other}\ncd '$P' && bun x`, repo)).toEqual([repo]);
    });

    it("🛑 never reads the environment, only what the command assigned", () => {
        // `$HOME` always resolves in this process, and it is never what the command saw.
        expect(commandDirs('cd "$HOME" && bun x', repo)).toEqual([repo]);
        expect(commandDirs('cd "$NOT_SET_ANYWHERE" && bun x', repo)).toEqual([repo]);
    });

    it("refuses a reference the command only partly builds", () => {
        expect(commandDirs(`P=${other}\ncd "$P/sub" && bun x`, repo)).toEqual([repo]);
    });

    it("does not read the assignment itself as a file the command named", () => {
        const named = namedArguments(`P=${other}\ncd "$P" && bun x`, [repo]);

        expect(named.filter((path) => path.includes("P="))).toEqual([]);
    });
});

describe("highlighting is skipped when nothing would use it", () => {
    // 🛑 One `bat` spawn per changed file sits on the hot path. Measured 2026-09-22 on a
    // 15-file change that rewrote every line: 597 ms with highlighting against 159 ms
    // without, for BYTE-IDENTICAL output, because only CONTEXT lines are ever coloured.
    const batty = { ...DEFAULT_HOOKS_CONFIG.diff, highlight: "bat" as const };
    const range = { from: 1, to: 4 };
    const rewrite = "@@ -1,2 +1,2 @@\n-old one\n-old two\n+new one\n+new two";
    const edited = "@@ -1,3 +1,3 @@\n kept line\n-old two\n+new two\n kept three";
    const batPresent = spawnSync("bat", ["--version"], { encoding: "utf8", env: process.env }).status === 0;

    it("sees a context line, or its absence", () => {
        expect(hasContext(rewrite)).toBe(false);
        expect(hasContext(edited)).toBe(true);
    });

    it("returns nothing for a patch that rewrote every line", () => {
        // 🛑 The file must EXIST. Pointed at a missing path, `bat` exits non-zero and the
        // function returns [] whether the skip is there or not, so the test passed for the
        // wrong reason and a planted regression went unnoticed.
        const file = join(repo, "rewritten.ts");

        writeFileSync(file, "const kept = 1;\nconst two = 2;\nconst three = 3;\n");

        expect(highlightRange(file, range, batty, rewrite)).toEqual([]);

        if (batPresent) {
            // The positive control for this very assertion: same file, same range, same
            // config, and the ONLY difference is a patch that has context.
            expect(highlightRange(file, range, batty, edited).length).toBeGreaterThan(0);
        }
    });

    it("still highlights a patch that KEPT lines, which is the normal case", () => {
        if (!batPresent) {
            // CI images do not all carry `bat`, and the point here is the negative control:
            // the skip above must not have disabled highlighting outright.
            expect(hasContext(edited)).toBe(true);
            return;
        }

        const file = join(repo, "highlight-me.ts");

        writeFileSync(file, "const kept = 1;\nconst two = 2;\nconst three = 3;\n");

        expect(highlightRange(file, range, batty, edited).length).toBeGreaterThan(0);
    });

    it("still returns nothing when highlighting is off entirely", () => {
        const off = { ...DEFAULT_HOOKS_CONFIG.diff, highlight: "none" as const };

        expect(highlightRange(join(repo, "anything.ts"), range, off, edited)).toEqual([]);
    });
});

describe("listing a wide untracked directory", () => {
    let wide: string;

    beforeAll(() => {
        wide = realpathSync(mkdtempSync(join(tmpdir(), "gt-wide-")));
        spawnSync("git", ["-C", wide, "init", "-q"], { encoding: "utf8", env: process.env });
        mkdirSync(join(wide, "many"), { recursive: true });

        // About 200 KB of names: well past the listing buffer a limit of 5 buys (64 KB).
        for (let index = 0; index < 4000; index += 1) {
            writeFileSync(join(wide, "many", `entry-${"x".repeat(30)}-${String(index).padStart(5, "0")}.txt`), "");
        }
    });

    afterAll(() => {
        rmSync(wide, { recursive: true, force: true });
    });

    it("stops at the limit and returns only whole names, even when git outgrows the buffer", () => {
        const names = untrackedFilesIn(wide, "many/", 5);

        expect(names).toHaveLength(5);

        for (const name of names ?? []) {
            expect(name).toMatch(/^many\/entry-x{30}-\d{5}\.txt$/);
        }
    });

    it("says null, not empty, when git cannot list at all", () => {
        expect(untrackedFilesIn(join(wide, "not-a-repo-at-all"), "many/", 5)).toBeNull();
    });
});
