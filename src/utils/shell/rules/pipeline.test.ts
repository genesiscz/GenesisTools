import { describe, expect, it } from "bun:test";

import { detectShellViolations, renderViolation, type ShellViolation } from "./index";

// Ported from the deleted exitCodeGuard.test.ts (e98cae4). Every case runs the
// WHOLE registry, as the live hook does, so a fixture that trips a second rule
// says so here rather than only in production. Ids map as: pipe-status:block →
// exit-code-after-pipeline:block, pipe-status:warn → exit-code-after-grep:context,
// pipestatus-zsh:warn → pipestatus-under-zsh:context, promoted to block on 2026-09-16 (D11b).

function tags(command: string): string[] {
    return detectShellViolations(command).map((v) => `${v.ruleId}:${v.severity}`);
}

function blocks(command: string): string[] {
    return detectShellViolations(command)
        .filter((v) => v.severity === "block")
        .map((v) => v.ruleId);
}

function violation(command: string, ruleId: string): ShellViolation | undefined {
    return detectShellViolations(command).find((v) => v.ruleId === ruleId);
}

const PIPE = "exit-code-after-pipeline";
const CHECKED = "exit-code-after-pipeline-checked";
const INDEX = "pipestatus-index-mismatch";
const GREP = "exit-code-after-grep";
const ZSH = "pipestatus-under-zsh";

// ---------------------------------------------------------------------------
// exit-code-after-pipeline: `$?` consumed right after a pipeline
// ---------------------------------------------------------------------------

describe("exit-code-after-pipeline: blocks when the last element's status is meaningless", () => {
    const filters = [
        "head",
        "tail",
        "wc",
        "tee",
        "cat",
        "sort",
        "uniq",
        "cut",
        "tr",
        "column",
        "fold",
        "nl",
        "rev",
        "tac",
        "paste",
        "less",
        "more",
    ];

    for (const filter of filters) {
        it(`blocks \`cmd | ${filter}; echo $?\``, () => {
            expect(tags(`cmd | ${filter}; echo $?`)).toEqual([`${PIPE}:block`]);
            expect(violation(`cmd | ${filter}; echo $?`, PIPE)?.matched).toBe(`cmd | ${filter}`);
        });
    }

    it("blocks the canonical tsgo shape from the corpus", () => {
        expect(tags('tsgo --noEmit 2>&1 | tail -20; echo "tsgo exit: $?"')).toEqual([`${PIPE}:block`]);
    });

    it("blocks the canonical tee shape from the corpus", () => {
        expect(tags('git rebase origin/feature/next 2>&1 | tee /tmp/rebase.log; echo "EXIT=$?"')).toEqual([
            `${PIPE}:block`,
        ]);
    });

    it("blocks head with a count and tail with a count", () => {
        expect(blocks('bunx tsc --noEmit 2>&1 | head -20; echo "TSC_DONE=$?"')).toEqual([PIPE]);
        expect(blocks('bun run typecheck 2>&1 | tail -10; echo "main=$?"')).toEqual([PIPE]);
    });

    it("blocks when the filter is reached through a path", () => {
        expect(blocks("cmd | /usr/bin/tail -3; echo $?")).toEqual([PIPE]);
    });

    it("blocks when the filter is wrapped in sudo, timeout or an env assignment", () => {
        expect(blocks("cmd | sudo tee /etc/x; echo $?")).toEqual([PIPE]);
        expect(blocks("cmd | timeout 5 tail -3; echo $?")).toEqual([PIPE]);
        expect(blocks("cmd | LC_ALL=C sort; echo $?")).toEqual([PIPE]);
    });

    it("blocks a three-element pipeline whose last element is a filter", () => {
        expect(blocks('cmd 2>&1 | rg -v noise | tail -5; echo "exit=$?"')).toEqual([PIPE]);
        expect(violation('cmd 2>&1 | rg -v noise | tail -5; echo "exit=$?"', PIPE)?.matched).toBe(
            "cmd 2>&1 | rg -v noise | tail -5"
        );
    });

    it("blocks with a 2>&1 redirect before the pipe", () => {
        expect(blocks("bun test 2>&1 | tail -3; echo $?")).toEqual([PIPE]);
    });

    it("blocks with |& (pipe both streams)", () => {
        expect(blocks("bun test |& tail -3; echo $?")).toEqual([PIPE]);
    });

    it("blocks when the pipeline is a subshell or a brace group", () => {
        expect(blocks("(cmd | tail -5); echo $?")).toEqual([PIPE]);
        expect(blocks("{ cmd | tail -5; }; echo $?")).toEqual([PIPE]);
    });

    it("blocks when the pipeline output is redirected to a file", () => {
        expect(blocks("cmd | tail -20 > /tmp/out.txt; echo $?")).toEqual([PIPE]);
    });

    it("points at the pipeline in the ORIGINAL command and offers pipefail", () => {
        const command = 'cd /repo\ntsgo --noEmit 2>&1 | tail -20; echo "exit=$?"';
        const v = violation(command, PIPE);

        expect(v?.index).toBe(command.indexOf("tsgo"));
        expect(v?.matched).toBe("tsgo --noEmit 2>&1 | tail -20");
        expect(v?.suggestion).toBe('cd /repo\n(set -o pipefail; tsgo --noEmit 2>&1 | tail -20); echo "exit=$?"');
    });

    it("keeps an && list intact, so a failed cd still stops the pipeline", () => {
        const v = violation('cd wt && grep -rn x . | head -30; echo "exit $?"', PIPE);

        expect(v?.suggestion).toBe('cd wt && (set -o pipefail; grep -rn x . | head -30); echo "exit $?"');
    });

    it("keeps then, do and ! in front of the subshell, where the correction still parses", () => {
        expect(violation("if true; then false | tail -1; echo $?; fi", PIPE)?.suggestion).toBe(
            "if true; then (set -o pipefail; false | tail -1); echo $?; fi"
        );
        expect(violation("for f in a b; do cmd $f | head -3; echo $?; done", PIPE)?.suggestion).toBe(
            "for f in a b; do (set -o pipefail; cmd $f | head -3); echo $?; done"
        );
        expect(violation("! cmd | tail -1; echo $?", PIPE)?.suggestion).toBe(
            "! (set -o pipefail; cmd | tail -1); echo $?"
        );
    });
});

describe("exit-code-after-pipeline: the pipefail correction", () => {
    it("wraps the pipeline as typed and never makes the producer run to EOF, so the correction always ends", () => {
        for (const command of [
            'seq 1 1000000 | head -1; echo "exit=$?"',
            "yes | head -1; echo $?",
            "tail -f x.log | head -5; echo $?",
        ]) {
            const v = violation(command, PIPE);

            expect(v?.suggestion).toBe(`(set -o pipefail; ${v?.matched})${command.slice((v?.matched ?? "").length)}`);
        }
    });

    it("closes the wrapper before a trailing comment, which would swallow it", () => {
        expect(violation('cmd | head -5  # top\necho "rc=$?"', PIPE)?.suggestion).toBe(
            '(set -o pipefail; cmd | head -5)  # top\necho "rc=$?"'
        );
        expect(violation("cmd 2>&1 | tail -3 # last lines\necho $?", PIPE)?.suggestion).toBe(
            "(set -o pipefail; cmd 2>&1 | tail -3) # last lines\necho $?"
        );
        // A `#` inside a quoted argument is not a comment.
        expect(violation('cmd | tail -n 5 "a #b"; echo $?', PIPE)?.suggestion).toBe(
            '(set -o pipefail; cmd | tail -n 5 "a #b"); echo $?'
        );
    });

    it("the corrected command fires nothing", () => {
        for (const command of [
            'seq 1 1000000 | head -1; echo "exit=$?"',
            "git log | head -100 | tail -5; echo $?",
            'cd wt && grep -rn x . | head -30; echo "exit $?"',
        ]) {
            const suggestion = violation(command, PIPE)?.suggestion;

            expect(suggestion).toBeDefined();
            expect(tags(suggestion as string)).toEqual([]);
        }
    });

    it("the message explains 141 after head under pipefail", () => {
        const text = renderViolation(violation("cmd | head -3; echo $?", PIPE) as ShellViolation);

        expect(text).toContain("not after head");
        expect(text).toContain("141 (SIGPIPE)");
    });
});

describe("exit-code-after-pipeline: the many ways $? gets consumed", () => {
    it("echo with text around it", () => {
        expect(blocks('cmd | tail; echo "--- exit $? ---"')).toEqual([PIPE]);
    });

    it("an assignment", () => {
        expect(blocks("cmd | tail; rc=$?; echo $rc")).toEqual([PIPE]);
    });

    it("a test expression", () => {
        expect(blocks("cmd | tail; [ $? -ne 0 ] && echo failed")).toEqual([PIPE]);
        expect(blocks("cmd | tail; test $? -eq 0 || exit 1")).toEqual([PIPE]);
    });

    it("exit $?", () => {
        expect(blocks("cmd | tail; exit $?")).toEqual([PIPE]);
    });

    it("${?} braces", () => {
        expect(blocks("cmd | tail; echo ${?}")).toEqual([PIPE]);
    });

    it("printf", () => {
        expect(blocks("cmd | tail; printf 'exit=%s\\n' $?")).toEqual([PIPE]);
    });

    it("$? appended to a log file", () => {
        expect(blocks('(bun run start:debug 2>&1 | tee /tmp/b.log; echo "EXIT:$?" >> /tmp/b.log)')).toEqual([PIPE]);
    });
});

describe("exit-code-after-pipeline: statement separators", () => {
    it("semicolon", () => {
        expect(blocks("cmd | tail; echo $?")).toEqual([PIPE]);
    });

    it("newline", () => {
        expect(blocks("cmd | tail\necho $?")).toEqual([PIPE]);
    });

    it("blank lines between", () => {
        expect(blocks("cmd | tail\n\n\necho $?")).toEqual([PIPE]);
    });

    it("a comment line between", () => {
        expect(blocks("cmd | tail\n# now the status\necho $?")).toEqual([PIPE]);
    });

    it("&& (the status is still the pipeline's)", () => {
        expect(blocks('cmd | tail -5 && echo "ok $?"')).toEqual([PIPE]);
    });

    it("|| (the status is still the pipeline's)", () => {
        expect(blocks('cmd | tail -5 || echo "failed $?"')).toEqual([PIPE]);
    });

    it("a multi-line script with the status three lines later but adjacent", () => {
        const command = `cd /repo
git cherry-pick a b c 2>&1 | tail -20
echo "EXIT=$?"`;

        expect(blocks(command)).toEqual([PIPE]);
    });

    it("backslash line continuation inside the pipeline", () => {
        expect(blocks("cmd \\\n  | tail -3\necho $?")).toEqual([PIPE]);
    });
});

describe("exit-code-after-grep: context when the last element's status might be intended", () => {
    const ambiguous = ["grep", "egrep", "fgrep", "rg", "jq", "sed", "awk", "yq"];

    for (const filter of ambiguous) {
        it(`context for \`cmd | ${filter} x; echo $?\``, () => {
            expect(tags(`cmd | ${filter} x; echo $?`)).toEqual([`${GREP}:context`]);
        });
    }

    it("context for the deliberate grep-exit shape from the corpus", () => {
        expect(tags('timeout 90 tsgo --noEmit 2>&1 | rg "dev-dashboard"; echo "grep-exit:$?"')).toEqual([
            `${GREP}:context`,
        ]);
    });

    it("context, not block, for `| rg -q x; echo $?`", () => {
        expect(tags("cmd | rg -q x; echo $?")).toEqual([`${GREP}:context`]);
    });
});

describe("exit-code-after-grep: the corrected command reads the left status from $pipestatus", () => {
    it("inserts left_exit right after the first $?, inside the same quotes", () => {
        const command = 'tools mcp-manager list --json 2>/dev/null | rg -i alza; echo "exit-rg=$?"';

        expect(violation(command, GREP)?.suggestion).toBe(
            'tools mcp-manager list --json 2>/dev/null | rg -i alza; echo "exit-rg=$? left_exit=${pipestatus[1]}"'
        );
    });

    it("unquoted echo, printf with $? in its format, and the ${?} spelling", () => {
        expect(violation("cmd | grep x; echo $?", GREP)?.suggestion).toBe(
            "cmd | grep x; echo $? left_exit=${pipestatus[1]}"
        );
        expect(violation('cmd | rg x; printf "rc=$?\\n"', GREP)?.suggestion).toBe(
            'cmd | rg x; printf "rc=$? left_exit=${pipestatus[1]}\\n"'
        );
        expect(violation('cmd | jq .a; echo "status=${?}"', GREP)?.suggestion).toBe(
            'cmd | jq .a; echo "status=${?} left_exit=${pipestatus[1]}"'
        );
    });

    it("offers none when printf takes $? as a separate argument, since printf reuses its format for it", () => {
        expect(violation('seq 3 | grep 9; printf "rc=%d\\n" $?', GREP)?.suggestion).toBeUndefined();
        expect(violation("cmd | rg x; printf 'rc=%s\\n' $?", GREP)?.suggestion).toBeUndefined();
        expect(violation('cmd | rg x; printf -v out "%s" "$?"', GREP)?.suggestion).toBeUndefined();
    });

    it("offers none when $? sits inside $(( )), where the text would break the arithmetic", () => {
        expect(violation("seq 3 | grep 9; echo $(( $? + 0 ))", GREP)?.suggestion).toBeUndefined();
        expect(violation('seq 3 | grep 9; echo "n=$(( $? * 2 ))"', GREP)?.suggestion).toBeUndefined();
        expect(violation('seq 3 | grep 9; echo "$(( 1 + 1 )) rc=$?"', GREP)?.suggestion).toBe(
            'seq 3 | grep 9; echo "$(( 1 + 1 )) rc=$? left_exit=${pipestatus[1]}"'
        );
    });

    it("spells the left status for the shell that runs the consumer", () => {
        const bash = violation("bash -c 'seq 3 | grep 9; echo \"rc=$?\"'", GREP);
        const sh = violation("sh -c 'seq 3 | grep 9; rc=$?; echo $rc'", GREP);

        expect(bash?.suggestion).toBe("bash -c 'seq 3 | grep 9; echo \"rc=$? left_exit=${PIPESTATUS[0]}\"'");
        expect(sh?.suggestion).toBe("sh -c 'seq 3 | grep 9; rc=$? left_rc=${PIPESTATUS[0]}; echo $rc'");
        expect(violation("/bin/bash -c 'cmd | rg x; echo $?'", GREP)?.suggestion).toBe(
            "/bin/bash -c 'cmd | rg x; echo $? left_exit=${PIPESTATUS[0]}'"
        );
        expect(violation("zsh -c 'cmd | grep x; echo \"rc=$?\"'", GREP)?.suggestion).toBe(
            "zsh -c 'cmd | grep x; echo \"rc=$? left_exit=${pipestatus[1]}\"'"
        );
        expect(violation("bash <<'E'\ncmd | grep x\necho \"rc=$?\"\nE", GREP)?.suggestion).toBe(
            "bash <<'E'\ncmd | grep x\necho \"rc=$? left_exit=${PIPESTATUS[0]}\"\nE"
        );
        // A backtick body runs in the shell around it.
        expect(violation("bash -c 'x=`cmd | grep y; echo $?`'", GREP)?.suggestion).toBe(
            "bash -c 'x=`cmd | grep y; echo $? left_exit=${PIPESTATUS[0]}`'"
        );
    });

    it("offers none where no shell spelling fits: dash, ksh93, or a body the outer shell expands first", () => {
        for (const command of [
            "dash -c 'cmd | grep x; echo \"rc=$?\"'",
            "ksh -c 'cmd | grep x; echo \"rc=$?\"'",
            'zsh -c "cmd | grep x; echo rc=$?"',
            'bash <<E\ncmd | grep x\necho "rc=$?"\nE',
        ]) {
            const v = violation(command, GREP);

            expect(v?.severity).toBe("context");
            expect(v?.suggestion).toBeUndefined();
        }
    });

    it("inserts after the first live $? only", () => {
        expect(violation('cmd | grep x; echo "a=$? b=$?"', GREP)?.suggestion).toBe(
            'cmd | grep x; echo "a=$? left_exit=${pipestatus[1]} b=$?"'
        );
        expect(violation("cmd | grep x; echo '$?' \"rc=$?\"", GREP)?.suggestion).toBe(
            "cmd | grep x; echo '$?' \"rc=$? left_exit=${pipestatus[1]}\""
        );
    });

    it("appends left_NAME after an assignment NAME=$?", () => {
        expect(violation("cmd | grep x; rc=$?; echo $rc", GREP)?.suggestion).toBe(
            "cmd | grep x; rc=$? left_rc=${pipestatus[1]}; echo $rc"
        );
        expect(violation('cmd | sed s/a/b/; code="$?"', GREP)?.suggestion).toBe(
            'cmd | sed s/a/b/; code="$?" left_code=${pipestatus[1]}'
        );
    });

    it("offers no corrected command for any other consumer, and never the pipefail wrapper", () => {
        const test = violation("cmd | grep x; [ $? -eq 0 ] && echo ok", GREP);

        expect(test?.severity).toBe("context");
        expect(test?.suggestion).toBeUndefined();
        expect(violation("cmd | rg x; exit $?", GREP)?.suggestion).toBeUndefined();
        expect(violation("cmd | rg x; rc=$? other=1", GREP)?.suggestion).toBeUndefined();

        for (const command of ["cmd | grep x; echo $?", "cmd | awk '{print}'; rc=$?", "cmd | rg x; exit $?"]) {
            expect(violation(command, GREP)?.suggestion ?? "").not.toContain("pipefail");
        }
    });

    it("the corrected command fires nothing", () => {
        for (const command of [
            "cmd | grep x; echo $?",
            'bun test 2>&1 | rg "fail"; echo "tests exit=$?"',
            "cmd | grep x; rc=$?; echo $rc",
            "bash -c 'seq 3 | grep 9; echo \"rc=$?\"'",
            "sh -c 'seq 3 | grep 9; rc=$?; echo $rc'",
            "/bin/bash -c 'cmd | rg x; echo $?'",
            "bash <<'E'\ncmd | grep x\necho \"rc=$?\"\nE",
        ]) {
            const suggestion = violation(command, GREP)?.suggestion;

            expect(suggestion).toBeDefined();
            expect(tags(suggestion as string)).toEqual([]);
        }
    });
});

describe("exit-code-after-grep: a deliberate match test is silent", () => {
    it("the label names the filter or a match, and every left element keeps stderr on screen", () => {
        expect(tags('git worktree list | grep feature-x; echo "grep_exit=$?"')).toEqual([]);
        expect(tags('cmd | rg -c x; echo "count-rc=$?"')).toEqual([]);
        expect(tags('cmd | rg x; echo "match-exit=$?"')).toEqual([]);
        expect(tags('git ls-tree -r origin/x | rg -i template; echo "template search exit=$?"')).toEqual([]);
        expect(tags('curl -fsSL https://example.com | rg x; echo "match=$?"')).toEqual([]);
    });

    it("still fires when the label names no filter or match, or names the left command", () => {
        expect(tags('bun test 2>&1 | rg fail; echo "tests exit=$?"')).toEqual([`${GREP}:context`]);
        expect(tags('ls node_modules | rg -i alza; echo "node_modules exit=$?"')).toEqual([`${GREP}:context`]);
        expect(tags("cmd | grep x; echo $?")).toEqual([`${GREP}:context`]);
        expect(tags('cmd | grep x; echo "$? = grep exit"')).toEqual([`${GREP}:context`]);
    });

    it("still fires when the label names a filter that runs on the left, not the last element", () => {
        expect(tags('jq .a in.json | grep x; echo "jq_exit=$?"')).toEqual([`${GREP}:context`]);
        expect(tags('sed -n 1,5p f.txt | grep x; echo "sed_exit=$?"')).toEqual([`${GREP}:context`]);
        expect(tags('git grep foo | rg bar; echo "git-grep exit=$?"')).toEqual([`${GREP}:context`]);
        expect(tags("awk '{print $1}' f.txt | rg x; echo \"awk rc=$?\"")).toEqual([`${GREP}:context`]);
        expect(tags('jq . f.json | grep x; echo "jq count=$?"')).toEqual([`${GREP}:context`]);
    });

    it("stays silent when the label names the last filter or a match, whatever runs on the left", () => {
        expect(tags('jq .a in.json | grep x; echo "grep_exit=$?"')).toEqual([]);
        expect(tags('grep -r foo src | grep -v test; echo "grep_exit=$?"')).toEqual([]);
        expect(tags('sed -n 1,5p f.txt | rg x; echo "match=$?"')).toEqual([]);
    });

    it("still fires when a left element discards or merges stderr", () => {
        expect(tags('tools x list 2>/dev/null | rg -i alza; echo "exit-rg=$?"')).toEqual([
            `${GREP}:context`,
            "stderr-discarded-then-read:context",
        ]);
        expect(tags('cmd 2>&1 | grep x; echo "grep=$?"')).toEqual([`${GREP}:context`]);
        expect(tags('cmd |& grep x; echo "grep=$?"')).toEqual([`${GREP}:context`]);
        expect(tags('cmd &>/tmp/x | grep x; echo "grep=$?"')).toEqual([`${GREP}:context`]);
        expect(tags('cmd 2>/tmp/e | sort | grep x; echo "grep=$?"')).toEqual([`${GREP}:context`]);
    });

    it("still fires when a left curl fails silently", () => {
        expect(tags('curl -s https://example.com | rg x; echo "match=$?"')).toEqual([`${GREP}:context`]);
        expect(tags('curl --silent -L https://example.com | rg x; echo "match=$?"')).toEqual([`${GREP}:context`]);
        expect(tags('curl -sL https://example.com | rg x; echo "match=$?"')).toEqual([`${GREP}:context`]);
    });

    it("a deliberate test does not hide a later misread in the same command", () => {
        const command = 'git worktree list | grep feat; echo "grep_exit=$?"; cmd 2>&1 | rg fail; echo "tests exit=$?"';

        expect(tags(command)).toEqual([`${GREP}:context`]);
        expect(violation(command, GREP)?.matched).toBe("cmd 2>&1 | rg fail");
    });
});

describe("exit-code-after-pipeline: does not fire", () => {
    it("when the last element is a shell or a real program", () => {
        expect(tags("cmd | bash; echo $?")).toEqual([]);
        expect(tags("cmd | sh -s; echo $?")).toEqual([]);
        expect(tags("cmd | zsh; echo $?")).toEqual([]);
        expect(tags("cmd | bun run x.ts; echo $?")).toEqual([]);
        expect(tags("cmd | python3 -c 'import sys'; echo $?")).toEqual([]);
        expect(tags("cmd | xargs rm; echo $?")).toEqual([]);
        expect(tags("cmd | xargs -0 git add; echo $?")).toEqual([]);
        expect(tags("cmd | node script.js; echo $?")).toEqual([]);
        expect(tags("cmd | sqlite3 db.sqlite; echo $?")).toEqual([]);
        expect(tags("cmd | ssh host 'cat > f'; echo $?")).toEqual([]);
        expect(tags("cmd | pbcopy; echo $?")).toEqual([]);
    });

    it("when the last element is a builtin read loop", () => {
        expect(tags("cmd | while read -r l; do echo $l; done; echo $?")).toEqual([]);
        expect(tags("cmd | read x; echo $?")).toEqual([]);
    });

    it("when the status is read through PIPESTATUS or pipestatus", () => {
        expect(tags("cmd | tail; echo $pipestatus[1]")).toEqual([]);
        expect(tags('cmd | tail; echo "rc=${pipestatus[1]}"')).toEqual([]);
        // PIPESTATUS itself is a different rule under zsh, not this one.
        expect(tags("cmd | tail; echo ${PIPESTATUS[0]}")).toEqual([`${ZSH}:block`]);
        expect(tags('cmd | tail; echo "rc=${PIPESTATUS[0]} tail=$?"')).toEqual([`${ZSH}:block`]);
    });

    it("when pipefail is set earlier in the same shell", () => {
        expect(tags("set -o pipefail; cmd | tail; echo $?")).toEqual([]);
        expect(tags("set -eo pipefail\ncmd | tail\necho $?")).toEqual([]);
        expect(tags("setopt pipefail; cmd | tail; echo $?")).toEqual([]);
        expect(tags("set -o pipefail && cmd | tail && echo $?")).toEqual([]);
    });

    it("when there is no pipeline", () => {
        expect(tags('cmd > /tmp/x.log 2>&1; echo "exit=$?"; tail -6 /tmp/x.log')).toEqual([]);
        expect(tags('gh run watch 123 --exit-status > /tmp/ci.txt 2>&1; echo "CI exit=$?"')).toEqual([]);
        expect(tags("bun test; echo $?")).toEqual([]);
        expect(tags("cmd 2>&1; echo $?")).toEqual([]);
        expect(tags('cmd || echo "failed $?"')).toEqual([]);
        expect(tags('cmd && echo "ok $?"')).toEqual([]);
    });

    it("when $? is two statements after the pipeline (already clobbered, a different bug)", () => {
        expect(tags("cmd | tail; echo done; echo $?")).toEqual([]);
        expect(tags("cmd | tail\nls\necho $?")).toEqual([]);
    });

    it("when $? comes before the pipeline", () => {
        expect(tags("echo $?; cmd | tail")).toEqual([]);
        expect(tags('echo "--- exit code from previous: $? ---"; tail -n 500 x.log | rg -i "rate"')).toEqual([]);
    });

    it("when the pipeline is a command substitution (the $? belongs to the outer command)", () => {
        expect(tags("x=$(cmd | tail -1); echo $?")).toEqual([]);
        expect(tags('echo "last: $(git log --oneline | head -1)"; echo $?')).toEqual([]);
        expect(tags("for f in $(ls | head -3); do echo $f; done; echo $?")).toEqual([]);
    });

    it("when the pipeline is a process substitution", () => {
        expect(tags("diff <(a | sort) <(b | sort); echo $?")).toEqual([]);
        expect(tags("while read l; do echo $l; done < <(cmd | head); echo $?")).toEqual([]);
    });

    it("when a backtick substitution holds the pipeline", () => {
        expect(tags("x=`cmd | tail -1`; echo $?")).toEqual([]);
    });

    it("when $? is only text", () => {
        expect(tags("cmd | tail; echo 'exit=$?'")).toEqual([]);
        expect(tags("cmd | tail; echo \\$?")).toEqual([]);
        expect(tags("cmd | tail # echo $?")).toEqual([]);
        expect(tags("cmd | tail\n# echo $?")).toEqual([]);
        expect(tags('git commit -m "cmd | tail; echo $?"')).toEqual([]);
        expect(tags("cat <<'EOF'\ncmd | tail; echo $?\nEOF")).toEqual([]);
        expect(tags("cat > run.sh <<'EOF'\ncmd | tail\necho $?\nEOF")).toEqual([]);
    });

    it("when the pipe is inside a string", () => {
        expect(tags('echo "a | tail"; echo $?')).toEqual([]);
        expect(tags("bun -e 'const s = \"a | b\"'; echo $?")).toEqual([]);
        expect(tags("rg 'foo|bar' src; echo $?")).toEqual([]);
    });

    it("when || is the only pipe-looking operator", () => {
        expect(tags("cmd || tail -1 x; echo $?")).toEqual([]);
    });

    it("when the pipeline is inside a bun -e script string", () => {
        const command = `bun -e '
const out = await $\`ls | head\`;
console.log(out);
'; echo $?`;

        expect(tags(command)).toEqual([]);
    });
});

describe("exit-code-after-pipeline-checked: a later existence check of the same path turns the block into context", () => {
    const remove = 'git worktree remove /tmp/wt/pr-1 2>&1 | tail -2; echo "remove exit=$?"';

    it("notes, without blocking, a read that a later git worktree list | rg re-checks", () => {
        const command = `${remove}; git worktree list | rg pr-1 || echo gone`;
        const v = violation(command, CHECKED);

        expect(tags(command)).toEqual([`${CHECKED}:context`]);
        expect(v?.matched).toBe("git worktree remove /tmp/wt/pr-1 2>&1 | tail -2");
        expect(v?.suggestion).toBe(
            '(set -o pipefail; git worktree remove /tmp/wt/pr-1 2>&1 | tail -2); echo "remove exit=$?"; git worktree list | rg pr-1 || echo gone'
        );
        expect(tags(v?.suggestion as string)).toEqual([]);
    });

    it("accepts every existence check, with the checked name quoted or not", () => {
        for (const check of [
            "git worktree list | grep -c pr-1",
            "git -C /repo worktree list | rg 'pr-1'",
            "git worktree list | rg 'wt/pr-1$'",
            "[ -d /tmp/wt/pr-1 ] && echo still there",
            "[ -e /tmp/wt/pr-1 ]",
            "test -f /tmp/wt/pr-1/.git",
            "ls -d /tmp/wt/pr-1",
        ]) {
            expect(tags(`${remove}; ${check}`)).toEqual([`${CHECKED}:context`]);
        }
    });

    it("reads a quoted path on the pipeline side, and a command word that changes the path", () => {
        for (const command of [
            'git worktree remove "/tmp/wt/pr-1" 2>&1 | tail -2; echo "exit=$?"; git worktree list | rg pr-1',
            "git worktree remove '/tmp/wt/pr-1' 2>&1 | tail -2; echo \"exit=$?\"; [ -d /tmp/wt/pr-1 ]",
            "rm -rf /tmp/wt/pr-1 2>&1 | tail -1; echo $?; ls /tmp/wt/pr-1",
            // A one-letter option after the verb is a flag.
            "git worktree remove -f /tmp/wt/pr-1 2>&1 | tail -2; echo $?; git worktree list | rg pr-1",
            "mkdir -p /tmp/x/out 2>&1 | head -1; echo $?; [ -d /tmp/x/out ]",
        ]) {
            expect(tags(command)).toEqual([`${CHECKED}:context`]);
        }
    });

    it("still blocks when the first element only reads the path, or the check names another path", () => {
        for (const command of [
            // Logged: the diff reads the folder, and ls shows the folder, not whether the diff worked.
            'git diff --stat daab7a248..HEAD -- database/migrations database/schema | cat; echo "rc=$?"; ls database/schema 2>&1 | head',
            'bun test src/utils/shell 2>&1 | tail -5; echo "exit=$?"; ls src/utils/shell',
            "git rebase origin/master 2>&1 | tail -3; echo rc=$?; git worktree list | rg master",
            // A whole name, not a part of one.
            'git worktree remove /tmp/wt/pr-6 2>&1 | tail -2; echo "exit=$?"; git worktree list | rg pr-629',
            "git worktree remove /tmp/wt/a 2>&1 | tail -2; echo rc=$?; git worktree list | rg main",
            // The name sits only in a redirect target of the check.
            "git worktree remove /tmp/wt/pr-1 2>&1 | tail -2; echo $?; ls /tmp 2>/tmp/pr-1.err",
            "git worktree remove /tmp/wt/pr-1 2>&1 | tail -2; echo $?; ls /tmp 2> /tmp/wt/pr-1",
        ]) {
            expect(violation(command, CHECKED)).toBeUndefined();
            expect(blocks(command)).toContain(PIPE);
        }
    });

    it("the logged shapes: a removal and a lock release, each re-checked by git worktree list", () => {
        expect(
            tags(
                'git -C /tmp/wt/pr-9 status --short | head -3; git worktree remove /tmp/wt/pr-9 2>&1 | tail -2; echo "remove exit=$?"; git worktree list | rg \'pr-9\' || echo "pr-9 worktree gone"'
            )
        ).toEqual([`${CHECKED}:context`]);
        expect(
            tags(
                "bun hooks/worktree-lock.ts release /tmp/wt/pr-7 --session 0000-test 2>&1 | tail -3; echo rc=$?; git worktree list | rg -c pr-7; date '+%H:%M'"
            )
        ).toEqual([`${CHECKED}:context`]);
    });

    it("still blocks without a later check, or with a check that comes before the read", () => {
        expect(tags(remove)).toEqual([`${PIPE}:block`]);
        expect(tags(`ls /tmp/wt/pr-1; ${remove}`)).toEqual([`${PIPE}:block`]);
        expect(tags(`${remove}; git worktree list | rg pr-2`)).toEqual([`${PIPE}:block`]);
        expect(tags(`${remove}; [ -n /tmp/wt/pr-1 ]`)).toEqual([`${PIPE}:block`]);
        expect(tags(`${remove}; git branch | rg pr-1`)).toEqual([`${PIPE}:block`]);
    });

    it("still blocks when the path is no positional path argument of the first element", () => {
        // An env-assignment prefix (the logged crash-fixture shape): ls checks the crash log, not the status.
        expect(
            blocks(
                'S=/tmp/s; GENESIS_TOOLS_HOME=$S/crash-home bun -e "throw new Error(1)" 2>&1 | head -15; echo rc=$?; ls -R $S/crash-home'
            )
        ).toContain(PIPE);
        // A flag value, text inside a -e or -c code string, a redirect target, a word without a slash.
        for (const command of [
            "git -C /tmp/wt/pr-1 worktree prune | head -3; echo $?; ls /tmp/wt/pr-1",
            "bun x.ts remove -e \"rm('/tmp/wt/pr-1')\" | tail -1; echo $?; ls /tmp/wt/pr-1",
            "sh -c 'rm -rf /tmp/wt/pr-1' | tail -1; echo $?; [ -e /tmp/wt/pr-1 ]",
            "cmd remove > /tmp/wt/pr-1 | tail -1; echo $?; ls /tmp/wt/pr-1",
            "tools x release pr-1 2>&1 | tail -2; echo $?; git worktree list | rg pr-1",
        ]) {
            expect(violation(command, CHECKED)).toBeUndefined();
            expect(blocks(command)).toContain(PIPE);
        }
    });

    it("a re-checked read does not hide a later unchecked misread, which blocks alone", () => {
        const command = `${remove}; git worktree list | rg pr-1; bun test 2>&1 | tail -3; echo $?`;

        expect(tags(command)).toEqual([`${PIPE}:block`]);
        expect(violation(command, PIPE)?.matched).toBe("bun test 2>&1 | tail -3");
    });
});

describe("pipestatus-index-mismatch: $pipestatus[N] right after a pipeline points at another element", () => {
    const biome = "git diff --name-only | rg '\\.ts$' | xargs bunx biome check 2>&1 | tail -3";

    it("notes a label that names another element, and corrects the index to that element", () => {
        const command = `${biome}; echo biome=$pipestatus[2]`;
        const v = violation(command, INDEX);

        expect(tags(command)).toEqual([`${INDEX}:context`]);
        expect(v?.index).toBe(0);
        expect(v?.matched).toBe(`${biome}; echo biome=$pipestatus[2]`);
        expect(v?.suggestion).toBe(`${biome}; echo biome=$pipestatus[3]`);
        expect(tags(v?.suggestion as string)).toEqual([]);
    });

    it("reads the label inside double quotes, in an assignment, and in the brace spelling", () => {
        expect(violation('tsgo --noEmit 2>&1 | rg error | head; echo "tsgo=$pipestatus[2]"', INDEX)?.suggestion).toBe(
            'tsgo --noEmit 2>&1 | rg error | head; echo "tsgo=$pipestatus[1]"'
        );
        expect(violation("cmd | xargs biome check | tail; biome=${pipestatus[1]}", INDEX)?.suggestion).toBe(
            "cmd | xargs biome check | tail; biome=${pipestatus[2]}"
        );
        expect(violation('a | b; echo "a=$pipestatus[1] b=$pipestatus[1]"', INDEX)?.suggestion).toBe(
            'a | b; echo "a=$pipestatus[1] b=$pipestatus[2]"'
        );
    });

    it("corrects every wrong read of one statement in one corrected command", () => {
        const command = 'a | xargs b | tail; echo "a=$pipestatus[2] b=$pipestatus[1]"';
        const v = violation(command, INDEX);

        expect(v?.matched).toBe('a | xargs b | tail; echo "a=$pipestatus[2] b=$pipestatus[1]');
        expect(v?.suggestion).toBe('a | xargs b | tail; echo "a=$pipestatus[1] b=$pipestatus[2]"');
        expect(tags(v?.suggestion as string)).toEqual([]);
        // One read has no single element to point at, so no corrected command at all.
        expect(tags('a | xargs b | tail; echo "b=$pipestatus[1] rc=$pipestatus[5]"')).toEqual([`${INDEX}:context`]);
        expect(violation('a | xargs b | tail; echo "b=$pipestatus[1] rc=$pipestatus[5]"', INDEX)?.suggestion).toBe(
            undefined
        );
    });

    it("sees the command word past a wrapper's quoted option value", () => {
        for (const command of [
            "a | env -u 'X' tail -3; echo $pipestatus[2]",
            "a | xargs -I '{}' tail -1 {}; echo $pipestatus[2]",
        ]) {
            expect(tags(command)).toEqual([`${INDEX}:context`]);
        }
    });

    it("reads a pipeline inside a subshell or a brace group as nothing it can count", () => {
        // After a group, $pipestatus holds the group's status, and the group can itself be an element:
        // `false | (exit 5 | true)` has two.
        for (const command of [
            "(rg x src | xargs biome check | tail -3); echo biome=$pipestatus[1]",
            "{ rg x src | xargs biome check | tail -3; }; echo biome=$pipestatus[1]",
            "cd wt && (rg x src | xargs biome check | tail -3); echo biome=$pipestatus[1]",
            "(a | b | c); echo $pipestatus[3]",
            "false | (exit 5 | true); echo $pipestatus[2]",
            "zsh -c '(a | b | c); echo $pipestatus[3]'",
        ]) {
            expect(violation(command, INDEX)).toBeUndefined();
        }

        // A subshell that opens before the read inherits the pipeline's statuses.
        expect(violation("a | xargs biome check | tail; (echo biome=$pipestatus[1])", INDEX)?.suggestion).toBe(
            "a | xargs biome check | tail; (echo biome=$pipestatus[2])"
        );
        // A paren in a quoted or substituted last argument closes no group.
        expect(tags("a | rg 'x)'; echo $pipestatus[3]")).toEqual([`${INDEX}:context`]);
        expect(tags("a | rg $(cat p); echo $pipestatus[3]")).toEqual([`${INDEX}:context`]);
    });

    it("notes an index past the last element or below 1, which expands to nothing", () => {
        for (const command of [
            'a | b; echo "rc=$pipestatus[3]"',
            "a | b; echo ${pipestatus[3]}",
            "a | b; echo $pipestatus[0]",
        ]) {
            expect(tags(command)).toEqual([`${INDEX}:context`]);
            expect(violation(command, INDEX)?.suggestion).toBeUndefined();
        }
    });

    it("notes an index that points at a filter that exits 0", () => {
        expect(tags("cmd | tail -3; echo $pipestatus[2]")).toEqual([`${INDEX}:context`]);
        expect(tags("a | sort | rg x; echo rc=$pipestatus[2]")).toEqual([`${INDEX}:context`]);
    });

    it("stays silent for the right element, a whole-array read, or a label that names no element", () => {
        for (const command of [
            "cmd | tail; echo $pipestatus[1]",
            "cat x.log | rg err; echo $pipestatus[1]",
            "a | b | c; echo ${pipestatus[*]}",
            'a | b | c; echo "$pipestatus[@]"',
            "cmd | tail; echo $pipestatus[-1]",
            "bun test 2>&1 | tail -5; echo test=$pipestatus[1]",
            "git log | rg x | head; echo rg=$pipestatus[2]",
            "rg x a | rg y; echo rg=$pipestatus[2]",
            "a | rg x | tail; echo rc=$pipestatus[2]",
            // The label names element N itself, so the filter's status is what was asked for.
            "cmd | tee out.log | rg x; echo tee=$pipestatus[2]",
            // Element 1 is the source, and cat or head reading a file fails when it cannot read it.
            "cat build.log | rg error; echo rc=$pipestatus[1]",
            // Every status printed together reads nothing under a wrong name.
            'cmd | tail -3; echo "rc=$pipestatus[1] $pipestatus[2]"',
            "cmd | tail -3; echo $pipestatus[1] $pipestatus[2]",
        ]) {
            expect(tags(command)).toEqual([]);
        }
    });

    it("reads only the statement right after the pipeline, and only where zsh runs it", () => {
        expect(tags("a | b | tail; echo ok; echo $pipestatus[3]")).toEqual([]);
        expect(tags("bash -c 'a | b; echo $pipestatus[3]'")).toEqual([]);
        // The outer zsh expands a double-quoted body first, so the read is the outer shell's.
        expect(tags('zsh -c "a | b; echo $pipestatus[3]"')).toEqual([]);
        expect(tags("zsh -c 'a | b; echo $pipestatus[3]'")).toEqual([`${INDEX}:context`]);
    });
});

describe("pipefail is decided for each pipeline, in the shell and scope that runs it", () => {
    it("a -c body that turns pipefail on before its pipeline is silent", () => {
        expect(tags("zsh -c 'set -o pipefail; false | tail -1; echo \"rc=$?\"'")).toEqual([]);
        expect(tags("bash -c 'set -o pipefail; false | tail -1; echo \"rc=$?\"'")).toEqual([]);
        expect(tags("zsh -c 'set -o pipefail; cmd | grep x; echo $?'")).toEqual([]);
    });

    it("a -c body does not inherit the outer pipefail: it is a new shell", () => {
        expect(blocks("set -o pipefail; zsh -c 'cmd | tail; echo $?'")).toEqual([PIPE]);
    });

    it("a shell started with its own pipefail option runs its -c body under it", () => {
        for (const command of [
            "bash -o pipefail -c 'false | tail -1; echo \"rc=$?\"'",
            "bash -eo pipefail -c 'false | tail -1; echo \"rc=$?\"'",
            "zsh -o pipefail -c 'false | tail -1; echo \"rc=$?\"'",
            "zsh -o PIPE_FAIL -c 'false | tail -1; echo \"rc=$?\"'",
            "zsh --pipefail -c 'false | tail -1; echo \"rc=$?\"'",
            "zsh --pipe-fail -c 'false | tail -1; echo \"rc=$?\"'",
            "env X=1 bash -o errexit -o pipefail -c 'false | tail -1; echo \"rc=$?\"'",
            "bash -o pipefail -c 'cmd | grep x; echo $?'",
        ]) {
            expect(tags(command)).toEqual([]);
        }
    });

    it("a shell started with pipefail turned off, or with another option, does not", () => {
        for (const command of [
            "bash +o pipefail -c 'false | tail -1; echo \"rc=$?\"'",
            "zsh --no-pipefail -c 'false | tail -1; echo \"rc=$?\"'",
            "bash -o pipefail +o pipefail -c 'false | tail -1; echo \"rc=$?\"'",
            "bash -o errexit -c 'false | tail -1; echo \"rc=$?\"'",
        ]) {
            expect(blocks(command)).toEqual([PIPE]);
        }
    });

    it("a heredoc fed to a shell is a new shell: pipefail neither leaks out of it nor into it", () => {
        const leaksOut = "bash <<'E'\nset -o pipefail\ntrue | tail -1\nE\nfalse | tail -1; echo \"rc=$?\"";

        expect(blocks(leaksOut)).toEqual([PIPE]);
        expect(violation(leaksOut, PIPE)?.matched).toBe("false | tail -1");
        expect(blocks("set -o pipefail\nbash <<'E'\ncmd | tail\necho $?\nE")).toEqual([PIPE]);
        expect(tags("bash <<'E'\nset -o pipefail\ncmd | tail\necho $?\nE")).toEqual([]);
        expect(tags("bash -o pipefail <<'E'\ncmd | tail\necho $?\nE")).toEqual([]);
        // The `)` of a case pattern in the body does not close the outer subshell.
        expect(tags("(set -o pipefail\nbash <<'E'\ncase $1 in a) echo a;; esac\nE\ncmd | tail; echo $?)")).toEqual([]);
    });

    it("a heredoc fed to a program is data, so a pipefail in it counts for nothing", () => {
        expect(blocks("cat <<'E'\nset -o pipefail\nE\ncmd | tail; echo $?")).toEqual([PIPE]);
    });

    it("a pipefail scoped to a closed subshell does not cover a later pipeline", () => {
        const command = '(set -o pipefail; true | tail -1); false | tail -1; echo "rc=$?"';

        expect(blocks(command)).toEqual([PIPE]);
        expect(violation(command, PIPE)?.matched).toBe("false | tail -1");
        expect(tags('(set -o pipefail; true | grep x); cmd | grep y; echo "rc=$?"')).toEqual([`${GREP}:context`]);
        expect(blocks("zsh -c '(set -o pipefail; true | tail -1); false | tail -1; echo \"rc=$?\"'")).toEqual([PIPE]);
    });

    it("a pipefail set after the pipeline does not cover it", () => {
        const command = 'bun a.ts 2>&1 | tail -5; echo "a=$?"; (set -o pipefail; bun b.ts | tail -1); echo "b=$?"';

        expect(blocks(command)).toEqual([PIPE]);
        expect(violation(command, PIPE)?.matched).toBe("bun a.ts 2>&1 | tail -5");
    });

    it("turning pipefail off again ends the exemption", () => {
        expect(blocks("set +o pipefail; false | tail -1; echo $?")).toEqual([PIPE]);
        expect(blocks("set -o pipefail; set +o pipefail; cmd | tail; echo $?")).toEqual([PIPE]);
        expect(blocks("setopt pipefail; unsetopt pipefail; cmd | tail; echo $?")).toEqual([PIPE]);
        expect(blocks("set -o pipefail; setopt no_pipe_fail; cmd | tail; echo $?")).toEqual([PIPE]);
    });

    it("every spelling that turns it on counts", () => {
        expect(tags("set -euo pipefail; cmd | tail; echo $?")).toEqual([]);
        expect(tags("set -o errexit -o pipefail; cmd | tail; echo $?")).toEqual([]);
        expect(tags("setopt PIPE_FAIL; cmd | tail; echo $?")).toEqual([]);
        expect(tags("unsetopt nopipefail; cmd | tail; echo $?")).toEqual([]);
        expect(tags("{ set -o pipefail; }; cmd | tail; echo $?")).toEqual([]);
    });

    it("a command substitution inherits the setting before it, and its own setting stays inside", () => {
        expect(tags("set -o pipefail; x=$(cmd | tail -1; echo $?); echo $x")).toEqual([]);
        expect(tags("set -o pipefail; x=`cmd | tail -1; echo $?`; echo $x")).toEqual([]);
        expect(blocks("x=$(cmd | tail -1; echo $?); echo $x")).toEqual([PIPE]);
        expect(blocks("x=$(set -o pipefail; true); cmd | tail; echo $?")).toEqual([PIPE]);
    });

    it("the pipefail correction itself stays silent, also inside a -c body", () => {
        expect(tags('(set -o pipefail; cmd | tail -1); echo "rc=$?"')).toEqual([]);
        expect(tags("zsh -c '(set -o pipefail; cmd | tail -1); echo \"rc=$?\"'")).toEqual([]);
    });
});

describe("exit-code-after-pipeline: heredocs fed to a shell are code", () => {
    it("blocks inside a bash heredoc", () => {
        const command = `bash <<'BASH'
cd /tmp/x
bun run check 2>&1 | tail -10
echo "exit=$?"
BASH`;

        expect(blocks(command)).toEqual([PIPE]);
    });

    it("blocks inside a zsh heredoc", () => {
        expect(blocks("zsh <<'Z'\ncmd | tail\necho $?\nZ")).toEqual([PIPE]);
    });

    it("does not scan a heredoc fed to a non-shell", () => {
        expect(tags("bun cli.ts <<'SPEC'\ncmd | tail\necho $?\nSPEC")).toEqual([]);
        expect(tags("python3 - <<'PY'\nimport os\n# cmd | tail; echo $?\nPY")).toEqual([]);
    });

    it("scans the rest of the line after a heredoc operator", () => {
        expect(blocks("bun cli.ts <<'SPEC' 2>&1 | tail -3; echo \"rc=$?\"\n@@ f\nSPEC")).toEqual([PIPE]);
    });
});

describe("exit-code-after-pipeline: the escapes the shell around a body removes come off first", () => {
    it("reads the escaped $? of a body nested in a double-quoted body as the inner shell's", () => {
        expect(violation(`zsh -c "bash -c 'false | tail -1; echo \\$?'"`, PIPE)).toMatchObject({
            matched: "false | tail -1",
            suggestion: `zsh -c "bash -c '(set -o pipefail; false | tail -1); echo \\$?'"`,
        });

        const escaped = String.raw`zsh -c "bash -c \"false | tail -1; echo \\\$?\""`;
        expect(violation(escaped, PIPE)).toMatchObject({
            matched: "false | tail -1",
            suggestion: String.raw`zsh -c "bash -c \"(set -o pipefail; false | tail -1); echo \\\$?\""`,
        });
    });

    it("reads an escaped $? in an unquoted heredoc a shell reads as that shell's, and a bare $? as the outer one's", () => {
        expect(violation("bash <<EOF\nfalse | tail -1; echo \\$?\nEOF", PIPE)).toMatchObject({
            matched: "false | tail -1",
            suggestion: "bash <<EOF\n(set -o pipefail; false | tail -1); echo \\$?\nEOF",
        });
        expect(violation('zsh <<EOF\ncmd | tail -1\necho "rc=\\$?"\nEOF', PIPE)?.matched).toBe("cmd | tail -1");
        expect(violation("bash <<EOF\nfalse | tail -1; echo $?\nEOF", PIPE)).toBeUndefined();
    });

    it("leaves single-quoted bodies and quoted heredocs as typed", () => {
        expect(violation("bash -c 'false | tail -1; echo \\$?'", PIPE)).toBeUndefined();
        expect(violation("bash <<'EOF'\nfalse | tail -1; echo \\$?\nEOF", PIPE)).toBeUndefined();
        expect(violation("cat <<EOF\nfalse | tail -1; echo \\$?\nEOF", PIPE)).toBeUndefined();
        expect(violation(`zsh -c 'bash -c "false | tail -1; echo \\$?"'`, PIPE)?.matched).toBe("false | tail -1");
    });

    // Each shape was run in zsh 5.9 with a known status before it: the shell that expands the `$?` is the one the
    // comment names.
    it("leaves a $? that a shell around a nested body expands to that shell", () => {
        for (const command of [
            // zsh -c expands it inside its own double quotes, so bash reads a number.
            String.raw`zsh -c "bash -c \"false | tail -1; echo \$?\""`,
            String.raw`zsh -c "bash -c \"false | tail -1; echo \\\\\$?\""`,
            // The outer zsh expands it: the single quotes are text inside its double quotes.
            `zsh -c "bash -c 'false | tail -1; echo $?'"`,
            // The outer zsh expands it before bash runs the escaped backticks.
            'bash -c "x=\\`false | tail -1; echo $?\\`"',
            // The outer zsh expands the heredoc, single quotes and all.
            "bash <<EOF\nzsh -c 'false | tail -1; echo $?'\nEOF",
            // bash expands it inside the double quotes of its own line.
            'bash <<EOF\nzsh -c "false | tail -1; echo \\$?"\nEOF',
            // bash -c expands the heredoc it feeds to the inner bash.
            'bash -c "bash <<EOF\nfalse | tail -1; echo \\$?\nEOF"',
            // A heredoc inside a heredoc: the middle bash expands the inner one.
            "bash <<'A'\nbash <<B\nfalse | tail -1; echo $?\nB\nA",
        ]) {
            expect([command, violation(command, PIPE)]).toEqual([command, undefined]);
        }
    });

    it("reads a $? that every shell around a nested body leaves escaped as the nested body's own", () => {
        for (const [command, suggestion] of [
            [
                String.raw`zsh -c "bash -c \"false | tail -1; echo \\\$?\""`,
                String.raw`zsh -c "bash -c \"(set -o pipefail; false | tail -1); echo \\\$?\""`,
            ],
            [
                'bash -c "x=\\`false | tail -1; echo \\$?\\`"',
                'bash -c "x=\\`(set -o pipefail; false | tail -1); echo \\$?\\`"',
            ],
            [
                'bash <<EOF\nzsh -c "false | tail -1; echo \\\\\\$?"\nEOF',
                'bash <<EOF\nzsh -c "(set -o pipefail; false | tail -1); echo \\\\\\$?"\nEOF',
            ],
            [
                "bash <<EOF\nzsh -c 'false | tail -1; echo \\$?'\nEOF",
                "bash <<EOF\nzsh -c '(set -o pipefail; false | tail -1); echo \\$?'\nEOF",
            ],
            [
                'bash -c "bash <<EOF\nfalse | tail -1; echo \\\\\\$?\nEOF"',
                'bash -c "bash <<EOF\n(set -o pipefail; false | tail -1); echo \\\\\\$?\nEOF"',
            ],
            [
                "bash <<'A'\nbash <<B\nfalse | tail -1; echo \\$?\nB\nA",
                "bash <<'A'\nbash <<B\n(set -o pipefail; false | tail -1); echo \\$?\nB\nA",
            ],
        ]) {
            expect([command, violation(command, PIPE)?.suggestion]).toEqual([command, suggestion]);
        }
    });

    it("reads a $(...) or backtick body the shell around runs with its own escapes, not the body's", () => {
        // The outer zsh runs the $(...), where \$ is a literal `$`: bash later reads its own status.
        expect(violation("bash <<EOF\necho $(false | tail -1; echo \\$?)\nEOF", PIPE)).toBeUndefined();
        expect(violation('bash -c "echo $(false | tail -1; echo \\$?)"', PIPE)).toBeUndefined();
        expect(violation("bash <<EOF\nx=\\\\$(false | tail -1; echo \\$?)\nEOF", PIPE)).toBeUndefined();
        // In backticks `\\` is one backslash, and `\$?` is then a literal.
        expect(violation("x=`false | tail -1; echo \\\\$?`; echo $x", PIPE)).toBeUndefined();
        expect(violation('echo "`false | tail -1; echo \\\\$?`"', PIPE)).toBeUndefined();
        // The escaped `\$(` is bash's own substitution, which reads the pipeline's status.
        expect(violation("bash <<EOF\necho \\$(false | tail -1; echo \\$?)\nEOF", PIPE)).toMatchObject({
            matched: "false | tail -1",
            suggestion: "bash <<EOF\necho \\$( (set -o pipefail; false | tail -1); echo \\$?)\nEOF",
        });
        expect(violation("x=`false | tail -1; echo \\$?`; echo $x", PIPE)?.matched).toBe("false | tail -1");
    });
});

// ---------------------------------------------------------------------------
// pipestatus-under-zsh: `${PIPESTATUS[0]}` under the zsh-backed Bash tool
// ---------------------------------------------------------------------------

describe("pipestatus-under-zsh", () => {
    it("blocks ${PIPESTATUS[0]}", () => {
        expect(tags('cmd 2>&1 | tail -3; echo "exit=${PIPESTATUS[0]}"')).toEqual([`${ZSH}:block`]);
    });

    it("blocks the corpus tee shape", () => {
        expect(tags('python check.py 2>&1 | tee /tmp/x.log; echo "EXIT=${PIPESTATUS[0]}" >> /tmp/x.log')).toEqual([
            `${ZSH}:block`,
        ]);
    });

    it("blocks the defaulted form, which silently falls back to $?", () => {
        expect(tags('rsync a b 2>&1 | tail -2\necho "rsync exit: ${PIPESTATUS[0]:-$?}"')).toEqual([`${ZSH}:block`]);
    });

    it("blocks $PIPESTATUS and ${PIPESTATUS[*]}", () => {
        expect(tags("cmd | tail; echo $PIPESTATUS")).toEqual([`${ZSH}:block`]);
        expect(tags("cmd | tail; echo ${PIPESTATUS[*]}")).toEqual([`${ZSH}:block`]);
    });

    it("blocks even with pipefail set (pipefail does not define PIPESTATUS)", () => {
        expect(tags('set -o pipefail\ncmd | tail -12; echo "exit: ${PIPESTATUS[0]}"')).toEqual([`${ZSH}:block`]);
    });

    it("rewrites the index to the 1-based zsh spelling in the suggestion", () => {
        expect(violation('cmd | tail; echo "exit=${PIPESTATUS[0]}"', ZSH)?.suggestion).toBe(
            'cmd | tail; echo "exit=${pipestatus[1]}"'
        );
        expect(violation("a | b | c; echo ${PIPESTATUS[2]}", ZSH)?.suggestion).toBe("a | b | c; echo ${pipestatus[3]}");
        expect(violation("cmd | tail; echo ${PIPESTATUS[*]}", ZSH)?.suggestion).toBe(
            "cmd | tail; echo ${pipestatus[*]}"
        );
        expect(violation("cmd | tail; echo $PIPESTATUS", ZSH)?.suggestion).toBe("cmd | tail; echo ${pipestatus[1]}");
    });

    it("matched is the exact expansion at its offset", () => {
        const command = 'x | tee /tmp/l; echo "rc=${PIPESTATUS[0]}"';
        const v = violation(command, ZSH);

        expect(v?.matched).toBe("${PIPESTATUS[0]}");
        expect(v?.index).toBe(command.indexOf("${PIPESTATUS"));
    });

    it("does not fire on the zsh spelling", () => {
        expect(tags("cmd | tail; echo $pipestatus[1]")).toEqual([]);
        expect(tags('cmd | tail; echo "rc=${pipestatus[1]}"')).toEqual([]);
    });

    it("does not fire when bash runs the command", () => {
        expect(tags('bash -c "cmd | tail; echo ${PIPESTATUS[0]}"')).toEqual([]);
        expect(tags("bash <<'B'\ncmd | tail\necho ${PIPESTATUS[0]}\nB")).toEqual([]);
        expect(tags("bash script.sh; echo ${PIPESTATUS[0]}")).toEqual([]);
        expect(tags("sh -c 'x'; echo ${PIPESTATUS[0]}")).toEqual([]);
    });

    it("does not fire when PIPESTATUS is only text", () => {
        expect(tags("echo '${PIPESTATUS[0]}'")).toEqual([]);
        expect(tags("cat > x.sh <<'S'\n#!/bin/bash\ncmd | tail; echo ${PIPESTATUS[0]}\nS")).toEqual([]);
        expect(tags("# echo ${PIPESTATUS[0]}\nls")).toEqual([]);
        expect(tags("rg PIPESTATUS src")).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Combinations, ordering, one violation per rule
// ---------------------------------------------------------------------------

describe("combinations", () => {
    it("returns blocks before context", () => {
        expect(tags('rg -n foo 2>/dev/null | head -5; echo "--- exit $? ---"')).toEqual([
            `${PIPE}:block`,
            "stderr-discarded-then-read:context",
        ]);
    });

    it("returns one violation per rule, ordered by index within a severity", () => {
        const command = "a | tail; echo $?\nb | head; echo $?\nls x 2>/dev/null | wc -l; ls y 2>/dev/null | wc -l";

        expect(tags(command)).toEqual([`${PIPE}:block`, "stderr-discarded-then-counted:block"]);
    });

    it("keeps the first match of a rule", () => {
        const command = "first | tail; echo $?\nsecond | head; echo $?";

        expect(violation(command, PIPE)?.matched).toBe("first | tail");
    });

    it("matched is the raw statement, and rendering keeps every character of it", () => {
        expect(violation("cmd   |   tail\t-3; echo $?", PIPE)?.matched).toBe("cmd   |   tail\t-3");

        const long = `cmd ${"--flag ".repeat(40)}| tail; echo $?`;
        const v = violation(long, PIPE);

        expect(v?.matched.length).toBeGreaterThan(200);
        expect(renderViolation(v as ShellViolation)).toContain(`matched (offset 0): ${v?.matched}`);
    });

    it("finds a block inside a substitution and context outside it", () => {
        const command = 'echo "n=$(ls a 2>/dev/null | wc -l)"; ls b 2>/dev/null | head';

        expect(tags(command)).toEqual(["stderr-discarded-then-counted:block", "stderr-discarded-then-read:context"]);
    });

    it("reports the pipeline rule and the PIPESTATUS rule together when both shapes appear", () => {
        const command = 'a | tail; echo $?\nb | tail; echo "${PIPESTATUS[0]}"';

        expect(tags(command)).toEqual([`${PIPE}:block`, `${ZSH}:block`]);
    });
});

// ---------------------------------------------------------------------------
// Robustness: never throw, stay fast
// ---------------------------------------------------------------------------

describe("robustness", () => {
    it("handles empty and whitespace input", () => {
        expect(tags("")).toEqual([]);
        expect(tags("   \n\t\n")).toEqual([]);
    });

    it("handles unbalanced quotes, parens and heredocs", () => {
        expect(() => detectShellViolations("echo 'oops | tail; echo $?")).not.toThrow();
        expect(() => detectShellViolations('echo "oops | tail; echo $?')).not.toThrow();
        expect(() => detectShellViolations("echo $(cmd | tail; echo $?")).not.toThrow();
        expect(() => detectShellViolations("cat <<EOF\ncmd | tail; echo $?")).not.toThrow();
        expect(() => detectShellViolations(")))((( | tail ; echo $?")).not.toThrow();
        expect(() => detectShellViolations("$(((( 1 | 2")).not.toThrow();
    });

    it("still finds the bug in an unbalanced double quote", () => {
        expect(tags('cmd | tail; echo "exit=$?')).toEqual([`${PIPE}:block`]);
    });

    it("scans deeply nested substitutions", () => {
        let command = "cmd | tail; echo $?";

        for (let i = 0; i < 30; i++) {
            command = `echo "$(${command})"`;
        }

        expect(() => detectShellViolations(command)).not.toThrow();
        expect(blocks(command)).toEqual([PIPE]);
    });
});

// ---------------------------------------------------------------------------
// Corpus fixtures: real Bash tool calls from Claude Code transcripts (paths
// shortened). Each pins the verdict the corpus review settled on.
// ---------------------------------------------------------------------------

describe("corpus fixtures that must fire", () => {
    const cases: Array<[string, string[]]> = [
        ['bash scripts/ci/placeholder-check.sh 2>&1 | tail -10; echo "placeholder-exit=$?"', [`${PIPE}:block`]],
        [
            'cd wt && echo "=== remaining ===" && grep -rn "dev.foltyn" --include="*" . 2>&1 | grep -v node_modules | head -30; echo "=== exit $? ==="',
            [`${PIPE}:block`],
        ],
        ['bunx tsc --noEmit 2>&1 | tail -3; echo "tsc exit=$?"; bun run build 2>&1 | tail -2', [`${PIPE}:block`]],
        ['timeout 40 bun run tools claude list 2>&1 | tail -8; echo "exit: $?"', [`${PIPE}:block`]],
        [
            'xcrun simctl spawn UDID log show --last 90m 2>/dev/null | rg -N "E2E|Injected" | tail -8; echo "exit: $?"',
            [`${PIPE}:block`, "stderr-discarded-then-read:context"],
        ],
        ['pgrep -lf "appium" | grep -v "appium-mcp" | cut -c1-140; echo "--- (exit $?)"', [`${PIPE}:block`]],
        [
            'cd repo && : > /tmp/b.log && (bun run start:debug 2>&1 | tee /tmp/b.log; echo "EXIT:$?" >> /tmp/b.log)',
            [`${PIPE}:block`],
        ],
        [
            'echo "=== doctor piped ==="; tools doctor 2>&1 | cat | head -20; echo "exit=$?"; echo "---"; tools port --help 2>&1 | cat | head -10',
            [`${PIPE}:block`],
        ],
        ['git worktree remove .worktrees/pr594 2>&1 | head -2; echo "pr594 exit=$?"', [`${PIPE}:block`]],
        [
            `cd repo
git checkout -b feat/x origin/master --no-track 2>&1 | tail -1
echo "=== cherry-pick ==="
git cherry-pick 2fd54fd23 1f21c97b3 2>&1 | tail -20
echo "EXIT=$?"`,
            [`${PIPE}:block`],
        ],
        [
            'cd wt && bunx biome check --write src >/dev/null 2>&1; bun run typecheck:all 2>&1 | tail -2; echo "typecheck:all EXIT=$?"; bun run test src/clarity/ 2>&1 | grep -E "^ *[0-9]+ (pass|fail)"; bunx biome check src >/dev/null 2>&1; echo "BIOME_EXIT=$?"',
            [`${PIPE}:block`],
        ],
        [
            'echo "=== stdout writers ==="; xargs rg --heading -n \'console\\.log\\(\' < /tmp/files.txt | head -40; echo "--- exit $? ---"',
            [`${PIPE}:block`],
        ],
        [
            'S=scripts/reconcile.ts\nbun $S --vendor src/x.ts --dry-run 2>&1 | head -4; echo "exit=${PIPESTATUS[0]}"',
            [`${ZSH}:block`],
        ],
        [
            'bun rohlik.ts alert --quiet 2>&1 | grep -E "^Alert|sent"; echo "exit=${PIPESTATUS[0]}"; tools say "Alert sent" --app claude',
            [`${ZSH}:block`],
        ],
        [
            'cd demo-tools && tsgo --noEmit 2>&1 | tee /tmp/demotools-tsgo.log | tail -30; echo "tsgo exit=${PIPESTATUS[0]}"',
            [`${ZSH}:block`],
        ],
        [
            'timeout 180 bun --bun src/youtube/index.ts extension build 2>&1 | tee /tmp/ext-build.log | tail -20\necho "EXIT: ${PIPESTATUS[0]}"',
            [`${ZSH}:block`],
        ],
        [
            'set -o pipefail\necho "=== peekaboo ==="\npeekaboo list --json-output 2>&1 | tools json 2>/dev/null | rg -i "error" | head -5\ntimeout 60 bun run src/control/index.ts capture preflight 2>&1 | tail -12; echo "exit: ${PIPESTATUS[0]}"',
            [`${ZSH}:block`, "stderr-discarded-then-read:context"],
        ],
        [
            "rg -n --pcre2 '\\x00' ~/.agents/skills/spotify/scripts/lib/*.ts 2>/dev/null | head -20; echo \"--- exit $? ---\"",
            [`${PIPE}:block`, "stderr-discarded-then-read:context"],
        ],
    ];

    for (const [command, expected] of cases) {
        it(`${expected.join(" + ")}: ${command.slice(0, 70).replace(/\n/g, "⏎")}`, () => {
            expect(tags(command)).toEqual(expected);
        });
    }
});

describe("corpus fixtures that must NOT fire", () => {
    const cases: string[] = [
        'cd repo; gh run watch 32243392511 --exit-status > /tmp/ci-312-r2.txt 2>&1; echo "CI exit=$?"; tail -6 /tmp/ci-312-r2.txt',
        'bun scripts/test.ts src/artifact/ 2>&1 | tail -3; tsgo --noEmit > /tmp/wt-tsgo.log 2>&1; echo "tsgo: $?"; rg error /tmp/wt-tsgo.log | head -3',
        '(date +%s > /tmp/pv-all.start; nohup bun port-verify.ts </dev/null >/tmp/pv-all.log 2>&1; echo "EXIT=$? END=$(date +%s)" >> /tmp/pv-all.log) & sleep 1; echo started',
        'cd /tmp && command codex app-server generate-json-schema > /tmp/schema.json 2>/tmp/schema.err; echo "EXIT=$?"; ls -la /tmp/schema.json; head -c 300 /tmp/schema.json; echo; echo "--- err ---"; head -5 /tmp/schema.err',
        '{ time graft build > /tmp/gp-coldbuild.log 2>&1 ; } 2>/tmp/gp-coldbuild-time.txt\necho "build exit: $?" >> /tmp/gp-coldbuild-time.txt\ncat /tmp/gp-coldbuild-time.txt',
        'grep -rn "unknown_self_test_case" Dev/ ; echo "exit=$?"; echo "--- positive control ---"; grep -rn "self-test" Dev/CaptureLab/rewind | head -5',
        'cd /tmp && swift test --package-path /repo > /tmp/swifttest.log 2>&1; echo "exit=$?"; tail -20 /tmp/swifttest.log',
        'M=/repo; ( cd "$M" && bun run lint:rules > /tmp/lint-rules.out 2>&1; echo "exit=$?" ); rg -v "^\\s*$" /tmp/lint-rules.out | tail -20',
        'gh run watch 34964619758 --exit-status > /tmp/head-dispatch.txt 2>&1; echo "EXIT=$?" >> /tmp/head-dispatch.txt',
        'gh run view 33881769522 --log-failed > /tmp/346-ci-fail.txt 2>&1; echo "exit=$? lines=$(wc -l < /tmp/346-ci-fail.txt)"; grep -n "(fail)" /tmp/346-ci-fail.txt | head -30',
        'cd repo && git push --force-with-lease=feat/bundlers:3413ebd origin feat/bundlers:refs/heads/feat/bundlers 2>&1; echo "EXIT=$?"',
        'timeout 60 env GENESIS_TOOLS_HOME="$SB" ./tools claude history "the" --limit 3 >/tmp/cold.out 2>/tmp/cold.err\nec=$?; end=$(date +%s)\necho "exit=$ec elapsed=$((end-start))s"\nhead -c 500 /tmp/cold.out',
        'for g in logging-guard ai-credentials-guard; do out=$(bash scripts/ci/$g.sh 2>&1); echo "$g exit=$?"; done',
        'bun invoices.ts --month 2026-02 --out /tmp/run3.json 2>/tmp/run3.err; echo "exit=$?"; tail -3 /tmp/run3.err',
        'cmd | tee /tmp/log; echo "rc=$pipestatus[1]"',
        'bunx tsc --noEmit >/tmp/u.log 2>&1; echo "utils tsc exit: $?"\nbunx tsc --noEmit >/tmp/o.log 2>&1; echo "obsidian tsc exit: $?"\necho "--- any output? ---"; cat /tmp/u.log /tmp/o.log',
        'bun check_traps_armed.ts; echo "rc=$?"\necho\necho "=== posture ==="\nbun check_trail_posture.ts; echo "rc=$?"',
        "SECONDS=0; until [ $SECONDS -ge 115 ]; do sleep 20; done; date -u '+%H:%M:%S UTC'",
        'git status --short | head -3\necho "on: $(git branch --show-current) @ $(git rev-parse --short HEAD)"\ngit log --oneline $(git merge-base HEAD origin/master)..HEAD | head -20\necho "  count: $(git rev-list --count $(git merge-base HEAD origin/master)..HEAD)"',
        'echo "count: $(pgrep -f \'Genesis.app/Contents/MacOS/Genesis\' | wc -l)"; pgrep -lf "Genesis" | head -5',
        "awk 'NR>12533 && /100002/{print NR}' $A | head -25\necho \"=== count after 12533 ===\"; awk 'NR>12533 && /100002/' $A | wc -l",
        'git ls-files packs | head -3; echo "--- tracked? ---"; git ls-files packs | wc -l',
        'ls -la ../../server/scripts/*.ts 2>&1 | head -20; echo "=== count ==="; ls ../../server/scripts/ | wc -l',
        "rg -l --fixed-strings \"Zayo\" ~/.grok/sessions --glob 'chat_history.jsonl' | sort | head -20\necho \"count: $(rg -l --fixed-strings 'Zayo' ~/.grok/sessions --glob 'chat_history.jsonl' | wc -l)\"",
        'cd repo && bun "/plugins/fable-replace/scripts/cli.ts" <<\'FRSPEC\'\n@@ src/chrome-devtools/lib/restart.ts\n<<<\nexport const X = /:\\/\\/profile-picker/i;\n===\nexport const X = /:\\/\\/profile-picker(\\/|\\?|#|$)/i;\n>>>\nFRSPEC\nbunx biome check --write src/chrome-devtools/ 2>&1 | tail -1\nbun tsgo --noEmit -p tsconfig.json; echo "TSGO_EXIT=$?"\nbun run test src/chrome-devtools 2>&1 | tail -5',
        "cat > /tmp/orphan-after/bun142-arm.sh <<'EOF'\n#!/bin/zsh\nfor i in 1 2 3; do\n  out=$(timeout 45 \"$B\" test --parallel=2 \"$f1\" 2>&1)\n  rc=$?\n  echo \"G$i rc=$rc :: $(printf '%s' \"$out\" | grep -E 'Ran [0-9]+ tests' || echo 'NO Ran LINE')\"\ndone\nEOF\nchmod +x /tmp/orphan-after/bun142-arm.sh",
        'echo "=== hooks ==="; ls ~/.claude/hooks 2>&1; echo "=== git ==="; git -C ~/x status --short 2>&1 | head -20',
        'kill -TERM "$p" 2>/dev/null && printf \'  TERM -> %s\\n\' "$p" || printf \'  %-6s already gone\\n\' "$p"',
        'git cat-file -e origin/feature/next:demo-mobile/x.ts 2>/dev/null && echo "EXISTS" || echo "NOT on feature/next"',
        "ps aux | grep -iE \"metro|expo start\" | grep -v grep | awk '{print $2, $11}' | head -10; echo ---; lsof -nP -iTCP:8081 -sTCP:LISTEN",
        "python3 - <<'EOF'\nimport pathlib\nn = 0\nfor f in pathlib.Path('.').glob('*.md'):\n    s = f.read_text()\n    if 'x' in s: n += 1\nprint('files changed:', n)\nEOF\necho \"=== recheck ===\"\nrg -o '\\[\\[([^\\]]+)\\]\\]' *.md | sort -u",
    ];

    for (const command of cases) {
        it(`silent: ${command.slice(0, 70).replace(/\n/g, "⏎")}`, () => {
            expect(tags(command)).toEqual([]);
        });
    }
});

// The grep verdict is deliberately soft. One of the corpus commands mixed a
// grep-exit intent with a heredoc run: pin that it stays context, so a future
// tightening of STATUS_AMBIGUOUS shows up here.
describe("corpus fixtures that must stay context", () => {
    it("`| rg` then $? with an explicit grep-exit label", () => {
        const command =
            'cd wt && bunx biome check --write src/x 2>&1 | tail -20 && bun test src/x/ 2>&1 | tail -10 && timeout 90 tsgo --noEmit 2>&1 | rg "dev-dashboard"; echo "grep-exit:$?"; bunx biome check src/x 2>&1 | tail -20';

        expect(tags(command)).toEqual([`${GREP}:context`]);
    });

    it("`| rg` then $? where 1 means clean", () => {
        const command =
            'rg -o \'(refresh_token|token)(=|%3D)[0-9a-f]{8}\' "evidence"/*.log; echo "(exit=$? ; 1 = clean)"\nfind "a" -type f -exec ls -l {} + | sort -k5 -rn | head -8';

        expect(tags(command)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Adversarial shapes: places a `$?` or a pipe can hide
// ---------------------------------------------------------------------------

describe("adversarial: $? in control flow after a pipeline", () => {
    it("if [ $? -ne 0 ]", () => {
        expect(blocks("cmd | tail\nif [ $? -ne 0 ]; then echo failed; fi")).toEqual([PIPE]);
    });

    it("[[ $? -eq 0 ]]", () => {
        expect(blocks("cmd | tail; [[ $? -eq 0 ]] && echo ok")).toEqual([PIPE]);
    });

    it("case $? in", () => {
        expect(blocks("cmd | tail\ncase $? in 0) echo ok;; *) echo bad;; esac")).toEqual([PIPE]);
    });

    it("return $? inside a function", () => {
        expect(blocks("f() { cmd | tail; return $?; }; f")).toEqual([PIPE]);
    });

    it("$? inside arithmetic", () => {
        expect(blocks("cmd | tail; total=$(( total + $? ))")).toEqual([PIPE]);
    });

    it("$? passed to another command", () => {
        expect(blocks('cmd | tail; tools say "exit $?" --app claude')).toEqual([PIPE]);
    });

    it("$? in a here-string", () => {
        expect(blocks('cmd | tail; cat <<< "rc=$?"')).toEqual([PIPE]);
    });
});

describe("adversarial: wrappers and paths on the last element", () => {
    const wrapped = [
        "sudo tail -3",
        "env tail -3",
        "command tail -3",
        "nohup tail -3",
        "time tail -3",
        "timeout 10 tail -3",
        "nice -n 10 tail -3",
        "xargs tail -3",
        "/usr/bin/tail -3",
        "/opt/homebrew/bin/gtail -3",
        "FOO=bar tail -3",
        "LC_ALL=C LANG=C sort",
    ];

    for (const last of wrapped) {
        const expected = last.includes("gtail") ? [] : [PIPE];

        it(`${expected.length ? "blocks" : "ignores"} \`cmd | ${last}; echo $?\``, () => {
            expect(blocks(`cmd | ${last}; echo $?`)).toEqual(expected);
        });
    }
});

describe("adversarial: pipes that are not pipelines", () => {
    it("a pipe inside a regex argument", () => {
        expect(tags("rg -n 'foo|bar' src; echo $?")).toEqual([]);
        expect(tags('rg -n "foo|bar" src; echo $?')).toEqual([]);
    });

    it("a pipe inside a jq filter", () => {
        expect(tags("jq '.a | .b' f.json; echo $?")).toEqual([]);
    });

    it("a pipe inside an awk program", () => {
        expect(tags("awk '{ print $1 \"|\" $2 }' f; echo $?")).toEqual([]);
    });

    it("a pipe inside a markdown table written with printf", () => {
        expect(tags("printf '| a | b |\\n' >> table.md; echo $?")).toEqual([]);
    });

    it("an escaped pipe", () => {
        expect(tags("echo a \\| tail; echo $?")).toEqual([]);
    });

    it("a pipe inside a comment", () => {
        expect(tags("cmd # | tail\necho $?")).toEqual([]);
    });

    it("a pipe inside a heredoc body", () => {
        expect(tags("cat <<'EOF' > f\ncmd | tail\nEOF\necho $?")).toEqual([]);
    });

    it("a pipe inside a fable-replace spec", () => {
        const command = `bun cli.ts <<'FRSPEC'
@@ src/x.ts
<<<
const a = run("ls | tail");
===
const a = run("ls | tail -1");
>>>
FRSPEC
echo "rc=$?"`;

        expect(tags(command)).toEqual([]);
    });
});

describe("adversarial: multi-line scripts with many statements", () => {
    it("finds the one bad line in a long script", () => {
        const command = `set -e
cd /repo
echo "=== step 1 ==="
bun install > /tmp/install.log 2>&1; echo "install=$?"
echo "=== step 2 ==="
bun run build 2>&1 | tail -5
echo "build=$?"
echo "=== step 3 ==="
bun test > /tmp/test.log 2>&1; echo "test=$?"`;

        expect(tags(command)).toEqual([`${PIPE}:block`]);
        expect(violation(command, PIPE)?.matched).toBe("bun run build 2>&1 | tail -5");
    });

    it("stays silent on a long script that does everything right", () => {
        const command = `set -o pipefail
cd /repo
bun install > /tmp/install.log 2>&1; echo "install=$?"
bun run build 2>&1 | tail -5
echo "build=$?"
n=$(git status --short | wc -l)
echo "dirty=$n"
ls /tmp/*.log 2>&1 | head -5
git log --oneline -3 | cat`;

        expect(tags(command)).toEqual([]);
    });

    it("finds a block hidden in a for loop body on one line", () => {
        const command = 'for wt in a b c; do git -C "$wt" status --short 2>&1 | tail -1; echo "$wt exit=$?"; done';

        expect(tags(command)).toEqual([`${PIPE}:block`]);
    });
});

describe("adversarial: zsh-specific spellings", () => {
    it("does not confuse $status with $?", () => {
        expect(tags("cmd | tail; echo $status")).toEqual([]);
    });

    it("does not confuse $? inside a zsh parameter flag expression", () => {
        expect(tags("cmd | tail; echo ${(j:,:)arr}")).toEqual([]);
    });

    it("treats $pipestatus[-1] as the correct idiom", () => {
        expect(tags("cmd | tail; echo $pipestatus[-1]")).toEqual([]);
    });
});

describe("what the model reads", () => {
    it("the pipeline block names the zsh trap and every fix", () => {
        const text = renderViolation(violation('tsgo 2>&1 | tail -20; echo "exit: $?"', PIPE) as ShellViolation);

        expect(text).toContain("[block] $? read right after a pipeline");
        expect(text).toContain("matched (offset 0): tsgo 2>&1 | tail -20");
        expect(text).toContain("${PIPESTATUS[0]} expands to an empty string");
        expect(text).toContain("set -o pipefail");
        expect(text).toContain("$pipestatus[1]");
        expect(text).toContain('your command, corrected:\n(set -o pipefail; tsgo 2>&1 | tail -20); echo "exit: $?"');
    });

    it("the grep context keeps the caveat that the status may be wanted", () => {
        const text = renderViolation(violation("cmd | rg x; echo $?", GREP) as ShellViolation);

        expect(text).toContain("[context]");
        expect(text).toContain("sometimes what was wanted");
    });

    it("the PIPESTATUS block gives the zsh spelling", () => {
        const text = renderViolation(violation("cmd | tail; echo ${PIPESTATUS[0]}", ZSH) as ShellViolation);

        expect(text).toContain("[block]");
        expect(text).toContain("expands to an empty string");
        expect(text).toContain("1-indexed");
        expect(text).toContain("your command, corrected:\ncmd | tail; echo ${pipestatus[1]}");
    });
});

describe("the follow-ups of the 2026-11-01 audit", () => {
    it("copies every backslash the typed $? carries onto the inserted left status", () => {
        expect(violation("zsh -c \"bash -c 'false | rg x; echo \\$?'\"", GREP)?.suggestion).toBe(
            "zsh -c \"bash -c 'false | rg x; echo \\$? left_exit=\\${PIPESTATUS[0]}'\""
        );
        expect(violation('bash -c "false | rg x; echo \\$?"', GREP)?.suggestion).toBe(
            'bash -c "false | rg x; echo \\$? left_exit=\\${PIPESTATUS[0]}"'
        );
    });

    it("puts a space between $( and the pipefail subshell, which would otherwise open arithmetic", () => {
        expect(violation("x=$(false | tail -1; echo $?); echo $x", PIPE)?.suggestion).toBe(
            "x=$( (set -o pipefail; false | tail -1); echo $?); echo $x"
        );
    });

    it("reads a pipeline and its $? inside one $(...) that the outer shell expands as the outer shell's", () => {
        expect(violation('bash -c "echo $(false | tail -1; echo $?)"', PIPE)?.suggestion).toBe(
            'bash -c "echo $( (set -o pipefail; false | tail -1); echo $?)"'
        );
        // Escaped, the substitution is bash's, and so is everything in it.
        expect(violation('bash -c "echo \\$(false | tail -1; echo \\$?)"', PIPE)).toBeDefined();
        // The outer shell's $? after a pipeline the body runs stays skipped.
        expect(violation('bash -c "false | tail -1; echo $?"', PIPE)).toBeUndefined();
    });

    it("names the element each wrong $pipestatus read is, and the one its label names", () => {
        expect(
            violation(
                "git diff --name-only | rg '\\.ts$' | xargs bunx biome check 2>&1 | tail -3; echo biome=$pipestatus[2]",
                INDEX
            )?.detail
        ).toBe("$pipestatus[2] is element 2 (rg '\\.ts$'), while biome= names element 3 (xargs bunx biome check 2>&1)");
        expect(violation("a | b; echo $pipestatus[3]", INDEX)?.detail).toBe(
            "$pipestatus[3] names element 3 of 2, so it expands to nothing"
        );
        const v = violation("make 2>&1 | tail -5; echo $pipestatus[2]", INDEX);
        expect(v?.detail).toBe("$pipestatus[2] is element 2 (tail -5), a filter that exits 0");
        expect(v && renderViolation(v)).toContain(
            "  here: $pipestatus[2] is element 2 (tail -5), a filter that exits 0"
        );
    });
});
