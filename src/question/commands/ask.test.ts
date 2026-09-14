import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { parseMs, registerAskCommand } from "./ask";

describe("parseMs", () => {
    test("a non-numeric duration is refused instead of silently becoming NaN", () => {
        // NaN made `--timeout` mean "no timeout", and gave `--wait-timeout` a deadline that
        // can never pass — a wait that polls the store forever at zero sleep.
        expect(() => parseMs("abc")).toThrow();
    });

    test("an empty value is refused, because Number('') is 0 rather than NaN", () => {
        expect(() => parseMs("")).toThrow();
        expect(() => parseMs("   ")).toThrow();
    });

    test("a negative duration is refused", () => {
        expect(() => parseMs("-5")).toThrow();
    });

    test("a numeric PREFIX is refused, not silently truncated", () => {
        // parseInt read a prefix: "10ms" became 10 and "1.5" became 1, so a mistyped timeout
        // expired far earlier than the user asked for.
        expect(() => parseMs("10ms")).toThrow();
        expect(() => parseMs("1.5")).toThrow();
    });

    test("a plain millisecond count parses", () => {
        expect(parseMs("2500")).toBe(2500);
    });
});

describe("registerAskCommand", () => {
    function commandNamed(name: string) {
        const program = new Command();
        registerAskCommand(program);

        return program.commands.find((command) => command.name() === name);
    }

    test("answer offers --json, because a partial submit is never stored", () => {
        const answer = commandNamed("answer");

        expect(answer).toBeDefined();
        expect(answer?.options.some((option) => option.long === "--json")).toBe(true);
    });

    test("every duration flag refuses a non-numeric value", () => {
        for (const [command, flag] of [
            ["ask", "--timeout"],
            ["ask", "--wait-timeout"],
            ["wait", "--timeout"],
        ] as const) {
            const option = commandNamed(command)?.options.find((candidate) => candidate.long === flag);

            expect(option).toBeDefined();
            // Behavior, not identity: the old inline parser returned NaN here without a word.
            expect(() => option?.parseArg?.("abc", undefined)).toThrow();
        }
    });
});
