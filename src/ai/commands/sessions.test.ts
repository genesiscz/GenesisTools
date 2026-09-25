import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { out } from "@genesiscz/utils/logger";
import { Command } from "commander";
import { registerSessionsCommands } from "./sessions";

async function run(args: string[]): Promise<{ exitCode: typeof process.exitCode; errors: string[] }> {
    const errors: string[] = [];
    const printlnErr = spyOn(out, "printlnErr").mockImplementation((line?: unknown) => {
        errors.push(String(line));
    });
    const program = new Command().exitOverride();
    registerSessionsCommands(program);

    try {
        await program.parseAsync(["node", "tools", ...args]);
        return { exitCode: process.exitCode, errors };
    } finally {
        printlnErr.mockRestore();
    }
}

afterEach(() => {
    process.exitCode = 0;
});

describe("sessions range flags", () => {
    test.each([
        [["sessions", "tail", "session-1", "--limit", "2oops"], "--limit must be a positive integer"],
        [["sessions", "tail", "session-1", "--limit", "1.5"], "--limit must be a positive integer"],
        [["sessions", "tail", "session-1", "--limit", "0"], "--limit must be a positive integer"],
        [["sessions", "tail", "session-1", "--offset", "3x"], "--offset must be a non-negative integer"],
        [["sessions", "tail", "session-1", "--turns", "3,1.5"], "--turns must be a comma-separated list"],
        [["sessions", "grep", "session-1", "needle", "--limit", "2oops"], "--limit must be a positive integer"],
    ])("%p is refused, not truncated", async (args, message) => {
        const result = await run(args);

        expect(result.exitCode).toBe(2);
        expect(result.errors.join("\n")).toContain(message);
    });

    // Negative control: whole numbers get past the range checks and stop at the next check instead.
    test("whole numbers pass the range checks", async () => {
        const tail = await run(["sessions", "tail", "session-1", "--limit", "5", "--offset", "0", "--provider", "x"]);
        expect(tail.errors).toEqual([expect.stringContaining("--provider must be one of")]);

        const grep = await run(["sessions", "grep", "session-1", "", "--limit", "5"]);
        expect(grep.errors).toEqual(["<query> must not be empty"]);
    });
});
