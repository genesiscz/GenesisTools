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

    it("when pipefail is set anywhere in the command", () => {
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
        "awk 'NR>12533 && /303439/{print NR}' $A | head -25\necho \"=== count after 12533 ===\"; awk 'NR>12533 && /303439/' $A | wc -l",
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
