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
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { DEFAULT_HOOKS_CONFIG, type DiffConfig } from "../config";
import { callDir, sessionDir } from "../paths";
import type { HookPayload } from "../payload";
import { beforeCopy } from "./before";
import { capturePre, captureRoots } from "./capture";
import { classifyChange, type DiffCategory } from "./classify";
import { changedFiles } from "./collect";
import { namedArguments } from "./command-paths";
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

        const result = capturePre(current, { ...DEFAULT_HOOKS_CONFIG.diff, maxNamedPathBytes: 1024 });

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

    it("lets the same session render its own claim, so a retry is not silenced", () => {
        const again = begin({ sessionId: "gt-diff-c", toolUseId: "share-3" });

        writeFileSync(shared, "one\nSAME-SESSION-AGAIN\nthree\n");

        expect(runDiffPost(again, plain).message).toContain("SAME-SESSION-AGAIN");

        const retry = begin({ sessionId: "gt-diff-c", toolUseId: "share-4" });

        // No further edit: the state is unchanged, so the claim is this session's own.
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
        const diff = { ...DEFAULT_HOOKS_CONFIG.diff, highlight: "none" as const, maxCaptureBytes: 100_000 };
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
        const diff = { ...DEFAULT_HOOKS_CONFIG.diff, highlight: "none" as const, maxCaptureBytes: 1 };
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
        const diff = { ...DEFAULT_HOOKS_CONFIG.diff, highlight: "none" as const, maxCaptureFileBytes: 100_000 };
        const current = begin({ cwd: tree, toolUseId: "budget-1" }, diff);

        writeFileSync(join(tree, "note.md"), "alpha\nBRAVO-SMALL\n");

        const decision = runDiffPost(current, { ...DEFAULT_HOOKS_CONFIG, diff });

        expect(decision.message).toContain("BRAVO-SMALL");
        expect(decision.message).toContain("Updated");
    });

    it("reports the heavy directory as left out rather than silently capturing it", () => {
        const diff = { ...DEFAULT_HOOKS_CONFIG.diff, maxCaptureFileBytes: 100_000 };
        const current = payload({ cwd: tree, toolUseId: "budget-2" });

        calls += 1;

        const result = capturePre(current, diff);

        expect(result.skipped.join(" ")).toContain("per-entry");
        expect(result.skipped.join(" ")).toContain("1 of 2 dirty entries left out");
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
