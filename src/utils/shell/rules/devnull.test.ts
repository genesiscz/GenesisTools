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
const READ = "stderr-discarded-then-read";

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
            "ls ~/Library/Developer/CoreSimulator/Devices/ 2>/dev/null | wc -l; echo \"--- searching ---\"; fd -t d -H --max-depth 8 'ColMobile.app' ~/Library/Developer/CoreSimulator/Devices/ 2>&1 | head -20",
            [`${COUNT}:block`],
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
            "echo \"=== all .har in Downloads ===\"; find /Users/Martin/Downloads -maxdepth 1 -iname '*.har' 2>&1 | head -20; echo \"=== count ===\"; find /Users/Martin/Downloads -maxdepth 1 -iname '*.har' 2>/dev/null | wc -l",
            [`${COUNT}:block`],
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
        ["rg -l 'col-init' /repo --hidden -g '!node_modules' 2>/dev/null | head -8", [`${READ}:context`]],
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

        expect(text).toContain("[block] 2>/dev/null then a count: a failure is counted as 0");
        expect(text).toContain("permission error");
        expect(text).toContain("2>/tmp/err | wc -l; cat /tmp/err");
        expect(text).toContain("your command, corrected:\nls ~/Downloads/*.har | wc -l");
    });

    it("the read context says empty output may be an error", () => {
        const text = renderViolation(violation("ls x 2>/dev/null | head -3", READ) as ShellViolation);

        expect(text).toContain("[context]");
        expect(text).toContain("you cannot tell which happened");
    });
});
