import { describe, expect, it } from "bun:test";
import { findRules } from "./find";
import { detectShellViolations, type ShellViolation } from "./index";

function only(command: string): ShellViolation | undefined {
    return detectShellViolations(command, findRules)[0];
}

function fires(command: string): boolean {
    return only(command) !== undefined;
}

describe("find-from-root: fires", () => {
    const roots = [
        "/",
        "~",
        "~/",
        "$HOME",
        "$HOME/",
        "${HOME}",
        "/Users/jdoe",
        "/Users/jdoe/",
        "/Users/alice",
        "/home/alice",
    ];

    for (const root of roots) {
        it(`find ${root} -name x`, () => {
            expect(fires(`find ${root} -name x`)).toBe(true);
        });

        it(`fd pattern ${root}`, () => {
            expect(fires(`fd pattern ${root}`)).toBe(true);
        });
    }

    it("the CLAUDE.md example, with -maxdepth and the usual tail", () => {
        const v = only("find ~ -iname 'report.har' 2>/dev/null | head");

        expect(v?.ruleId).toBe("find-from-root");
        expect(v?.severity).toBe("block");
        expect(v?.matched).toBe("find ~ -iname 'report.har' 2>/dev/null");
        expect(v?.index).toBe(0);
        expect(v?.suggestion).toBe("mdfind -name 'report.har'");
    });

    it("find with -H/-L/-P before the path", () => {
        expect(fires("find -L / -name x")).toBe(true);
        expect(fires("find -H ~ -type f")).toBe(true);
    });

    it("find with several paths where one is a root", () => {
        expect(fires("find /tmp / -name x")).toBe(true);
    });

    it("fd with the root named by --search-path or --base-directory", () => {
        expect(fires("fd --search-path ~ pattern")).toBe(true);
        expect(fires("fd --base-directory / x")).toBe(true);
        expect(fires("fd --search-path=~ pattern")).toBe(true);
        expect(fires("fd --search-path src pattern")).toBe(false);
    });

    it("fd with value flags before the pattern and a root path after", () => {
        expect(fires("fd -e ts -t f pattern ~")).toBe(true);
        expect(fires("fd --max-depth 3 --hidden 'x' /Users/jdoe")).toBe(true);
    });

    it("fd with a root as the second positional and no -name to suggest", () => {
        const v = only("fd -H '.har' ~");

        expect(v?.matched).toBe("fd -H '.har' ~");
        expect(v?.suggestion).toBeUndefined();
    });

    it("through wrappers, in a pipeline, in a substitution", () => {
        expect(fires("sudo find / -name x")).toBe(true);
        expect(fires("timeout 30 find ~ -name x | head")).toBe(true);
        expect(fires('n=$(find ~ -name "*.har" | wc -l)')).toBe(true);
        expect(fires("cd /tmp; find / -name x")).toBe(true);
    });

    it("matched covers the find element only, not the rest of the pipeline", () => {
        const command = "find / -name x 2>&1 | head -5";

        expect(only(command)?.matched).toBe("find / -name x 2>&1");
    });
});

describe("find-from-root: does not fire", () => {
    it("scoped paths", () => {
        expect(fires("find ~/Downloads -maxdepth 2 -iname 'report.har'")).toBe(false);
        expect(fires("find . -name '*.ts'")).toBe(false);
        expect(fires("find /tmp -mtime -1")).toBe(false);
        expect(fires("find /Users/jdoe/Projects -type d")).toBe(false);
        expect(fires("find /Users/jdoe/.claude.bkp -type f")).toBe(false);
        expect(fires("find $HOME/.codex -name x")).toBe(false);
        expect(fires("find ${HOME}/.codex -name x")).toBe(false);
        expect(fires("fd pattern ~/Projects")).toBe(false);
        expect(fires("fd -e ts foo src")).toBe(false);
        expect(fires("fd foo")).toBe(false);
    });

    it('a quoted path is read as typed, so "$HOME/.codex" is not the home root', () => {
        expect(fires('find "$HOME/.codex/sessions" -name "*.jsonl"')).toBe(false);
        expect(fires("find '$HOME/.codex' -name x")).toBe(false);
        expect(fires('fd -e jsonl . "$HOME/.claude/projects"')).toBe(false);
    });

    it("a double-quoted $HOME still expands, so it is still a root; single quotes make it a literal name", () => {
        expect(fires('find "$HOME" -name x')).toBe(true);
        expect(fires("find '$HOME' -name x")).toBe(false);
    });

    it("known gap: a fully quoted literal root leaves no token and is not seen", () => {
        expect(fires('find "/" -name x')).toBe(false);
        expect(fires("find '/Users/jdoe' -name x")).toBe(false);
    });

    it("the -name value survives its quotes in the suggestion", () => {
        expect(only('find / -name "*.har"')?.suggestion).toBe('mdfind -name "*.har"');
        expect(only("find ~ -type f -iname 'a b.txt' -print")?.suggestion).toBe("mdfind -name 'a b.txt'");
        expect(only("find ~ -name x")?.suggestion).toBe("mdfind -name x");
    });

    it("inside a zsh -c body the -name value loses the body's escapes, and a value the inner shell expands gives none", () => {
        expect(only('zsh -c "find ~ -name \\"*.ts\\""')?.suggestion).toBe("mdfind -name '*.ts'");
        expect(only("bash -c 'find / -iname \"a b.txt\"'")?.suggestion).toBe("mdfind -name 'a b.txt'");
        expect(only('zsh -c "find ~ -name \\"$P\\""')?.suggestion).toBeUndefined();
    });

    it("find with an expression and no path is the cwd", () => {
        expect(fires("find -name x")).toBe(false);
    });

    it("other commands", () => {
        expect(fires("mdfind -name report.har")).toBe(false);
        expect(fires("ls /")).toBe(false);
        expect(fires("finder / x")).toBe(false);
        expect(fires("fdupes ~")).toBe(false);
    });

    it("prose", () => {
        expect(fires('echo "find / -name x"')).toBe(false);
        expect(fires("cat <<'EOF'\nfind ~ -name x\nEOF")).toBe(false);
        expect(fires("# find / -name x\nls")).toBe(false);
        expect(fires("git commit -m 'never find ~'")).toBe(false);
    });
});

describe("find-from-root: corpus fixtures", () => {
    const mustFire = [
        "find ~ -name '*.har' -mtime -7 2>/dev/null | head",
        "find / -name 'DarwinKit.app' -maxdepth 6 2>/dev/null | head -5",
        "find /Users/jdoe -maxdepth 3 -name '.claude' -type d 2>/dev/null",
        "find $HOME -maxdepth 2 -name '*.jsonl' 2>/dev/null | head -20",
        "find ~ -depth 1 -name x",
        "find ~ -maxdepth 1 -exec du -sh {} +",
    ];

    for (const command of mustFire) {
        it(`fires: ${command.slice(0, 70)}`, () => {
            expect(fires(command)).toBe(true);
        });
    }

    const mustNotFire = [
        'find "$HOME/.codex/sessions" -name "*.jsonl" -newer /tmp/stamp | head',
        "find . -path ./node_modules -prune -o -name '*.test.ts' -print",
        "find /Users/jdoe/Downloads -maxdepth 1 -iname '*.har' 2>&1 | head -20",
        "fd -t d -H --max-depth 8 'ColMobile.app' ~/Library/Developer/CoreSimulator/Devices/",
        "fd -e jsonl . ~/.claude/projects | wc -l",
        "find ~ -maxdepth 1 -type l",
        "find / -maxdepth 1 -name x",
        "fd -d 1 x ~",
    ];

    for (const command of mustNotFire) {
        it(`silent: ${command.slice(0, 70)}`, () => {
            expect(fires(command)).toBe(false);
        });
    }
});

describe("find-from-root: a depth limit of 1 reads one directory", () => {
    it.each([
        "find /Users/jdoe -maxdepth 1 -type l | tr '\\n' ' '",
        "find ~ -maxdepth 0 -type d",
        "find -L ~ -type l -maxdepth 1",
        "find ~ / -maxdepth 1 -name x",
        'find ~ -maxdepth "1" -name x',
        "fd -d1 x ~",
        "fd --max-depth 1 x /",
        "fd --max-depth=1 -H x ~",
        "fd x ~ -d 1",
        "fd --search-path ~ -d 1 x",
    ])("does not fire on %j", (command) => {
        expect(fires(command)).toBe(false);
    });

    it.each([
        "find ~ -maxdepth 2 -name x",
        "find ~ -maxdepth $D -name x",
        'find ~ -maxdepth "$D" -name x',
        "find ~ -maxdepth 1 -maxdepth 3 -name x",
        "find ~ -maxdepth 1 -execdir ls {} \\;",
        "find ~ -maxdepth 1 -ok du -sh {} \\;",
        "find ~ -maxdepth 1 -okdir du -sh {} \\;",
        "find ~ -exec find {} -maxdepth 1 \\;",
        "find ~ -maxdepth 1 -name '*.log' -delete",
        "find ~ -mindepth 1 -name x",
        "fd -d 2 x ~",
        "fd -d $D x ~",
        "fd --max-depth=3 x ~",
        "fd -d 1 x ~ -x du -sh",
        "fd -d 1 x ~ --exec-batch du -sh",
    ])("still fires on %j: a deeper or unknown limit, a command run per entry, or -delete", (command) => {
        expect(fires(command)).toBe(true);
    });
});

describe("find-from-root: the limit as the shell passes it", () => {
    it.each([
        "find ~ -maxdepth 1;",
        "find ~ -maxdepth 1|head",
        "echo $(find ~ -maxdepth 1)",
        "(find ~ -maxdepth 1)",
        "bash -c 'find ~ -maxdepth 1'",
        "zsh -c 'fd x ~ -d 1'",
        "find ~ -maxdepth 1 >/dev/null",
        "fd -Hd1 x ~",
        "fd -d1 -tx x ~",
    ])("does not fire on %j: the 1 ends at the operator or at the end of the body", (command) => {
        expect(fires(command)).toBe(false);
    });

    it.each([
        "fd -d 1 . ~ -Hx du -sh",
        "fd -d1 -Hx du -sh . ~",
        "fd -d 1 -HX du -sh . ~",
        "fd -d 1 --maxdepth 5 x ~",
        "fd -d 1 --maxdepth=5 x ~",
        "fd -d 1 -Hd 5 x ~",
        "fd -d 1 --exact-depth 4 x ~",
        "find ~ -maxdepth 1 '-exec' du {} +",
    ])("still fires on %j: x inside a cluster runs per entry, and the last depth flag wins", (command) => {
        expect(fires(command)).toBe(true);
    });
});

function searchFires(command: string): boolean {
    return detectShellViolations(command, findRules).some((v) => v.ruleId === "search-from-root");
}

describe("search-from-root", () => {
    it("fires on rg and recursive grep rooted at /, ~ or a home folder", () => {
        for (const command of [
            "rg -l API_TOKEN ~",
            "rg -l 'API_TOKEN' ~",
            'rg -n "x" /',
            "rg foo $HOME",
            'rg foo "$HOME"',
            "rg -C 3 foo /Users/alice",
            "rg -e foo -e bar ~",
            "rg --files ~",
            "rg -tmarkdown foo ~/",
            "grep -rn foo ~",
            "grep -R --include=*.ts foo /",
            "grep --recursive foo $HOME",
            "cd /tmp && rg -l secret ~ | head",
        ]) {
            expect(searchFires(command)).toBe(true);
        }
    });

    it("matched is the search element, from its command word", () => {
        const [v] = detectShellViolations("cd /tmp && rg -l secret ~ | head", findRules);

        expect(v?.ruleId).toBe("search-from-root");
        expect(v?.matched).toBe("rg -l secret ~");
        expect(v?.severity).toBe("block");
    });

    it("stays quiet on scoped searches, a lone pattern and grep without -r", () => {
        for (const command of [
            "rg foo ~/Projects/app",
            "rg -n foo src",
            "rg ~",
            "rg /",
            "rg -C 3 / src",
            "grep foo ~/notes.txt",
            "grep foo ~",
            "grep -rn foo .",
            "echo 'rg foo ~'",
            "rg -g '*.ts' foo ./src",
        ]) {
            expect(searchFires(command)).toBe(false);
        }
    });
});
