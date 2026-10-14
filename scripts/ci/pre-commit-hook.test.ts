import { beforeAll, describe, expect, test } from "bun:test";
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { jsonProblem } from "./check-json";
import { findLostComments, parseZeroContextDiff } from "./check-lost-comments";

/**
 * Runs the real `.githooks/pre-commit` in a scratch repository. The hook formats each staged blob by piping it
 * through `biome check --write --stdin-file-path`. For a path biome has no handler for (Swift, Markdown) and that is
 * not on disk, biome prints NOTHING and exits 0, and the hook used to write that empty output back as the staged
 * blob: a file staged and then moved or deleted in the working tree was committed empty (2026-10-13, found when a
 * GenesisKit agent's Swift commits came out with empty test and store files).
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
        writeFileSync(
            join(directory, ".githooks/pre-commit"),
            '#!/bin/sh\nprintf "pre-commit\\n" >> hook-runs\ntest ! -f fail-hook\n'
        );
        writeFileSync(join(directory, ".githooks/commit-msg"), '#!/bin/sh\nprintf "%s\\n" "$@" > hook-args\n');
        if (unsupported) {
            const bin = join(directory, "bin");
            mkdirSync(bin);
            const realGit = Bun.which("git");
            if (!realGit) {
                throw new Error("git is required");
            }

            writeFileSync(
                join(bin, "git"),
                `#!/bin/sh\nif [ "$1" = hook ] && [ "$2" = list ]; then exit 1; fi\nexec '${realGit}' "$@"\n`
            );
            chmodSync(join(bin, "git"), 0o755);
            testEnv.PATH = `${bin}:${testEnv.PATH}`;
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

    test.each([false, true])("preserves inherited global and system hook paths, unsupported=%s", (unsupported) => {
        for (const scope of ["--global", "--system"]) {
            for (const local of [false, true]) {
                const s = scratch(unsupported);
                expect(s.runGit("config", scope, "core.hooksPath", "inherited-hooks").code).toBe(0);
                if (local) {
                    expect(s.runGit("config", "--local", "core.hooksPath", ".githooks").code).toBe(0);
                }

                s.install();
                if (local && !unsupported) {
                    chmodSync(join(s.directory, ".githooks/pre-commit"), 0o755);
                    chmodSync(join(s.directory, ".githooks/commit-msg"), 0o755);
                    expect(s.runGit("commit", "--allow-empty", "-qm", "inherited path fixture").code).toBe(0);
                    expect(readFileSync(join(s.directory, "hook-runs"), "utf8")).toBe("pre-commit\n");
                }

                expect(s.runGit("config", scope, "--get", "core.hooksPath").out).toBe("inherited-hooks");
                expect(s.runGit("config", "--local", "--get", "core.hooksPath").out).toBe(local ? ".githooks" : "");
                expect(s.runGit("config", "--get", "core.hooksPath").out).toBe(local ? ".githooks" : "inherited-hooks");
            }
        }
    });

    test("older Git keeps the repository hook folder when unset or repository-owned", () => {
        for (const local of [false, true]) {
            const s = scratch(true);
            if (local) {
                expect(s.runGit("config", "--local", "core.hooksPath", ".githooks").code).toBe(0);
            }

            s.install();
            expect(s.runGit("config", "--local", "--get", "core.hooksPath").out).toBe(".githooks");
        }
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

    test("checkout and rebase early exits never start git or tools", () => {
        const s = scratch();
        const bin = join(s.directory, "blocked-bin");
        mkdirSync(bin);
        for (const command of ["git", "bun", "tools"]) {
            const file = join(bin, command);
            writeFileSync(file, '#!/bin/sh\nprintf "unexpected process\\n" >> unexpected-process\nexit 99\n');
            chmodSync(file, 0o755);
        }

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
    copyFileSync(join(ROOT, ".githooks", "pre-commit"), join(repo, ".githooks", "pre-commit"));
    chmodSync(join(repo, ".githooks", "pre-commit"), 0o755);
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
