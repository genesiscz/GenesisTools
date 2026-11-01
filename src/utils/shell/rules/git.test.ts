import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitRules } from "./git";
import { detectShellViolations, type ShellViolation } from "./index";

function ids(command: string, cwd?: string): string[] {
    return detectShellViolations(command, gitRules, cwd ? { cwd } : {}).map((v) => v.ruleId);
}

function only(command: string, ruleId: string): ShellViolation | undefined {
    return detectShellViolations(command, gitRules).find((v) => v.ruleId === ruleId);
}

const CHECKOUT = "git-checkout-overwrites-file";
const FRESH = "git-checkout-in-fresh-worktree";
const SAVED = "git-checkout-overwrites-saved-file";
const FORCE = "git-push-force-without-lease";
const gate = (paths: string, git = "git") =>
    `test -z "$(${git} status --porcelain --untracked-files=all -- ${paths})" && `;

function blockedWithoutSuggestion(commands: string[]): void {
    for (const command of commands) {
        const v = only(command, CHECKOUT);

        expect(v?.severity).toBe("block");
        expect(v?.suggestion).toBeUndefined();
    }
}

describe("git-checkout-overwrites-file: fires", () => {
    it("git checkout -- <file>, with the stash suggestion", () => {
        const v = only("git checkout -- src/utils/ai/grok/models.ts", CHECKOUT);

        expect(v?.severity).toBe("block");
        expect(v?.matched).toBe("git checkout -- src/utils/ai/grok/models.ts");
        expect(v?.index).toBe(0);
        expect(v?.suggestion).toBe('git stash push -m "before revert" -- src/utils/ai/grok/models.ts');
    });

    it("git checkout HEAD -- <files>", () => {
        expect(only("git checkout HEAD -- a.ts b.ts", CHECKOUT)?.suggestion).toBe(
            'git stash push -m "before revert" -- a.ts b.ts'
        );
    });

    it("git checkout <branch> -- <file> (the sneaky one), gated on a clean status", () => {
        const v = only("git checkout origin/master -- README.md", CHECKOUT);

        expect(v?.severity).toBe("block");
        expect(v?.suggestion).toBe(
            'test -z "$(git status --porcelain --untracked-files=all -- README.md)" && git checkout origin/master -- README.md'
        );
    });

    it("git checkout -- . and the dot-slash form", () => {
        expect(ids("git checkout -- .")).toEqual([CHECKOUT]);
        expect(ids("git checkout -- ./src")).toEqual([CHECKOUT]);
    });

    it("git checkout . and git checkout ./src, with no -- at all", () => {
        expect(only("git checkout .", CHECKOUT)?.suggestion).toBe('git stash push -m "before revert" -- .');
        expect(only("git checkout ./src", CHECKOUT)?.suggestion).toBe('git stash push -m "before revert" -- ./src');
        expect(ids("git checkout main")).toEqual([]);
        expect(ids("git checkout -b feat/x")).toEqual([]);
    });

    it("keeps a quoted path in the suggestion", () => {
        expect(only('git checkout -- "my file.ts"', CHECKOUT)?.suggestion).toBe(
            'git stash push -m "before revert" -- "my file.ts"'
        );
    });

    it("git restore keeps a quoted path, and gives no partial suggestion without --", () => {
        expect(only('git restore -- "my file.ts"', CHECKOUT)?.suggestion).toBe(
            'git stash push -m "before restore" -- "my file.ts"'
        );
        expect(only('git restore "a b.ts" other.ts', CHECKOUT)?.suggestion).toBeUndefined();
        expect(ids('git restore "a b.ts" other.ts')).toEqual([CHECKOUT]);
    });

    it("git restore --source <ref> is gated like a checkout from that ref, and the value is no path", () => {
        for (const command of [
            "git restore --source HEAD~1 src/x.ts",
            "git restore -s HEAD~1 src/x.ts",
            "git restore --source=HEAD~1 src/x.ts",
            "git restore -sHEAD~1 src/x.ts",
            "git restore -Ws HEAD~1 src/x.ts",
            "git restore --source main -- src/x.ts",
        ]) {
            const suggestion = only(command, CHECKOUT)?.suggestion;

            expect(suggestion).toBe(`${gate("src/x.ts")}${command}`);
            expect(ids(suggestion ?? "")).toEqual([]);
        }

        expect(only("git restore --source=HEAD src/x.ts", CHECKOUT)?.suggestion).toBe(
            'git stash push -m "before restore" -- src/x.ts'
        );
    });

    it("behind `sudo -n`, whose -n takes no value", () => {
        expect(ids("sudo -n git checkout -- a.ts")).toEqual([CHECKOUT]);
    });

    it("git restore <file>, and restore --staged --worktree", () => {
        expect(only("git restore src/x.ts", CHECKOUT)?.suggestion).toBe(
            'git stash push -m "before restore" -- src/x.ts'
        );
        expect(ids("git restore --staged --worktree src/x.ts")).toEqual([CHECKOUT]);
        expect(ids("git restore -S -W src/x.ts")).toEqual([CHECKOUT]);
        expect(ids("git restore --source=HEAD~1 src/x.ts")).toEqual([CHECKOUT]);
    });

    it("with -C and other global options in front", () => {
        const command = "cd /tmp && git -C /repo checkout -- a.ts";
        const v = only(command, CHECKOUT);

        expect(v?.matched).toBe("git -C /repo checkout -- a.ts");
        expect(v?.index).toBe(command.indexOf("git -C"));
        expect(ids("git --no-pager -c core.quotepath=off checkout -- a.ts")).toEqual([CHECKOUT]);
    });

    it("in a chain, a loop or through a wrapper", () => {
        expect(ids("git stash; git checkout -- a.ts; git stash pop")).toEqual([CHECKOUT]);
        expect(ids('for f in a b; do git checkout -- "$f"; done')).toEqual([CHECKOUT]);
        expect(ids("sudo git checkout -- a.ts")).toEqual([CHECKOUT]);
        expect(ids("echo a.ts | xargs git checkout --")).toEqual([CHECKOUT]);
    });

    it("inside executable substitutions and literal shell command arguments", () => {
        const commands = [
            "echo `git restore fixture.ts`",
            'echo "result=`git restore fixture.ts`"',
            "echo $(git restore fixture.ts)",
            "sh -c 'git restore fixture.ts'",
            "bash -lc 'git restore fixture.ts'",
            "bash <<'EOF'\ngit restore fixture.ts\nEOF",
        ];

        for (const command of commands) {
            const violation = only(command, CHECKOUT);
            expect(violation?.severity).toBe("block");
            expect(violation?.index).toBe(command.indexOf("git restore"));
            expect(violation?.matched).toBe("git restore fixture.ts");
        }
    });
});

describe("git-checkout-overwrites-file: does not fire", () => {
    it("a branch checkout is a branch switch, not a revert", () => {
        expect(ids("git checkout master")).toEqual([]);
        expect(ids("git checkout -b feat/x --no-track origin/master")).toEqual([]);
        expect(ids("git checkout feat/x")).toEqual([]);
    });

    it("--ours / --theirs is conflict resolution", () => {
        expect(ids("git checkout --theirs -- src/x.ts")).toEqual([]);
        expect(ids("git checkout --ours -- bun.lock")).toEqual([]);
    });

    it("restore --staged alone only touches the index", () => {
        expect(ids("git restore --staged -- src/x.ts")).toEqual([]);
        expect(ids("git restore -S src/x.ts")).toEqual([]);
        expect(ids("git restore -Sq src/x.ts")).toEqual([]);
        expect(ids("git restore -SW src/x.ts")).toEqual([CHECKOUT]);
    });

    it("the recommended alternative", () => {
        expect(ids('git stash push -m "models.ts before revert" -- src/x.ts')).toEqual([]);
    });

    it("prose and other tools", () => {
        expect(ids('git commit -m "never git checkout -- x"')).toEqual([]);
        expect(ids("echo 'git restore f'")).toEqual([]);
        expect(ids("cat <<'EOF'\ngit checkout -- a\nEOF")).toEqual([]);
        expect(ids("rg 'checkout --' docs")).toEqual([]);
        expect(ids("gh pr checkout 42")).toEqual([]);
        expect(ids("bash -c 'echo git restore fixture.ts'")).toEqual([]);
    });
});

describe("git-checkout-overwrites-file: conflict re-creation", () => {
    it("checkout -m, --merge and --conflict re-create the conflicted merge, so they pass", () => {
        expect(ids("git checkout --conflict=diff3 -- scripts/ci/harness-guard-allowlist.ts")).toEqual([]);
        expect(ids("git checkout --conflict zdiff3 -- src/a.ts")).toEqual([]);
        expect(ids("git checkout -m -- src/a.ts")).toEqual([]);
        expect(ids("git checkout --merge -- src/a.ts")).toEqual([]);
        expect(ids("git checkout -3 -- bun.lock")).toEqual([]);
    });

    it("restore with --ours, --theirs, -m, --merge or --conflict passes too", () => {
        expect(ids("git restore --ours -- src/a.ts")).toEqual([]);
        expect(ids("git restore --theirs src/a.ts")).toEqual([]);
        expect(ids("git restore -m src/a.ts")).toEqual([]);
        expect(ids("git restore --merge -- src/a.ts")).toEqual([]);
        expect(ids("git restore --conflict=zdiff3 -- src/a.ts")).toEqual([]);
    });

    it("a conflict flag with a tree-ish before -- still fires", () => {
        expect(ids("git checkout --conflict=diff3 main -- src/a.ts")).toEqual([CHECKOUT]);
        expect(ids("git checkout --conflict diff3 HEAD -- src/a.ts")).toEqual([CHECKOUT]);
    });

    it("the logged rebase and merge commands (cases 37 and 72) pass", () => {
        expect(
            ids(
                "cd /tmp/cc/app/s1/worktrees/stack; F=scripts/ci/harness-guard-allowlist.ts; git checkout --conflict=diff3 -- $F; python3 /tmp/cc/app/s1/stack/allowmerge.py $F"
            )
        ).toEqual([]);
        expect(
            ids(
                'cd /tmp/cc/app/s1/worktrees/unified-split && git checkout --conflict=zdiff3 -- $(rg -v harness-locate ../../unified-split/conflicts.txt) && for f in src/a.ts src/b.ts; do echo "=== $f"; done'
            )
        ).toEqual([]);
    });
});

describe("git-checkout-overwrites-file: the corrected command is the whole command", () => {
    it("splices the stash into the command, for checkout and restore", () => {
        expect(only("cd /tmp/w && git checkout HEAD -- src/a.ts; bun test src/a.test.ts", CHECKOUT)?.suggestion).toBe(
            'cd /tmp/w && git stash push -m "before revert" -- src/a.ts; bun test src/a.test.ts'
        );
        expect(only("cd /tmp/w && git restore src/a.ts && bun test", CHECKOUT)?.suggestion).toBe(
            'cd /tmp/w && git stash push -m "before restore" -- src/a.ts && bun test'
        );
    });

    it("keeps git's global options, a loop's do, and the quoting of a -c body", () => {
        expect(only("cd /tmp && git -C /repo checkout -- a.ts", CHECKOUT)?.suggestion).toBe(
            'cd /tmp && git -C /repo stash push -m "before revert" -- a.ts'
        );
        expect(only('for f in a b; do git checkout -- "$f"; done', CHECKOUT)?.suggestion).toBe(
            'for f in a b; do git stash push -m "before revert" -- "$f"; done'
        );
        expect(only("sh -c 'git restore fixture.ts'", CHECKOUT)?.suggestion).toBe(
            "sh -c 'git stash push -m \"before restore\" -- fixture.ts'"
        );
        expect(only('bash -c "git checkout -- a.ts"', CHECKOUT)?.suggestion).toBe(
            "bash -c \"git stash push -m 'before revert' -- a.ts\""
        );
    });

    it("offers no stash when a later statement pops or applies the stash", () => {
        const popped = only("git checkout -- a.ts && git stash pop", CHECKOUT);

        expect(popped?.severity).toBe("block");
        expect(popped?.suggestion).toBeUndefined();
        expect(only("git stash; git checkout -- a.ts; git stash pop", CHECKOUT)?.suggestion).toBeUndefined();
        expect(only("git restore a.ts; git -C . stash apply", CHECKOUT)?.suggestion).toBeUndefined();
        expect(only("git stash pop; git checkout -- a.ts", CHECKOUT)?.suggestion).toBe(
            'git stash pop; git stash push -m "before revert" -- a.ts'
        );
    });

    it("offers no stash when a later drop, clear, show or nested pop would take or read the new entry", () => {
        blockedWithoutSuggestion([
            "git checkout -- a.ts; git stash drop",
            "git checkout -- a.ts; git stash clear",
            "git checkout -- a.ts && sh -c 'git stash pop'",
            "git checkout -- a.ts; git stash show -p | git apply",
        ]);
        expect(only("git checkout -- a.ts; git stash list", CHECKOUT)?.suggestion).toBe(
            'git stash push -m "before revert" -- a.ts; git stash list'
        );
    });

    it("git restore -h is help, and a redirect alone is no path to stash", () => {
        expect(ids("git restore -h 2>&1")).toEqual([]);
        expect(only("xargs git restore 2>&1", CHECKOUT)?.suggestion).toBeUndefined();
    });
});

describe("git-checkout-overwrites-file: a checkout from another ref", () => {
    it("is gated on an empty git status of the same paths, spliced into the command", () => {
        const command = "git checkout 1c7b5e0c0e -- src/control/lib/kept-behaviours.test.ts";
        const suggestion = only(command, CHECKOUT)?.suggestion;

        expect(suggestion).toBe(`${gate("src/control/lib/kept-behaviours.test.ts")}${command}`);
        expect(ids(suggestion ?? "")).toEqual([]);
    });

    it("splices the gate into the logged command (case 140), which then passes", () => {
        const files =
            "src/macos/GenesisKit/Sources/GenesisKit/Widgets/WidgetHostView.swift src/macos/GenesisKit/Tests/GenesisKitTests/WidgetDecisionSurfacesTests.swift";
        const command = `git status --short && git checkout origin/master -- ${files} && git status --short`;
        const v = only(command, CHECKOUT);

        expect(v?.severity).toBe("block");
        expect(v?.suggestion).toBe(
            `git status --short && ${gate(files)}git checkout origin/master -- ${files} && git status --short`
        );
        expect(ids(v?.suggestion ?? "")).toEqual([]);
    });

    it("gates with git's own global options, after a loop's do, and leaves redirections out of the status", () => {
        expect(only("git -C /r checkout main -- a.ts", CHECKOUT)?.suggestion).toBe(
            `${gate("a.ts", "git -C /r")}git -C /r checkout main -- a.ts`
        );

        const loop = only('for f in a b; do git checkout main -- "$f"; done', CHECKOUT)?.suggestion;

        expect(loop).toBe(`for f in a b; do ${gate('"$f"')}git checkout main -- "$f"; done`);
        expect(ids(loop ?? "")).toEqual([]);
        expect(only("git checkout main -- a.ts 2>&1", CHECKOUT)?.suggestion).toBe(
            `${gate("a.ts")}git checkout main -- a.ts 2>&1`
        );
        expect(only("git checkout main -- a.ts # base", CHECKOUT)?.suggestion).toBe(
            `${gate("a.ts")}git checkout main -- a.ts # base`
        );
    });

    it("still fires when the gate does not cover the checkout", () => {
        expect(ids(`${gate("a.ts")}git checkout main -- b.ts`)).toEqual([CHECKOUT]);
        expect(ids(`${gate("a.ts").replace(" && ", "; ")}git checkout main -- a.ts`)).toEqual([CHECKOUT]);
        expect(ids(`false || ${gate("a.ts")}git checkout main -- a.ts`)).toEqual([CHECKOUT]);
        expect(ids(`! ${gate("a.ts")}git checkout main -- a.ts`)).toEqual([CHECKOUT]);
        expect(ids(`${gate("a.ts")}git -C /other checkout main -- a.ts`)).toEqual([CHECKOUT]);
        // `git diff --quiet` exits 0 over an untracked file, which the checkout then overwrites.
        expect(ids("git diff --quiet HEAD -- a.ts && git checkout main -- a.ts")).toEqual([CHECKOUT]);
    });

    it("offers no gate inside a double-quoted -c body, where its quotes would end the body", () => {
        const v = only('bash -c "git checkout main -- a.ts"', CHECKOUT);

        expect(v?.severity).toBe("block");
        expect(v?.suggestion).toBeUndefined();
    });

    it("gates on every untracked file whatever status.showUntrackedFiles says, so the plain status is no gate", () => {
        expect(only("git checkout main -- a.ts", CHECKOUT)?.suggestion).toBe(
            'test -z "$(git status --porcelain --untracked-files=all -- a.ts)" && git checkout main -- a.ts'
        );
        expect(ids('test -z "$(git status --porcelain -- a.ts)" && git checkout main -- a.ts')).toEqual([CHECKOUT]);
    });

    it("passes the exact gate written with a line continuation", () => {
        expect(ids(`${gate("a.ts")}\\\n    git checkout main -- a.ts`)).toEqual([]);
        expect(ids(`${gate("a.ts")}\\\n    git checkout main -- b.ts`)).toEqual([CHECKOUT]);
    });

    it("offers no gate when the checkout can write another tree than the gate reads", () => {
        blockedWithoutSuggestion([
            "GIT_WORK_TREE=/other git checkout main -- a.ts",
            "env GIT_DIR=/other/.git git checkout main -- a.ts",
            "sudo -u bob git checkout main -- a.ts",
            // The outer shell expands `$(…)` in an unquoted heredoc before the body's `cd` runs.
            "bash <<EOF\ncd /other\ngit checkout main -- a.ts\nEOF",
        ]);
    });

    it("gates a checkout in a heredoc with a quoted delimiter, where the body's own shell runs the status", () => {
        const command = "bash <<'EOF'\ncd /other\ngit checkout main -- a.ts\nEOF";
        const suggestion = only(command, CHECKOUT)?.suggestion;

        expect(suggestion).toBe(`bash <<'EOF'\ncd /other\n${gate("a.ts")}git checkout main -- a.ts\nEOF`);
        expect(ids(suggestion ?? "")).toEqual([]);
    });

    it("offers no gate after a ! or in a pipe, where it would invert the test or cut the input", () => {
        blockedWithoutSuggestion([
            "! git checkout main -- a.ts",
            "if ! git checkout main -- a.ts; then echo failed; fi",
            "git diff --name-only main | xargs -I{} git checkout main -- {}",
            "echo a.ts | git checkout main -- a.ts",
        ]);
    });

    it("still fires behind the gate when the checkout runs in another tree", () => {
        expect(ids(`${gate("a.ts")}GIT_WORK_TREE=/other GIT_DIR=/other/.git git checkout main -- a.ts`)).toEqual([
            CHECKOUT,
        ]);
        expect(ids(`${gate("a.ts")}env -C /other git checkout main -- a.ts`)).toEqual([CHECKOUT]);
        expect(ids(`bash <<EOF\ncd /other\n${gate("a.ts")}git checkout main -- a.ts\nEOF`)).toEqual([CHECKOUT]);
        expect(ids(`${gate("a.ts")}! git checkout main -- a.ts`)).toEqual([]);
    });
});

describe("git-checkout-overwrites-file: a fresh worktree and the command's own swap", () => {
    it("passes a checkout in a worktree the same && chain added and entered", () => {
        expect(
            ids(
                "git worktree add -q --detach /tmp/w/x origin/main && cd /tmp/w/x && git checkout 330c98a774 -- a.ts b.ts"
            )
        ).toEqual([]);
        expect(ids("W=/tmp/w/x; git worktree add $W origin/main && cd $W && git checkout abc -- a.ts")).toEqual([]);
        expect(ids("git worktree add -b feat/x /tmp/w/x origin/main && cd /tmp/w/x && git checkout -- a.ts")).toEqual(
            []
        );
        expect(ids("git worktree add /tmp/w/x main && cd /tmp/w/x && git restore a.ts")).toEqual([]);
    });

    it("is a context note when a ; can let the checkout run in an old folder (case 89), from the add on", () => {
        const command =
            'L=/tmp/cc/app/s1/bench; W=/tmp/cc/app/s1/worktrees/pr658; git worktree add -q --detach $W origin/feat/x > $L/wt658.log 2>&1; echo "wt exit=$?"; cd $W && git checkout 330c98a774 -- src/a.ts src/b.ts && git status --short';
        const violations = detectShellViolations(command, gitRules);
        const start = command.indexOf("git worktree add");

        expect(violations.map((v) => [v.ruleId, v.severity])).toEqual([[FRESH, "context"]]);
        expect(violations[0].index).toBe(start);
        expect(violations[0].matched).toBe(command.slice(start, command.indexOf(" && git status")));
        expect(violations[0].suggestion).toBeUndefined();
        expect(ids("git worktree add /tmp/w/x main && cd /tmp/w/x; git checkout abc -- a.ts")).toEqual([FRESH]);
        expect(ids("git worktree add /tmp/w/x main\ncd /tmp/w/x && git restore a.ts")).toEqual([FRESH]);
    });

    it("blocks when a || on the way skips the cd or runs the checkout only after a failure", () => {
        const skipped = "git worktree add /tmp/w/x main || cd /tmp/w/x && git checkout abc -- a.ts";
        const suggestion = only(skipped, CHECKOUT)?.suggestion;

        expect(ids(skipped)).toEqual([CHECKOUT]);
        expect(suggestion).toBe(skipped.replace("git checkout", `${gate("a.ts")}git checkout`));
        expect(ids(suggestion ?? "")).toEqual([]);
        // `a || <gate> && <checkout>` skips the gate when `a` succeeds, so no gate is offered there.
        blockedWithoutSuggestion([
            "git worktree add /tmp/w/x main && cd /tmp/w/x || git checkout abc -- a.ts",
            "false || git checkout main -- a.ts",
        ]);
    });

    it("passes a gated checkout after a ; joined worktree add, where the gate covers the old folder", () => {
        expect(ids(`git worktree add /tmp/w/x main; cd /tmp/w/x && ${gate("a.ts")}git checkout abc -- a.ts`)).toEqual(
            []
        );
    });

    it("yields to the block when another revert in the command is not in the fresh worktree", () => {
        const command = "git worktree add /w main; cd /w && git checkout x -- a.ts; cd /repo && git checkout -- b.ts";

        expect(ids(command)).toEqual([CHECKOUT]);
        expect(only(command, CHECKOUT)?.matched).toBe("git checkout -- b.ts");
    });

    it("fires when the cd went elsewhere", () => {
        expect(ids("git worktree add /tmp/w/x && cd /tmp/w/y && git checkout abc -- a.ts")).toEqual([CHECKOUT]);
        expect(ids("git worktree add /tmp/w/x && cd /tmp/w/x && cd /repo && git checkout abc -- a.ts")).toEqual([
            CHECKOUT,
        ]);
    });

    it("fires when git -C makes a relative worktree folder another folder than the cd", () => {
        expect(ids("git -C /repo worktree add ../w main && cd ../w && git checkout x -- a.ts")).toEqual([CHECKOUT]);
        expect(ids("git -C /repo worktree add /tmp/w/x main && cd /tmp/w/x && git checkout x -- a.ts")).toEqual([]);
    });

    it("passes git checkout HEAD -- <paths> that undoes the same chain's gated swap", () => {
        expect(
            ids(`${gate("a.ts b.ts")}git checkout main -- a.ts b.ts && bun test a.test.ts && git checkout HEAD -- a.ts`)
        ).toEqual([]);
    });

    it("passes a show or restore swap that the chain undoes from HEAD, so the corrected swap does not re-fire", () => {
        for (const [swap, undo, path] of [
            ["git show main:a.ts > a.ts", "git show HEAD:a.ts > a.ts", "a.ts"],
            ["git restore -s main src/x.ts", "git restore -s HEAD src/x.ts", "src/x.ts"],
            ["git restore -s main src/x.ts", "git checkout HEAD -- src/x.ts", "src/x.ts"],
            ["git checkout main -- src/x.ts", "git show HEAD:src/x.ts > src/x.ts", "src/x.ts"],
        ]) {
            const command = `${swap} && bun test && ${undo}`;
            const v = only(command, CHECKOUT);

            expect(v?.matched).toBe(swap);
            expect(v?.suggestion).toBe(`${gate(path)}${command}`);
            expect(ids(v?.suggestion ?? "")).toEqual([]);
        }

        expect(ids(`${gate("a.ts")}git show main:a.ts > a.ts; git show HEAD:a.ts > a.ts`)).toEqual([CHECKOUT]);
    });

    it("fires on a HEAD revert that a cd or another -C moves away from the swap", () => {
        expect(ids(`${gate("a.ts")}git checkout main -- a.ts && cd /repo && git checkout HEAD -- a.ts`)).toEqual([
            CHECKOUT,
        ]);
        expect(ids(`${gate("a.ts")}git checkout main -- a.ts && git -C /other checkout HEAD -- a.ts`)).toEqual([
            CHECKOUT,
        ]);
        expect(
            ids("git worktree add /w main && cd /w && git checkout x -- a.ts && cd /repo && git checkout HEAD -- a.ts")
        ).toEqual([CHECKOUT]);
        expect(
            ids(`${gate("a.ts", "git -C /r")}git -C /r checkout main -- a.ts && git -C /r checkout HEAD -- a.ts`)
        ).toEqual([]);
    });

    it("fires on the swap itself, and on a HEAD revert of other paths", () => {
        const swap = only("git checkout main -- a.ts && bun test && git checkout HEAD -- a.ts", CHECKOUT);

        expect(swap?.matched).toBe("git checkout main -- a.ts");
        expect(ids(`${gate("a.ts")}git checkout main -- a.ts && git checkout HEAD -- b.ts`)).toEqual([CHECKOUT]);
    });

    it("fires on a HEAD revert that a ; separates from a gated swap: a failed gate skips the swap, not the revert", () => {
        const command = `${gate("a.ts")}git checkout main -- a.ts; bun test a.test.ts; git checkout HEAD -- a.ts`;
        const v = only(command, CHECKOUT);

        expect(v?.matched).toBe("git checkout HEAD -- a.ts");
        expect(v?.suggestion).toBe(
            `${gate("a.ts")}git checkout main -- a.ts; bun test a.test.ts; git stash push -m "before revert" -- a.ts`
        );
    });

    it("the logged base-ref test (case 50) fires on the swap with the gate", () => {
        const paths = "src/question src/utils/agents src/claude src/utils/notifications";
        const command = `cd /tmp/cc/app/s1/worktrees/merged-b; git checkout 8392a4fcd6 -- ${paths}; bun run test src/question/lib/decisions/store.test.ts > /tmp/cc/app/s1/base.log 2>&1; echo rc=$?; git checkout HEAD -- ${paths}; git status --short`;
        const v = only(command, CHECKOUT);

        expect(v?.matched).toBe(`git checkout 8392a4fcd6 -- ${paths}`);
        expect(v?.suggestion).toBe(command.replace("git checkout 8392a4fcd6", `${gate(paths)}git checkout 8392a4fcd6`));
    });
});

describe("git-checkout-overwrites-file: git show <ref>:<path> > <path>", () => {
    it("writes the file it names like a checkout from that ref, so it is gated the same way", () => {
        for (const [command, target] of [
            ["git show 1c7b5e0c0e:src/a.ts > src/a.ts", "src/a.ts"],
            ["git show main:./src/a.ts > src/a.ts", "src/a.ts"],
            ["git show main:src/a.ts >| src/a.ts", "src/a.ts"],
            ["git show main:src/a.ts >src/a.ts 2>/dev/null", "src/a.ts"],
            ["git show --no-color origin/master:src/a.ts > ./src/a.ts", "./src/a.ts"],
            ["git show main:src/a.ts >& src/a.ts", "src/a.ts"],
        ]) {
            const v = only(command, CHECKOUT);
            const suggestion = command.replace("git show", `${gate(target)}git show`);

            expect(v?.severity).toBe("block");
            expect(v?.suggestion).toBe(suggestion);
            expect(ids(suggestion)).toEqual([]);
        }
    });

    it("gates a loop variable, and the logged rewrite after case 30 is caught", () => {
        const command = 'for f in a.ts b.ts; do git show 1c7b5e0c0e:"$f" > "$f"; done';

        expect(only(command, CHECKOUT)?.suggestion).toBe(
            `for f in a.ts b.ts; do ${gate('"$f"')}git show 1c7b5e0c0e:"$f" > "$f"; done`
        );
        expect(ids("cd /tmp/w && git show 1c7b5e0c0e:$f > $f && git status --short")).toEqual([CHECKOUT]);
    });

    it("from HEAD or the index it offers the stash, like git checkout HEAD -- <path>", () => {
        expect(only("git show HEAD:a.ts > a.ts", CHECKOUT)?.suggestion).toBe(
            'git stash push -m "before revert" -- a.ts'
        );
        expect(only("git show :a.ts > a.ts && bun test", CHECKOUT)?.suggestion).toBe(
            'git stash push -m "before revert" -- a.ts && bun test'
        );
    });

    it("offers no gate under git -C, where the redirect writes the shell's folder and the status reads another", () => {
        blockedWithoutSuggestion(["git -C /r show main:a.ts > a.ts"]);
        expect(ids(`${gate("a.ts", "git -C /r")}git -C /r show main:a.ts > a.ts`)).toEqual([CHECKOUT]);
    });

    it("never fires on another target, an append, a pipe, a commit or a conflict stage", () => {
        for (const command of [
            "git show main:a.ts > /tmp/x",
            "git show main:a.ts > a.ts.orig",
            "git show main:b.ts > a.ts",
            "git show main:a.ts >> a.ts",
            "git show main:a.ts | rg foo > a.ts",
            "git show main:a.ts",
            "git show main > a.ts",
            "git show :3:a.ts > a.ts",
            "git show main:a.ts 2> a.ts",
            "git show main:a.ts >&2",
        ]) {
            expect(ids(command)).toEqual([]);
        }
    });

    it("is a saved revert when the same command copied the file first", () => {
        expect(ids("cp a.ts /tmp/a && git show main:a.ts > a.ts")).toEqual([SAVED]);
    });

    it("reads a redirection glued to the object, and every target zsh's MULTIOS writes", () => {
        for (const [command, target] of [
            ["git show main:a.ts>a.ts", "a.ts"],
            ["git show main:a.ts>|a.ts", "a.ts"],
            ["git show main:a.ts >! a.ts", "a.ts"],
            ["git show main:a.ts > a.ts > /dev/null", "a.ts"],
            ["git show main:a.ts >/dev/null >a.ts", "a.ts"],
            ['git show main:"a b.ts">"a b.ts"', '"a b.ts"'],
        ]) {
            const v = only(command, CHECKOUT);
            const suggestion = command.replace("git show", `${gate(target)}git show`);

            expect(v?.severity).toBe("block");
            expect(v?.suggestion).toBe(suggestion);
            expect(ids(suggestion)).toEqual([]);
        }

        for (const command of [
            "git show main:a.ts>>a.ts",
            "git show main:a.ts >> a.ts > /dev/null",
            "git show main:a.ts>a.ts.orig",
            "git show main:a.ts 2>a.ts",
            'git show main:a.ts">"a.ts',
            "git show main:a.ts\\>a.ts",
        ]) {
            expect(ids(command)).toEqual([]);
        }
    });

    it("a heredoc operator that is only quoted text leaves the gate", () => {
        const command = "echo 'cat <<EOF'\ngit checkout main -- a.ts";

        expect(only(command, CHECKOUT)?.suggestion).toBe(`echo 'cat <<EOF'\n${gate("a.ts")}git checkout main -- a.ts`);
        blockedWithoutSuggestion(["cat <<EOF\n`git checkout main -- a.ts`\nEOF"]);
    });
});

describe("git-checkout-overwrites-file: paths that do not exist only create files", () => {
    const root = mkdtempSync(join(tmpdir(), "git-rule-"));
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "exists.ts"), "x");
    writeFileSync(join(root, "sub", "here.ts"), "x");
    writeFileSync(join(root, "a1.ts"), "x");
    writeFileSync(join(root, "file1.ts"), "x");
    symlinkSync("/nonexistent/target", join(root, "dangling.ts"));

    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it("passes a checkout, a restore --source or a git show whose every path is absent in a known folder", () => {
        for (const command of [
            "git checkout main -- missing.ts other/missing.ts",
            "git checkout HEAD -- missing.ts",
            "git restore --source main missing.ts",
            "git show main:missing.ts > missing.ts",
            "cd sub && git checkout main -- missing.ts",
            `cd ${root}/sub; git checkout main -- exists.ts`,
            "git -C sub checkout main -- missing.ts exists.ts",
            "git checkout main -- 'my missing.ts'",
        ]) {
            expect(ids(command, root)).toEqual([]);
        }

        // Case 30: the paths were absent in the worktree the command entered.
        expect(
            ids(
                `cd ${root} && git switch -q feat/x && git checkout 1c7b5e0c0e -- src/control/lib/__fixtures__/fake-ax.ts src/control/lib/kept-behaviours.test.ts && git status --short`,
                "/"
            )
        ).toEqual([]);
    });

    it("still fires when one path exists, the folder is unknown, or a path is no literal file", () => {
        for (const command of [
            "git checkout main -- missing.ts exists.ts",
            "git restore --source main exists.ts",
            "git show main:exists.ts > exists.ts",
            "cd sub && git checkout main -- here.ts",
            "git -C sub checkout main -- here.ts",
            "git checkout main -- sub",
            "git checkout main -- .",
            "git checkout main -- 'missing*.ts'",
            "git checkout main -- $f",
            "git checkout main -- ~/missing.ts",
            "cd $D && git checkout main -- missing.ts",
            // zsh globs that NO_EXTENDED_GLOB still expands, to a1.ts and file1.ts.
            "git checkout main -- a(1).ts",
            "git checkout main -- file<1-3>.ts",
            // A dangling symlink is a file the checkout replaces.
            "git checkout main -- dangling.ts",
        ]) {
            expect(ids(command, root)).toEqual([CHECKOUT]);
        }

        expect(ids("git checkout main -- missing.ts")).toEqual([CHECKOUT]);
        expect(ids("git checkout main -- missing.ts", join(root, "gone"))).toEqual([CHECKOUT]);
    });

    it("still fires when the folder the checkout runs in is not the one a cd named", () => {
        for (const command of [
            // The failed cd leaves the shell in the fixture, where exists.ts is.
            "cd nosuch; git checkout main -- exists.ts",
            // The subshell's cd ends with it, and a skipped cd moves nothing.
            "(cd sub); git checkout main -- exists.ts",
            "false && cd sub; git checkout main -- exists.ts",
            "cd sub & git checkout main -- exists.ts",
            "sh -c 'cd sub; git checkout main -- exists.ts'",
            "for d in sub; do cd sub; done; git checkout main -- exists.ts",
            // eval and a sourced script can change the folder where no cd statement shows it.
            "eval cd sub; git checkout main -- here.ts",
            "source ./go.sh; git checkout main -- here.ts",
            ". ./go.sh && git checkout main -- here.ts",
        ]) {
            expect(ids(command, root)).toEqual([CHECKOUT]);
        }
    });

    it("still fires when an earlier statement can have made the path, and for a revert from the index", () => {
        for (const command of [
            "git stash pop && git checkout main -- missing.ts",
            "printf x > missing.ts; git checkout main -- missing.ts",
            // A move brings a folder in by a name that is no path segment, or by a parent folder's name.
            "mv ../wip/* . && git checkout main -- missing.ts",
            "rsync -a --remove-source-files ../wip/lib/ lib/ && git checkout main -- lib/missing.ts",
            "git apply ../wip.patch && git checkout main -- missing.ts",
            "git checkout -- missing.ts",
            "git restore missing.ts",
        ]) {
            expect(ids(command, root)).toEqual([CHECKOUT]);
        }
    });
});

describe("git-checkout-overwrites-saved-file", () => {
    it("is context, not a block, when cp saved the path first, and the matched text names the copy", () => {
        const command = "cp src/a.ts /tmp/cc/app/s1/a.fixed.ts && git checkout HEAD -- src/a.ts";
        const violations = detectShellViolations(command, gitRules);

        expect(violations.map((v) => [v.ruleId, v.severity])).toEqual([[SAVED, "context"]]);
        expect(violations[0].matched).toBe(command);
        expect(violations[0].index).toBe(0);
        expect(violations[0].suggestion).toBeUndefined();
    });

    it("the logged cp, stash and diff saves (cases 70, 74 and 97) move to context", () => {
        const cases = [
            'cd /tmp/cc/GenesisTools/244eaf85-7f6e-4c7b-8991-3a68109d8c90/worktrees/recast && cp src/recast/lib/validation.ts ../../recast-agent/validation.fixed.ts && git checkout HEAD -- src/recast/lib/validation.ts 2>&1; bun run test src/recast 2>&1 | grep -E "pass|fail|UTC offset" | head; cp ../../recast-agent/validation.fixed.ts src/recast/lib/validation.ts; bun run test src/recast 2>&1 | grep -E "^ *[0-9]+ (pass|fail)"; git diff --stat',
            'cd /tmp/cc/GenesisTools/244eaf85-7f6e-4c7b-8991-3a68109d8c90/worktrees/unified-fix && S=/tmp/cc/GenesisTools/244eaf85-7f6e-4c7b-8991-3a68109d8c90/unified-fix-agent; git diff src/dev-dashboard/server/routes/share.ts > $S/t2-route.patch; git stash push -q -- src/dev-dashboard/server/routes/share.ts && printf \'\\nexport const LINKED_NOTE_READ_CONCURRENCY = 4;\\n\' >> src/dev-dashboard/server/routes/share.ts && bun scripts/test.ts src/dev-dashboard/server/routes/share.test.ts -t "linked notes a few" > $S/t2-red.log 2>&1; echo rc=$?; rg -n "pass|fail|Expected|Received" $S/t2-red.log | head; git checkout -q -- src/dev-dashboard/server/routes/share.ts && git stash pop -q && git diff --stat',
            "cd /tmp/cc/GenesisTools/244eaf85-7f6e-4c7b-8991-3a68109d8c90/worktrees/tmp-reclaim && F=.claude/skills/babysit/scripts/tmp-reclaim.ts; P=../../reclaim-fix.patch; git diff $F > $P && git apply -R $P && printf '%s\\n' 'export function isLiveQuarantine(): boolean { return false; }' >> $F && bun run test ./.claude/skills/babysit/scripts/scripts.test.ts -t 'quarantine|process exits|plan in /tmp/cc' 2>&1 | rg '\\(fail\\)|\\(pass\\)|^\\s*\\d+ (pass|fail)' | cut -c1-140; git checkout -- $F && git apply $P && git diff --stat | tail -1",
        ];
        const starts = ["cp src/recast", "git stash push -q", "git diff $F > $P"];

        cases.forEach((command, k) => {
            const violations = detectShellViolations(command, gitRules);

            expect(violations.map((v) => [v.ruleId, v.severity])).toEqual([[SAVED, "context"]]);
            expect(violations[0].index).toBe(command.indexOf(starts[k]));
            expect(violations[0].matched.startsWith(starts[k])).toBe(true);
            expect(violations[0].matched).toMatch(/git checkout (HEAD|-q|--) .*(validation\.ts 2>&1|share\.ts|\$F)$/);
        });
    });

    it("the logged checkout of committed files (case 140) still blocks: nothing saved them", () => {
        const command =
            "git status --short && git checkout origin/master -- src/macos/GenesisKit/Sources/GenesisKit/Widgets/WidgetHostView.swift src/macos/GenesisKit/Sources/GenesisKit/Widgets/WidgetMarkdown.swift src/macos/GenesisKit/Sources/GenesisKit/Widgets/LiveWidgetView.swift src/macos/GenesisKit/Sources/GenesisKit/Widgets/WidgetModel.swift src/macos/GenesisKit/Tests/GenesisKitTests/WidgetDecisionSurfacesTests.swift && git status --short";

        expect(ids(command)).toEqual([CHECKOUT]);
    });

    it("counts git stash push with or without --, git diff [HEAD] [--] > file, and restore", () => {
        expect(ids("git stash push -q -- a.ts && printf x >> a.ts; git checkout -- a.ts && git stash pop")).toEqual([
            SAVED,
        ]);
        expect(ids('git stash push -m "wip" a.ts; git checkout -- a.ts')).toEqual([SAVED]);
        expect(ids("git diff HEAD -- a.ts > /tmp/a.patch; git checkout HEAD -- a.ts")).toEqual([SAVED]);
        expect(ids("git diff a.ts >/tmp/a.patch && git restore a.ts")).toEqual([SAVED]);
        expect(ids('cp "my file.ts" /tmp/x && git checkout -- "my file.ts"')).toEqual([SAVED]);
        expect(ids("cp a.ts b.ts /tmp/bak/ && git checkout main -- a.ts b.ts")).toEqual([SAVED]);
    });

    it("reads >& <file> as stdout and stderr into the file, and >&2 or >& 2 as no file", () => {
        expect(ids("git diff -- a.ts >& /tmp/cc/a.patch && git checkout -- a.ts")).toEqual([SAVED]);
        expect(ids("git diff -- a.ts >&/tmp/cc/a.patch && git checkout -- a.ts")).toEqual([SAVED]);
        expect(ids("git diff -- a.ts 1>& /tmp/cc/a.patch && git checkout -- a.ts")).toEqual([SAVED]);
        expect(ids("git diff -- a.ts >&2 && git checkout -- a.ts")).toEqual([CHECKOUT]);
        expect(ids("git diff -- a.ts >& 2 && git checkout -- a.ts")).toEqual([CHECKOUT]);
    });

    it("reads a redirection glued to the path, >|, and every target zsh's MULTIOS writes", () => {
        expect(ids("git diff a.ts>/tmp/a.patch && git checkout -- a.ts")).toEqual([SAVED]);
        expect(ids("git diff a.ts >| /tmp/a.patch && git checkout -- a.ts")).toEqual([SAVED]);
        expect(ids("git diff a.ts > /tmp/a.patch > /dev/null && git checkout -- a.ts")).toEqual([SAVED]);
        expect(ids("git diff a.ts > /dev/null >/tmp/a.patch && git checkout -- a.ts")).toEqual([SAVED]);
        expect(ids("git diff a.ts>/dev/null; git checkout -- a.ts")).toEqual([CHECKOUT]);
        expect(ids("git diff a.ts > /dev/null > /dev/null; git checkout -- a.ts")).toEqual([CHECKOUT]);
    });

    it("reads only the last target of a save that bash or sh runs, which has no MULTIOS", () => {
        // bash truncates /tmp/a.patch and writes the diff to /dev/null only.
        expect(ids('bash -c "git diff a.ts > /tmp/a.patch > /dev/null; git checkout -- a.ts"')).toEqual([CHECKOUT]);
        expect(ids("sh <<'EOF'\ngit diff a.ts > /tmp/a.patch > /dev/null; git checkout -- a.ts\nEOF")).toEqual([
            CHECKOUT,
        ]);
        expect(ids('bash -c "git diff a.ts > /dev/null > /tmp/a.patch && git checkout -- a.ts"')).toEqual([SAVED]);
        expect(ids('zsh -c "git diff a.ts > /tmp/a.patch > /dev/null && git checkout -- a.ts"')).toEqual([SAVED]);
    });

    it("blocks when a path was not saved, or the save does not hold the work", () => {
        expect(ids("cp a.ts /tmp/a && git checkout -- a.ts b.ts")).toEqual([CHECKOUT]);
        expect(ids("git diff a.ts > /dev/null; git checkout -- a.ts")).toEqual([CHECKOUT]);
        expect(ids("git diff --stat a.ts > /tmp/s; git checkout -- a.ts")).toEqual([CHECKOUT]);
        expect(ids("git diff main -- a.ts > /tmp/p; git checkout -- a.ts")).toEqual([CHECKOUT]);
        expect(ids("git stash push --staged -- a.ts; git checkout -- a.ts")).toEqual([CHECKOUT]);
        expect(ids("git stash push -p -- a.ts; git checkout -- a.ts")).toEqual([CHECKOUT]);
        expect(ids("git checkout -- a.ts; cp a.ts /tmp/a")).toEqual([CHECKOUT]);
        expect(ids("cp a.ts /tmp/a; cd sub; git checkout -- a.ts")).toEqual([CHECKOUT]);
        expect(ids("echo a.ts | xargs git checkout --")).toEqual([CHECKOUT]);
        expect(ids("cp a.ts /dev/null && git checkout -- a.ts")).toEqual([CHECKOUT]);
        expect(ids('git diff a.ts > "/dev/null"; git checkout -- a.ts')).toEqual([CHECKOUT]);
    });

    it("blocks when a stash pop, drop or clear took the saved entry off the list before the revert", () => {
        expect(ids("git stash push -- a.ts && git stash pop && sed -i '' s/x/y/ a.ts && git checkout -- a.ts")).toEqual(
            [CHECKOUT]
        );
        expect(ids("git stash push -- a.ts; bun test; git stash drop; git checkout -- a.ts")).toEqual([CHECKOUT]);
        expect(ids("git stash push -- a.ts; git stash clear; git checkout -- a.ts")).toEqual([CHECKOUT]);
        expect(ids("git stash push -- a.ts; git stash apply; git checkout -- a.ts")).toEqual([SAVED]);
        expect(ids("cp a.ts /tmp/a; git stash pop; git checkout -- a.ts")).toEqual([SAVED]);
    });

    it("blocks when the save ran in another repository or folder than the revert", () => {
        for (const command of [
            "git -C /other stash push -- a.ts && git checkout -- a.ts",
            "git -C /other diff a.ts > /tmp/a.patch && git checkout -- a.ts",
            "git stash push -- a.ts && git -C /other checkout -- a.ts",
            "cp a.ts /tmp/a && git -C /other checkout -- a.ts",
            "cp a.ts /tmp/a && GIT_WORK_TREE=/other git checkout -- a.ts",
            "(cd sub && cp a.ts /tmp/a) && git checkout -- a.ts",
            "(cd sub && git stash push -- a.ts) && git checkout -- a.ts",
        ]) {
            expect(ids(command)).toEqual([CHECKOUT]);
        }

        expect(ids("git -C /r stash push -- a.ts && git -C /r checkout -- a.ts")).toEqual([SAVED]);
        expect(ids("git -c core.quotepath=off diff a.ts > /tmp/a.patch && git checkout -- a.ts")).toEqual([SAVED]);
        expect(ids("{ cd sub && cp a.ts /tmp/a; } && git checkout -- a.ts")).toEqual([SAVED]);
    });

    it("needs git diff HEAD for a revert that also resets the index, where a plain git diff misses the staged part", () => {
        for (const command of [
            "git diff a.ts > /tmp/a.patch; git checkout HEAD -- a.ts",
            "git diff a.ts > /tmp/a.patch && git checkout main -- a.ts",
            "git diff a.ts > /tmp/a.patch && git restore --staged --worktree a.ts",
            "git diff a.ts > /tmp/a.patch && git restore -SW a.ts",
        ]) {
            expect(ids(command)).toEqual([CHECKOUT]);
        }

        for (const command of [
            "git diff HEAD a.ts > /tmp/a.patch; git checkout HEAD -- a.ts",
            "git diff HEAD -- a.ts > /tmp/a.patch && git restore -SW a.ts",
            "git diff a.ts > /tmp/a.patch && git checkout -- a.ts",
            "git diff a.ts > /tmp/a.patch && git restore --source=HEAD~1 a.ts",
        ]) {
            expect(ids(command)).toEqual([SAVED]);
        }
    });

    it("yields to the block when another revert in the command was not saved", () => {
        expect(ids("cp a.ts /tmp/a && git checkout -- a.ts; git checkout -- b.ts")).toEqual([CHECKOUT]);
        expect(only("cp a.ts /tmp/a && git checkout -- a.ts; git checkout -- b.ts", CHECKOUT)?.matched).toBe(
            "git checkout -- b.ts"
        );
    });
});

describe("git-push-force-without-lease", () => {
    it("--force and -f fire, with the lease substituted in the suggestion", () => {
        const v = only("git push --force origin feat/x", FORCE);

        expect(v?.severity).toBe("block");
        expect(v?.matched).toBe("git push --force origin feat/x");
        expect(v?.suggestion).toBe("git push --force-with-lease origin feat/x");
        expect(only("git push -f", FORCE)?.suggestion).toBe("git push --force-with-lease");
    });

    it("a short cluster with f keeps the other letters", () => {
        expect(only("git push -fu origin feat/x", FORCE)?.suggestion).toBe(
            "git push -u --force-with-lease origin feat/x"
        );
    });

    it("--force-with-lease passes, with and without a value", () => {
        expect(ids("git push --force-with-lease origin feat/x")).toEqual([]);
        expect(ids("git push --force-with-lease=feat/x:abc123 origin feat/x")).toEqual([]);
        expect(ids("git push --force-if-includes --force-with-lease")).toEqual([]);
    });

    it("other git commands with -f are not a push", () => {
        expect(ids("git fetch -f origin")).toEqual([]);
        expect(ids("git branch -f feat/x abc")).toEqual([]);
        expect(ids("git clean -fd")).toEqual([]);
        expect(ids("git tag -f v1")).toEqual([]);
    });

    it("prose", () => {
        expect(ids('git commit -m "stop using git push --force"')).toEqual([]);
        expect(ids("echo 'git push -f'")).toEqual([]);
    });
});

describe("git rules: corpus fixtures", () => {
    const cases: Array<[string, string[]]> = [
        ["git checkout -- src/utils/ai/grok/models.ts && bun test src/utils/ai/grok", [CHECKOUT]],
        ["git checkout HEAD -- README.md; git diff --stat", [CHECKOUT]],
        ["git checkout --theirs -- bun.lock && bun install && git add bun.lock", []],
        ["git restore --staged -- src/x.ts", []],
        ["git restore --staged src/a.ts src/b.ts && git status --short", []],
        ["git stash push -m 'wip' -- src/x.ts; git checkout master", []],
        [
            'cd repo && git push --force-with-lease=feat/bundlers:3413ebd origin feat/bundlers:refs/heads/feat/bundlers 2>&1; echo "EXIT=$?"',
            [],
        ],
        ["git push --force-with-lease origin HEAD", []],
    ];

    for (const [command, expected] of cases) {
        it(`${expected.join("+") || "silent"}: ${command.slice(0, 70)}`, () => {
            expect(ids(command)).toEqual(expected);
        });
    }
});
