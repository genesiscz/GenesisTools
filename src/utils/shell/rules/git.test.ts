import { describe, expect, it } from "bun:test";
import { gitRules } from "./git";
import { detectShellViolations, type ShellViolation } from "./index";

function ids(command: string): string[] {
    return detectShellViolations(command, gitRules).map((v) => v.ruleId);
}

function only(command: string, ruleId: string): ShellViolation | undefined {
    return detectShellViolations(command, gitRules).find((v) => v.ruleId === ruleId);
}

const CHECKOUT = "git-checkout-overwrites-file";
const FORCE = "git-push-force-without-lease";

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

    it("git checkout <branch> -- <file> (the sneaky one) with no suggestion", () => {
        const v = only("git checkout origin/master -- README.md", CHECKOUT);

        expect(v).toBeDefined();
        expect(v?.suggestion).toBeUndefined();
    });

    it("git checkout -- . and the dot-slash form", () => {
        expect(ids("git checkout -- .")).toEqual([CHECKOUT]);
        expect(ids("git checkout -- ./src")).toEqual([CHECKOUT]);
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
