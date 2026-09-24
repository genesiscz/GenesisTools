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
    const roots = ["/", "~", "~/", "$HOME", "$HOME/", "${HOME}", "/Users/Martin", "/Users/Martin/", "/Users/alice"];

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
        expect(fires("fd --max-depth 3 --hidden 'x' /Users/Martin")).toBe(true);
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
        expect(fires("find /Users/Martin/Projects -type d")).toBe(false);
        expect(fires("find /Users/Martin/.claude.bkp -type f")).toBe(false);
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
        expect(fires("find '/Users/Martin' -name x")).toBe(false);
    });

    it("the -name value survives its quotes in the suggestion", () => {
        expect(only('find / -name "*.har"')?.suggestion).toBe('mdfind -name "*.har"');
        expect(only("find ~ -type f -iname 'a b.txt' -print")?.suggestion).toBe("mdfind -name 'a b.txt'");
        expect(only("find ~ -name x")?.suggestion).toBe("mdfind -name x");
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
        "find /Users/Martin -maxdepth 3 -name '.claude' -type d 2>/dev/null",
        "find $HOME -maxdepth 2 -name '*.jsonl' 2>/dev/null | head -20",
    ];

    for (const command of mustFire) {
        it(`fires: ${command.slice(0, 70)}`, () => {
            expect(fires(command)).toBe(true);
        });
    }

    const mustNotFire = [
        'find "$HOME/.codex/sessions" -name "*.jsonl" -newer /tmp/stamp | head',
        "find . -path ./node_modules -prune -o -name '*.test.ts' -print",
        "find /Users/Martin/Downloads -maxdepth 1 -iname '*.har' 2>&1 | head -20",
        "fd -t d -H --max-depth 8 'ColMobile.app' ~/Library/Developer/CoreSimulator/Devices/",
        "fd -e jsonl . ~/.claude/projects | wc -l",
    ];

    for (const command of mustNotFire) {
        it(`silent: ${command.slice(0, 70)}`, () => {
            expect(fires(command)).toBe(false);
        });
    }
});
