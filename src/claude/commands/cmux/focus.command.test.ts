import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SessionCmuxRefs } from "@app/claude/lib/cmux/session-refs";
import type { CmuxLivePane, CmuxLiveSnapshot, CmuxLiveSurface } from "@genesiscz/utils/cmux/lib/live-snapshot";
import { out } from "@genesiscz/utils/logger";

const SESSION_A = "8b6e69bf-0efc-4990-ba3e-b77262498421";
const CALLER_PANE = "pane:2";
const DEAD_SURFACE = "dead-surf";

let snapshot: CmuxLiveSnapshot;

/**
 * Every cmux effect the command reaches for, in order.
 *
 * One shared list rather than one per mock, because the ordering is part of the contract:
 * the window has to be raised before the pane is focused, and the pane before its tab.
 */
let events: string[] = [];

let stdout: string[] = [];
let originalWrite: typeof process.stdout.write;

mock.module("@genesiscz/utils/cmux/lib/cli", () => ({
    runCmuxJSON: async (args: string[]) => {
        events.push(args.join(" "));

        // `identify --workspace <ref>` answers for the workspace you name; bare `identify`
        // answers for the pane you are calling from.
        if (args.includes("--workspace")) {
            return { caller: { window_ref: "window:1" } };
        }

        return { bundle_identifier: "com.cmuxterm.app", caller: { pane_ref: CALLER_PANE } };
    },
    runCmuxOk: async (args: string[]) => {
        events.push(args.join(" "));
        return { code: 0, stdout: "", stderr: "" };
    },
    runCmux: async (args: string[]) => {
        events.push(args.join(" "));
        return { code: 0, stdout: "", stderr: "" };
    },
}));

mock.module("@genesiscz/utils/cmux/lib/controls", () => ({
    focusCmuxPane: async ({ workspaceId, paneId }: { workspaceId: string; paneId: string }) => {
        events.push(`focus-pane ${workspaceId} ${paneId}`);
    },
    focusCmuxSurface: async ({ surfaceId }: { surfaceId: string }) => {
        events.push(`focus-surface ${surfaceId}`);

        // A recorded surface that cmux no longer knows: the stale-ref case.
        if (surfaceId === DEAD_SURFACE) {
            throw new Error("no such surface");
        }
    },
}));

function surface(overrides: Partial<CmuxLiveSurface> & Pick<CmuxLiveSurface, "id">): CmuxLiveSurface {
    return { title: "zsh", type: "terminal", index: 0, selected: false, active: false, ...overrides };
}

function pane(overrides: Partial<CmuxLivePane> & Pick<CmuxLivePane, "id">): CmuxLivePane {
    return {
        workspaceId: "workspace:11",
        title: "zsh",
        active: false,
        surfaceCount: 1,
        surfaces: [],
        ...overrides,
    };
}

function setSnapshot(panes: CmuxLivePane[]): void {
    snapshot = {
        fetchedAt: "2026-08-19T13:00:00.000Z",
        available: true,
        workspaces: [{ id: "workspace:11", name: "GenesisTools" }],
        panes,
    };
}

const RECORDED_PANE = "pane:7";

/** Refs the session hook journaled, pointing at a surface cmux has since forgotten. */
function staleRefs(): SessionCmuxRefs {
    return {
        sessionId: SESSION_A,
        workspaceId: "ws-uuid",
        surfaceId: DEAD_SURFACE,
        workspaceRef: "workspace:11",
        paneRef: RECORDED_PANE,
        surfaceRef: "surface:41",
        windowRef: "window:1",
        tmuxPane: null,
        cwd: "/repo",
        at: Date.now(),
    };
}

function resumeScreen(sessionId: string): string {
    return `cd -- '/repo' && tools claude start -- --resume '${sessionId}'`;
}

/** stdout is the machine result channel, and `out.result` writes it asynchronously. */
async function capturedResult(): Promise<string> {
    await out.flush();
    return stdout.join("");
}

beforeEach(() => {
    events = [];
    stdout = [];
    setSnapshot([]);
    originalWrite = process.stdout.write;
    process.stdout.write = ((
        chunk: string | Uint8Array,
        encodingOrCallback?: unknown,
        callback?: (err?: Error | null) => void
    ) => {
        stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());

        // `out.result` awaits this callback. A stub that drops it hangs the test instead of
        // failing it, which is how the first version of this file timed out.
        const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;

        if (typeof done === "function") {
            (done as (err?: Error | null) => void)(null);
        }

        return true;
    }) as typeof process.stdout.write;
});

afterEach(() => {
    process.stdout.write = originalWrite;
    // The command sets this on its failure paths; leaving it set would fail the whole run.
    process.exitCode = 0;
});

async function runFocus(
    query: string,
    opts: Record<string, boolean> = {},
    lookupSession: (query: string) => Promise<{ aliases: string[]; sessionId: string | null }> = async () => ({
        aliases: [],
        sessionId: null,
    })
): Promise<{ exitCode: number; result: string }> {
    const { focusCommand } = await import("@app/claude/commands/cmux/focus");
    // Never let a test raise the real cmux app: `activateApp()` shells out to `open -b`.
    await focusCommand(query, { activate: false, ...opts }, { fetchSnapshot: async () => snapshot, lookupSession });

    return { exitCode: process.exitCode === undefined ? 0 : Number(process.exitCode), result: await capturedResult() };
}

describe("focusCommand", () => {
    test("--json with no match exits nonzero and focuses nothing", async () => {
        // The bug: this path emitted `{ focused: null }` and returned, so Commander exited
        // 0 and anything scripting the command read a miss as a success.
        setSnapshot([pane({ id: "pane:33", title: "unrelated" })]);

        const { exitCode, result } = await runFocus(SESSION_A, { json: true });

        expect(exitCode).toBe(1);
        expect(result).toContain(`"focused": null`);
        expect(events).toEqual(["identify"]);
    });

    test("--json with a match still exits 0", async () => {
        setSnapshot([pane({ id: "pane:33", preview: resumeScreen(SESSION_A) })]);

        const { exitCode, result } = await runFocus(SESSION_A, { json: true });

        expect(exitCode).toBe(0);
        expect(result).toContain(`"paneId": "pane:33"`);
    });

    test("--json with an ambiguous match exits nonzero and focuses nothing", async () => {
        setSnapshot([pane({ id: "pane:33", title: "build" }), pane({ id: "pane:34", title: "build" })]);

        const { exitCode, result } = await runFocus("build", { json: true });

        expect(exitCode).toBe(1);
        expect(result).toContain(`"ambiguous": true`);
        expect(events).toEqual(["identify"]);
    });

    test("--dry-run resolves a target but performs no cmux mutation", async () => {
        setSnapshot([pane({ id: "pane:33", preview: resumeScreen(SESSION_A) })]);

        const { exitCode, result } = await runFocus(SESSION_A, { json: true, dryRun: true });

        expect(exitCode).toBe(0);
        expect(result).toContain(`"wouldFocus"`);
        expect(events).toEqual(["identify"]);
    });

    test("raises the window, then the pane, then the tab the match came from", async () => {
        setSnapshot([
            pane({
                id: "pane:33",
                preview: "another tab's output",
                surfaces: [
                    surface({ id: "surface:45", selected: true }),
                    surface({ id: "surface:46", title: "hidden", preview: resumeScreen(SESSION_A) }),
                ],
            }),
        ]);

        await runFocus(SESSION_A);

        expect(events).toEqual([
            "identify",
            "identify --workspace workspace:11",
            "focus-window --window window:1",
            "focus-pane workspace:11 pane:33",
            "focus-surface surface:46",
        ]);
    });

    test("uses the snapshot windowRef and skips identify --workspace", async () => {
        setSnapshot([
            pane({
                id: "pane:33",
                windowRef: "window:7",
                preview: resumeScreen(SESSION_A),
            }),
        ]);

        await runFocus(SESSION_A);

        expect(events).toEqual(["identify", "focus-window --window window:7", "focus-pane workspace:11 pane:33"]);
    });

    test("a match on the pane's own screen switches no tab", async () => {
        setSnapshot([pane({ id: "pane:33", preview: resumeScreen(SESSION_A) })]);

        await runFocus(SESSION_A);

        expect(events).not.toContain("focus-surface surface:45");
        expect(events.filter((event) => event.startsWith("focus-surface"))).toEqual([]);
    });

    test("session-id focus uses lookup aliases to match a topic tab", async () => {
        setSnapshot([
            pane({
                id: "pane:1",
                title: "pane:1",
                surfaces: [
                    surface({
                        id: "surface:124",
                        selected: true,
                        title: "◑ Clauderoo cwd slowdown",
                    }),
                ],
            }),
        ]);

        const { exitCode, result } = await runFocus("4691ef7b", { json: true, dryRun: true }, async () => ({
            aliases: ["clauderoo cwd slowdown"],
            sessionId: "4691ef7b-0ab5-4f05-8513-e7b118f05f50",
        }));

        expect(exitCode).toBe(0);
        expect(result).toContain('"paneId": "pane:1"');
        expect(result).toContain('"surfaceId": "surface:124"');
        expect(result).toContain('"matchedOn": "session-name"');
        expect(result).toContain("4691ef7b-0ab5-4f05-8513-e7b118f05f50");
    });

    test("the calling pane is skipped by default and searched with --include-self", async () => {
        // Typing the query puts it on the caller's own screen, so without the exclusion any
        // query at all matches the pane it was run from.
        setSnapshot([pane({ id: CALLER_PANE, preview: "$ tools claude cmux focus zzz-nope" })]);

        expect((await runFocus("zzz-nope", { json: true })).exitCode).toBe(1);

        process.exitCode = 0;
        events = [];
        stdout = [];

        const included = await runFocus("zzz-nope", { json: true, includeSelf: true });

        expect(included.exitCode).toBe(0);
        expect(included.result).toContain(`"paneId": "${CALLER_PANE}"`);
    });

    test("a stale recorded ref falling back to two panes is not focused blindly", async () => {
        // The fallback re-runs the matcher, so it can land on several panes exactly
        // like the first pass can. It used to take targets[0] with no --first, so a
        // cmux restart silently focused an arbitrary pane.
        setSnapshot([
            pane({ id: "pane:7", cwd: "/repo", surfaces: [surface({ id: "surface:1", selected: true })] }),
            pane({ id: "pane:8", cwd: "/repo", surfaces: [surface({ id: "surface:2", selected: true })] }),
        ]);

        const { focusCommand } = await import("@app/claude/commands/cmux/focus");
        await focusCommand(
            SESSION_A,
            { activate: false, json: true },
            {
                fetchSnapshot: async () => snapshot,
                lookupSession: async () => ({ aliases: [], sessionId: SESSION_A, cwd: "/repo" }),
                lookupRefs: () => staleRefs(),
            }
        );

        const result = await capturedResult();

        expect(process.exitCode).toBe(1);
        expect(result).toContain(`"ambiguous": true`);
        expect(result).toContain(`"focused": null`);
        // The dead recorded surface is attempted once; no live pane is focused after it.
        expect(events.filter((event) => event.startsWith("focus-pane"))).toEqual([
            `focus-pane ws-uuid ${RECORDED_PANE}`,
        ]);
    });
});
