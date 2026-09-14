import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { focusSessionPane, type RunResult, resumeCommandFor } from "./session-focus";

const SESSION = "11111111-2222-3333-4444-555555555555";

function runner(result: Partial<RunResult>, seen?: string[][]) {
    return async (args: string[]): Promise<RunResult> => {
        seen?.push(args);

        return { code: 0, stdout: "", stderr: "", ...result };
    };
}

describe("focusSessionPane", () => {
    test("delegates to the cmux focus CLI and reports the focused pane", async () => {
        const calls: string[][] = [];
        const stdout = SafeJSON.stringify({
            query: SESSION,
            focused: { workspaceId: "ws-1", workspaceName: "genesis", paneId: "pane-7" },
            activated: true,
        });

        const result = await focusSessionPane(SESSION, { run: runner({ stdout }, calls) });

        expect(result.ok).toBe(true);
        expect(result.ok && result.focused.paneId).toBe("pane-7");
        expect(result.ok && result.activated).toBe(true);
        expect(calls[0]).toEqual(["claude", "cmux", "focus", SESSION, "--first", "--json"]);
    });

    test("a session with no pane returns a structured miss, not a throw", async () => {
        const stdout = SafeJSON.stringify({ query: SESSION, focused: null, matches: [] });
        const result = await focusSessionPane(SESSION, { run: runner({ code: 1, stdout }) });

        expect(result.ok).toBe(false);
        expect(result.ok === false && result.error).toContain("No cmux pane");
        expect(result.ok === false && result.remedy).toContain("restore");
    });

    test("a CLI crash surfaces stderr instead of claiming the pane is missing", async () => {
        const result = await focusSessionPane(SESSION, {
            run: runner({ code: 1, stdout: "", stderr: "cmux is not reachable: socket refused\n" }),
        });

        expect(result.ok).toBe(false);
        expect(result.ok === false && result.error).toBe("cmux is not reachable: socket refused");
    });

    test("an unknown session id never spawns anything", async () => {
        const calls: string[][] = [];
        const result = await focusSessionPane("unknown", { run: runner({}, calls) });

        expect(result.ok).toBe(false);
        expect(calls).toEqual([]);
    });
});

describe("resumeCommandFor", () => {
    test("builds the same resume string Genesis copies", () => {
        expect(resumeCommandFor(SESSION)).toBe(`tools claude run --resume ${SESSION}`);
    });
});
