import { beforeAll, describe, expect, test } from "bun:test";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { env as testEnvironment } from "@genesiscz/utils/env.client";
import { keptBin, keptExecutable } from "@genesiscz/utils/test/kept-executable";
import { jsonProblem } from "./check-json";
import { findLostComments, parseZeroContextDiff } from "./check-lost-comments";

/**
 * Runs the real `.githooks/pre-commit` in a scratch repository. Staged blobs are formatted in a temporary tree at
 * their original paths. The old stdin formatter printed nothing for unhandled Swift/Markdown paths missing from
 * disk, and the hook committed that empty output (2026-10-13). These tests preserve staged bytes, unstaged hunks,
 * exact-path rules and Unicode without using console output as file content.
 */

const ROOT = resolve(import.meta.dir, "../..");

// A test run inside another git process (a hook, a rebase --exec) inherits GIT_DIR / GIT_INDEX_FILE, which would
// point every git call below at the outer repository.
const env: Record<string, string | undefined> = { ...process.env };
delete env.GIT_DIR;
delete env.GIT_INDEX_FILE;
delete env.GIT_WORK_TREE;

describe("config hook installer", () => {
    function scratch(unsupported = false) {
        const directory = mkdtempSync(join(tmpdir(), "gt-hook-installer-"));
        const testEnv: Record<string, string | undefined> = {
            ...env,
            GIT_CONFIG_GLOBAL: join(directory, "global"),
            GIT_CONFIG_SYSTEM: join(directory, "system"),
        };
        const runGit = (...args: string[]) => {
            const r = Bun.spawnSync(["git", ...args], { cwd: directory, env: testEnv, stdout: "pipe", stderr: "pipe" });
            return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString() };
        };
        expect(runGit("init", "-q").code).toBe(0);
        expect(runGit("config", "user.name", "Hook Test").code).toBe(0);
        expect(runGit("config", "user.email", "hook-test@example.com").code).toBe(0);
        mkdirSync(join(directory, "scripts/git"), { recursive: true });
        copyFileSync(join(ROOT, "scripts/git/install-hooks.ts"), join(directory, "scripts/git/install-hooks.ts"));
        mkdirSync(join(directory, ".githooks"));
        symlinkSync(
            keptExecutable("pre-commit", '#!/bin/sh\nprintf "pre-commit\\n" >> hook-runs\ntest ! -f fail-hook\n'),
            join(directory, ".githooks/pre-commit")
        );
        symlinkSync(
            keptExecutable("commit-msg", '#!/bin/sh\nprintf "%s\\n" "$@" > hook-args\n'),
            join(directory, ".githooks/commit-msg")
        );
        if (unsupported) {
            const realGit = Bun.which("git");
            if (!realGit) {
                throw new Error("git is required");
            }

            const wrapper = keptExecutable(
                "git",
                `#!/bin/sh\nif [ "$1" = hook ] && [ "$2" = list ]; then exit 1; fi\nexec '${realGit}' "$@"\n`
            );
            testEnv.PATH = `${dirname(wrapper)}:${testEnv.PATH}`;
        }

        const install = () => {
            const r = Bun.spawnSync([process.execPath, "scripts/git/install-hooks.ts"], {
                cwd: directory,
                env: testEnv,
                stdout: "pipe",
                stderr: "pipe",
            });
            expect(r.exitCode, r.stderr.toString()).toBe(0);
        };
        return { directory, testEnv, runGit, install };
    }

    const capabilityProbe = scratch();
    capabilityProbe.runGit("config", "hook.capability-probe.command", "true");
    capabilityProbe.runGit("config", "hook.capability-probe.event", "pre-commit");
    const supportsConfigHooks = capabilityProbe.runGit("hook", "list", "pre-commit").out.includes("capability-probe");

    test.each([false, true])("preserves a custom local hooksPath or /dev/null, unsupported=%s", (unsupported) => {
        for (const hooksPath of ["custom-hooks", "/dev/null", ""]) {
            const s = scratch(unsupported);
            expect(s.runGit("config", "--local", "core.hooksPath", hooksPath).code).toBe(0);
            s.install();
            expect(s.runGit("config", "--local", "--get", "core.hooksPath").code).toBe(0);
            expect(s.runGit("config", "--local", "--get", "core.hooksPath").out).toBe(hooksPath);
        }
    });

    test.each(
        [false, true].flatMap((unsupported) =>
            ["--global", "--system"].flatMap((scope) => [false, true].map((local) => ({ unsupported, scope, local })))
        )
    )(
        "preserves inherited hook paths, unsupported=$unsupported scope=$scope local=$local",
        ({ unsupported, scope, local }) => {
            const s = scratch(unsupported);
            expect(s.runGit("config", scope, "core.hooksPath", "inherited-hooks").code).toBe(0);
            if (local) {
                expect(s.runGit("config", "--local", "core.hooksPath", ".githooks").code).toBe(0);
            }

            s.install();
            if (local && !unsupported) {
                expect(s.runGit("commit", "--allow-empty", "-qm", "inherited path fixture").code).toBe(0);
                expect(readFileSync(join(s.directory, "hook-runs"), "utf8")).toBe("pre-commit\n");
            }

            expect(s.runGit("config", scope, "--get", "core.hooksPath").out).toBe("inherited-hooks");
            expect(s.runGit("config", "--local", "--get", "core.hooksPath").out).toBe(local ? ".githooks" : "");
            expect(s.runGit("config", "--get", "core.hooksPath").out).toBe(local ? ".githooks" : "inherited-hooks");
        }
    );

    test.each([false, true])("older Git keeps the repository hook folder, local .githooks=%s", (local) => {
        const s = scratch(true);
        if (local) {
            expect(s.runGit("config", "--local", "core.hooksPath", ".githooks").code).toBe(0);
        }

        s.install();
        expect(s.runGit("config", "--local", "--get", "core.hooksPath").out).toBe(".githooks");
    });

    test.skipIf(!supportsConfigHooks).each([false, true])(
        "config hooks execute through their interpreter, local .githooks=%s",
        (local) => {
            const s = scratch();
            if (local) {
                expect(s.runGit("config", "--local", "core.hooksPath", ".githooks").code).toBe(0);
            }

            s.install();
            expect(s.runGit("hook", "list", "pre-commit").out).toContain("genesis-tools-pre-commit");
            expect(s.runGit("config", "--local", "--get", "core.hooksPath").code).toBe(1);
            const commit = s.runGit("commit", "--allow-empty", "-qm", "fixture");
            expect(commit.code, commit.err).toBe(0);
            expect(readFileSync(join(s.directory, "hook-runs"), "utf8")).toBe("pre-commit\n");
            expect(readFileSync(join(s.directory, "hook-args"), "utf8").trim()).toMatch(/COMMIT_EDITMSG$/);

            writeFileSync(join(s.directory, "fail-hook"), "");
            const before = s.runGit("rev-parse", "HEAD").out;
            expect(s.runGit("commit", "--allow-empty", "-qm", "blocked").code).not.toBe(0);
            expect(s.runGit("rev-parse", "HEAD").out).toBe(before);
            expect(s.runGit("-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-qm", "disabled").code).toBe(
                0
            );
            expect(s.runGit("-c", "core.hooksPath=", "commit", "--allow-empty", "-qm", "empty override").code).toBe(0);
            expect(readFileSync(join(s.directory, "hook-runs"), "utf8")).toBe("pre-commit\npre-commit\n");
        }
    );

    test("executable fixtures survive scratch cleanup outside the test temp root", () => {
        // Construction only: the old scratch executables are never launched by this regression.
        const s = scratch(true);
        const wrapper = Bun.which("git", { PATH: s.testEnv.PATH });
        expect(wrapper).not.toBeNull();
        const programs = [
            join(s.directory, ".githooks/pre-commit"),
            join(s.directory, ".githooks/commit-msg"),
            wrapper ?? "",
        ].map((path) => realpathSync(path));
        const sandbox = testEnvironment.test.getTmpRoot();
        expect(sandbox).toBeTruthy();
        for (const program of programs) {
            const local = relative(realpathSync(sandbox ?? s.directory), program);
            expect(local === ".." || local.startsWith(".." + sep)).toBe(true);
        }
        rmSync(s.directory, { recursive: true, force: true });
        for (const program of programs) {
            expect(existsSync(program)).toBe(true);
            expect(readFileSync(program, "utf8")).toStartWith("#!/bin/sh");
        }
    });

    test("checkout and rebase early exits never start git or tools", () => {
        const s = scratch();
        const unexpected = '#!/bin/sh\nprintf "unexpected process\\n" >> unexpected-process\nexit 99\n';
        const bin = keptBin({ git: unexpected, bun: unexpected, tools: unexpected });

        const linked = join(s.directory, "linked");
        mkdirSync(linked);
        writeFileSync(join(linked, ".git"), `gitdir: ${join(s.directory, ".git")}\n`);
        const isolatedEnv = { ...s.testEnv, PATH: bin };
        for (const args of [
            ["old", "new", "0"],
            ["old", "new", "1"],
            ["0000000000000000000000000000000000000000", "new", "1"],
        ]) {
            const r = Bun.spawnSync(["/bin/bash", join(ROOT, ".githooks/post-checkout"), ...args], {
                cwd: args[0].startsWith("0000") ? s.directory : linked,
                env: isolatedEnv,
                stdout: "pipe",
                stderr: "pipe",
            });
            expect(r.exitCode).toBe(0);
        }

        for (const state of ["rebase-merge", "rebase-apply"]) {
            mkdirSync(join(s.directory, ".git", state));
            const r = Bun.spawnSync(["/bin/bash", join(ROOT, ".githooks/post-commit")], {
                cwd: linked,
                env: { ...isolatedEnv, GIT_INDEX_FILE: join(s.directory, ".git/index") },
                stdout: "pipe",
                stderr: "pipe",
            });
            expect(r.exitCode).toBe(0);
            rmSync(join(s.directory, ".git", state), { recursive: true });
        }

        expect(existsSync(join(s.directory, "unexpected-process"))).toBe(false);
        expect(existsSync(join(linked, "unexpected-process"))).toBe(false);
    });
});

// The scratch repo lives under the test temp root, which the bun test preload removes on a green exit.
let repo = "";

function git(...args: string[]): { code: number; out: string } {
    const result = Bun.spawnSync(["git", ...args], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() };
}

function write(path: string, text: string): void {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), text);
}

function headBlob(path: string): string {
    return git("show", `HEAD:${path}`).out;
}

beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "gt-pre-commit-hook-"));
    expect(git("init", "-q", ".").code).toBe(0);
    git("config", "user.name", "Hook Test");
    git("config", "user.email", "hook-test@example.com");
    symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
    copyFileSync(join(ROOT, "biome.json"), join(repo, "biome.json"));
    mkdirSync(join(repo, ".githooks"));
    symlinkSync(
        keptExecutable("pre-commit", readFileSync(join(ROOT, ".githooks/pre-commit"), "utf8")),
        join(repo, ".githooks/pre-commit")
    );
    mkdirSync(join(repo, "scripts", "ci"), { recursive: true });
    copyFileSync(join(ROOT, "scripts", "ci", "check-json.ts"), join(repo, "scripts", "ci", "check-json.ts"));
    copyFileSync(
        join(ROOT, "scripts", "ci", "check-lost-comments.ts"),
        join(repo, "scripts", "ci", "check-lost-comments.ts")
    );
    git("config", "core.hooksPath", ".githooks");
    write("tsconfig.json", '{"compilerOptions":{"strict":true,"noEmit":true,"skipLibCheck":true},"files":["ok.ts"]}\n');
    write("ok.ts", "export const ok = 1;\n");
    write(".gitignore", "node_modules\naside\n");
    mkdirSync(join(repo, "aside"));
    git(
        "add",
        ".gitignore",
        "biome.json",
        "tsconfig.json",
        "ok.ts",
        ".githooks/pre-commit",
        "scripts/ci/check-json.ts",
        "scripts/ci/check-lost-comments.ts"
    );
    const init = git("commit", "-qm", "init");
    expect(init.code, init.out).toBe(0);
});

describe("pre-commit hook: staged content survives the biome pass", () => {
    test("a staged Swift file whose working copy was moved away is committed with its staged content", () => {
        const staged = "import Foundation\nlet b = 1\n";
        write("src/app/B.swift", staged);
        git("add", "src/app/B.swift");
        renameSync(join(repo, "src/app/B.swift"), join(repo, "aside/B.swift"));
        const commit = git("commit", "-qm", "swift moved after staging");
        expect(commit.code, commit.out).toBe(0);
        expect(headBlob("src/app/B.swift")).toBe(staged);
    }, 60_000);

    test("a staged Markdown file whose working copy was moved away is committed with its staged content", () => {
        const staged = "# Notes\n\nSome text.\n";
        write("src/app/C.md", staged);
        git("add", "src/app/C.md");
        renameSync(join(repo, "src/app/C.md"), join(repo, "aside/C.md"));
        const commit = git("commit", "-qm", "markdown moved after staging");
        expect(commit.code, commit.out).toBe(0);
        expect(headBlob("src/app/C.md")).toBe(staged);
    }, 60_000);

    test("a partly staged Swift file commits the staged hunk and keeps the unstaged hunk in the working tree", () => {
        const staged = "import Foundation\nlet a = 1\n";
        const working = `${staged}let unstaged = 2\n`;
        write("src/app/A.swift", staged);
        git("add", "src/app/A.swift");
        write("src/app/A.swift", working);
        const commit = git("commit", "-qm", "swift partly staged");
        expect(commit.code, commit.out).toBe(0);
        expect(headBlob("src/app/A.swift")).toBe(staged);
        expect(readFileSync(join(repo, "src/app/A.swift"), "utf8")).toBe(working);
    }, 60_000);

    // `biome check --write --staged` also formats the working copy (the hook's own comment says so); the point here is
    // that the commit is formatted and the unstaged line is still in the working tree afterwards.
    test("a partly staged TypeScript file is still committed formatted, and its unstaged hunk stays", () => {
        write("src/app/d.ts", "export const d = 1;\n");
        git("add", "src/app/d.ts");
        expect(git("commit", "-qm", "d").code).toBe(0);
        write("src/app/d.ts", "export const d = 1;\nexport const   e   =   2\n");
        git("add", "src/app/d.ts");
        const working = "export const d = 1;\nexport const   e   =   2\nexport const f = 3;\n";
        write("src/app/d.ts", working);
        const commit = git("commit", "-qm", "ts partly staged");
        expect(commit.code, commit.out).toBe(0);
        expect(headBlob("src/app/d.ts")).toBe("export const d = 1;\nexport const e = 2;\n");
        expect(readFileSync(join(repo, "src/app/d.ts"), "utf8")).toBe(
            "export const d = 1;\nexport const e = 2;\nexport const f = 3;\n"
        );
    }, 60_000);
});

// d9687720a (2026-10-14): a conflict resolver wrote the word `ours` into both plugin manifests. Biome reads only the
// root's JSON files, so the hook passed it with "Checked 0 files", and the plugin did not load for 12 hours.
describe("round 16 exact Biome overrides", () => {
    test("a partly staged exact-path restriction blocks the index and preserves Unicode on a valid retry", () => {
        const file = "src/utils/logger/client.ts";
        const bad = 'import color from "picocolors";\nexport const mark = color.green("fixture");\n';
        const good = 'export const mark = "✔ ✖ ⚠ ℹ";\n';
        write(file, bad);
        git("add", "--", file);
        write(file, good);
        const before = git("rev-parse", "HEAD").out;
        const blocked = git("commit", "-qm", "exact override fixture");
        expect(blocked.code, blocked.out).not.toBe(0);
        expect(blocked.out).toContain("noRestrictedImports");
        expect(git("rev-parse", "HEAD").out).toBe(before);
        expect(readFileSync(join(repo, file), "utf8")).toBe(good);
        git("add", "--", file);
        const committed = git("commit", "-qm", "valid exact override fixture");
        expect(committed.code, committed.out).toBe(0);
        expect(headBlob(file)).toBe(good);
    });
});

describe("pre-commit hook: staged JSON must parse", () => {
    const stray = '{\n    "name": "genesis-tools",\nours    "description": "Skills"\n}\n';

    test("tsconfig, .jsonc and .vscode files may carry comments; every other JSON file is strict", () => {
        expect(jsonProblem("src/app/tsconfig.json", '{ // paths\n    "compilerOptions": {},\n}\n')).toBeNull();
        expect(jsonProblem(".vscode/settings.json", '{ /* editor */ "a": 1 }')).toBeNull();
        expect(jsonProblem("plugins/p/.claude-plugin/plugin.json", '{ // version\n    "a": 1\n}\n')).not.toBeNull();
    });

    test("the stray word fails with comments allowed and without", () => {
        expect(jsonProblem(".claude-plugin/marketplace.json", stray)).not.toBeNull();
        expect(jsonProblem("src/app/tsconfig.json", stray)).not.toBeNull();
    });

    test("a nested manifest that does not parse blocks the commit and is named", () => {
        write(".claude-plugin/plugin.json", stray);
        git("add", ".claude-plugin/plugin.json");
        const commit = git("commit", "-qm", "broken manifest");
        git("rm", "-q", "--cached", "--", ".claude-plugin/plugin.json");
        expect(commit.code, commit.out).not.toBe(0);
        expect(commit.out).toContain("✖ .claude-plugin/plugin.json:");
        expect(git("log", "-1", "--format=%s").out.trim()).not.toBe("broken manifest");
    }, 60_000);
});

// Biome's unsafe noUnusedImports fix deleted a 27-line header with the import under it (2026-10-14).
describe("pre-commit hook: no comment deleted with an import", () => {
    const HEADER = [
        "#!/usr/bin/env bun",
        "/**",
        " * What the poll daemon costs, read back out of the day logs.",
        " *",
        " * Every tick is its own short-lived process, so there is nothing resident to sample.",
        " */",
        "",
    ];
    // Sorted as Biome sorts them, so the removed import is the one under the header.
    const IMPORTS = ['import { readFileSync } from "node:fs";', 'import { join } from "node:path";', ""];
    const BODY = ['export const text = readFileSync(join("a", "b"), "utf8");', ""];
    // What a removed `readFileSync` import leaves: the body no longer calls it.
    const AFTER_BODY = ['export const text = join("a", "b");', ""];
    const before = [...HEADER, ...IMPORTS, ...BODY].join("\n");

    function lost(after: string): string[] {
        // The -U0 diff the hook reads, from two scratch files.
        write("lost/before.ts", before);
        write("lost/after.ts", after);
        const diff = Bun.spawnSync(["git", "diff", "--no-index", "-U0", "lost/before.ts", "lost/after.ts"], {
            cwd: repo,
            env,
        }).stdout.toString();
        const [fileDiff] = parseZeroContextDiff(diff);

        return fileDiff
            ? findLostComments({ diff: fileDiff, oldContent: before, newContent: after }).flatMap(
                  (loss) => loss.missing
              )
            : [];
    }

    test("a header deleted with the import below it is reported, with or without the blank line between", () => {
        const withoutBlank = ["#!/usr/bin/env bun", ...IMPORTS.slice(1), ...AFTER_BODY].join("\n");
        const blankKept = ["#!/usr/bin/env bun", "", ...IMPORTS.slice(1), ...AFTER_BODY].join("\n");

        expect(lost(withoutBlank)).toContain("What the poll daemon costs, read back out of the day logs.");
        expect(lost(blankKept)).toContain("What the poll daemon costs, read back out of the day logs.");
    });

    test("a rewritten header, a moved comment and a short comment that goes with its import pass", () => {
        const rewritten = ["#!/usr/bin/env bun", "/** The poll daemon's cost. */", ...IMPORTS.slice(1), ...AFTER_BODY];
        const moved = ["#!/usr/bin/env bun", ...IMPORTS.slice(1), ...HEADER.slice(1), ...AFTER_BODY];
        const short = ["// fs for the reader", 'import { readFileSync } from "node:fs";', ...BODY].join("\n");
        const shortBefore = [
            "// fs for the reader",
            'import { readFileSync } from "node:fs";',
            "// one",
            'import "a";',
            ...BODY,
        ];

        expect(lost(rewritten.join("\n"))).toEqual([]);
        expect(lost(moved.join("\n"))).toEqual([]);
        expect(
            findLostComments({
                diff: { file: "x.ts", hunks: [{ oldStart: 3, removed: ["// one", 'import "a";'] }] },
                oldContent: shortBefore.join("\n"),
                newContent: short,
            })
        ).toEqual([]);
    });

    test("the hook blocks the commit and names the file; GT_ALLOW_LOST_COMMENTS=1 lets it through", () => {
        write("src/poll.ts", before);
        git("add", "src/poll.ts");
        expect(git("commit", "-qm", "poll").code).toBe(0);

        write("src/poll.ts", ["#!/usr/bin/env bun", ...IMPORTS.slice(1), ...AFTER_BODY].join("\n"));
        git("add", "src/poll.ts");
        const blocked = git("commit", "-qm", "lost header");
        expect(blocked.code, blocked.out).not.toBe(0);
        expect(blocked.out).toContain("✖ src/poll.ts:2: the file header was deleted with");

        const allowed = Bun.spawnSync(["git", "commit", "-qm", "header goes on purpose"], {
            cwd: repo,
            env: { ...env, GT_ALLOW_LOST_COMMENTS: "1" },
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(allowed.exitCode, allowed.stderr.toString()).toBe(0);
    }, 60_000);
});

describe("round 7 lost-comment rename regressions", () => {
    function renamedFixture() {
        const directory = mkdtempSync(join(tmpdir(), "gt-lost-rename-"));
        const runGit = (...args: string[]) =>
            Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", ...args], {
                cwd: directory,
                env,
                stdout: "pipe",
                stderr: "pipe",
            });
        expect(runGit("init", "-q").exitCode).toBe(0);
        runGit("config", "user.name", "Fixture");
        runGit("config", "user.email", "fixture@example.com");
        const header = "/** Important fixture header explaining retained behavior. */\nimport 'unused-fixture';\n";
        const body = Array.from({ length: 30 }, (_, i) => "export const fixture" + i + " = " + i + ";\n").join("");
        writeFileSync(join(directory, "old name.ts"), header + body);
        runGit("add", "--", "old name.ts");
        expect(runGit("commit", "-qm", "fixture baseline").exitCode).toBe(0);
        const baseline = runGit("rev-parse", "HEAD").stdout.toString().trim();
        renameSync(join(directory, "old name.ts"), join(directory, "new name.ts"));
        writeFileSync(join(directory, "new name.ts"), body);
        runGit("add", "--", "old name.ts", "new name.ts");
        const check = (args: string[], preload?: string) =>
            Bun.spawnSync(
                [
                    process.execPath,
                    ...(preload ? ["--preload", preload] : []),
                    join(ROOT, "scripts/ci/check-lost-comments.ts"),
                    ...args,
                ],
                { cwd: directory, env, stdout: "pipe", stderr: "pipe", timeout: 5000 }
            );
        return { directory, runGit, baseline, check };
    }

    test("staged and range audits read a rename's old path and still allow additions", () => {
        const s = renamedFixture();
        const staged = s.check(["--staged"]);
        expect(staged.exitCode, staged.stderr.toString()).toBe(1);
        expect(staged.stderr.toString()).toContain("new name.ts:1: the file header");
        expect(s.runGit("commit", "-qm", "fixture renamed").exitCode).toBe(0);
        const ranged = s.check(["--range", s.baseline + "..HEAD"]);
        expect(ranged.exitCode, ranged.stderr.toString()).toBe(1);
        expect(ranged.stderr.toString()).toContain("new name.ts:1: the file header");
        writeFileSync(join(s.directory, "added.ts"), "export const added = 1;\n");
        writeFileSync(join(s.directory, "empty.ts"), "");
        s.runGit("add", "--", "added.ts", "empty.ts");
        expect(s.check(["--staged"]).exitCode).toBe(0);
    });

    test("unexpected blob read errors fail the audit instead of standing in for empty content", () => {
        const s = renamedFixture();
        const preload = join(s.directory, "read-error.ts");
        writeFileSync(
            preload,
            "const spawn = Bun.spawnSync; Bun.spawnSync = (args,opts) => args[0] === 'git' && args[1] === 'show' ? {...spawn([process.execPath,'-e','void 0'],opts),exitCode:128,stdout:Buffer.from(''),stderr:Buffer.from('fixture blob read failed')} : spawn(args,opts);\n"
        );
        const result = s.check(["--staged"], preload);
        expect(result.exitCode).toBe(2);
        expect(result.stderr.toString()).toContain("fixture blob read failed");
    });
});

describe("round 8 quoted pure rename regression", () => {
    test("staged and range audits skip blob reads for a content-identical rename with Git-quoted names", () => {
        const directory = mkdtempSync(join(tmpdir(), "gt-pure-rename-"));
        const runGit = (...args: string[]) =>
            Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", ...args], {
                cwd: directory,
                env,
                stdout: "pipe",
                stderr: "pipe",
            });
        expect(runGit("init", "-q").exitCode).toBe(0);
        runGit("config", "user.name", "Fixture");
        runGit("config", "user.email", "fixture@example.com");
        runGit("config", "core.quotePath", "true");
        const before = "café.ts";
        const after = "žluťoučký.ts";
        writeFileSync(
            join(directory, before),
            "/** A fixture header that remains unchanged. */\nimport 'fixture';\nexport const fixture = 1;\n"
        );
        runGit("add", "--", before);
        expect(runGit("commit", "-qm", "fixture baseline").exitCode).toBe(0);
        const baseline = runGit("rev-parse", "HEAD").stdout.toString().trim();
        renameSync(join(directory, before), join(directory, after));
        runGit("add", "--", before, after);
        const diff = runGit("diff", "--cached", "-U0", "-M").stdout.toString();
        expect(diff).toContain('diff --git "a/');
        expect(diff).not.toContain("@@");
        const check = (args: string[]) =>
            Bun.spawnSync([process.execPath, join(ROOT, "scripts/ci/check-lost-comments.ts"), ...args], {
                cwd: directory,
                env,
                stdout: "pipe",
                stderr: "pipe",
                timeout: 5000,
            });
        const staged = check(["--staged"]);
        expect(staged.exitCode, staged.stderr.toString()).toBe(0);
        expect(staged.stdout.toString()).toContain("no comment was deleted");
        expect(runGit("commit", "-qm", "fixture pure rename").exitCode).toBe(0);
        const range = check(["--range", baseline + "..HEAD"]);
        expect(range.exitCode, range.stderr.toString()).toBe(0);
        expect(range.stdout.toString()).toContain("no comment was deleted");
    });
});

describe("round 20 modified quoted paths", () => {
    test.each(["café.ts", "with\ttab.ts", 'with"quote.ts', "with\\slash.ts", "with\nnewline.ts", "plain.ts"])(
        "staged and range comment audits read the real filename %j",
        (file) => {
            const directory = mkdtempSync(join(tmpdir(), "gt-modified-quoted-"));
            const runGit = (...args: string[]) =>
                Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", ...args], {
                    cwd: directory,
                    env,
                    stdout: "pipe",
                    stderr: "pipe",
                });
            expect(runGit("init", "-q").exitCode).toBe(0);
            runGit("config", "user.name", "Fixture");
            runGit("config", "user.email", "fixture@example.com");
            runGit("config", "core.quotePath", "true");
            const header = "/** Important fixture header explaining retained behavior. */\nimport 'unused-fixture';\n";
            const body = "export const kept = 1;\n";
            writeFileSync(join(directory, file), header + body + "export const removed = 2;\n");
            expect(runGit("add", "--", file).exitCode).toBe(0);
            expect(runGit("commit", "-qm", "fixture baseline").exitCode).toBe(0);
            const baseline = runGit("rev-parse", "HEAD").stdout.toString().trim();
            const check = (args: string[]) =>
                Bun.spawnSync([process.execPath, join(ROOT, "scripts/ci/check-lost-comments.ts"), ...args], {
                    cwd: directory,
                    env,
                    stdout: "pipe",
                    stderr: "pipe",
                    timeout: 5000,
                });
            writeFileSync(join(directory, file), header + body);
            runGit("add", "--", file);
            const safe = check(["--staged"]);
            expect(safe.exitCode, safe.stderr.toString()).toBe(0);
            expect(safe.stdout.toString()).toContain("no comment was deleted");
            writeFileSync(join(directory, file), body);
            runGit("add", "--", file);
            const staged = check(["--staged"]);
            expect(staged.exitCode, staged.stderr.toString()).toBe(1);
            expect(staged.stderr.toString()).toContain(file + ":1: the file header");
            expect(runGit("commit", "-qm", "fixture comment removed").exitCode).toBe(0);
            const range = check(["--range", baseline + "..HEAD"]);
            expect(range.exitCode, range.stderr.toString()).toBe(1);
            expect(range.stderr.toString()).toContain(file + ":1: the file header");
        }
    );
});

describe("round 33 nested mirror configuration", () => {
    test("a partly staged dashboard file uses its standalone nested Biome config", () => {
        const config = "src/claude-history-dashboard/biome.json";
        const file = "src/claude-history-dashboard/src/staged.ts";
        write(
            config,
            '{"formatter":{"indentStyle":"tab"},"javascript":{"formatter":{"quoteStyle":"single"}},"linter":{"enabled":false},"assist":{"enabled":false}}\n'
        );
        const staged = 'export function staged() {\n return "✔";\n}\n';
        write(file, staged);
        expect(git("add", "--", config, file).code).toBe(0);
        write(file, staged + 'export const unstaged = "kept";\n');
        const result = git("commit", "-qm", "nested config mirror");
        expect(result.code, result.out).toBe(0);
        expect(headBlob(file)).toBe("export function staged() {\n\treturn '✔';\n}\n");
        expect(readFileSync(join(repo, file), "utf8")).toContain("export const unstaged = 'kept';");
    });
});

describe("pre-commit hook: the typecheck binary", () => {
    test("runs the checkout's own tsc, never bunx, which can write a partial node_modules in a worktree", () => {
        const hook = readFileSync(join(ROOT, ".githooks/pre-commit"), "utf8");
        const tscLine = hook.split("\n").find((line) => line.startsWith("tsc_output="));
        expect(tscLine).toStartWith("tsc_output=$(./node_modules/.bin/tsc --noEmit");
        expect(hook).not.toMatch(/^[^#]*\bbunx tsc\b/m);
    });
});
