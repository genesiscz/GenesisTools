import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";

import { scanShell } from "../scan";
import { stderrDiscardedThenCounted } from "./devnull";
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
const SCRATCH = "stderr-discarded-then-counted-scratch";
const DD = "dd-skip-silent-short-read";
const READ = "stderr-discarded-then-read";

// The ids that fire with the command run in `cwd`.
function tagsIn(cwd: string, command: string): string[] {
    return detectShellViolations(command, undefined, { cwd }).map((v) => `${v.ruleId}:${v.severity}`);
}

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
        expect(tags("ls ~/ab 2>&1 | head; ls ~/a 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
    });

    it("when the producer's flag, primary or value can fail, which a sibling listing never shows", () => {
        expect(tags("ls src; find src -not-a-primary 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("ls src; find src -newer stamp 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("ls src; ls --colr src 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("ls src; find src -type f 2>/dev/null | wc -l")).toEqual([`${COVERED}:context`]);
    });

    it("unless the sibling runs the same command with the same arguments, which shows that failure too", () => {
        const same = "fd -t f --changed-within 2023-01-01 . ~/x -H";

        expect(tags(`${same} 2>&1 | head -8; ${same} 2>/dev/null | wc -l`)).toEqual([`${COVERED}:context`]);
        expect(tags("find src -newer stamp 2>&1 | head; find src -newer stamp 2>/dev/null | wc -l")).toEqual([
            `${COVERED}:context`,
        ]);
        expect(tags("find src -newer stamp 2>&1 | head; find src -newer other 2>/dev/null | wc -l")).toEqual([
            `${COUNT}:block`,
        ]);
        expect(tags(`fd -t f . ~/x -H 2>&1 | head -8; ${same} 2>/dev/null | wc -l`)).toEqual([`${COUNT}:block`]);
    });

    it("when a relative path is read in another folder than the sibling's, or one the guard cannot place", () => {
        expect(tags("ls src; cd other; find src -type f 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tagsIn("/repo", "ls src; cd other; find src -type f 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tagsIn("/repo", "ls src; cd $D; find src -type f 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        // The same folder after the cd, and an absolute path from any folder, still cover.
        expect(tagsIn("/repo", "cd other; ls src; find src -type f 2>/dev/null | wc -l")).toEqual([
            `${COVERED}:context`,
        ]);
        expect(tags("ls /x; cd other; find /x -type f 2>/dev/null | wc -l")).toEqual([`${COVERED}:context`]);
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
            "| sed 'd'",
            "| sed q",
            "| sed 's/.*//'",
            "| sed 's/[a-z]//g'",
            "| sed 's/\\w//g'",
            "| sed 's/x\\+//'",
            "| sed -e 's/a/b/' -e d",
            "| sed -f fix.sed",
            "| sed 's/a/b/' notes.txt",
            "| sed -i.bak s/a/b/ notes.txt",
            "| sed -z s/a/b/",
            "| sed 's/a/b/w out.txt'",
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

        // sed keeps the error line when its program only swaps fixed text, whatever the delimiter or the count.
        for (const sed of [
            "sed 's/^/  /'",
            "sed -E -e 's|/tmp||g' -e 's/a;b/c/'",
            "sed --expression='s/x/y/2;s.a.b.'",
        ]) {
            expect(tags(`ls ~/x 2>&1 | ${sed}; ls ~/x 2>/dev/null | wc -l`)).toEqual([`${COVERED}:context`]);
        }
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
// awk END aggregates, tsc and tsgo, scratch paths, dd short reads
// ---------------------------------------------------------------------------

describe("stderr-discarded-then-counted: an awk END aggregate is a counter", () => {
    it("blocks an awk that prints only in END, and the read note stays quiet", () => {
        expect(
            tags(
                "find . -type f -print0 2>/dev/null | xargs -0 stat -f '%z' | awk '{s+=$1} END {printf \"%.1f MB\\n\", s/1048576}'"
            )
        ).toEqual([`${COUNT}:block`]);
        expect(tags("cmd 2>/dev/null | awk 'END {print NR}'")).toEqual([`${COUNT}:block`]);
        expect(tags("cmd 2>/dev/null | awk -F, '{s+=$2} END {print s}'")).toEqual([`${COUNT}:block`]);
        expect(tags("cmd 2>/dev/null | gawk -v n=0 '{n++} END {print n}'")).toEqual([`${COUNT}:block`]);
        expect(tags("cmd 2>/dev/null | awk 'BEGIN {print \"n\"} {n++} END {print n}'")).toEqual([`${COUNT}:block`]);
    });

    it("an awk that prints a line outside END, or reads its program from a file, stays a reader", () => {
        expect(tags("cmd 2>/dev/null | awk '{print} END{print \"done\"}'")).toEqual([`${READ}:context`]);
        expect(tags("cmd 2>/dev/null | awk '{printf \"%s\\n\", $1} END {print NR}'")).toEqual([`${READ}:context`]);
        expect(tags("cmd 2>/dev/null | awk '{print \"END {\"}'")).toEqual([`${READ}:context`]);
        expect(tags("cmd 2>/dev/null | awk -f sum.awk")).toEqual([`${READ}:context`]);
        expect(tags("cmd 2>/dev/null | awk '{s+=$1}'")).toEqual([`${READ}:context`]);
    });

    it("a pattern with no action prints each line it matches, so the awk stays a reader", () => {
        expect(tags("cmd 2>/dev/null | awk '/x/; END {print NR}'")).toEqual([`${READ}:context`]);
        expect(tags("cmd 2>/dev/null | awk 'NR<5 END {print NR}'")).toEqual([`${READ}:context`]);
        expect(tags("cmd 2>/dev/null | awk '1; END{print \"total\", NR}'")).toEqual([`${READ}:context`]);
        expect(tags("cmd 2>/dev/null | awk '/print/ {n++} END {print n+0}'")).toEqual([`${COUNT}:block`]);
    });
});

describe("stderr-discarded-then-counted: tsc and tsgo print their errors on stdout", () => {
    it("the corrected command keeps the compiler's exit status visible", () => {
        const command =
            'sed -n 1,25p tsconfig.json; bunx tsgo --noEmit -p tsconfig.json --listFilesOnly 2>/dev/null | rg -c "probe-models.ts"';

        expect(tags(command)).toEqual([`${COUNT}:block`]);
        expect(violation(command, COUNT)?.suggestion).toBe(
            'sed -n 1,25p tsconfig.json; { bunx tsgo --noEmit -p tsconfig.json --listFilesOnly; echo "tsgo rc=$?" >&2; } | rg -c "probe-models.ts"'
        );
        expect(expectSuggestionClean(command, COUNT)).toContain('echo "tsgo rc=$?" >&2; }');
    });

    it("tsc and tsgo, directly or through npx and bun x", () => {
        expect(violation("tsc --noEmit 2>/dev/null | grep -c error", COUNT)?.suggestion).toBe(
            '{ tsc --noEmit; echo "tsc rc=$?" >&2; } | grep -c error'
        );
        expect(violation("npx tsc -p . 2>/dev/null | wc -l", COUNT)?.suggestion).toBe(
            '{ npx tsc -p .; echo "tsc rc=$?" >&2; } | wc -l'
        );
        expect(violation("bun x tsgo 2>/dev/null | wc -l", COUNT)?.suggestion).toBe(
            '{ bun x tsgo; echo "tsgo rc=$?" >&2; } | wc -l'
        );
    });

    it("the value of -p or --package names the package, so the program after it is the compiler", () => {
        const wraps: Array<[string, string]> = [
            ["npx -p typescript tsc --noEmit", "tsc"],
            ["npx --package typescript tsc", "tsc"],
            ["npx --package=typescript tsc", "tsc"],
            ["bunx -p typescript tsc", "tsc"],
            ["bun x --package @typescript/native-preview tsgo", "tsgo"],
            ["pnpm dlx --package typescript tsc", "tsc"],
            ["yarn dlx -p typescript tsc", "tsc"],
            ["npm exec -- tsc", "tsc"],
            ["npm exec tsc --noEmit", "tsc"],
            ["npm exec --package=typescript -- tsc", "tsc"],
        ];

        for (const [producer, word] of wraps) {
            expect(violation(`${producer} 2>/dev/null | wc -l`, COUNT)?.suggestion).toBe(
                `{ ${producer}; echo "${word} rc=$?" >&2; } | wc -l`
            );
        }
    });

    it("a runner whose program is not a compiler only loses its redirect", () => {
        expect(violation("npx -p tsc eslint . 2>/dev/null | wc -l", COUNT)?.suggestion).toBe(
            "npx -p tsc eslint . | wc -l"
        );
        expect(violation("npm exec eslint 2>/dev/null | wc -l", COUNT)?.suggestion).toBe("npm exec eslint | wc -l");
        expect(violation("pnpm dlx -p tsc 2>/dev/null | wc -l", COUNT)?.suggestion).toBe("pnpm dlx -p tsc | wc -l");
    });

    it("in an unquoted heredoc a shell reads, the status line escapes $? once", () => {
        expect(violation("bash <<EOF\ntsgo --noEmit 2>/dev/null | wc -l\nEOF", COUNT)?.suggestion).toBe(
            'bash <<EOF\n{ tsgo --noEmit; echo "tsgo rc=\\$?" >&2; } | wc -l\nEOF'
        );
        expect(violation("sudo zsh -s <<-EOF\n\tbunx tsc 2>/dev/null | wc -l\n\tEOF", COUNT)?.suggestion).toBe(
            'sudo zsh -s <<-EOF\n\t{ bunx tsc; echo "tsc rc=\\$?" >&2; } | wc -l\n\tEOF'
        );
        expect(violation("bash -c 'bash <<EOF\ntsgo 2>/dev/null | wc -l\nEOF'", COUNT)?.suggestion).toBe(
            "bash -c 'bash <<EOF\n{ tsgo; echo \"tsgo rc=\\$?\" >&2; } | wc -l\nEOF'"
        );
    });

    it("a quoted heredoc, or a compiler after the heredoc, keeps $? as it is", () => {
        expect(violation("bash <<'EOF'\ntsgo 2>/dev/null | wc -l\nEOF", COUNT)?.suggestion).toBe(
            "bash <<'EOF'\n{ tsgo; echo \"tsgo rc=$?\" >&2; } | wc -l\nEOF"
        );
        expect(violation("bash <<EOF\necho hi\nEOF\ntsgo 2>/dev/null | wc -l", COUNT)?.suggestion).toBe(
            'bash <<EOF\necho hi\nEOF\n{ tsgo; echo "tsgo rc=$?" >&2; } | wc -l'
        );
    });

    it("a heredoc the scan marks as not fed, or whose command is not a shell, escapes nothing", () => {
        const scan = scanShell("bash <<EOF\ntsgo 2>/dev/null | wc -l\nEOF");
        const notFed = { ...scan, heredocs: scan.heredocs.map((h) => ({ ...h, fed: false })) };

        expect(stderrDiscardedThenCounted.detect(notFed)?.suggestion).toBe(
            'bash <<EOF\n{ tsgo; echo "tsgo rc=$?" >&2; } | wc -l\nEOF'
        );
    });

    it("an unquoted heredoc whose command is not a shell only loses the redirect: the local shell expands its $?", () => {
        // The scan may read these bodies as code, but echo, ssh and docker are the commands.
        for (const opener of ["echo sh <<EOF", "ssh host bash <<EOF", "docker exec -i c sh <<EOF"]) {
            expect(violation(`${opener}\ntsgo 2>/dev/null | wc -l\nEOF`, COUNT)?.suggestion).toBe(
                `${opener}\ntsgo | wc -l\nEOF`
            );
        }
    });

    it("a compiler in an unescaped $(…) inside the heredoc keeps $?: the shell around the heredoc runs it", () => {
        expect(violation('bash <<EOF\necho "n=$(tsgo 2>/dev/null | wc -l)"\nEOF', COUNT)?.suggestion).toBe(
            'bash <<EOF\necho "n=$({ tsgo; echo "tsgo rc=$?" >&2; } | wc -l)"\nEOF'
        );
        expect(
            violation('sh <<EOF\nfor f in a; do echo "$(tsgo 2>/dev/null | wc -l)"; done\nEOF', COUNT)?.suggestion
        ).toBe('sh <<EOF\nfor f in a; do echo "$({ tsgo; echo "tsgo rc=$?" >&2; } | wc -l)"; done\nEOF');
        // `\\$(` is an escaped backslash, so the shell around the heredoc still runs the substitution.
        expect(violation("bash <<EOF\nn=\\\\$(tsgo 2>/dev/null | wc -l)\nEOF", COUNT)?.suggestion).toBe(
            'bash <<EOF\nn=\\\\$({ tsgo; echo "tsgo rc=$?" >&2; } | wc -l)\nEOF'
        );
    });

    it("a compiler in an escaped \\$(…) inside the heredoc escapes $? once: the shell it feeds runs it", () => {
        expect(violation("bash <<EOF\nn=\\$(tsgo 2>/dev/null | wc -l); echo \\$n\nEOF", COUNT)?.suggestion).toBe(
            'bash <<EOF\nn=\\$({ tsgo; echo "tsgo rc=\\$?" >&2; } | wc -l); echo \\$n\nEOF'
        );
    });

    it("a $(…) in a double-quoted body runs in the shell around it, so its $? stays and \\$(…) escapes once", () => {
        expect(violation('sh -c "n=$(tsgo 2>/dev/null | wc -l); echo n=\\$n"', COUNT)?.suggestion).toBe(
            'sh -c "n=$({ tsgo; echo "tsgo rc=$?" >&2; } | wc -l); echo n=\\$n"'
        );
        expect(violation('sh -c "n=\\$(tsgo 2>/dev/null | wc -l); echo n=\\$n"', COUNT)?.suggestion).toBe(
            'sh -c "n=\\$({ tsgo; echo \\"tsgo rc=\\$?\\" >&2; } | wc -l); echo n=\\$n"'
        );
    });

    it("the shell before << is found past a $(…) on its line, a continuation line, or a heredoc in a $(…)", () => {
        const body = "\ntsgo 2>/dev/null | wc -l\nEOF";
        const escaped = '\n{ tsgo; echo "tsgo rc=\\$?" >&2; } | wc -l\nEOF';

        for (const [opener, after] of [
            ["X=$(pwd) bash <<EOF", ""],
            ['bash -s -- "$(date +%s)" <<EOF', ""],
            ["env \\\n  bash <<EOF", ""],
            ["sudo \\\n  bash <<EOF", ""],
            ["{ bash <<EOF", "\n}"],
            ["if true; then bash <<EOF", "\nfi"],
            ["true && nice bash <<EOF", ""],
            ["out=$(bash <<EOF", "\n); echo $out"],
        ]) {
            expect(violation(`${opener}${body}${after}`, COUNT)?.suggestion).toBe(`${opener}${escaped}${after}`);
        }
    });

    it("a heredoc inside a double-quoted body, or two unquoted heredocs, only lose the redirect", () => {
        expect(violation('zsh -c "bash <<EOF\ntsgo 2>/dev/null | wc -l\nEOF"', COUNT)?.suggestion).toBe(
            'zsh -c "bash <<EOF\ntsgo | wc -l\nEOF"'
        );
        expect(violation("bash <<A\nbash <<B\ntsgo 2>/dev/null | wc -l\nB\nA", COUNT)?.suggestion).toBe(
            "bash <<A\nbash <<B\ntsgo | wc -l\nB\nA"
        );
    });

    it("other hits of the same call only lose their redirect", () => {
        expect(violation("ls a 2>/dev/null | wc -l; bunx tsgo 2>/dev/null | rg -c x", COUNT)?.suggestion).toBe(
            'ls a | wc -l; { bunx tsgo; echo "tsgo rc=$?" >&2; } | rg -c x'
        );
    });

    it("a do, then or else in front stays outside the braces", () => {
        expect(violation("for p in a b; do tsgo -p $p 2>/dev/null | wc -l; done", COUNT)?.suggestion).toBe(
            'for p in a b; do { tsgo -p $p; echo "tsgo rc=$?" >&2; } | wc -l; done'
        );
        expect(violation("while read p; do tsc -p $p 2>/dev/null | wc -l; done < list", COUNT)?.suggestion).toBe(
            'while read p; do { tsc -p $p; echo "tsc rc=$?" >&2; } | wc -l; done < list'
        );
        expect(
            violation("if true; then tsgo 2>/dev/null | wc -l; else tsc 2>/dev/null | wc -l; fi", COUNT)?.suggestion
        ).toBe(
            'if true; then { tsgo; echo "tsgo rc=$?" >&2; } | wc -l; else { tsc; echo "tsc rc=$?" >&2; } | wc -l; fi'
        );
    });

    it("inside a double-quoted body the status line is escaped once; in a backtick only the redirect goes", () => {
        expect(violation('zsh -c "bunx tsgo --noEmit 2>/dev/null | rg -c error"', COUNT)?.suggestion).toBe(
            'zsh -c "{ bunx tsgo --noEmit; echo \\"tsgo rc=\\$?\\" >&2; } | rg -c error"'
        );
        expect(violation("zsh -c 'bunx tsgo 2>/dev/null | rg -c error'", COUNT)?.suggestion).toBe(
            "zsh -c '{ bunx tsgo; echo \"tsgo rc=$?\" >&2; } | rg -c error'"
        );
        expect(violation("n=`tsgo 2>/dev/null | wc -l`", COUNT)?.suggestion).toBe("n=`tsgo | wc -l`");
    });

    it("a |& after the compiler becomes |, so the status line is not counted", () => {
        expect(violation("bunx tsgo --noEmit 2>/dev/null |& rg -c error", COUNT)?.suggestion).toBe(
            '{ bunx tsgo --noEmit; echo "tsgo rc=$?" >&2; } | rg -c error'
        );
    });

    it("a compiler that feeds a reader, not a counter, only loses its redirect", () => {
        expect(violation("tsgo --noEmit 2>/dev/null | head", READ)?.suggestion).toBe("tsgo --noEmit | head");
    });

    it("the right text says why", () => {
        const text = renderViolation(violation("tsc 2>/dev/null | wc -l", COUNT) as ShellViolation);

        expect(text).toContain("tsc and tsgo print their errors on stdout");
    });
});

describe("stderr-discarded-then-counted-scratch: a literal path under /tmp", () => {
    it("context instead of the block for ls, find, fd, du and stat", () => {
        for (const command of [
            "ls /tmp/cc/x/out 2>/dev/null | wc -l",
            "find /private/tmp/x -type f 2>/dev/null | wc -l",
            "fd -t f . /tmp/x 2>/dev/null | wc -l",
            "du -a /tmp/x 2>/dev/null | wc -l",
            "stat -f %z /tmp/x/a 2>/dev/null | wc -l",
            "ls /tmp/a 2>/dev/null | wc -l; echo \"n=$(find '/tmp/b c' 2>/dev/null | wc -l)\"",
        ]) {
            expect(tags(command)).toEqual([`${SCRATCH}:context`]);
        }
    });

    it("the corrected command drops the redirect, and the note says why", () => {
        const command = "ls /tmp/cc/x/out 2>/dev/null | wc -l";

        expect(expectSuggestionClean(command, SCRATCH)).toBe("ls /tmp/cc/x/out | wc -l");
        expect(renderViolation(violation(command, SCRATCH) as ShellViolation)).toContain(
            "missing path is the honest 0"
        );
    });

    it("the block stays for a variable, a glob, a relative path, a path outside /tmp or another producer", () => {
        for (const command of [
            "ls $S/out 2>/dev/null | wc -l",
            "ls /tmp/x/*.log 2>/dev/null | wc -l",
            "ls /tmp/../Users/x 2>/dev/null | wc -l",
            "ls ~/x 2>/dev/null | wc -l",
            "ls /tmp/a 2>/dev/null | wc -l; ls ~/b 2>/dev/null | wc -l",
            "rg -l x /tmp/x 2>/dev/null | wc -l",
            "cat /tmp/x 2>/dev/null | wc -l",
            "fd foo 2>/dev/null | wc -l",
        ]) {
            expect(tags(command)).toEqual([`${COUNT}:block`]);
        }

        expect(tagsIn("/tmp/x", "ls out 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
    });

    it("the block stays for /tmp itself, a link out of /tmp and a folder that refuses the listing", () => {
        const dir = mkdtempSync("/tmp/devnull-scratch-");
        mkdirSync(`${dir}/open`);
        mkdirSync(`${dir}/closed`);
        symlinkSync("/usr", `${dir}/link`);

        try {
            // /tmp holds other users' folders, and the link reads a tree outside it.
            expect(tags("find /tmp/ -name x 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
            expect(tags(`ls ${dir}/link 2>/dev/null | wc -l`)).toEqual([`${COUNT}:block`]);
            // A readable folder and a missing path keep the note.
            expect(tags(`ls ${dir}/open 2>/dev/null | wc -l`)).toEqual([`${SCRATCH}:context`]);
            expect(tags(`ls ${dir}/missing 2>/dev/null | wc -l`)).toEqual([`${SCRATCH}:context`]);

            // Root lists a folder whatever its mode, so the refusal needs another user.
            if (process.getuid?.() !== 0) {
                chmodSync(`${dir}/closed`, 0o000);
                expect(tags(`ls ${dir}/closed 2>/dev/null | wc -l`)).toEqual([`${COUNT}:block`]);
            }
        } finally {
            chmodSync(`${dir}/closed`, 0o700);
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("an unknown ls, du or stat flag also prints 0, so the block stays", () => {
        expect(tags("ls --colr /tmp/cc/x 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("du -d x /tmp/cc/x 2>/dev/null | wc -l")).toEqual([`${COUNT}:block`]);
        expect(tags("ls -la /tmp/cc/x 2>/dev/null | wc -l")).toEqual([`${SCRATCH}:context`]);
    });

    it("find primaries and fd flags that read no other path and run nothing keep the note", () => {
        for (const command of [
            "find /tmp/cc/x -name '*.log' -type f 2>/dev/null | wc -l",
            "find -L /tmp/x -maxdepth 2 \\( -name a -o -iname 'b*' \\) ! -empty -print 2>/dev/null | wc -l",
            "find /tmp/x -mindepth 1 -mtime -1 -mmin +5 -size +1k -newermt 2026-01-01 2>/dev/null | wc -l",
            "find /tmp/x -path '*/node_modules' -prune -o -not -type d,l -print0 2>/dev/null | wc -l",
            "find -s /tmp/x -depth -newermt '2026-01-01 10:00' -a -ipath '*/A/*' -or -true 2>/dev/null | wc -l",
            "fd -H -I -t f -e log -d 3 -g '*.log' /tmp/x 2>/dev/null | wc -l",
            "fd -a -0 -1 -L -E '*.tmp' '\\.log$' /tmp/x 2>/dev/null | wc -l",
            "fd --type=file --max-depth=2 --hidden -S +1k '.*' /tmp/x 2>/dev/null | wc -l",
            "fd -uu -F 'a(b' /tmp/x 2>/dev/null | wc -l",
            "fd -p 'cc/x' /tmp/cc 2>/dev/null | wc -l",
        ]) {
            expect(tags(command)).toEqual([`${SCRATCH}:context`]);
        }
    });

    it("a misspelled or unknown find primary, a bad value or a broken expression keeps the block", () => {
        for (const command of [
            "find /tmp/cc/x -nmae '*.log' 2>/dev/null | wc -l",
            "find /tmp/x -name 2>/dev/null | wc -l",
            "find /tmp/x -name a -o 2>/dev/null | wc -l",
            "find /tmp/x \\( -name a 2>/dev/null | wc -l",
            "find /tmp/x \\( \\) 2>/dev/null | wc -l",
            "find /tmp/x -name a extra 2>/dev/null | wc -l",
            "find /tmp/x -maxdepth x 2>/dev/null | wc -l",
            "find /tmp/x -type x 2>/dev/null | wc -l",
            "find /tmp/x -size 1m 2>/dev/null | wc -l",
            "find /tmp/x -mmin 1h 2>/dev/null | wc -l",
            "find /tmp/x -newermt yesterday 2>/dev/null | wc -l",
            "find /tmp/x -newermt 2026-02-30 2>/dev/null | wc -l",
            "find /tmp/x -regex '[' 2>/dev/null | wc -l",
            "find /tmp/x -user nobody2 2>/dev/null | wc -l",
            "find -X /tmp/x 2>/dev/null | wc -l",
        ]) {
            expect(tags(command)).toEqual([`${COUNT}:block`]);
        }
    });

    it("a find primary that names another path or runs a command keeps the block", () => {
        for (const command of [
            "find /tmp/x -newer ~/Library/Preferences/a.plist 2>/dev/null | wc -l",
            "find /tmp/x -newer /tmp/y 2>/dev/null | wc -l",
            "find /tmp/x -anewer /tmp/y 2>/dev/null | wc -l",
            "find /tmp/x -neweram /tmp/y 2>/dev/null | wc -l",
            "find /tmp/x -samefile ~/a 2>/dev/null | wc -l",
            "find /tmp/x -fprint /tmp/out 2>/dev/null | wc -l",
            "find /tmp/x -exec cat {} \\; 2>/dev/null | wc -l",
            "find /tmp/x -execdir ls {} + 2>/dev/null | wc -l",
            "find /tmp/x -ok rm {} \\; 2>/dev/null | wc -l",
            "find /tmp/x -name a -delete 2>/dev/null | wc -l",
        ]) {
            expect(tags(command)).toEqual([`${COUNT}:block`]);
        }
    });

    it("an fd flag that names another path, runs a command or takes a bad value, or a bad pattern, keeps the block", () => {
        for (const command of [
            "fd --base-directory ~/Library x /tmp/x 2>/dev/null | wc -l",
            "fd -C ~/Library x /tmp/x 2>/dev/null | wc -l",
            "fd --search-path ~/x . /tmp/x 2>/dev/null | wc -l",
            "fd --ignore-file ~/.ignore . /tmp/x 2>/dev/null | wc -l",
            "fd -x cat . /tmp/x 2>/dev/null | wc -l",
            "fd -X ls . /tmp/x 2>/dev/null | wc -l",
            "fd --exec cat . /tmp/x 2>/dev/null | wc -l",
            "fd -l . /tmp/x 2>/dev/null | wc -l",
            "fd -t foo . /tmp/x 2>/dev/null | wc -l",
            "fd -S 500 . /tmp/x 2>/dev/null | wc -l",
            "fd -j 0 . /tmp/x 2>/dev/null | wc -l",
            "fd --hidn . /tmp/x 2>/dev/null | wc -l",
            "fd '*.log' /tmp/x 2>/dev/null | wc -l",
            "fd -g '[' /tmp/x 2>/dev/null | wc -l",
            "fd -E '[' . /tmp/x 2>/dev/null | wc -l",
            "fd 'a/b' /tmp/x 2>/dev/null | wc -l",
        ]) {
            expect(tags(command)).toEqual([`${COUNT}:block`]);
        }
    });

    it("fd flags that fd refuses together, or -g with --regex, keep the block", () => {
        for (const command of [
            "fd -F -g x /tmp/x 2>/dev/null | wc -l",
            "fd --glob --fixed-strings x /tmp/x 2>/dev/null | wc -l",
            "fd --exact-depth 1 -d 2 . /tmp/x 2>/dev/null | wc -l",
            "fd --exact-depth 1 --min-depth 1 . /tmp/x 2>/dev/null | wc -l",
            "fd --exact-depth=1 --prune . /tmp/x 2>/dev/null | wc -l",
            "fd --prune -S +1k . /tmp/x 2>/dev/null | wc -l",
            "fd -g --regex '*.log' /tmp/x 2>/dev/null | wc -l",
        ]) {
            expect(tags(command)).toEqual([`${COUNT}:block`]);
        }
    });

    it("a find option cluster of d, s and x alone, which bfs refuses, keeps the block", () => {
        for (const command of [
            "find -dx /tmp/x -name a 2>/dev/null | wc -l",
            "find -xs /tmp/x -name a 2>/dev/null | wc -l",
            "find -dd /tmp/x -name a 2>/dev/null | wc -l",
        ]) {
            expect(tags(command)).toEqual([`${COUNT}:block`]);
        }

        for (const command of [
            "find -x /tmp/x -name a 2>/dev/null | wc -l",
            "find -Hsx /tmp/x -name a 2>/dev/null | wc -l",
            "find -dL /tmp/x -name a 2>/dev/null | wc -l",
        ]) {
            expect(tags(command)).toEqual([`${SCRATCH}:context`]);
        }
    });

    it("a number or a date that find or fd cannot hold keeps the block", () => {
        for (const command of [
            "find /tmp/x -maxdepth 99999999999999999999 2>/dev/null | wc -l",
            "find /tmp/x -mmin 99999999999999999999 2>/dev/null | wc -l",
            "find /tmp/x -size 99999999999999999999 2>/dev/null | wc -l",
            "find /tmp/x -size 9999999T 2>/dev/null | wc -l",
            "find /tmp/x -size +9999P 2>/dev/null | wc -l",
            "find /tmp/x -newermt 0001-01-01 2>/dev/null | wc -l",
            "find /tmp/x -newermt 1970-01-01 2>/dev/null | wc -l",
            "find /tmp/x -newermt 2039-01-01 2>/dev/null | wc -l",
            "fd -j 99999999999999999999 . /tmp/x 2>/dev/null | wc -l",
            "fd -d 99999999999999999999 . /tmp/x 2>/dev/null | wc -l",
        ]) {
            expect(tags(command)).toEqual([`${COUNT}:block`]);
        }

        for (const command of [
            "find /tmp/x -maxdepth 999999999 -size 999999T 2>/dev/null | wc -l",
            "find /tmp/x -size -999P -newermt 1971-01-01 2>/dev/null | wc -l",
            "find /tmp/x -newermt '2038-12-31 23:59:59' 2>/dev/null | wc -l",
            "fd -j 8 -d 999999999 . /tmp/x 2>/dev/null | wc -l",
        ]) {
            expect(tags(command)).toEqual([`${SCRATCH}:context`]);
        }
    });

    it("a sibling that covers the path still wins, and the block never fires with it", () => {
        expect(tags("ls /tmp/a/ | head; ls /tmp/a 2>/dev/null | wc -l")).toEqual([`${COVERED}:context`]);

        for (const command of [
            "ls /tmp/a 2>/dev/null | wc -l",
            "ls /tmp/a 2>/dev/null | wc -l; ls ~/b 2>/dev/null | wc -l",
        ]) {
            const ids = detectShellViolations(command).map((v) => v.ruleId);
            expect(ids.includes(COUNT) && ids.includes(SCRATCH)).toBe(false);
        }
    });
});

describe("dd-skip-silent-short-read: dd skip= with status=none, then a count", () => {
    it("context for skip= or iseek= with status=none", () => {
        expect(tags("dd if=f.log bs=1048576 skip=2700 count=1 status=none | LC_ALL=C tr -d '\\000' | wc -c")).toEqual([
            `${DD}:context`,
        ]);
        expect(tags("dd if=f.log bs=1m iseek=5 count=1 status=none | wc -c")).toEqual([`${DD}:context`]);
        expect(
            tags(
                "for off in 2560 2700; do dd if=\"$F\" bs=1048576 skip=$off count=1 status=none | LC_ALL=C tr -d '\\000' | wc -c; done"
            )
        ).toEqual([`${DD}:context`]);
    });

    it("next to the counted block when stderr is discarded too", () => {
        expect(tags("dd if=f bs=1 skip=5 status=none 2>/dev/null | wc -c")).toEqual([
            `${COUNT}:block`,
            `${DD}:context`,
        ]);
    });

    it("does not fire without status=none, without an offset or without a counter", () => {
        expect(tags("dd if=f.log bs=1m skip=5 count=1 | wc -c")).toEqual([]);
        expect(tags("dd if=f.log bs=1m skip=5 count=1 status=noxfer | wc -c")).toEqual([]);
        expect(tags("dd if=f.log bs=1m count=1 status=none | wc -c")).toEqual([]);
        expect(tags("dd if=f.log bs=1m skip=5 count=1 status=none | xxd | head")).toEqual([]);
        expect(tags("dd if=f.log bs=1m skip=5 count=1 status=none > out.bin")).toEqual([]);
    });

    it("the note names the hidden records line", () => {
        const text = renderViolation(
            violation("dd if=f.log bs=1m skip=5 count=1 status=none | wc -c", DD) as ShellViolation
        );

        expect(text).toContain("[context]");
        expect(text).toContain("0+0 records in");
        expect(text).toContain("compare skip x bs with the file size first");
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

describe("stderr-discarded-then-read: an operand the call already established", () => {
    it("made by mkdir, used by a sibling with stderr visible, or gated by a test", () => {
        for (const command of [
            "mkdir -p /tmp/x/out; ls -R /tmp/x/out 2>/dev/null | head",
            'ls docs | head -40; rg -l -i "agentSessions|welcome" docs apps/web/src --glob \'!*.test.*\' 2>/dev/null | head -15; rg -n "x" apps/web/src | head -5',
            'C=$(readlink -f "$(command -v claude)"); ls -la "$C" | head -2; strings -n 8 "$C" 2>/dev/null | rg -n -o entry | head -8',
            'nm -gU *.dylib 2>/dev/null | rg "impersonate"; codesign -dv *.dylib 2>&1 | tail -2',
            'grep -rniE "postMessage|iframe|widget" --include=*.ts -l apps libs 2>/dev/null | grep -v spec | head -50; grep -rn "x" --include=*.ts -l apps libs | head',
            "ls docs/ 2>&1 | head; rg -l foo docs 2>/dev/null | head",
            "ls ~/Downloads | head; ls ~/Downloads 2>/dev/null | head",
            "ls docs 2>&1 | head; ls -R docs 2>/dev/null | head",
        ]) {
            expect(tags(command)).toEqual([]);
        }

        for (const command of [
            "[ -d out ] && ls -R out 2>/dev/null | head",
            "if [ -d out ]; then ls -R out 2>/dev/null | head; fi",
            "for w in a b; do [ -d $w ] || continue; du -sh $w 2>/dev/null | cut -f1; done",
        ]) {
            expect(tagsIn("/Users/alice/app", command)).toEqual([]);
        }
    });

    it("a test, cd, stat or mkdir does not show a refused listing, so for a listing it counts only in a known folder", () => {
        for (const command of [
            "[ -d ~/Downloads ] && ls ~/Downloads 2>/dev/null | head",
            "cd ~/Downloads; ls ~/Downloads 2>/dev/null | head",
            "stat ~/Downloads; ls ~/Downloads 2>/dev/null | head",
            "mkdir -p ~/Downloads; ls ~/Downloads 2>/dev/null | head",
            "[ -d ~/Library/Mail ] && du -sh ~/Library/Mail 2>/dev/null | cut -f1",
        ]) {
            expect(tagsIn("/Users/alice/app", command)).toEqual([`${READ}:context`]);
        }

        // Case 34's shape: the gated folder is a variable, so where it points is unknown.
        expect(
            tags(
                'for w in a b; do p=/tmp/w/$w; [ -d "$p" ] || continue; echo "size=$(du -sh "$p" 2>/dev/null | cut -f1)"; done'
            )
        ).toEqual([`${READ}:context`]);
        expect(tags("[ -d out ] && ls -R out 2>/dev/null | head")).toEqual([`${READ}:context`]);
        expect(tags("mkdir -p $S/out; ls -R $S/out 2>/dev/null | head")).toEqual([`${READ}:context`]);
    });

    it("a sibling whose stderr goes into a filter or a capture shows nothing", () => {
        for (const command of [
            "ls docs 2>&1 | grep -q x; ls docs 2>/dev/null | head",
            "x=$(ls docs 2>&1); ls docs 2>/dev/null | head",
            "ls docs 2>&1 | wc -l; ls -R docs 2>/dev/null | head",
        ]) {
            expect(tagsIn("/Users/alice/app", command)).toContain(`${READ}:context`);
        }
    });

    it("`.` counts only in a known folder outside the protected roots", () => {
        expect(
            tags("cd /tmp/w && rg -rn 'features.test' --glob '!node_modules' . 2>/dev/null | head -5")
        ).not.toContain(`${READ}:context`);
        expect(tags("cd /tmp/w && rg -n 'features.test' --glob '!node_modules' . 2>/dev/null | head -5")).toEqual([]);
        expect(tagsIn("/Users/alice/app", "ls -la . 2>/dev/null | head")).toEqual([]);
        expect(tags("ls -la . 2>/dev/null | head")).toEqual([`${READ}:context`]);
        expect(tags("cd /System/Library/AssetsV2/persisted; rg -l -a 'UAF' . 2>/dev/null | head -5")).toEqual([
            `${READ}:context`,
        ]);
    });

    it("the note stays when the pattern can fail, a flag is unknown, or an operand is not established", () => {
        for (const command of [
            "ls -R /tmp/x/out 2>/dev/null | head",
            "ls docs; rg 'foo(' docs 2>/dev/null | head",
            "rg -n foo src/a.ts 2>/dev/null | head; rg -n foo src | head",
            "tools x list --json 2>/dev/null | rg y",
            "ls docs | head; rg --hiden foo docs 2>/dev/null | head",
            "ls docs | head; rg -t rust foo docs 2>/dev/null | head",
            "ls docs | head; rg -e foo docs 2>/dev/null | head",
            "ls docs 2>/dev/null; rg -l foo docs 2>/dev/null | head",
            "out=$(ls docs 2>/dev/null); rg -l foo docs 2>/dev/null | head",
            "echo docs; rg -l foo docs 2>/dev/null | head",
            "[ -d out ] || echo none; ls -R out 2>/dev/null | head",
            "[ ! -d out ] || continue; ls -R out 2>/dev/null | head",
            "ls -R out 2>/dev/null | head; [ -d out ] && echo y",
            "[ -d out ] && echo y; ls -R out 2>/dev/null | head",
            "git log a 2>/dev/null | head; git show a",
            "fd foo | xargs ls docs; ls -R docs 2>/dev/null | head",
        ]) {
            expect(tags(command)).toEqual([`${READ}:context`]);
        }
    });
});

describe("stderr-discarded-then-read: ls -d or several operands, in a known folder", () => {
    it("the listing already tells missing from present", () => {
        expect(tags("cd /Users/alice/Projects/app/src && ls -d */mcp* */*mcp* 2>/dev/null | head -50")).toEqual([]);
        expect(
            tags(
                "cd /Users/alice/app/src && for d in telegram voice-memos; do ls $d/commands $d/lib 2>/dev/null | tr '\\n' ' '; done"
            )
        ).toEqual([]);
        expect(tagsIn("/Users/alice/app", "ls -d a b 2>/dev/null | head")).toEqual([]);
        expect(tagsIn("/Users/alice/app", "ls -1 a b 2>/dev/null | head")).toEqual([]);
    });

    it("the note stays for a protected or unknown folder, an operand that leaves it, or a single folder", () => {
        const home = homedir();

        expect(tags("cd ~/Library/Containers/x && ls -d *.har 2>/dev/null | head")).toEqual([`${READ}:context`]);
        expect(tags("ls -d a b 2>/dev/null | head")).toEqual([`${READ}:context`]);
        expect(tags("cd $X && ls -d a b 2>/dev/null | head")).toEqual([`${READ}:context`]);
        expect(tags("cd ~ && ls -d .* 2>/dev/null | head")).toEqual([`${READ}:context`]);
        expect(tagsIn("/Users/alice/app", "ls ../docs 2>/dev/null | head")).toEqual([`${READ}:context`]);
        expect(tagsIn("/Users/alice/app", "ls -d ~/Documents/a ~/b 2>/dev/null | head")).toEqual([`${READ}:context`]);
        expect(tagsIn("/Users/alice/app", "ls -d ../../../../Library/x a 2>/dev/null | head")).toEqual([
            `${READ}:context`,
        ]);
        expect(tagsIn(`${home}/x`, "ls -d ../* 2>/dev/null | head")).toEqual([`${READ}:context`]);
        expect(tagsIn("/Users/alice/app", "for d in a /System; do ls $d/x $d/y 2>/dev/null | head; done")).toEqual([
            `${READ}:context`,
        ]);
        expect(tagsIn("/Users/alice/app", "x=$(cd ~/Library && ls -d a b 2>/dev/null | head)")).toEqual([
            `${READ}:context`,
        ]);
        expect(tagsIn("/Users/alice/app", "cd ~/Library; y=$(ls -d a b 2>/dev/null | head)")).toEqual([
            `${READ}:context`,
        ]);
    });

    it("a loop variable counts only inside its loop, and only until it is assigned", () => {
        expect(tagsIn("/Users/alice/app", "for d in a b; do ls $d/x $d/y 2>/dev/null | head; done")).toEqual([]);
        expect(
            tagsIn("/Users/alice/app", "for d in a b; do for e in c; do :; done; ls $d/x $d/y 2>/dev/null | head; done")
        ).toEqual([]);

        for (const command of [
            "for d in a b; do :; done; d=~/Library/Mail; ls $d/x $d/y 2>/dev/null | head",
            "for d in a b; do d=~/Library; ls $d/x $d/y 2>/dev/null | head; done",
        ]) {
            expect(tagsIn("/Users/alice/app", command)).toEqual([`${READ}:context`]);
        }
    });
});

describe("stderr-discarded-then-read: the folder the command runs in", () => {
    it("a cd in a ( … ) that closed before the hit changes nothing", () => {
        expect(
            tags("cd /System/Library/AssetsV2/persisted; (cd /tmp && ls); rg -l -a 'UAF' . 2>/dev/null | head -5")
        ).toEqual([`${READ}:context`]);
        expect(
            tagsIn(homedir(), "(cd /Users/alice/app && git status --short); rg -n foo . 2>/dev/null | head")
        ).toEqual([`${READ}:context`]);
        expect(tagsIn("/Users/alice/app", "(cd ~/Library/Mail && ls); rg -n foo . 2>/dev/null | head")).toEqual([]);
        expect(tagsIn("/System/x", "(cd /Users/alice/app && rg -n foo . 2>/dev/null | head)")).toEqual([]);
        expect(tagsIn("/System/x", "{ cd /Users/alice/app; }; rg -n foo . 2>/dev/null | head")).toEqual([]);
    });

    it("pushd, popd, and a cd that may not run make the folder unknown", () => {
        for (const command of [
            "pushd /tmp/w >/dev/null; rg -n foo . 2>/dev/null | head",
            "popd; rg -n foo . 2>/dev/null | head",
            'if [ -n "$X" ]; then cd /tmp/w; fi; rg -n foo . 2>/dev/null | head',
            "[ -d /tmp/w ] && cd /tmp/w; rg -n foo . 2>/dev/null | head",
            "f() { cd /tmp/w; }; f; rg -n foo . 2>/dev/null | head",
            "echo | cd /tmp/w; rg -n foo . 2>/dev/null | head",
        ]) {
            expect(tagsIn("/System/x", command)).toEqual([`${READ}:context`]);
        }

        expect(tagsIn("/System/x", "cd /tmp/w || exit 1; rg -n foo . 2>/dev/null | head")).toEqual([]);
        expect(tagsIn("/System/x", "cd /tmp/w && rg -n foo . 2>/dev/null | head")).toEqual([]);
    });

    it("a pipeline of groups before the hit does not switch the rule off", () => {
        for (const command of [
            "(cd src && git ls-files) | (cd /tmp/x && cat); ls ~/Downloads 2>/dev/null | head",
            "{ echo a; } | { cat; }; ls ~/Downloads 2>/dev/null | head",
        ]) {
            expect(tags(command)).toEqual([`${READ}:context`]);
            expect(tagsIn("/Users/alice/app", command)).toEqual([`${READ}:context`]);
        }
    });
});

describe("stderr-discarded-then-read: a search over the folder with a fixed pattern", () => {
    it("rg over . or no path, grep -r over ., or over a lister's output", () => {
        expect(tags('cd /Users/alice/Projects/app && rg -n "enum Foo" . 2>/dev/null | head -20')).toEqual([]);
        expect(
            tags(
                'cd /Users/alice/app && grep -rl "McpServer\\|@modelcontextprotocol" --include=*.ts -l . 2>/dev/null | grep -v node_modules | head -40'
            )
        ).toEqual([]);
        expect(
            tags(
                'cd /Users/alice/app && rg -n "onNewIntent|session_secret" $(rg -l "class AuthActivity" . 2>/dev/null) 2>/dev/null | head -12'
            )
        ).toEqual([]);
        expect(tagsIn("/Users/alice/app", "rg -n Foo 2>/dev/null | head")).toEqual([]);
        expect(tagsIn("/Users/alice/app", "timeout 60 rg -l -F 'a(b' . 2>/dev/null | head")).toEqual([]);
    });

    it("the note stays for a protected folder, a pattern that can fail, a type flag or a named root", () => {
        for (const command of [
            "cd /System/Library/AssetsV2/persisted; timeout 60 rg -l -a 'UAF' . 2>/dev/null | head -5",
            'cd /Users/alice/app && rg -n "enum (Foo|Bar)" . 2>/dev/null | head',
            "cd /Users/alice/app && rg -n 'a\\y' . 2>/dev/null | head",
            "cd /Users/alice/app && rg -n foo -t rust . 2>/dev/null | head",
            "cd /Users/alice/app && rg -n foo src 2>/dev/null | head",
            "cd /Users/alice/app && grep -l foo . 2>/dev/null | head",
            "cd /Users/alice/app && grep -rl foo 2>/dev/null | head",
            "cd /Users/alice/app && rg -n foo $(git ls-files) 2>/dev/null | head",
            "rg -n foo . 2>/dev/null | head",
        ]) {
            expect(tags(command)).toEqual([`${READ}:context`]);
        }
    });

    it("a flag value that can be invalid keeps the note", () => {
        for (const command of [
            "rg -n foo -g '*.{ts' . 2>/dev/null | head",
            "rg -n foo --glob='[a' . 2>/dev/null | head",
            "rg -n foo --sort bogus . 2>/dev/null | head",
            "rg -n -A x foo . 2>/dev/null | head",
            "rg -n -m1x foo . 2>/dev/null | head",
            "rg -n --encoding utf8 foo . 2>/dev/null | head",
            "grep -rn -m x foo . 2>/dev/null | head",
            "grep -rn -d bogus foo . 2>/dev/null | head",
        ]) {
            expect(tagsIn("/Users/alice/app", command)).toEqual([`${READ}:context`]);
        }
    });

    it("a number, a plain glob or a known choice clears", () => {
        for (const command of [
            "rg -n -A 3 -m5 -g '!*.test.*' --glob=*.ts --sort path foo . 2>/dev/null | head",
            "grep -rn -m 5 --include=*.ts --exclude-dir=node_modules foo . 2>/dev/null | head",
        ]) {
            expect(tagsIn("/Users/alice/app", command)).toEqual([]);
        }
    });
});

describe("stderr-discarded-then-read: a strict JSON parser downstream shows the failure", () => {
    it("bun -e, node -e, deno eval or python3 -c that parses all of stdin", () => {
        for (const command of [
            "tools x list --json 2>/dev/null | bun -e 'const a=JSON.parse(await Bun.stdin.text()); console.log(a.length)' | head -20",
            "tools x list --json 2>/dev/null | bun -e 'const a=JSON.parse(await Bun.stdin.text()); console.log(a)' 2>&1 | head -20",
            'tools x 2>/dev/null | node -e \'const a=JSON.parse(require("fs").readFileSync(0, "utf8")); console.log(a)\' | head',
            "tools x 2>/dev/null | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' | head",
        ]) {
            expect(tags(command)).toEqual([]);
        }
    });

    it("the note stays for jq, for a parser that hides its own stderr, and for code that parses nothing", () => {
        for (const command of [
            "tools x list --json 2>/dev/null | jq '.[]' | head",
            "tools x list --json 2>/dev/null | bun -e 'JSON.parse(await Bun.stdin.text())' 2>/dev/null | head",
            "cmd 2>/dev/null | bun -e 'console.log(await Bun.stdin.text())' | head",
        ]) {
            expect(tags(command)).toEqual([`${READ}:context`]);
        }
    });

    it("the note stays for a parse that can be caught, has a fallback, or does not read stdin", () => {
        for (const command of [
            "tools x 2>/dev/null | bun -e 'let a=[]; try { a=JSON.parse(await Bun.stdin.text()) } catch {} console.log(a.length)' | head",
            "tools x 2>/dev/null | bun -e 'const a=JSON.parse(await Bun.stdin.text() || \"[]\"); console.log(a)' | head",
            "tools x 2>/dev/null | bun -e 'const c=JSON.parse(process.env.CFG||\"{}\"); process.stdout.write(await Bun.stdin.text())' | head",
            "tools x 2>/dev/null | python3 -c 'import json,sys\nfor l in sys.stdin:\n  try: print(json.loads(l))\n  except Exception: pass' | head",
        ]) {
            expect(tags(command)).toEqual([`${READ}:context`]);
        }
    });

    it("the parse error must reach the terminal", () => {
        expect(
            tags(
                "tools x 2>/dev/null | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).length)' 2>&1 | grep -E '^[0-9]+$' | head"
            )
        ).toEqual([`${READ}:context`]);
        expect(
            tags("tools x 2>/dev/null | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).length)' 2>&1 | head")
        ).toEqual([]);
        expect(
            tags("tools x 2>/dev/null | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).length)' |& head")
        ).toEqual([]);
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
            "cat /tmp/tasks/x.output 2>/dev/null; echo \"--- copy progress ---\"; find /Users/alice/.claude.bkp -type f 2>/dev/null | wc -l | tr -d ' '",
            [`${COUNT}:block`],
        ],
        ['echo "files: $(find /Users/alice/.claude.test.clone -type f 2>/dev/null | wc -l)"', [`${COUNT}:block`]],
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
            "echo \"=== all .har in Downloads ===\"; find /Users/alice/Downloads -maxdepth 1 -iname '*.har' 2>&1 | head -20; echo \"=== count ===\"; find /Users/alice/Downloads -maxdepth 1 -iname '*.har' 2>/dev/null | wc -l",
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
