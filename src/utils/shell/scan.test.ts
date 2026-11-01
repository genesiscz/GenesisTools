import { describe, expect, it } from "bun:test";
import { detectShellViolations } from "./rules";
import {
    commandTokenIndex,
    commandWord,
    lastSimpleCommandOnLine,
    originalSlice,
    scanShell,
    splitPipeline,
    stripShellNoise,
    tokenize,
} from "./scan";

describe("lastSimpleCommandOnLine", () => {
    it("retains fully quoted commands and ignores comment-only trailing spans", () => {
        const command = '"/opt/my launcher" "--permission-mode" "plan"';
        expect(lastSimpleCommandOnLine(`echo --no-chrome&&${command}; # ignored | text`)).toBe(command);
        expect(lastSimpleCommandOnLine(`printf data|&${command}`)).toBe(command);
        expect(lastSimpleCommandOnLine(command)).toBe(command);
        expect(lastSimpleCommandOnLine('# "launcher" --chrome')).toBe("");
    });
});

describe("scanShell", () => {
    it("keeps the original command beside the cleaned one", () => {
        const scan = scanShell("git status | rg foo | head -3");

        expect(scan.command).toBe("git status | rg foo | head -3");
        expect(scan.cleaned).toBe("git status | rg foo | head -3");
    });

    it("blanks quoted text so a rule cannot match inside a string", () => {
        const scan = scanShell(`echo "rm -rf /" && ls`);

        // The quoted payload is blanked, not removed: offsets into `command` stay valid.
        expect(scan.cleaned).toHaveLength(scan.command.length);
        expect(scan.cleaned).not.toContain("rm -rf /");
        expect(scan.cleaned).toContain("echo");
    });

    it("survives an unbalanced quote without throwing", () => {
        expect(() => scanShell("echo 'unterminated")).not.toThrow();
    });

    it("splits the outer command into statements", () => {
        const scan = scanShell("a && b; c");

        expect(scan.units).toHaveLength(1);
        expect(scan.units[0]?.length).toBe(3);
    });

    it("treats a command substitution as its own unit", () => {
        const scan = scanShell("echo $(git rev-parse HEAD)");

        expect(scan.units.length).toBeGreaterThan(1);
    });

    it("treats backticks and literal shell command arguments as executable units", () => {
        const command = "echo `git status`; bash -lc 'git diff --stat'";
        const scan = scanShell(command);
        const statements = scan.units.flat().map((unit) => ({ text: unit.text, start: unit.start }));

        expect(statements).toContainEqual({ text: "git status", start: command.indexOf("git status") });
        expect(statements).toContainEqual({ text: "git diff --stat", start: command.indexOf("git diff --stat") });
    });

    it("leaves backticks in a comment or a quoted-delimiter heredoc as data", () => {
        const texts = (command: string) =>
            scanShell(command)
                .units.flat()
                .map((unit) => unit.text.trim());

        expect(texts("echo ok # `git restore fixture.ts`")).not.toContain("git restore fixture.ts");
        expect(texts("cat <<'EOF'\nrun `git restore fixture.ts` to reset\nEOF\necho done")).not.toContain(
            "git restore fixture.ts"
        );
        expect(texts("cat <<EOF\n`git restore fixture.ts`\nEOF")).toContain("git restore fixture.ts");
        expect(texts("bash <<'EOF'\necho `git restore fixture.ts`\nEOF")).toContain("git restore fixture.ts");
    });
});

describe("the helpers the rules match with", () => {
    it("splits a pipeline into its elements", () => {
        const [statement] = scanShell("git status | rg foo | head -3").units[0] ?? [];

        if (!statement) {
            throw new Error("expected one statement");
        }

        expect(splitPipeline(statement)).toHaveLength(3);
    });

    it("finds the command word past a wrapper", () => {
        expect(commandWord("/usr/bin/rg")).toBe("rg");
        expect(commandWord("rg")).toBe("rg");
    });

    it("points at the real command, not at `sudo` or `timeout`", () => {
        const [statement] = scanShell("sudo timeout 5 rg foo").units[0] ?? [];

        if (!statement) {
            throw new Error("expected one statement");
        }

        const tokens = tokenize(statement);

        expect(commandTokenIndex(tokens)).toBeGreaterThan(0);
    });

    it("reads a wrapper's value-taking options per wrapper, so `sudo -n` does not eat the command", () => {
        const commandAfter = (command: string): string | undefined => {
            const [statement] = scanShell(command).units[0] ?? [];

            if (!statement) {
                throw new Error("expected one statement");
            }

            const tokens = tokenize(statement);
            return tokens[commandTokenIndex(tokens)]?.text;
        };

        expect(commandAfter("sudo -n git checkout -- a.ts")).toBe("git");
        expect(commandAfter("sudo -k -s git status")).toBe("git");
        expect(commandAfter("sudo -u deploy git status")).toBe("git");
        expect(commandAfter("nice -n 10 git status")).toBe("git");
        expect(commandAfter("xargs -n 1 git rm")).toBe("git");
        // GNU long options with a separate value, an unambiguous prefix of one, and `--name=value`.
        expect(commandAfter("xargs --max-args 1 rm -f")).toBe("rm");
        expect(commandAfter("xargs --max-procs 4 --delimiter , rm")).toBe("rm");
        expect(commandAfter("xargs --arg-file list.txt rm")).toBe("rm");
        expect(commandAfter("xargs --max-a 1 rm")).toBe("rm");
        expect(commandAfter("xargs --max-args=1 --null rm")).toBe("rm");
        // An option with an optional value, or none, never eats the command; neither does GNU's -l.
        expect(commandAfter("xargs --no-run-if-empty rm")).toBe("rm");
        expect(commandAfter("xargs -l rm")).toBe("rm");
        expect(commandAfter("xargs -J % rm % /tmp/x")).toBe("rm");
        expect(commandAfter("xargs -- rm -rf")).toBe("rm");
    });
});

describe("originalSlice", () => {
    const sliceOf = (command: string, from: string, to: string = from): string => {
        const start = command.indexOf(from);
        return originalSlice(scanShell(command), start, command.indexOf(to, start) + to.length);
    };
    const matchedBy = (command: string, ruleId: string): string | undefined =>
        detectShellViolations(command).find((violation) => violation.ruleId === ruleId)?.matched;

    it("keeps a quoted last argument outside an executable body", () => {
        expect(sliceOf("log show --predicate 'x'", "log", "--predicate")).toBe("log show --predicate 'x'");
        expect(matchedBy("log show --predicate 'x'", "bare-log-command")).toBe("log show --predicate 'x'");
        expect(sliceOf("ls 'a b' | wc -l", "ls")).toBe("ls 'a b'");
    });

    it("ends at the span's own statement inside a -c body, where the whole body is blank in the outer text", () => {
        expect(sliceOf(`zsh -c 'git checkout -- f; echo done; cat f'`, "git", "-- f")).toBe("git checkout -- f");
        expect(sliceOf(`bash -c 'ls a 2>/dev/null | wc -l && echo hi'`, "ls a", "-l")).toBe("ls a 2>/dev/null | wc -l");
        expect(sliceOf(`zsh -c 'log show --predicate "x"\necho next'`, "log", "--predicate")).toBe(
            'log show --predicate "x"'
        );
        expect(sliceOf(`zsh -c '(set -o pipefail; false | tail -1); echo "rc=$?"'`, "false", "-1")).toBe(
            "false | tail -1"
        );
    });

    it("ends at the span's own statement in a body nested in another body", () => {
        const command = `zsh -c 'bash -c "git restore f; ls" ; echo outer'`;
        expect(sliceOf(command, "git", "restore f")).toBe("git restore f");
    });

    it("never returns the body's closing quote for an empty tail at the body's end", () => {
        const command = "zsh -c 'git restore --'";
        const end = command.indexOf("--") + 2;
        expect(originalSlice(scanShell(command), end, end)).toBe("");
    });

    it("carries a quoted $(...) at the end of a statement up to its closing quote", () => {
        const command = `git show HEAD:$f 2>/dev/null | rg -c -F "$(sed -n "\${n}p" $f)" ; done`;
        expect(sliceOf(command, "git", "-F")).toBe(`git show HEAD:$f 2>/dev/null | rg -c -F "$(sed -n "\${n}p" $f)"`);
        expect(sliceOf("echo $(\n  date\n) | wc -l", "echo")).toBe("echo $(\n  date\n)");
    });

    it("stays inside the command substitution a span sits in", () => {
        const command = `echo "n=$(ls 2>/dev/null | wc -l)"; ls`;
        expect(sliceOf(command, "ls 2>", "-l")).toBe("ls 2>/dev/null | wc -l");
    });

    it("gives the rules a matched excerpt that is exactly the offending statement", () => {
        expect(
            matchedBy(`zsh -c 'false | tail -1; echo "rc=$?"; cd /tmp; echo done'`, "exit-code-after-pipeline")
        ).toBe("false | tail -1");
        expect(matchedBy(`bash -c 'false | tail -1; echo rc=$?'`, "exit-code-after-pipeline")).toBe("false | tail -1");
        expect(matchedBy(`zsh -c 'ls a 2>/dev/null | wc -l; echo hi; ls b'`, "stderr-discarded-then-counted")).toBe(
            "ls a 2>/dev/null | wc -l"
        );
        expect(matchedBy(`zsh -c 'git checkout -- f; echo done; cat f'`, "git-checkout-overwrites-file")).toBe(
            "git checkout -- f"
        );
        // Logged case 148: the excerpt stopped at the opening quote of the `$(...)` argument.
        const loop =
            'for spec in "a.ts:3"; do f=${spec%:*}; n=${spec##*:}; git show HEAD:$f 2>/dev/null | rg -c -F "$(sed -n "${n}p" $f)" ; done';
        expect(matchedBy(loop, "stderr-discarded-then-counted")).toBe(
            'git show HEAD:$f 2>/dev/null | rg -c -F "$(sed -n "${n}p" $f)"'
        );
        expect(matchedBy("command log show --predicate 'x' | tail -3; echo $?", "exit-code-after-pipeline")).toBe(
            "command log show --predicate 'x' | tail -3"
        );
    });

    it("stops before a comment, in a -c body and outside one", () => {
        expect(sliceOf("false | tail -1 # c\necho $?", "false", "-1")).toBe("false | tail -1");
        expect(sliceOf(`zsh -c 'false | tail -1 # c\necho $?'`, "false", "-1")).toBe("false | tail -1");
        expect(sliceOf(`zsh -c 'false | tail -1 "$(date)" # note\necho $?'`, "false", "-1")).toBe(
            'false | tail -1 "$(date)"'
        );
        expect(matchedBy(`zsh -c 'git checkout -- f # undo\necho done'`, "git-checkout-overwrites-file")).toBe(
            "git checkout -- f"
        );
    });

    it("keeps a # that is quoted, escaped or inside a word", () => {
        expect(sliceOf("log show --predicate 'a #b'", "log", "--predicate")).toBe("log show --predicate 'a #b'");
        expect(sliceOf(`zsh -c 'ls "a #b" | wc -l; ls'`, "ls", "-l")).toBe(`ls "a #b" | wc -l`);
        expect(sliceOf("ls a \\#b 'x' | wc -l", "ls", "\\#b")).toBe("ls a \\#b 'x'");
        expect(sliceOf("ls a#b 'x' | wc -l", "ls", "a#b")).toBe("ls a#b 'x'");
    });

    it("drops a line continuation that ends the excerpt", () => {
        expect(sliceOf("false | tail -1 'x' \\\n  && echo $?", "false", "-1")).toBe("false | tail -1 'x'");
        expect(sliceOf(`zsh -c 'false | tail -1 "x" \\\n && echo $?'`, "false", "-1")).toBe('false | tail -1 "x"');
    });

    it("reads a double-quoted -c body with its escapes removed, so an escaped $(...) argument stays whole", () => {
        expect(
            matchedBy(`zsh -c "git checkout -- \\"\\$(git ls-files -m)\\"; echo done"`, "git-checkout-overwrites-file")
        ).toBe(`git checkout -- \\"\\$(git ls-files -m)\\"`);
        expect(
            matchedBy(`zsh -c "ls 2>/dev/null | wc -l \\"\\$(cat x)\\"; echo done"`, "stderr-discarded-then-counted")
        ).toBe(`ls 2>/dev/null | wc -l \\"\\$(cat x)\\"`);
        // `\` + newline inside double quotes joins the lines; the excerpt still maps back to the raw text.
        expect(sliceOf(`bash -c "ls a 2>/dev/null | wc -l \\"x\\" \\\n && echo hi"`, "ls a", "-l")).toBe(
            `ls a 2>/dev/null | wc -l \\"x\\"`
        );
    });

    it("gives git the path list of its own statement only", () => {
        const command = `zsh -c 'git checkout -- f; echo done; cat f'`;
        const afterDashes = command.indexOf("--") + 2;
        expect(originalSlice(scanShell(command), afterDashes, afterDashes + 2)).toBe(" f");
    });

    it("builds corrected commands that keep the rest of the -c body after the excerpt", () => {
        const suggestionBy = (command: string, ruleId: string): string | undefined =>
            detectShellViolations(command).find((violation) => violation.ruleId === ruleId)?.suggestion;

        expect(
            suggestionBy(`zsh -c 'false | tail -1; echo "rc=$?"; cd /tmp; echo done'`, "exit-code-after-pipeline")
        ).toContain(`false | tail -1); echo "rc=$?"; cd /tmp; echo done'`);
        // The subshell closes before the comment, so the corrected command parses.
        expect(suggestionBy(`zsh -c 'false | tail -1 # c\necho $?'`, "exit-code-after-pipeline")).toContain(
            "false | tail -1) # c\necho $?'"
        );
        expect(suggestionBy("false | tail -1 # c\necho $?", "exit-code-after-pipeline")).toContain(
            "false | tail -1) # c\necho $?"
        );
        expect(suggestionBy("false | tail -1 'x' \\\n  && echo $?", "exit-code-after-pipeline")).toContain(
            "false | tail -1 'x') \\\n  && echo $?"
        );
        const git = suggestionBy(`zsh -c 'git checkout -- f; echo done; cat f'`, "git-checkout-overwrites-file");
        expect(git).toContain("-- f");
        expect(git?.match(/echo done/g)?.length ?? 0).toBeLessThanOrEqual(1);
        // An empty path list after `--`: no suggestion, instead of one that stashes the body's closing quote.
        expect(suggestionBy("zsh -c 'git restore --'", "git-checkout-overwrites-file")).toBeUndefined();
    });

    it("marks a comment only when asked, and keeps the cleaned length", () => {
        expect(stripShellNoise("ls # c")).toBe(`ls${" ".repeat(4)}`);
        expect(stripShellNoise("ls # c", "#")).toBe("ls #  ");
        expect(stripShellNoise("ls 'a # b' # c", "#")).toBe(`ls${" ".repeat(9)}#  `);
    });
});

describe("the cleaned text is always the same length as the command", () => {
    const cases = [
        'echo "a\\',
        "echo 'a",
        'echo "a\\" b"',
        "echo a\\",
        'echo "$(date)" | tail -3',
        "cmd <<'EOF'\nbody\nEOF",
        "echo `date`",
        'echo "nested \\"quotes\\" here"',
    ];

    it.each(cases)("holds for %j", (command) => {
        // Every offset a rule reports is an index into the ORIGINAL command, and the file's
        // header states that invariant. A trailing backslash inside an unterminated double
        // quote used to emit two blanks for one source character.
        expect(scanShell(command).cleaned).toHaveLength(command.length);
    });
});
