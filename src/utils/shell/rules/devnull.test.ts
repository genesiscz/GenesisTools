import { describe, expect, it } from "bun:test";

import { detectShellViolations, renderViolation, type ShellViolation } from "./index";

// Ported from the deleted exitCodeGuard.test.ts (e98cae4), whole registry, ids
// mapped: devnull-count:block → stderr-discarded-then-counted:block,
// devnull-filter:warn → stderr-discarded-then-read:context.

function tags(command: string): string[] {
    return detectShellViolations(command).map((v) => `${v.ruleId}:${v.severity}`);
}

function blocks(command: string): string[] {
    return detectShellViolations(command)
        .filter((v) => v.severity === "block")
        .map((v) => v.ruleId);
}

function contexts(command: string): string[] {
    return detectShellViolations(command)
        .filter((v) => v.severity === "context")
        .map((v) => v.ruleId);
}

function violation(command: string, ruleId: string): ShellViolation | undefined {
    return detectShellViolations(command).find((v) => v.ruleId === ruleId);
}

const COUNT = "stderr-discarded-then-counted";
const COVERED = "stderr-discarded-then-counted-covered";
const READ = "stderr-discarded-then-read";

// The corrected command, scanned again, must not trip the rule that offered it.
function expectSuggestionClean(command: string, ruleId: string): string {
    const suggestion = violation(command, ruleId)?.suggestion;

    expect(suggestion).toBeDefined();
    expect(detectShellViolations(suggestion as string).map((v) => v.ruleId)).not.toContain(ruleId);
    return suggestion as string;
}

// ---------------------------------------------------------------------------
// stderr-discarded-then-counted: `2>/dev/null` then a count
// ---------------------------------------------------------------------------

describe("stderr-discarded-then-counted: blocks", () => {
    it("the canonical shape", () => {
        expect(tags("ls ~/Downloads/*.har 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(violation("ls x 2>/dev/null | wc -l", COUNT)?.matched).toBe("ls x 2>/dev/null | wc -l");
    });

    it("with a space after 2>", () => {
        expect(blocks("ls x 2> /dev/null | wc -l")).toEqual([COUNT]);
    });

    it("wc -c and wc -w and bare wc", () => {
        expect(blocks("cmd 2>/dev/null | wc -c")).toEqual([COUNT]);
        expect(blocks("cmd 2>/dev/null | wc -w")).toEqual([COUNT]);
        expect(blocks("cmd 2>/dev/null | wc")).toEqual([COUNT]);
    });

    it("when wc is not the next element, and the read rule stays quiet on that pipeline", () => {
        expect(tags("rg -l x src 2>/dev/null | rg -v node_modules | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("git status --short 2>/dev/null | wc -l | tr -d ' '")).toEqual([`${COUNT}:block`]);
        expect(tags("rg -n 'poll' log 2>/dev/null | awk -F',' '{print $2}' | sort -u | wc -l")).toEqual([
            `${COUNT}:block`,
        ]);
    });

    it("when the redirect is on a middle element", () => {
        expect(blocks("ls | grep x 2>/dev/null | wc -l")).toEqual([COUNT]);
    });

    it("grep -c, rg -c, rg --count and rg --count-matches", () => {
        expect(blocks("cmd 2>/dev/null | grep -c pending")).toEqual([COUNT]);
        expect(blocks("cmd 2>/dev/null | grep -ic pending")).toEqual([COUNT]);
        expect(blocks("cmd 2>/dev/null | rg -c foo")).toEqual([COUNT]);
        expect(blocks("cmd 2>/dev/null | rg --count foo")).toEqual([COUNT]);
        expect(blocks("cmd 2>/dev/null | rg --count-matches foo")).toEqual([COUNT]);
    });

    it("inside a command substitution in double quotes", () => {
        expect(blocks("echo \"unpushed: $(git log @{u}..HEAD 2>/dev/null | wc -l | tr -d ' ')\"")).toEqual([COUNT]);
    });

    it("inside an unquoted command substitution", () => {
        expect(blocks("n=$(find . -name '*.jsonl' 2>/dev/null | wc -l); echo $n")).toEqual([COUNT]);
    });

    it("inside a function body and a loop", () => {
        const command = `chk() { c=$(git grep -l -F -- "$2" HEAD -- "$1" 2>/dev/null | grep -v 'package.json$' | wc -l | tr -d ' '); printf '%s\\n' "$c"; }
for p in a b; do n=$(rg -l --no-messages "x" "$p" 2>/dev/null | rg -v '\\.md$' | wc -l | tr -d ' '); echo "$p -> $n"; done`;

        expect(blocks(command)).toEqual([COUNT]);
    });

    it("inside a test expression in an until loop", () => {
        expect(
            blocks('until [ "$(ps -p 1,2 -o pid= 2>/dev/null | wc -l | tr -d \' \')" = "0" ]; do sleep 2; done')
        ).toEqual([COUNT]);
    });

    it("inside a bash heredoc", () => {
        expect(blocks("bash <<'B'\nls x 2>/dev/null | wc -l\nB")).toEqual([COUNT]);
    });

    it("points at the statement and drops the redirect in the suggestion", () => {
        const command = "cd x; ls ~/Downloads/*.har 2>/dev/null | wc -l";
        const v = violation(command, COUNT);

        expect(v?.index).toBe(command.indexOf("ls ~"));
        expect(v?.matched).toBe("ls ~/Downloads/*.har 2>/dev/null | wc -l");
        expect(v?.suggestion).toBe("cd x; ls ~/Downloads/*.har | wc -l");
    });
});

describe("stderr-discarded-then-counted: the corrected command drops every counted redirect", () => {
    it("two statements: both redirects go, and the result passes the rule", () => {
        const command = "ls a 2>/dev/null | wc -l; ls b 2>/dev/null | wc -l";

        expect(expectSuggestionClean(command, COUNT)).toBe("ls a | wc -l; ls b | wc -l");
    });

    it("a statement and a substitution", () => {
        const command = 'fd -t f . "$a" 2>/dev/null | wc -l; echo "n=$(fd -t f . "$b" 2>/dev/null | wc -l)"';

        expect(expectSuggestionClean(command, COUNT)).toBe(
            'fd -t f . "$a" | wc -l; echo "n=$(fd -t f . "$b" | wc -l)"'
        );
    });

    it("reports the hit with the lowest offset, wherever its unit sits", () => {
        const command = 'echo "n=$(ls a 2>/dev/null | wc -l)"; ls b 2>/dev/null | wc -l';
        const v = violation(command, COUNT);

        expect(v?.index).toBe(command.indexOf("ls a"));
        expect(v?.matched).toBe("ls a 2>/dev/null | wc -l");
        expect(v?.suggestion).toBe('echo "n=$(ls a | wc -l)"; ls b | wc -l');
    });

    it("cuts a token reached through the outer unit and through the shell body once", () => {
        expect(expectSuggestionClean('bash -c "$(ls a 2>/dev/null | wc -l)"', COUNT)).toBe('bash -c "$(ls a | wc -l)"');
    });

    it("inside a zsh -c body and a loop", () => {
        const command =
            "zsh -c 'ls a 2>/dev/null | wc -l; echo hi'; for p in a b; do find \"$p\" 2>/dev/null | wc -l; done";

        expect(expectSuggestionClean(command, COUNT)).toBe(
            "zsh -c 'ls a | wc -l; echo hi'; for p in a b; do find \"$p\" | wc -l; done"
        );
    });

    it("leaves the redirects of reading pipelines to the read rule, and each suggestion passes its own rule", () => {
        const command = "ls a 2>/dev/null | wc -l; ls b 2>/dev/null | head";

        expect(expectSuggestionClean(command, COUNT)).toBe("ls a | wc -l; ls b 2>/dev/null | head");
        expect(expectSuggestionClean(command, READ)).toBe("ls a 2>/dev/null | wc -l; ls b | head");
    });

    it("every logged multi-hit shape replays clean", () => {
        const commands = [
            "ls a 2>/dev/null | wc -l\nls b 2> /dev/null | grep -c x\nn=$(find c 2>/dev/null | wc -l)",
            "lsof -p 2108 2>/dev/null | wc -l; lsof -p 2108 2>/dev/null | awk '{print $5}' | sort | uniq -c | wc -l",
            'for id in a b; do t=$(fd -t f "^$id.jsonl$" ~/x 2>/dev/null | wc -l); echo "$(fd -H . ~/y 2>/dev/null | wc -l)"; done',
            "cmd 2>/dev/null 2>/dev/null | wc -l",
        ];

        for (const command of commands) {
            expectSuggestionClean(command, COUNT);
        }
    });
});

describe("stderr-discarded-then-counted: does not fire", () => {
    it("when nothing counts the output", () => {
        expect(tags("ls x 2>/dev/null")).toEqual([]);
        expect(tags("ls x 2>/dev/null || echo none")).toEqual([]);
        expect(tags("ls x 2>/dev/null; wc -l other.txt")).toEqual([]);
        expect(tags("ls x 2>/dev/null && wc -l other.txt")).toEqual([]);
    });

    it("when the redirect is on the last element", () => {
        expect(tags("ls | wc -l 2>/dev/null")).toEqual([]);
        expect(tags("ls | grep x 2>/dev/null")).toEqual([]);
    });

    it("when stdout is what goes to /dev/null", () => {
        expect(tags("cmd >/dev/null 2>&1 | wc -l")).toEqual([]);
        expect(tags("cmd &>/dev/null | wc -l")).toEqual([]);
        expect(tags("cmd 2>&1 >/dev/null | wc -l")).toEqual([]);
    });

    it("when stderr is kept (2>&1)", () => {
        expect(tags("ls x 2>&1 | wc -l")).toEqual([]);
    });

    it("when stderr goes to a file that can be read", () => {
        expect(tags("ls x 2>/tmp/err | wc -l; cat /tmp/err")).toEqual([]);
    });

    it("when the count flag is uppercase -C (context) or a long option that is not --count", () => {
        expect(blocks("cmd 2>/dev/null | rg -C 3 foo")).toEqual([]);
        expect(blocks("cmd 2>/dev/null | rg --color=never foo")).toEqual([]);
        expect(contexts("cmd 2>/dev/null | rg -C 3 foo")).toEqual([READ]);
    });

    it("when the shape is only text", () => {
        expect(tags("echo 'ls x 2>/dev/null | wc -l'")).toEqual([]);
        expect(tags('echo "ls x 2>/dev/null | wc -l"')).toEqual([]);
        expect(tags("# ls x 2>/dev/null | wc -l\nls")).toEqual([]);
        expect(tags("cat <<'EOF'\nls x 2>/dev/null | wc -l\nEOF")).toEqual([]);
        expect(tags("git commit -m 'drop the 2>/dev/null | wc -l probe'")).toEqual([]);
    });

    it("when /dev/null is a positional argument, not a redirect", () => {
        expect(tags("rg -n '' /dev/null | wc -l")).toEqual([]);
        expect(tags("diff /dev/null x | wc -l")).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// stderr-discarded-then-counted-covered: a sibling shows the same path's error
// ---------------------------------------------------------------------------

describe("stderr-discarded-then-counted-covered: context instead of the block", () => {
    it("find with the same start point listed with 2>&1", () => {
        expect(tags('find /x -type l 2>&1 | head -20; echo "n=$(find /x -type l 2>/dev/null | wc -l)"')).toEqual([
            `${COVERED}:context`,
        ]);
    });

    it("fd whose search path an ls in the same call prints", () => {
        expect(tags("ls ~/.grok 2>&1 | head; fd -t f events.jsonl ~/.grok 2>/dev/null | wc -l")).toEqual([
            `${COVERED}:context`,
        ]);
    });

    it("a quoted operand compares with its quotes stripped", () => {
        expect(tags('ls -lO "$Q" "$Q/BT_backup" 2>&1; ls $Q/BT_backup 2>/dev/null | wc -l')).toEqual([
            `${COVERED}:context`,
        ]);
        expect(tags("ls -la '/a b/c' | head; find \"/a b/c\" -type f 2>/dev/null | wc -l")).toEqual([
            `${COVERED}:context`,
        ]);
    });

    it("a parent or a child at a / boundary names the path", () => {
        expect(tags('ls -laO "$L" | head -20; ls "$L/Archive" 2>/dev/null | wc -l')).toEqual([`${COVERED}:context`]);
        expect(tags("ls ~/x/Archive/2026 2>&1 | head; ls ~/x/Archive 2>/dev/null | wc -l")).toEqual([
            `${COVERED}:context`,
        ]);
        expect(tags("ls /tmp/a/ | head; ls /tmp/a 2>/dev/null | wc -l")).toEqual([`${COVERED}:context`]);
    });

    it("every hit and every operand covered", () => {
        expect(
            tags('ls -lO "$Q" 2>&1; ls "$Q/a" 2>/dev/null | wc -l; find "$Q/b" -type f 2>/dev/null | wc -l')
        ).toEqual([`${COVERED}:context`]);
        expect(tags("du -sh ~/a ~/b; ls ~/a ~/b 2>/dev/null | wc -l")).toEqual([`${COVERED}:context`]);
    });

    it("flag values are not operands, on either side", () => {
        expect(tags("du -sh ~/x; du -d 1 ~/x 2>/dev/null | wc -l")).toEqual([`${COVERED}:context`]);
        expect(tags("ls -la ~/x; stat -f '%z' ~/x/a 2>/dev/null | wc -l")).toEqual([`${COVERED}:context`]);
        expect(tags("ls /x; find -L /x -type l 2>/dev/null | wc -l")).toEqual([`${COVERED}:context`]);
        expect(tags("rg -n -g '*.ts' foo ~/x | head; find ~/x -name '*.ts' 2>/dev/null | wc -l")).toEqual([
            `${COVERED}:context`,
        ]);
        expect(tags("grep -rn -e foo ~/x | head; ls ~/x 2>/dev/null | wc -l")).toEqual([`${COVERED}:context`]);
    });

    it("a sibling whose stdout is discarded still shows its stderr", () => {
        expect(tags("ls ~/x 2>&1 >/dev/null; ls ~/x 2>/dev/null | wc -l")).toEqual([`${COVERED}:context`]);
        expect(tags("ls ~/x >/dev/null; ls ~/x 2>/dev/null | wc -l")).toEqual([`${COVERED}:context`]);
    });

    it("the corrected command drops the redirect and passes both rules", () => {
        const command = "ls ~/.grok 2>&1 | head; fd -t f events.jsonl ~/.grok 2>/dev/null | wc -l";
        const suggestion = expectSuggestionClean(command, COVERED);

        expect(suggestion).toBe("ls ~/.grok 2>&1 | head; fd -t f events.jsonl ~/.grok | wc -l");
        expect(tags(suggestion)).toEqual([]);
        expect(violation(command, COVERED)?.index).toBe(command.indexOf("fd -t"));
    });

    it("the note says the count can still lie and names the sibling", () => {
        const text = renderViolation(
            violation(
                "ls ~/.grok 2>&1 | head; fd -t f events.jsonl ~/.grok 2>/dev/null | wc -l",
                COVERED
            ) as ShellViolation
        );

        expect(text).toContain("[context]");
        expect(text).toContain("can still read a failure as 0");
        expect(text).toContain("before you trust the count");
    });
});

describe("stderr-discarded-then-counted-covered: the block stays", () => {
    it("with no sibling at all", () => {
        expect(tags("ls ~/Downloads/*.har 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
    });

    it("for a producer that is not ls, du, stat, find or fd", () => {
        expect(tags('git -C "$w" log -1 2>/dev/null; git -C "$w" status 2>/dev/null | wc -l')).toEqual([
            `${COUNT}:block`,
        ]);
        expect(tags("ls src | head; rg -l foo src 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("ls db; sqlite3 db/x.db 'select 1' 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("ls ~/x; bunx tsgo -p ~/x 2>/dev/null | rg -c y")).toEqual([`${COUNT}:block`]);
    });

    it("when the sibling discards fd 2", () => {
        for (const discard of ["2>/dev/null", "&>/dev/null", ">/dev/null 2>&1", "2>&-", "2>>/dev/null", "2>/tmp/err"]) {
            expect(tags(`ls ~/x ${discard}; ls ~/x 2>/dev/null | wc -l`)).toContain(`${COUNT}:block`);
        }
    });

    it("when a compound command around the sibling discards fd 2", () => {
        expect(tags("for d in a; do ls ~/x; done 2>/dev/null; ls ~/x 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("{ ls ~/x; } 2>/dev/null; ls ~/x 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
    });

    it("when the sibling is not a listing command", () => {
        expect(tags("cat ~/x/a; ls ~/x 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("echo ~/x; ls ~/x 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("test -d ~/x && ls ~/x 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("cd ~/x && ls ~/x 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
    });

    it("when one hit or one operand is not covered", () => {
        const command = "ls ~/a 2>&1 | head; ls ~/a 2>/dev/null | wc -l; ls ~/b 2>/dev/null | wc -l";

        expect(tags(command)).toEqual([`${COUNT}:block`]);
        expect(violation(command, COUNT)?.suggestion).toBe("ls ~/a 2>&1 | head; ls ~/a | wc -l; ls ~/b | wc -l");
        expect(tags("ls ~/a | head; ls ~/a ~/b 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
    });

    it("when the match is not at a / boundary", () => {
        expect(tags("ls /tmp/ab 2>&1 | head; ls /tmp/a 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
    });

    it(". / ~ and $HOME match only themselves, never as a parent", () => {
        expect(tags("ls ~ 2>&1 | head; ls ~/x 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("ls . | head; ls src 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("ls / | head; find /x 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("ls $HOME | head; ls $HOME/x 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("ls src/a | head; ls . 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("ls . | head; ls . 2>/dev/null | wc -l")).toEqual([`${COVERED}:context`]);
        expect(tags("ls ~/ | head; ls ~ 2>/dev/null | wc -l")).toEqual([`${COVERED}:context`]);
    });

    it("when the producer names no path: fd and find search the folder they run in", () => {
        expect(tags("ls . | head; fd -t f foo 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("ls . | head; ls 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
    });

    it("when the only match is the pattern of a search, not its path", () => {
        expect(tags("rg -n ~/x src | head; ls ~/x 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("fd ~/x src | head; ls ~/x 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
    });

    it("never fires together with the block", () => {
        const commands = [
            "ls ~/a 2>&1 | head; ls ~/a 2>/dev/null | wc -l; ls ~/b 2>/dev/null | wc -l",
            "ls ~/.grok 2>&1 | head; fd -t f events.jsonl ~/.grok 2>/dev/null | wc -l",
            "ls ~/Downloads/*.har 2>/dev/null | wc -l",
            "ls ~/x 2>/dev/null | head; ls ~/x 2>/dev/null | wc -l",
            "[ -d ./nope ] && ls ./nope | head; find ./nope 2>/dev/null | wc -l",
            "ls -d ~/Downloads 2>&1; find ~/Downloads -name '*.har' 2>/dev/null | wc -l",
            "zsh -c 'ls ./nope' 2>/dev/null; find ./nope 2>/dev/null | wc -l",
        ];

        for (const command of commands) {
            const ids = detectShellViolations(command).map((v) => v.ruleId);
            expect(ids.includes(COUNT) && ids.includes(COVERED)).toBe(false);
        }
    });
});

describe("stderr-discarded-then-counted-covered: a sibling that may not run covers nothing", () => {
    it("after && or ||, including the advised test for the path", () => {
        expect(tags("[ -d ./nope ] && ls ./nope | head; find ./nope 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("false && ls ~/x; find ~/x -type f 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("find ~/x 2>/dev/null | wc -l || ls ~/x")).toEqual([`${COUNT}:block`]);
        expect(tags("[ -d ~/x ] && { ls ~/x; }; find ~/x 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("[ -d ~/x ] && out=$(ls ~/x); find ~/x 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
    });

    it("in a function body", () => {
        expect(tags("f() { ls ~/x; }; find ~/x 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("function f { ls ~/x; }; find ~/x 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
    });

    it("in an if or case branch, or a loop body", () => {
        expect(tags("if [ -d ~/x ]; then ls ~/x; fi; find ~/x 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("if [ -d ~/y ]; then echo y; else ls ~/x; fi; find ~/x 2>/dev/null | wc -l")).toEqual([
            `${COUNT}:block`,
        ]);
        expect(tags("case $m in a) ls ~/x ;; esac; find ~/x 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("for d in $L; do ls ~/x; done; find ~/x 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("if c; then ls ~/x; else find ~/x 2>/dev/null | wc -l; fi")).toEqual([`${COUNT}:block`]);
    });

    it("run by xargs, which runs nothing on an empty input", () => {
        expect(tags("find ./nope -type f 2>/dev/null | xargs -I{} ls ./nope/{} | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("fd foo | xargs ls ~/x; ls ~/x 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
    });

    it("a sibling that runs whenever the producer runs still covers", () => {
        expect(tags("if ls ~/x; then echo y; fi; find ~/x 2>/dev/null | wc -l")).toEqual([`${COVERED}:context`]);
        expect(tags("ls ~/x 2>&1 | head && find ~/x 2>/dev/null | wc -l")).toEqual([`${COVERED}:context`]);
        expect(tags('for d in a b; do ls "$d" | head; find "$d" 2>/dev/null | wc -l; done')).toEqual([
            `${COVERED}:context`,
        ]);
        expect(tags("if c; then ls ~/x; find ~/x 2>/dev/null | wc -l; fi")).toEqual([`${COVERED}:context`]);
        expect(tags("f() { ls ~/x; find ~/x 2>/dev/null | wc -l; }")).toEqual([`${COVERED}:context`]);
    });
});

describe("stderr-discarded-then-counted-covered: a sibling whose error never reaches the terminal covers nothing", () => {
    it("2>&1 into a counter, grep -q, a zero count, a filter or a file", () => {
        for (const tail of [
            "| wc -l",
            "| grep -c x",
            "| grep -q x",
            "| head -0",
            "| grep foo",
            "| cut -c1-10",
            "| tail -n +2",
            "| sed -n 1p",
            "| head > /tmp/o",
        ]) {
            expect(tags(`ls ./nope 2>&1 ${tail}; find ./nope 2>/dev/null | wc -l`)).toEqual([`${COUNT}:block`]);
        }
    });

    it("|& into a counter", () => {
        expect(tags("ls ./nope |& wc -l; find ./nope 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("ls ~/x |& head; ls ~/x 2>/dev/null | wc -l")).toEqual([`${COVERED}:context`]);
    });

    it("2>&1 into a capture", () => {
        expect(tags("out=$(ls ./nope 2>&1); find ./nope 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("out=`ls ./nope 2>&1`; find ./nope 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
    });

    it("an error merged into a pipe that prints its lines still shows", () => {
        expect(tags("ls ~/x 2>&1 | sed 's|/a||' | head -20; find ~/x 2>/dev/null | wc -l")).toEqual([
            `${COVERED}:context`,
        ]);
        expect(tags('du -sh "$R" 2>&1 | tail -1; find "$R" -type d 2>/dev/null | wc -l')).toEqual([
            `${COVERED}:context`,
        ]);
        expect(tags("ls ~/x 2>&1 | grep -v total; ls ~/x 2>/dev/null | wc -l")).toEqual([`${COVERED}:context`]);
    });

    it("a capture keeps only stdout: the sibling's stderr still shows", () => {
        expect(tags("out=$(ls ~/x); find ~/x 2>/dev/null | wc -l")).toEqual([`${COVERED}:context`]);
    });
});

describe("stderr-discarded-then-counted-covered: compound, exec and sh -c redirects around the sibling", () => {
    it("a group or subshell that discards or files stderr", () => {
        expect(tags("{ ls ./nope; } 2>/tmp/e; ls ./nope 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("( ls ./nope ) 2>/dev/null; ls ./nope 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("{ ls ./nope; } >/dev/null 2>&1; ls ./nope 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("{ ls ~/x 2>&1; } | wc -l; ls ~/x 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("{ ls ~/x; } 2>&1 | head; ls ~/x 2>/dev/null | wc -l")).toEqual([`${COVERED}:context`]);
        expect(tags("( ls ~/x ); ls ~/x 2>/dev/null | wc -l")).toEqual([`${COVERED}:context`]);
    });

    it("a loop whose done line discards stderr, after an input redirect too", () => {
        expect(tags("for d in a; do ls ~/x; find ~/x 2>/dev/null | wc -l; done 2>/dev/null")).toEqual([
            `${COUNT}:block`,
        ]);
        expect(tags("while read l; do ls ~/x; ls ~/x 2>/dev/null | wc -l; done < in.txt 2>/dev/null")).toEqual([
            `${COUNT}:block`,
        ]);
        expect(tags("while read l; do ls ~/x; ls ~/x 2>/dev/null | wc -l; done < in.txt")).toEqual([
            `${COVERED}:context`,
        ]);
        expect(tags("while read l; do ls ./nope; done < in.txt 2>/dev/null; ls ./nope 2>/dev/null | wc -l")).toEqual([
            `${COUNT}:block`,
        ]);
    });

    it("exec 2>/dev/null hides every later stderr; exec 2>&1 does not", () => {
        expect(tags("exec 2>/dev/null; ls ./nope; ls ./nope 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("exec 2>&1; ls ~/x; ls ~/x 2>/dev/null | wc -l")).toEqual([`${COVERED}:context`]);
    });

    it("a sh -c wrapper that discards stderr, or pipes it into a counter", () => {
        expect(tags("zsh -c 'ls ./nope' 2>/dev/null; find ./nope 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags('bash -c "ls ./nope" &>/dev/null; find ./nope 2>/dev/null | wc -l')).toEqual([`${COUNT}:block`]);
        expect(tags("zsh -c 'ls ~/x' 2>&1 | wc -l; find ~/x 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("zsh -c 'ls ~/x'; find ~/x 2>/dev/null | wc -l")).toEqual([`${COVERED}:context`]);
        expect(tags("zsh -c 'ls ~/x' 2>&1 | head; find ~/x 2>/dev/null | wc -l")).toEqual([`${COVERED}:context`]);
    });

    it("a shell fed a heredoc carries its redirects, its pipe and its condition into the body", () => {
        const after = "find ./nope 2>/dev/null | wc -l";

        expect(tags(`bash <<'B' 2>/dev/null\nls ./nope\nB\n${after}`)).toEqual([`${COUNT}:block`]);
        expect(tags(`bash <<'B' 2>&1 | wc -l\nls ./nope\nB\n${after}`)).toEqual([`${COUNT}:block`]);
        expect(tags(`zsh <<-EOF 2>/dev/null\n\tls ./nope\n\tEOF\n${after}`)).toEqual([`${COUNT}:block`]);
        expect(tags(`[ -d ./nope ] && bash <<'B'\nls ./nope\nB\n${after}`)).toEqual([`${COUNT}:block`]);
        expect(tags(`bash <<'B'\nls ./nope\nB\n${after}`)).toEqual([`${COVERED}:context`]);
        expect(tags(`bash <<-EOF\n\tls ./nope\n\tEOF\n${after}`)).toEqual([`${COVERED}:context`]);
    });

    it("a heredoc body ends at its delimiter line, and a cat heredoc is data", () => {
        expect(tags("bash <<'B' 2>/dev/null\necho hi\nB\nls ~/x\nfind ~/x 2>/dev/null | wc -l")).toEqual([
            `${COVERED}:context`,
        ]);
        expect(tags("cat <<'B'\nls ~/x\nB\nfind ~/x 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
    });

    it("a keyword inside a path or a parameter is not a compound command", () => {
        expect(tags("ls ~/x 2>&1 | head; find ~/x/done 2>/dev/null | wc -l")).toEqual([`${COVERED}:context`]);
        expect(tags("ls ${D} 2>&1 | head; ls ${D} 2>/dev/null | wc -l")).toEqual([`${COVERED}:context`]);
        expect(tags("ls ~/fi 2>&1 | head; ls ~/fi 2>/dev/null | wc -l")).toEqual([`${COVERED}:context`]);
    });
});

describe("stderr-discarded-then-counted-covered: a sibling that reads only the entry", () => {
    it("stat or ls -d of a parent says nothing about a child", () => {
        expect(tags('stat -f "%N" ./real; find ./real/typo -type f 2>/dev/null | wc -l')).toEqual([`${COUNT}:block`]);
        expect(tags("ls -ld ./real | cut -c1-10; ls ./real/typo 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("ls -ld ~/Downloads; ls ~/Downloads/*.har 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("find ~/x -maxdepth 0; ls ~/x/a 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("grep foo ~/x | head; ls ~/x/a 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
    });

    it("stat or ls -d of the same folder succeeds where a listing is refused", () => {
        expect(tags("ls -d ~/Downloads 2>&1; find ~/Downloads -name '*.har' 2>/dev/null | wc -l")).toEqual([
            `${COUNT}:block`,
        ]);
        expect(tags('ls -lOd "$Q" "$Q/BT_backup" 2>&1; ls $Q/BT_backup 2>/dev/null | wc -l')).toEqual([
            `${COUNT}:block`,
        ]);
    });

    it("the same entry read the same way, a path under it, or a recursive grep of a parent covers", () => {
        expect(tags("stat ~/x; ls -d ~/x 2>/dev/null | wc -l")).toEqual([`${COVERED}:context`]);
        expect(tags("stat ~/x/a; find ~/x 2>/dev/null | wc -l")).toEqual([`${COVERED}:context`]);
        expect(tags("grep -r foo ~/x | head; ls ~/x/a 2>/dev/null | wc -l")).toEqual([`${COVERED}:context`]);
    });
});

describe("stderr-discarded-then-counted-covered: operands the reader used to miss", () => {
    it("rg --files takes no pattern, so its first word is a path", () => {
        expect(tags("rg --files ~/x | head; ls ~/x 2>/dev/null | wc -l")).toEqual([`${COVERED}:context`]);
    });

    it("a double-quoted bash -c body loses one level of backslashes", () => {
        const command = 'bash -c "ls \\"$Q/a\\" 2>/dev/null | wc -l"; ls "$Q/a"';

        expect(tags(command)).toEqual([`${COVERED}:context`]);
        expect(violation(command, COVERED)?.suggestion).toBe('bash -c "ls \\"$Q/a\\" | wc -l"; ls "$Q/a"');
    });
});

// ---------------------------------------------------------------------------
// stderr-discarded-then-read: `2>/dev/null` then a reader
// ---------------------------------------------------------------------------

describe("stderr-discarded-then-read: context", () => {
    const readers = [
        "head",
        "tail",
        "grep",
        "egrep",
        "fgrep",
        "rg",
        "jq",
        "awk",
        "sed",
        "cut",
        "tr",
        "sort",
        "uniq",
        "xargs",
        "column",
        "tee",
        "cat",
        "less",
        "yq",
    ];

    for (const reader of readers) {
        it(`context for \`cmd 2>/dev/null | ${reader}\``, () => {
            expect(tags(`cmd 2>/dev/null | ${reader} x`)).toEqual([`${READ}:context`]);
        });
    }

    it("context for the corpus ls shape", () => {
        expect(tags("ls ~/Library/Developer/CoreSimulator/Devices/ 2>/dev/null | head -20")).toEqual([
            `${READ}:context`,
        ]);
    });

    it("context for the corpus lsof shape", () => {
        expect(tags("lsof -ti :3000 2>/dev/null | head -3")).toEqual([`${READ}:context`]);
    });

    it("context for the corpus git shape", () => {
        expect(tags("git log --oneline @{u}..HEAD 2>/dev/null | head -10")).toEqual([`${READ}:context`]);
    });

    it("fires once even when several statements carry the shape", () => {
        expect(tags("ls a 2>/dev/null | head; ls b 2>/dev/null | tail -1")).toEqual([`${READ}:context`]);
    });

    it("fires when the reader comes later in the pipeline", () => {
        expect(tags("cmd 2>/dev/null | bun x.ts | head")).toEqual([`${READ}:context`]);
    });

    it("fires inside a for loop body", () => {
        expect(tags('for d in */; do ls "$d" 2>/dev/null | head -1; done')).toEqual([`${READ}:context`]);
    });

    it("xargs running a program still reads the empty input", () => {
        expect(tags("cmd 2>/dev/null | xargs -I {} open {}")).toEqual([`${READ}:context`]);
    });

    it("drops the redirect in the suggestion", () => {
        expect(violation("ls x 2>/dev/null | head -3", READ)?.suggestion).toBe("ls x | head -3");
        expect(violation("ls 2> /dev/null x | head", READ)?.suggestion).toBe("ls x | head");
    });

    it("drops every reading redirect, and the result passes the rule", () => {
        expect(expectSuggestionClean("ls a 2>/dev/null | head; ls b 2>/dev/null | tail -1", READ)).toBe(
            "ls a | head; ls b | tail -1"
        );
        expect(
            expectSuggestionClean(
                "ps -axo pid,command | rg x; ls -t ~/Logs 2>/dev/null | rg -i genesis | head -5; d=$(fd -t d -d 6 '^a$' ~/n 2>/dev/null | head -1)",
                READ
            )
        ).toBe(
            "ps -axo pid,command | rg x; ls -t ~/Logs | rg -i genesis | head -5; d=$(fd -t d -d 6 '^a$' ~/n | head -1)"
        );
    });

    it("points at the hit with the lowest offset", () => {
        const command = "x=$(ls a 2>/dev/null | head -1); ls b 2>/dev/null | tail -1";

        expect(violation(command, READ)?.index).toBe(command.indexOf("ls a"));
    });
});

describe("stderr-discarded-then-read: a zero count passes nothing", () => {
    const zeroCounts = ["-0", "-n 0", "-n0", "--lines=0", "-c 0", "-c0", "--bytes=0"];

    for (const reader of ["head", "tail"]) {
        for (const count of zeroCounts) {
            it(`${reader} ${count} is not a reader`, () => {
                expect(tags(`sed -n 1,5p f.c 2>/dev/null | ${reader} ${count}`)).toEqual([]);
            });
        }
    }

    it("nothing after the zero count reads the producer", () => {
        expect(tags("cmd 2>/dev/null | head -0 | grep x")).toEqual([]);
        expect(tags("cmd 2>/dev/null | tail -n 0 | wc -l")).toEqual([]);
        expect(tags("f=$(fd -t f -d 3 . Projects 2>/dev/null | head -0)")).toEqual([]);
    });

    it("a reader before the zero count still reads it", () => {
        expect(tags("cmd 2>/dev/null | grep x | head -0")).toEqual([`${READ}:context`]);
    });

    it("a non-zero count stays a reader", () => {
        expect(tags("sed -n 1,5p f.c 2>/dev/null | head -1")).toEqual([`${READ}:context`]);
        expect(tags("cmd 2>/dev/null | head -n 10")).toEqual([`${READ}:context`]);
        expect(tags("cmd 2>/dev/null | tail -c 100")).toEqual([`${READ}:context`]);
        expect(tags("cmd 2>/dev/null | tail -n +0")).toEqual([`${READ}:context`]);
    });
});

describe("mdfind: stderr is locale chatter, its errors go to stdout", () => {
    it("neither rule fires on an mdfind producer", () => {
        expect(tags('mdfind -name "t3code" 2>/dev/null | head -20')).toEqual([]);
        expect(tags("mdfind -onlyin ~/x 'kind:pdf' 2>/dev/null | wc -l")).toEqual([]);
        expect(
            tags(
                'ls ~/.t3 2>&1 | head -50; mdfind -name "t3code" 2>/dev/null | head -20; ls /Applications | grep -i t3'
            )
        ).toEqual([]);
    });

    it("other producers in the same call still fire", () => {
        expect(tags("mdfind -name x 2>/dev/null | head; ls ~/x 2>/dev/null | head")).toEqual([`${READ}:context`]);
        expect(violation("mdfind -name x 2>/dev/null | head; ls ~/x 2>/dev/null | head", READ)?.suggestion).toBe(
            "mdfind -name x 2>/dev/null | head; ls ~/x | head"
        );
    });
});

describe("stderr-discarded-then-read: does not fire", () => {
    it("when the consumer is a program, not a reader", () => {
        expect(tags("cmd 2>/dev/null | bash")).toEqual([]);
        expect(tags("cmd 2>/dev/null | bun x.ts")).toEqual([]);
        expect(tags("cmd 2>/dev/null | python3 -c 'x'")).toEqual([]);
        expect(tags("cmd 2>/dev/null | while read l; do echo $l; done")).toEqual([]);
        expect(tags("cmd 2>/dev/null | pbcopy")).toEqual([]);
        expect(tags("cmd 2>/dev/null | tools json")).toEqual([]);
    });

    it("when there is no pipe", () => {
        expect(tags("ls x 2>/dev/null")).toEqual([]);
        expect(tags("ls x 2>/dev/null; head -3 y")).toEqual([]);
        expect(tags("kill -TERM $p 2>/dev/null && echo sent")).toEqual([]);
    });

    it("when only stdout is discarded", () => {
        expect(tags("cmd >/dev/null 2>&1 | head")).toEqual([]);
        expect(tags("curl -s -o /dev/null -w '%{http_code}' url | head")).toEqual([]);
    });

    it("when the shape is text", () => {
        expect(tags("echo 'ls x 2>/dev/null | head'")).toEqual([]);
        expect(tags("cat <<'EOF'\nls x 2>/dev/null | head\nEOF")).toEqual([]);
    });

    it("when the reader is the element carrying the redirect", () => {
        expect(tags("cmd | rg x 2>/dev/null")).toEqual([]);
    });

    it("when a counter sits downstream: that pipeline belongs to the counted rule", () => {
        expect(tags("cmd 2>/dev/null | head -100 | wc -l")).toEqual([`${COUNT}:block`]);
    });
});

describe("adversarial: 2>/dev/null spelled differently", () => {
    it("2> /dev/null with a space", () => {
        expect(tags("ls x 2> /dev/null | head")).toEqual([`${READ}:context`]);
        expect(tags("ls x 2>  /dev/null | wc -l")).toEqual([`${COUNT}:block`]);
    });

    it("2>/dev/null before other arguments", () => {
        expect(tags("ls 2>/dev/null x | head")).toEqual([`${READ}:context`]);
    });

    it("2>/dev/null with a following 2>&1 is still a discard of stderr", () => {
        expect(tags("ls x 2>/dev/null 2>&1 | wc -l")).toEqual([`${COUNT}:block`]);
    });

    it("2>>/dev/null (append) is not matched, and that is documented", () => {
        expect(tags("ls x 2>>/dev/null | wc -l")).toEqual([]);
    });

    it("stderr redirected to a file is fine", () => {
        expect(tags("ls x 2>/tmp/err.txt | wc -l")).toEqual([]);
        expect(tags("ls x 2>/dev/stderr | wc -l")).toEqual([]);
    });

    it("only the statement with the redirect is reported", () => {
        const command = "ls a | wc -l\nls b 2>/dev/null | wc -l";
        const v = violation(command, COUNT);

        expect(v?.matched).toBe("ls b 2>/dev/null | wc -l");
        expect(v?.index).toBe(command.indexOf("ls b"));
    });
});

describe("adversarial: loops and conditions", () => {
    it("finds context hidden in a while loop condition", () => {
        expect(tags("while ! lsof -ti :3000 2>/dev/null | head -1 | grep -q .; do sleep 1; done")).toEqual([
            `${READ}:context`,
        ]);
    });
});

describe("corpus fixtures that must fire", () => {
    const cases: Array<[string, string[]]> = [
        [
            "sqlite3 ~/.genesis-tools/question/qa.db \"SELECT file FROM ingest_offsets WHERE file LIKE '%/log/%'\" 2>/dev/null | wc -l",
            [`${COUNT}:block`],
        ],
        [
            // The fd on the same folder keeps stderr (2>&1), so it prints the error the count hides.
            "ls ~/Library/Developer/CoreSimulator/Devices/ 2>/dev/null | wc -l; echo \"--- searching ---\"; fd -t d -H --max-depth 8 'ColMobile.app' ~/Library/Developer/CoreSimulator/Devices/ 2>&1 | head -20",
            [`${COVERED}:context`],
        ],
        [
            "cat /tmp/tasks/x.output 2>/dev/null; echo \"--- copy progress ---\"; find /Users/Martin/.claude.bkp -type f 2>/dev/null | wc -l | tr -d ' '",
            [`${COUNT}:block`],
        ],
        ['echo "files: $(find /Users/Martin/.claude.test.clone -type f 2>/dev/null | wc -l)"', [`${COUNT}:block`]],
        [
            "ls database/seeders/E2e/*.php 2>/dev/null | wc -l | tr -d ' '; echo \"tracked E2e count:\"; git ls-files database/seeders/E2e/ | wc -l | tr -d ' '",
            [`${COUNT}:block`],
        ],
        ['TOTAL=$(ls -1 */*.jsonl 2>/dev/null | wc -l)\necho "total jsonl files: $TOTAL"', [`${COUNT}:block`]],
        [
            "git push 2>&1 | tail -2; cd repo && git log --oneline -2 | cat; echo \"--- GT unpushed: $(git log --oneline @{u}..HEAD 2>/dev/null | wc -l | tr -d ' ') ---\"",
            [`${COUNT}:block`],
        ],
        [
            // The first find lists the same folder with 2>&1, so a refused listing prints there.
            "echo \"=== all .har in Downloads ===\"; find /Users/Martin/Downloads -maxdepth 1 -iname '*.har' 2>&1 | head -20; echo \"=== count ===\"; find /Users/Martin/Downloads -maxdepth 1 -iname '*.har' 2>/dev/null | wc -l",
            [`${COVERED}:context`],
        ],
        [
            'aws s3 ls s3://bucket/ --profile $P 2>/dev/null | rg -c "backups-prod" | xargs -I{} echo "retained: {}"',
            [`${COUNT}:block`],
        ],
        [
            'for ref in origin/master origin/feature/next; do printf "%-22s " "$ref"; git ls-tree -r --name-only "$ref" 2>/dev/null | rg -c \'buildLogoutUrl\' || echo 0; done',
            [`${COUNT}:block`],
        ],
        ['xcrun simctl list devices 2>/dev/null | grep -c "unavailable" || echo "0"', [`${COUNT}:block`]],
        [
            'C=$(cd wt && gh pr checks 299 2>/dev/null | grep -c pending); if [ "${C:-1}" -eq 0 ]; then break; fi',
            [`${COUNT}:block`],
        ],
        [
            "lsof -p 2108 2>/dev/null | wc -l; echo \"--- by type ---\"; lsof -p 2108 2>/dev/null | awk '{print $5}' | sort | uniq -c | sort -rn | head",
            [`${COUNT}:block`, `${READ}:context`],
        ],
        [
            'cd ~/.claude/projects 2>/dev/null || exit 1\nls -td */ 2>/dev/null | head -3\nfor d in */; do\n  n=$(ls "$d"agent-*.jsonl 2>/dev/null | wc -l | tr -d \' \')\n  [ "$n" != "0" ] && echo "  $n in $d"\ndone 2>/dev/null | head',
            [`${COUNT}:block`, `${READ}:context`],
        ],
        ["lsof -nP -iTCP:9876 -sTCP:LISTEN 2>/dev/null | head -3 || echo free", [`${READ}:context`]],
        [
            'cat node_modules/.genesis-test-stamp 2>/dev/null | head -2; echo "---"; ls -d node_modules >/dev/null && echo "node_modules present"',
            [`${READ}:context`],
        ],
        ["rg -l 'abc-init' /repo --hidden -g '!node_modules' 2>/dev/null | head -8", [`${READ}:context`]],
        [
            'find . -path ./node_modules -prune -o -name "*.test.ts*" -print 2>/dev/null | xargs grep -l "fetchPendingSnapshot" 2>/dev/null',
            [`${READ}:context`],
        ],
        [
            "ps eww -p 9964 2>/dev/null | tr ' ' '\\n' | grep -oE '^[A-Z][A-Z0-9_]*_(SESSION_ID|ID)=' | sort -u",
            [`${READ}:context`],
        ],
        [
            "ls | head -20\necho \"--- tsconfigs at root ---\"\nls tsconfig* 2>&1\ncat package.json | tools json 2>/dev/null | rg -A12 '^scripts:' || rg -A12 '\"scripts\"' package.json",
            [`${READ}:context`],
        ],
    ];

    for (const [command, expected] of cases) {
        it(`${expected.join(" + ")}: ${command.slice(0, 70).replace(/\n/g, "⏎")}`, () => {
            expect(tags(command)).toEqual(expected);
        });
    }
});

describe("what the model reads", () => {
    it("the counted block explains the zero and offers the readable form", () => {
        const text = renderViolation(violation("ls ~/Downloads/*.har 2>/dev/null | wc -l", COUNT) as ShellViolation);

        expect(text).toContain("[block] 2>/dev/null then a count: a failure reads as 0 or a blank");
        expect(text).toContain("permission error");
        expect(text).toContain("`wc -l` and `grep -c` then print 0");
        expect(text).toContain("`rg -c` prints nothing");
        expect(text).toContain("test for them, so that absence prints a word and a typo still prints an error");
        expect(text).not.toContain("buys nothing");
        expect(text).toContain("2>/tmp/err | wc -l; cat /tmp/err");
        expect(text).toContain('[ -d "$p" ] && ls "$p" | wc -l || echo "absent: $p"');
        expect(text).toContain("your command, corrected:\nls ~/Downloads/*.har | wc -l");
    });

    it("the read context says empty output may be an error", () => {
        const text = renderViolation(violation("ls x 2>/dev/null | head -3", READ) as ShellViolation);

        expect(text).toContain("[context]");
        expect(text).toContain("you cannot tell which happened");
    });
});
