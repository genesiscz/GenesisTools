import { describe, expect, it } from "bun:test";

import { detectShellViolations, type ShellViolation } from "./index";
import { rgRules } from "./rg";

// This file pins the registry face (matched, index, suggestion, severity) and the
// exemptions that shipped after the corpus review.

function only(command: string): ShellViolation | undefined {
    return detectShellViolations(command, rgRules)[0];
}

function tags(command: string): string[] {
    return detectShellViolations(command).map((v) => `${v.ruleId}:${v.severity}`);
}

describe("rg-replace-cluster: the violation", () => {
    it("is a block with the cluster as `matched` at its offset", () => {
        const command = "cd src && rg --heading -rn 'setSavedToken' packages";
        const v = only(command);

        expect(v?.ruleId).toBe("rg-replace-cluster");
        expect(v?.severity).toBe("block");
        expect(v?.matched).toBe("-rn");
        expect(v?.index).toBe(command.indexOf("-rn"));
    });

    it("suggests the same command with the r dropped from the cluster", () => {
        expect(only("rg -rn foo src")?.suggestion).toBe("rg -n foo src");
        expect(only("rg --heading -rln 'x' a b")?.suggestion).toBe("rg --heading -ln 'x' a b");
        expect(only("rg -nr foo src")?.suggestion).toBe("rg -n foo src");
        expect(only("ls | rg -ril kibana .")?.suggestion).toBe("ls | rg -il kibana .");
    });

    it("keeps everything around the cluster byte for byte, quotes included", () => {
        const command = 'echo "start"; rg -rn "a|b" src/ 2>&1 | head -3; echo "end"';

        expect(only(command)?.suggestion).toBe('echo "start"; rg -n "a|b" src/ 2>&1 | head -3; echo "end"');
    });
});

describe("rg-replace-cluster: exemptions from the corpus review", () => {
    it("a bare -r TEXT is the real --replace and passes", () => {
        expect(only("rg -o 'x(\\d+)' -r '$1' file")).toBeUndefined();
    });

    it("-or TEXT and -Nor TEXT are the only-matching plus replace idiom and pass", () => {
        expect(only("rg -o 'x(\\d+)' -or '$1' file")).toBeUndefined();
        expect(only("rg -Nor '$1' 'v=(\\d+)' f")).toBeUndefined();
    });

    it("an r inside a value flag's value is not --replace", () => {
        expect(only("rg -tmarkdown foo")).toBeUndefined();
        expect(only("rg -ntrust foo")).toBeUndefined();
        expect(only("rg -gbar/** foo")).toBeUndefined();
    });

    it("an r before the value flag is still --replace", () => {
        expect(only("rg -rtmarkdown foo")?.suggestion).toBe("rg -tmarkdown foo");
    });

    it("--replace spelled out passes", () => {
        expect(only("rg --replace n -n foo")).toBeUndefined();
    });

    it("a cluster after -- is a pattern, not a flag", () => {
        expect(only("rg -n -- -rn file.txt")).toBeUndefined();
    });

    it("other tools keep their -rn", () => {
        expect(only("grep -rn foo .")).toBeUndefined();
        expect(only("sort -rn counts.txt")).toBeUndefined();
        expect(only("rg -n foo | sort -rn")).toBeUndefined();
    });

    it("prose is never scanned", () => {
        expect(only('git commit -m "fix(rg-guard): explain that rg -rn means --replace n"')).toBeUndefined();
        expect(only("cat <<'EOF'\nnever run rg -rn\nEOF")).toBeUndefined();
        expect(only("# rg -rn foo\nrg -n foo")).toBeUndefined();
    });
});

describe("rg-replace-cluster: a run that prints no match text", () => {
    it.each([
        "rg -rn 'x' src --type ts -l | head -2",
        "rg -lrn foo src",
        "rg -rn foo -c .",
        "rg -rn foo -q .",
        'rg -rn "user_active|FOREGROUND" --heading -l native/ src/macos 2>&1 | head',
        "rg -rn foo --files-with-matches .",
        "rg -rn foo --files-without-match .",
        "rg -rn foo --count .",
        "rg -rn foo --count-matches .",
        "rg -rn foo --quiet .",
        "rg -rn --files src",
        "rg -crn foo .",
        "rg -rn foo -nl .",
        "rg -rn foo -lt ts .",
    ])("lets %j through: -l, -c, -q and --files print no replacement", (command) => {
        expect(only(command)).toBeUndefined();
    });

    it("reads past a quoted value, which leaves no token, to the flag after it", () => {
        expect(only("rg -rn \"AuthLogger\" ../packages --glob '*.ts' --glob '*.tsx' -l 2>/dev/null")).toBeUndefined();
        expect(only("rg -rn foo -g '*.ts' -l .")).toBeUndefined();
        expect(only('rg -rn foo -g "$GLOB" -l .')).toBeUndefined();
    });

    it.each([
        ["rg -rl foo src", "rg -l foo src"],
        ["rg -rnl foo src", "rg -nl foo src"],
        ["rg -rnq foo .", "rg -nq foo ."],
        ["rg -lr foo src", "rg -l foo src"],
        ["rg -nr foo -l src", "rg -n foo -l src"],
        ["rg -rn foo -L src", "rg -n foo -L src"],
    ])(
        "still blocks %j: the letters after r are the replacement, an r last eats the pattern, -L is --follow",
        (command, fixed) => {
            expect(only(command)?.suggestion).toBe(fixed);
        }
    );

    it("a flag's value is not an output mode, and neither is a later rg's flag or a path after --", () => {
        expect(only("rg -rn foo -e -l .")?.matched).toBe("-rn");
        expect(only("rg -rn foo --glob -l .")?.matched).toBe("-rn");
        expect(only("rg -rn foo -tl .")?.matched).toBe("-rn");
        expect(only("rg -rn foo -- -l")?.matched).toBe("-rn");
        expect(only("rg -rn foo . | rg -l bar")?.matched).toBe("-rn");
    });

    it("a second -r or --replace takes the next word as its replacement, so a -l there is no output mode", () => {
        expect(only("rg -rn foo -r -l src")?.suggestion).toBe("rg -n foo -r -l src");
        expect(only("rg -rn foo --replace -l src")?.suggestion).toBe("rg -n foo --replace -l src");
        expect(only("rg -rn foo -or -l src")?.matched).toBe("-rn");
        expect(only("rg -rn foo -or '$1' -l src")).toBeUndefined();
        expect(only("rg -rn foo --type-clear l -l src")).toBeUndefined();
    });
});

describe("rg-replace-cluster: with the rest of the registry", () => {
    it("wins the ordering over a context rule on the same command", () => {
        expect(tags("ls x 2>/dev/null | rg -rn foo")).toEqual([
            "rg-replace-cluster:block",
            "stderr-discarded-then-read:context",
        ]);
    });

    it("sits by index among other blocks", () => {
        expect(tags("cmd | tail; echo $?; rg -rn foo")).toEqual([
            "exit-code-after-pipeline:block",
            "rg-replace-cluster:block",
        ]);
        expect(tags("rg -rn foo; cmd | tail; echo $?")).toEqual([
            "rg-replace-cluster:block",
            "exit-code-after-pipeline:block",
        ]);
    });
});
