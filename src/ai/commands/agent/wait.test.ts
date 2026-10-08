import { describe, expect, it } from "bun:test";
import { Command } from "commander";
import {
    DEFAULT_WAIT_STALL_SECONDS,
    exitCodeOf,
    parseSeconds,
    registerAgentWaitCommand,
    WAIT_EXIT_DONE,
    WAIT_EXIT_STALLED,
    WAIT_EXIT_TIMEOUT,
} from "./wait";

describe("wait exit codes", () => {
    it("gives each outcome its own status, with timeout matching coreutils", () => {
        expect(exitCodeOf("done")).toBe(WAIT_EXIT_DONE);
        expect(exitCodeOf("stalled")).toBe(WAIT_EXIT_STALLED);
        expect(exitCodeOf("timeout")).toBe(WAIT_EXIT_TIMEOUT);
        expect(new Set([exitCodeOf("done"), exitCodeOf("stalled"), exitCodeOf("timeout")]).size).toBe(3);
        expect(WAIT_EXIT_TIMEOUT).toBe(124);
    });
});

describe("parseSeconds", () => {
    it("accepts positive numbers and, when allowed, zero", () => {
        expect(parseSeconds("2.5", "--timeout", { allowZero: false })).toBe(2.5);
        expect(parseSeconds("0", "--stall-timeout", { allowZero: true })).toBe(0);
        expect(parseSeconds(undefined, "--timeout", { allowZero: false })).toBeUndefined();
    });

    it("rejects zero, negatives and words, naming the flag", () => {
        expect(() => parseSeconds("0", "--timeout", { allowZero: false })).toThrow("--timeout");
        expect(() => parseSeconds("-1", "--timeout", { allowZero: false })).toThrow("--timeout");
        expect(() => parseSeconds("soon", "--stall-timeout", { allowZero: true })).toThrow("--stall-timeout");
    });
});

describe("registerAgentWaitCommand", () => {
    it("registers `wait <session>` with the documented flags", () => {
        const program = new Command();
        const command = registerAgentWaitCommand(program, "grok");
        const flags = command.options.map((option) => option.long);

        expect(command.name()).toBe("wait");
        expect(flags).toEqual(["--timeout", "--stall-timeout", "--next", "--stream", "--json", "--first"]);
        expect(command.description()).toContain("grok");
        expect(DEFAULT_WAIT_STALL_SECONDS).toBeGreaterThan(120);
    });
});
