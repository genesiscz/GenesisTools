import { describe, expect, it } from "bun:test";
import { commandTokenIndex, commandWord, scanShell, splitPipeline, tokenize } from "./scan";

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
});

describe("the helpers the rules match with", () => {
    it("splits a pipeline into its elements", () => {
        const [statement] = scanShell("git status | rg foo | head -3").units[0] ?? [];

        expect(statement).toBeDefined();
        expect(splitPipeline(statement as never)).toHaveLength(3);
    });

    it("finds the command word past a wrapper", () => {
        expect(commandWord("/usr/bin/rg")).toBe("rg");
        expect(commandWord("rg")).toBe("rg");
    });

    it("points at the real command, not at `sudo` or `timeout`", () => {
        const [statement] = scanShell("sudo timeout 5 rg foo").units[0] ?? [];
        const tokens = tokenize(statement as never);

        expect(commandTokenIndex(tokens)).toBeGreaterThan(0);
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
