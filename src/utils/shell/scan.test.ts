import { describe, expect, it } from "bun:test";
import { detectShellViolations } from "./rules";
import {
    commandTokenIndex,
    commandWord,
    lastSimpleCommandOnLine,
    originalSlice,
    scanShell,
    simpleCommandWord,
    splitPipeline,
    stripShellNoise,
    tokenize,
    wordsFrom,
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

    it("keeps a statement that starts with $(...), so the next one is not adjacent to the one before", () => {
        const outer = (command: string) => scanShell(command).units[0]?.map((unit) => unit.text.trim());

        expect(outer("$(ls a) && b")).toEqual(["$______", "b"]);
        // One word with a path glued to it, from the opening quote of a quoted one.
        expect(outer("$(npm bin)/biome check")).toEqual(["$_________/biome check"]);
        const quoted = 'cd x; "$(ls a)" | wc -l';
        expect(scanShell(quoted).units[0]?.[1]).toEqual({ text: "$_______  | wc -l", start: quoted.indexOf('"') });
        const escaped = 'bash -c "\\"$(ls a)\\" | wc -l"';
        expect(scanShell(escaped).units[2]?.[0]?.start).toBe(escaped.indexOf("\\"));
        // A substitution in an argument stays blank.
        expect(outer("echo $(ls a) && b")).toEqual(["echo", "b"]);
        expect(
            detectShellViolations("false | tail -1\n$(ls a) && echo $?").map((violation) => violation.ruleId)
        ).not.toContain("exit-code-after-pipeline");
        // The substitution's output is the left element: `$?` is tail's.
        expect(detectShellViolations("$(cmd) | tail -1; echo $?")[0]).toMatchObject({
            ruleId: "exit-code-after-pipeline",
            matched: "$(cmd) | tail -1",
        });
    });

    it("finds the command word of a statement that starts with $(...): glued to it, or the word after it", () => {
        const fired = (command: string) =>
            detectShellViolations(command).map(({ ruleId, matched, suggestion }) => ({ ruleId, matched, suggestion }));

        expect(fired("$(brew --prefix)/bin/rg -rn foo src")).toContainEqual({
            ruleId: "rg-replace-cluster",
            matched: "-rn",
            suggestion: "$(brew --prefix)/bin/rg -n foo src",
        });
        expect(fired("ls | $(brew --prefix)/bin/rg -rn x")).toContainEqual({
            ruleId: "rg-replace-cluster",
            matched: "-rn",
            suggestion: "ls | $(brew --prefix)/bin/rg -n x",
        });
        expect(fired("$(npm bin)/biome check --write --unsafe src")).toContainEqual({
            ruleId: "biome-unsafe-deletes-comments",
            matched: "$(npm bin)/biome check --write --unsafe src",
            suggestion: "$(npm bin)/biome check --write --unsafe --skip=correctness/noUnusedImports src",
        });

        for (const command of [
            "$(which bunx) biome check --write --unsafe src",
            '"$(which bunx)" biome check --write --unsafe src',
        ]) {
            expect(fired(command).map(({ ruleId }) => ruleId)).toContain("biome-unsafe-deletes-comments");
        }

        expect(fired("$(brew --prefix)/bin/find ~ -name x")).toContainEqual({
            ruleId: "find-from-root",
            matched: "$(brew --prefix)/bin/find ~ -name x",
            suggestion: "mdfind -name x",
        });
        expect(fired("$(brew --prefix)/bin/fd -H x ~").map(({ ruleId }) => ruleId)).toContain("find-from-root");
        expect(fired("$(brew --prefix)/bin/rg -l foo ~").map(({ ruleId }) => ruleId)).toContain("search-from-root");
    });

    it("starts the corrected command of a statement that starts with a quoted $(...) before its quote", () => {
        const pipefail = (command: string) =>
            detectShellViolations(command).find((violation) => violation.ruleId === "exit-code-after-pipeline");

        expect(pipefail('"$(cmd)" | tail -1; echo $?')).toMatchObject({
            matched: '"$(cmd)" | tail -1',
            suggestion: '(set -o pipefail; "$(cmd)" | tail -1); echo $?',
        });
        expect(pipefail('cd x && "$(which tsgo)" --noEmit 2>&1 | tail -5; echo "exit=$?"')?.suggestion).toBe(
            'cd x && (set -o pipefail; "$(which tsgo)" --noEmit 2>&1 | tail -5); echo "exit=$?"'
        );
        expect(pipefail('bash -c "\\"\\$(cmd)\\" | tail -1; echo \\$?"')?.suggestion).toBe(
            'bash -c "(set -o pipefail; \\"\\$(cmd)\\" | tail -1); echo \\$?"'
        );
        expect(
            detectShellViolations('"$(which ls)" missing 2>/dev/null | wc -l').find(
                (violation) => violation.ruleId === "stderr-discarded-then-counted"
            )?.matched
        ).toBe('"$(which ls)" missing 2>/dev/null | wc -l');
    });

    it("reads a double-quoted -c body and a backtick body with one level of escapes removed", () => {
        const body = (command: string) => scanShell(command).units[1]?.map(({ text, start }) => ({ text, start }));
        const command = 'bash -c "false | tail -1; echo \\$?"';

        expect(body(command)).toEqual([
            { text: "false | tail -1", start: command.indexOf("false") },
            // The backslash the outer shell removes is a blank, so every offset still points into the command.
            { text: "echo  $?", start: command.indexOf("echo") },
        ]);
        expect(body("echo `false | tail -1; echo \\$?`")?.[1]?.text).toBe("echo  $?");
        expect(body('zsh -c "ls \\"\\$d\\" 2>/dev/null | wc -l"')?.[0]?.text).toBe("ls    $d   2>/dev/null | wc -l");
        // A single-quoted body reaches its shell as typed: `\$?` stays a literal there.
        expect(body("bash -c 'false | tail -1; echo \\$?'")?.[1]?.text).toBe("echo   ?");
    });

    it("lets the rules see a pipeline's $? in an escaped double-quoted or backtick body", () => {
        const pipelineBy = (command: string) =>
            detectShellViolations(command).find((violation) => violation.ruleId === "exit-code-after-pipeline");

        expect(pipelineBy('bash -c "false | tail -1; echo \\$?"')).toMatchObject({
            matched: "false | tail -1",
            suggestion: 'bash -c "(set -o pipefail; false | tail -1); echo \\$?"',
        });
        expect(pipelineBy('zsh -c "false | tail -1; echo \\"rc=\\$?\\""')?.matched).toBe("false | tail -1");
        expect(pipelineBy("echo `false | tail -1; echo \\$?`")?.matched).toBe("false | tail -1");
        expect(pipelineBy("bash -c 'false | tail -1; echo \\$?'")).toBeUndefined();
        expect(pipelineBy("bash -c 'false | tail -1; echo $?'")?.matched).toBe("false | tail -1");
    });

    it("reads a `\\$` in a double-quoted body as the body shell's, and an unescaped `$` as the outer shell's", () => {
        const by = (command: string, ruleId: string) =>
            detectShellViolations(command).find((violation) => violation.ruleId === ruleId);

        expect(by('zsh -c "false | tail -1; echo \\$pipestatus[2]"', "pipestatus-index-mismatch")?.matched).toBe(
            "false | tail -1; echo \\$pipestatus[2]"
        );
        expect(by('zsh -c "false | tail -1; echo $pipestatus[2]"', "pipestatus-index-mismatch")).toBeUndefined();
        // The inserted `$` gets the backslash too, or the outer shell would expand it to nothing.
        expect(by('bash -c "false | rg x; echo \\$?"', "exit-code-after-grep")?.suggestion).toBe(
            'bash -c "false | rg x; echo \\$? left_exit=\\${PIPESTATUS[0]}"'
        );
        expect(by('zsh -c "false | rg x; rc=\\$?"', "exit-code-after-grep")?.suggestion).toBe(
            'zsh -c "false | rg x; rc=\\$? left_rc=\\${pipestatus[1]}"'
        );
        expect(by('zsh -c "false | rg x; rc=\\"\\$?\\""', "exit-code-after-grep")?.suggestion).toBe(
            'zsh -c "false | rg x; rc=\\"\\$?\\" left_rc=\\${pipestatus[1]}"'
        );

        // The outer shell expands these `$?` before the body runs, so pipefail in the body changes nothing.
        for (const command of [
            'bash -c "false | tail -1; echo $?"',
            'bash -c "false | tail -1; echo \\\\$?"',
            "bash <<EOF\nfalse | tail -1; echo $?\nEOF",
            'bash -c "git worktree remove /tmp/wt/x 2>&1 | tail -2; echo $?"; git worktree list | rg x',
        ]) {
            const ids = detectShellViolations(command).map(({ ruleId }) => ruleId);
            expect(ids.filter((id) => id.startsWith("exit-code-after-pipeline"))).toEqual([]);
        }

        expect(by("bash <<'EOF'\nfalse | tail -1; echo $?\nEOF", "exit-code-after-pipeline")?.matched).toBe(
            "false | tail -1"
        );
    });

    it("reports every heredoc body, and whether a shell reads it, in command offsets", () => {
        const command = "bash <<'EOF'\nfalse | tail -1\nEOF\ncat <<EOF\ndata\nEOF";
        const body = command.indexOf("false");
        const data = command.indexOf("data");

        expect(scanShell(command).heredocs).toEqual([
            {
                opener: command.indexOf("<<"),
                start: body,
                end: command.indexOf("\nEOF", body) + 1,
                quoted: true,
                fed: true,
            },
            { opener: command.lastIndexOf("<<"), start: data, end: data + "data\n".length, quoted: false, fed: false },
        ]);

        const nested = 'zsh -c \'bash <<X\nls\nX\'; bash -c "sh <<\\"Y\\"\nls\nY"';
        const heredocs = scanShell(nested).heredocs;

        expect(heredocs.map(({ start, end }) => nested.slice(start, end))).toEqual(["ls\n", "ls\n"]);
        expect(heredocs.map(({ opener, quoted, fed }) => [nested.slice(opener, opener + 2), quoted, fed])).toEqual([
            ["<<", false, true],
            ["<<", true, true],
        ]);

        // A `$(…)` in a double-quoted body is scanned with the command and with the body: one entry.
        const twice = "zsh -c \"x=$(bash <<'EOF'\nfalse | tail -1\nEOF\n)\"";
        expect(scanShell(twice).heredocs.map(({ opener }) => opener)).toEqual([twice.indexOf("<<")]);

        // Text that only looks like an operator opens none: quoted, in a comment, escaped, or in a body that is data.
        for (const text of ["echo 'cat <<EOF'\nx\nEOF", 'echo "<<EOF"\nx', "# cat <<EOF\nx", "echo \\<<EOF\nx"]) {
            expect(scanShell(text).heredocs).toEqual([]);
        }

        expect(scanShell("cat <<'A'\ncat <<B\nx\nA").heredocs.map(({ quoted, fed }) => [quoted, fed])).toEqual([
            [true, false],
        ]);
    });

    it("removes the escapes of every body around a nested body, outermost first", () => {
        // The outer zsh turns `\$` into `$`, so bash reads `echo $?`.
        const command = `zsh -c "bash -c 'false | tail -1; echo \\$?'"`;
        const inner = (text: string) => scanShell(text).units[2]?.map(({ text, start }) => ({ text, start }));

        expect(inner(command)).toEqual([
            { text: "false | tail -1", start: command.indexOf("false") },
            { text: "echo  $?", start: command.indexOf("echo") },
        ]);

        // A body in escaped double quotes loses one level for each shell around it: `\\\$` reaches bash as `$`.
        const escaped = String.raw`zsh -c "bash -c \"false | tail -1; echo \\\$?\""`;
        expect(inner(escaped)).toEqual([
            { text: "false | tail -1", start: escaped.indexOf("false") },
            { text: "echo    $?", start: escaped.indexOf("echo") },
        ]);
        // The inner body ends at its last character, before the backslash of its closing `\"`.
        expect(scanShell(escaped).executableRanges.map(({ start, end }) => escaped.slice(start, end))).toEqual([
            String.raw`bash -c \"false | tail -1; echo \\\$?\"`,
            String.raw`false | tail -1; echo \\\$?`,
        ]);

        // A single-quoted body inside a single-quoted one, or alone, keeps every backslash.
        expect(scanShell("bash -c 'false | tail -1; echo \\$?'").units[1]?.[1]?.text).toBe("echo   ?");
        expect(inner(`zsh -c 'bash -c "false | tail -1; echo \\$?"'`)?.[1]?.text).toBe("echo  $?");
    });

    it("reads `\\$` in an unquoted heredoc a shell reads as that shell's, and a quoted heredoc as typed", () => {
        const statements = (command: string) =>
            scanShell(command).units[0]?.map(({ text, start }) => ({ text, start }));
        const command = "bash <<EOF\nfalse | tail -1; echo \\$?\nEOF";

        // The outer shell removes the backslash, which stays a blank.
        expect(statements(command)).toEqual([
            { text: "bash", start: 0 },
            { text: "false | tail -1", start: command.indexOf("false") },
            { text: "echo  $?", start: command.indexOf("echo") },
        ]);
        expect(statements("bash <<'EOF'\nfalse | tail -1; echo \\$?\nEOF")?.[2]?.text).toBe("echo   ?");
        // `\\$(` is a backslash and a substitution the shell around runs, which stays a unit.
        expect(
            scanShell("bash <<EOF\nn=\\\\$(ls | tail -1)\nEOF")
                .units.flat()
                .map(({ text }) => text)
        ).toContain("ls | tail -1");
        // A heredoc that is data stays blank, escapes or not.
        expect(statements("cat <<EOF\nfalse | tail -1; echo \\$?\nEOF")?.map(({ text }) => text)).toEqual(["cat"]);
    });

    it("keeps a backtick substitution that starts a statement as one word, like a $(...)", () => {
        const outer = (command: string) => scanShell(command).units[0]?.map((unit) => unit.text.trim());

        expect(outer("`ls a` && b")).toEqual(["$_____", "b"]);
        expect(outer("x | `ls a` y")).toEqual(["x | $_____ y"]);
        const quoted = 'cd x; "`ls a`" | wc -l';
        expect(scanShell(quoted).units[0]?.[1]).toEqual({ text: "$______  | wc -l", start: quoted.indexOf('"') });
        // In an argument, quoted, or on a line of a heredoc that is data, a backtick span stays blank.
        expect(outer("echo `ls a` && b")).toEqual(["echo", "b"]);
        expect(outer("'`ls a`' x")).toEqual(["x"]);
        expect(outer("cat <<EOF\n`ls a` x\nEOF")).toEqual(["cat"]);
        expect(
            scanShell("cat <<EOF\n`ls a` x\nEOF")
                .units.flat()
                .map(({ text }) => text)
        ).toContain("ls a");
        // In a -c body and in a heredoc a shell reads, it starts a statement there.
        expect(scanShell("bash -c '`ls a` x'").units[1]?.[0]?.text).toBe("$_____ x");
        expect(outer("bash <<'EOF'\n`ls a` x\nEOF")).toEqual(["bash", "$_____ x"]);

        expect(
            detectShellViolations("false | tail -1\n`ls a` && echo $?").map((violation) => violation.ruleId)
        ).not.toContain("exit-code-after-pipeline");
        expect(
            detectShellViolations('"`cmd`" | tail -1; echo $?').find(
                (violation) => violation.ruleId === "exit-code-after-pipeline"
            )
        ).toMatchObject({ matched: '"`cmd`" | tail -1', suggestion: '(set -o pipefail; "`cmd`" | tail -1); echo $?' });
    });

    it("names the command a `which` or `command -v` substitution at a statement start prints", () => {
        const outer = (command: string) => scanShell(command).units[0]?.map((unit) => unit.text.trim());
        const fired = (command: string) =>
            detectShellViolations(command).map(({ ruleId, matched, suggestion }) => ({ ruleId, matched, suggestion }));

        expect(outer("`which rg` -rn foo src")).toEqual(["$______/rg -rn foo src"]);
        expect(outer("$(which rg) -rn foo src")).toEqual(["$_______/rg -rn foo src"]);

        for (const [command, suggestion] of [
            ["`which rg` -rn foo src", "`which rg` -n foo src"],
            ["$(which rg) -rn foo src", "$(which rg) -n foo src"],
            ['"$(command -v rg)" -rn foo', '"$(command -v rg)" -n foo'],
            ["bash -c '`which rg` -rn x'", "bash -c '`which rg` -n x'"],
        ]) {
            expect(fired(command)).toContainEqual({ ruleId: "rg-replace-cluster", matched: "-rn", suggestion });
        }

        // Any other substitution names nothing: the word after it stands for the command.
        expect(outer("$(brew --prefix rg) -rn x")).toEqual([`$${"_".repeat(18)} -rn x`]);
        expect(fired("$(which bunx) biome check --write --unsafe src").map(({ ruleId }) => ruleId)).toContain(
            "biome-unsafe-deletes-comments"
        );
    });

    it("reads >| and zsh's >>|, &>| and >&| as a redirection, never as a pipe", () => {
        const elements = (command: string) =>
            scanShell(command).units[0]?.flatMap((statement) => splitPipeline(statement).map(({ text }) => text));
        const pipeline = (command: string) =>
            detectShellViolations(command).find((violation) => violation.ruleId === "exit-code-after-pipeline");

        expect(elements("git show main:a.ts >| a.ts")).toEqual(["git show main:a.ts >  a.ts"]);
        expect(elements("cmd >| out; echo $?")).toEqual(["cmd >  out", "echo $?"]);
        expect(elements("a 2>|e >>|d &>|b >&|c | wc")).toEqual(["a 2> e >> d &> b >& c", "wc"]);
        // An escaped or quoted `>` leaves a real pipe.
        expect(elements("echo \\>|cat")).toEqual(["echo", "cat"]);
        expect(elements('echo ">"|cat')).toEqual(["echo", "cat"]);

        expect(pipeline("cmd >| tail; echo $?")).toBeUndefined();
        expect(pipeline("cmd | tail -1 >| out; echo $?")).toMatchObject({
            matched: "cmd | tail -1 >| out",
            suggestion: "(set -o pipefail; cmd | tail -1 >| out); echo $?",
        });
    });

    it("finds the bodies of an unquoted heredoc a shell reads in the text that shell reads", () => {
        const fired = (command: string) =>
            detectShellViolations(command).map(({ ruleId, matched, suggestion }) => ({ ruleId, matched, suggestion }));
        // The outer shell turns `\`` into a backtick, so bash runs `rg` in a substitution of its own.
        const command = "bash <<EOF\nx=\\`rg -rn foo src\\`\nEOF";
        const scan = scanShell(command);

        expect(scan.executableRanges.map(({ start, end }) => command.slice(start, end))).toEqual(["rg -rn foo src"]);
        expect(scan.units.flat().map(({ text }) => text)).toContain("rg -rn foo src");
        expect(fired(command)).toContainEqual({
            ruleId: "rg-replace-cluster",
            matched: "-rn",
            suggestion: "bash <<EOF\nx=\\`rg -n foo src\\`\nEOF",
        });
        expect(fired("bash <<EOF\nx=\\`ls 2>/dev/null | wc -l\\`\nEOF").map(({ ruleId }) => ruleId)).toContain(
            "stderr-discarded-then-counted"
        );
        expect(fired("bash <<EOF\n\\`which rg\\` -rn foo src\nEOF")).toContainEqual({
            ruleId: "rg-replace-cluster",
            matched: "-rn",
            suggestion: "bash <<EOF\n\\`which rg\\` -n foo src\nEOF",
        });

        // A `-c` body on a line of it loses the heredoc's escapes first, then its own.
        const nested = 'bash <<EOF\nzsh -c "false | tail -1; echo \\\\\\$?"\nEOF';
        expect(scanShell(nested).units[1]?.map(({ text }) => text)).toEqual([
            "false | tail -1",
            `echo${" ".repeat(4)}$?`,
        ]);

        // A `$(…)` the outer shell runs keeps its own escapes: `\$?` is a literal there.
        const substitution = "bash <<EOF\necho $(ls | tail -1; echo \\$?)\nEOF";
        expect(scanShell(substitution).units[1]?.map(({ text }) => text)).toEqual(["ls | tail -1", "echo   ?"]);
    });

    it("reveals the -c body of a shell named by a backtick lookup, as it does for $(...)", () => {
        const fired = (command: string) => detectShellViolations(command).map(({ ruleId }) => ruleId);

        for (const command of ["`which bash` -c 'rg -rn x'", "$(which bash) -c 'rg -rn x'"]) {
            expect(scanShell(command).executableRanges).toHaveLength(command.startsWith("`") ? 2 : 1);
            expect(fired(command)).toContain("rg-replace-cluster");
        }

        expect(fired("`which bash` -c 'false | tail -1; echo $?'")).toContain("exit-code-after-pipeline");
        // A lookup in escaped backticks inside a double-quoted body names the command too.
        expect(
            detectShellViolations('bash -c "\\`which rg\\` -rn x"').find(
                ({ ruleId }) => ruleId === "rg-replace-cluster"
            )
        ).toMatchObject({ matched: "-rn", suggestion: 'bash -c "\\`which rg\\` -n x"' });
    });

    it("leaves an empty substitution glued to a word unmarked, since the word is the command", () => {
        for (const command of ["``rg -rn x", "$()rg -rn x"]) {
            expect(detectShellViolations(command).find(({ ruleId }) => ruleId === "rg-replace-cluster")).toMatchObject({
                matched: "-rn",
                suggestion: command.replace("-rn", "-n"),
            });
        }

        // An empty one alone still keeps its statement, so the next one is not adjacent to the one before.
        expect(scanShell("false | tail -1; $(); echo $?").units[0]?.map(({ text }) => text)).toEqual([
            "false | tail -1",
            "$__",
            "echo $?",
        ]);
    });

    it.skipIf(!Bun.which("zsh"))("builds corrected commands for nested bodies that zsh parses", () => {
        const commands = [
            String.raw`zsh -c "bash -c \"false | tail -1; echo \\\$?\""`,
            'bash -c "x=\\`false | tail -1; echo \\$?\\`"',
            'bash <<EOF\nzsh -c "false | tail -1; echo \\\\\\$?"\nEOF',
            "bash <<EOF\nzsh -c 'false | tail -1; echo \\$?'\nEOF",
            'bash -c "bash <<EOF\nfalse | tail -1; echo \\\\\\$?\nEOF"',
            "bash <<EOF\necho \\$(false | tail -1; echo \\$?)\nEOF",
            "bash <<EOF\nx=\\`rg -rn foo src\\`\nEOF",
            "bash <<EOF\n\\`which rg\\` -rn foo src\nEOF",
            "`which bash` -c 'false | tail -1; echo $?'",
            '"`cmd`" | tail -1; echo $?',
            "``rg -rn x",
        ];
        const suggestions = commands.flatMap((command) =>
            detectShellViolations(command).flatMap(({ suggestion }) => (suggestion ? [suggestion] : []))
        );

        expect(suggestions.length).toBeGreaterThanOrEqual(commands.length);
        // One zsh for all of them: each in a function of its own, so the first error names its line.
        const script = suggestions.map((suggestion, k) => `f${k}() {\n${suggestion}\n}`).join("\n");
        const result = Bun.spawnSync(["zsh", "-n", "-c", script], { env: process.env });

        expect([result.exitCode, result.stderr.toString()]).toEqual([0, ""]);
    });
});

describe("wordsFrom", () => {
    const words = (command: string, after: string, max?: number) => {
        const scan = scanShell(command);
        return wordsFrom(scan, command.indexOf(after) + after.length, max).words;
    };

    it("cuts at an unquoted operator and at the end of the body that holds the start", () => {
        expect(words("find ~ -maxdepth 1;echo", "-maxdepth")).toEqual(["1"]);
        expect(words("(find ~ -maxdepth 1) && ls", "-maxdepth")).toEqual(["1"]);
        expect(words("bash -c 'tools rm approve --help' && ls x", "approve")).toEqual(["--help"]);
        // The outer shell removes the backslashes, and the body's shell the quotes.
        expect(words('zsh -c "biome --only \\"$R\\""', "--only")).toEqual(["$R"]);
        expect(words("x --only a|tail", "--only")).toEqual(["a"]);
        expect(words("x --only a # note", "--only")).toEqual(["a"]);
        // A start on a body's closing quote is past the body; one right after an unquoted body reads on.
        expect(words("zsh -c 'biome' && ls", "biome")).toEqual([]);
        expect(words("bash -c ls 2>/dev/null", "-c ls")).toEqual(["2>/dev/null"]);
    });

    it("removes quotes, keeps $, substitutions and backticks whole, and splits a word from a glued redirection", () => {
        expect(words("x --only 'a b' \"c\"d e", "--only")).toEqual(["a b", "cd", "e"]);
        expect(words("x --only $R `r` $(cat f) ${a:-b c}", "--only")).toEqual(["$R", "`r`", "$(cat f)", "${a:-b c}"]);
        expect(words("x approve 2>&1 &>/dev/null >log abc", "approve")).toEqual(["2>&1", "&>/dev/null", ">log", "abc"]);
        expect(words("x --only=a>/tmp/log b", "x")).toEqual(["--only=a", ">/tmp/log", "b"]);
        expect(words("x --only a b c", "--only", 1)).toEqual(["a"]);
    });

    it("keeps zsh's numeric glob in its word, while a glued redirection still splits", () => {
        expect(words("ls file<1-3>.ts <->x b", "ls")).toEqual(["file<1-3>.ts", "<->x", "b"]);
        expect(words("ls a<b >c", "ls")).toEqual(["a", "<b", ">c"]);
    });

    it("keeps the | of >| in the redirection, and reads a nested body with the escapes of every body around it", () => {
        expect(words("ls >|out | wc", "ls")).toEqual([">|out"]);
        expect(words("ls >| out >&|e | wc", "ls")).toEqual([">|", "out", ">&|e"]);
        expect(words("echo \\>|cat", "echo")).toEqual([">"]);
        expect(words(`zsh -c "bash -c 'tools rm \\$f \\"a b\\"'"`, "rm")).toEqual(["$f", "a b"]);
    });

    it("says whether the words end at |&", () => {
        const command = "ls a |& wc -l; ls b | wc -l";
        const scan = scanShell(command);

        expect(wordsFrom(scan, 0).pipesStderr).toBe(true);
        expect(wordsFrom(scan, command.indexOf("ls b")).pipesStderr).toBe(false);
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

    it("passes a word that is only a substitution, as typed or as marked at a statement start", () => {
        const index = (...words: string[]) => commandTokenIndex(words.map((text) => ({ text, start: 0 })));

        expect(index("$(which ls)", "missing")).toBe(1);
        expect(index("$__________", "biome")).toBe(1);
        expect(index("$__________")).toBe(-1);
        expect(index("$_________/biome", "check")).toBe(0);
        expect(index("$HOME/bin/rg", "x")).toBe(0);
    });

    it("reads a wrapper's value-taking options per wrapper, so `sudo -n` does not eat the command", () => {
        const commandAfter = (command: string): string | undefined => {
            const [statement] = scanShell(command).units[0] ?? [];

            if (!statement) {
                throw new Error("expected one statement");
            }

            const tokens = tokenize(statement);
            return tokens[commandTokenIndex(tokens, command)]?.text;
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
        // A quoted value is blanked by the scanner; it is still the option's value, not the command.
        expect(commandAfter("xargs -J '%' rm %")).toBe("rm");
        expect(commandAfter('xargs -I "{}" rm "{}"')).toBe("rm");
        expect(commandAfter("xargs --max-args '1' rm")).toBe("rm");
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

describe("simpleCommandWord", () => {
    it("reads a quoted wrapper value as typed when given the span and the command", () => {
        const command = "env -u 'X' tail -1";
        const scan = scanShell(command);
        const [element] = scan.units[0] ?? [];
        expect(simpleCommandWord(element ?? { text: "", start: 0 }, command)).toBe("tail");
        expect(simpleCommandWord("ls -la")).toBe("ls");
    });
});
