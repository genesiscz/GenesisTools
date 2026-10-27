import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { CmuxLivePane, CmuxLiveSnapshot, CmuxLiveSurface } from "@genesiscz/utils/cmux/lib/live-snapshot";
import { CmuxRpcError, CmuxTransportError } from "@genesiscz/utils/cmux/lib/socket";
import type { SessionCmuxRefs } from "@genesiscz/utils/cmux/session-refs";
import type { CmuxTree } from "@genesiscz/utils/cmux/tree";
import { out } from "@genesiscz/utils/logger";

const SESSION_A = "8b6e69bf-0efc-4990-ba3e-b77262498421";
const CALLER_PANE = "pane:2";
const DEAD_SURFACE = "dead-surf";
const TIMEOUT_SURFACE = "timeout-surf";
const REFUSED_SURFACE = "refused-surf";

let snapshot: CmuxLiveSnapshot;

/**
 * Every cmux effect the command reaches for, in order.
 *
 * One shared list rather than one per mock, because the ordering is part of the contract:
 * the window has to be raised before the pane is focused, and the pane before its tab.
 */
let events: string[] = [];
const WINDOW_1 = "0B49D0CA-0000-4000-8000-000000000001";

let stdout: string[] = [];
let originalWrite: typeof process.stdout.write;

mock.module("@genesiscz/utils/cmux/lib/cli", () => ({
    runCmuxJSON: async (args: string[]) => {
        events.push(args.join(" "));

        // `identify --workspace <id>` answers for the workspace you name; bare `identify`
        // answers for the pane you are calling from.
        if (args.includes("--workspace")) {
            return { caller: { window_id: WINDOW_1, window_ref: "window:1" } };
        }

        return { bundle_identifier: "com.cmuxterm.app", caller: { pane_id: CALLER_PANE, pane_ref: CALLER_PANE } };
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
            throw new CmuxRpcError("surface.focus", "not_found", "no such surface");
        }

        // cmux refused for another reason: the pane may well be alive.
        if (surfaceId === REFUSED_SURFACE) {
            throw new CmuxRpcError("surface.focus", "invalid_params", "bad surface ref");
        }

        // cmux did not answer: says nothing about whether the surface exists.
        if (surfaceId === TIMEOUT_SURFACE) {
            throw new CmuxTransportError("surface.focus", "cmux RPC surface.focus timed out after 5000ms");
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
const RECORDED_PANE_ID = "7A7A7A7A-0000-4000-8000-000000000007";

/** Refs the session hook journaled, pointing at a surface cmux has since forgotten. */
function staleRefs(): SessionCmuxRefs {
    return {
        sessionId: SESSION_A,
        workspaceId: "ws-uuid",
        surfaceId: DEAD_SURFACE,
        workspaceRef: "workspace:11",
        paneId: RECORDED_PANE_ID,
        paneRef: RECORDED_PANE,
        surfaceRef: "surface:41",
        windowId: WINDOW_1,
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
        expect(events).toEqual(["--id-format both identify"]);
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
        expect(events).toEqual(["--id-format both identify"]);
    });

    test("--exact refuses a pane that only shows the id on screen, and focuses one proven to run it", async () => {
        // 2026-10-25: a cache chip pressed with --first focused `ncdu /tmp`, whose listing names a session folder.
        setSnapshot([pane({ id: "pane:33", title: "ncdu /tmp", preview: `/tmp/cc/GenesisTools/${SESSION_A}/` })]);

        const weak = await runFocus(SESSION_A, { json: true, first: true, exact: true });

        expect(weak.exitCode).toBe(1);
        expect(weak.result).toContain(`"focused": null`);
        expect(events).toEqual(["--id-format both identify"]);

        process.exitCode = 0;
        setSnapshot([pane({ id: "pane:34", preview: resumeScreen(SESSION_A) })]);

        const proven = await runFocus(SESSION_A, { json: true, first: true, exact: true, dryRun: true });

        expect(proven.exitCode).toBe(0);
        expect(proven.result).toContain(`"paneId": "pane:34"`);
    });

    test("--exact searches beyond aliases and selects only the proven pane, including stale-ref retry", async () => {
        const { focusCommand } = await import("@app/claude/commands/cmux/focus");
        for (const stale of [false, true]) {
            events = [];
            stdout = [];
            setSnapshot([pane({ id: "pane:33", title: "cache work" }), pane({ id: "pane:34", title: "zsh" })]);
            const stages: string[] = [];
            await focusCommand(
                SESSION_A,
                { activate: false, json: true, exact: true },
                {
                    lookupRefs: () => (stale ? staleRefs() : null),
                    lookupSession: async () => ({ aliases: ["cache work"], sessionId: SESSION_A }),
                    fetchSnapshot: async (previews) => {
                        stages.push(previews);
                        return {
                            ...snapshot,
                            panes: snapshot.panes.map((held) =>
                                held.id === "pane:34" && previews !== "none"
                                    ? { ...held, preview: resumeScreen(SESSION_A) }
                                    : held
                            ),
                        };
                    },
                }
            );
            expect(process.exitCode ?? 0).toBe(0);
            expect(stages).toEqual(["none", "selected"]);
            expect(await capturedResult()).toContain('"paneId": "pane:34"');
            expect(events).toContain("focus-pane workspace:11 pane:34");
            expect(events).not.toContain("focus-pane workspace:11 pane:33");
        }
    });

    test("--dry-run resolves a target but performs no cmux mutation", async () => {
        setSnapshot([pane({ id: "pane:33", preview: resumeScreen(SESSION_A) })]);

        const { exitCode, result } = await runFocus(SESSION_A, { json: true, dryRun: true });

        expect(exitCode).toBe(0);
        expect(result).toContain(`"wouldFocus"`);
        expect(events).toEqual(["--id-format both identify"]);
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
            "--id-format both identify",
            "--id-format both identify --workspace workspace:11",
            `focus-window --window ${WINDOW_1}`,
            "focus-pane workspace:11 pane:33",
            "focus-surface surface:46",
        ]);
    });

    test("uses the snapshot's window UUID and skips identify --workspace", async () => {
        setSnapshot([
            pane({
                id: "pane:33",
                windowId: "0B49D0CA-0000-4000-8000-000000000007",
                windowRef: "window:7",
                preview: resumeScreen(SESSION_A),
            }),
        ]);

        await runFocus(SESSION_A);

        expect(events).toEqual([
            "--id-format both identify",
            "focus-window --window 0B49D0CA-0000-4000-8000-000000000007",
            "focus-pane workspace:11 pane:33",
        ]);
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
        // The dead recorded tab is tried first, so its old pane is never raised, and no live
        // pane is focused after it.
        expect(events.filter((event) => event.startsWith("focus-surface"))).toEqual([`focus-surface ${DEAD_SURFACE}`]);
        expect(events.filter((event) => event.startsWith("focus-pane"))).toEqual([]);
    });

    test("--exact rechecks a stale recorded ref's fallback before focusing a screen-only match", async () => {
        setSnapshot([pane({ id: "pane:33", title: "ncdu /tmp", preview: `/tmp/cc/${SESSION_A}/` })]);
        const { focusCommand } = await import("@app/claude/commands/cmux/focus");
        await focusCommand(
            SESSION_A,
            { activate: false, json: true, first: true, exact: true },
            {
                fetchSnapshot: async () => snapshot,
                lookupRefs: () => staleRefs(),
                lookupSession: async () => ({ aliases: [], sessionId: SESSION_A }),
            }
        );
        expect(process.exitCode).toBe(1);
        expect(await capturedResult()).toContain('"exact": false');
        expect(events.filter((event) => !event.includes("identify"))).toEqual([`focus-surface ${DEAD_SURFACE}`]);
    });

    test("--exact still focuses a proven fallback after stale recorded refs", async () => {
        setSnapshot([pane({ id: "pane:33", preview: resumeScreen(SESSION_A) })]);
        const { focusCommand } = await import("@app/claude/commands/cmux/focus");
        await focusCommand(
            SESSION_A,
            { activate: false, json: true, first: true, exact: true },
            {
                fetchSnapshot: async () => snapshot,
                lookupRefs: () => staleRefs(),
                lookupSession: async () => ({ aliases: [], sessionId: SESSION_A }),
            }
        );
        expect(process.exitCode ?? 0).toBe(0);
        expect(await capturedResult()).toContain('"paneId": "pane:33"');
        expect(events).toContain("focus-pane workspace:11 pane:33");
    });

    test("a stale recorded ref with no other pane says the pane is gone and moves nothing", async () => {
        // The hub showed "ERROR: [socket] RPC error" here, after raising the dead tab's window
        // and pane. The answer is a plain `gone` result, and nothing on screen changes.
        setSnapshot([pane({ id: "pane:9", cwd: "/elsewhere", surfaces: [surface({ id: "surface:3" })] })]);

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
        expect(result).toContain(`"gone": true`);
        expect(result).toContain(`"focused": null`);
        expect(events.filter((event) => !event.includes("identify"))).toEqual([`focus-surface ${DEAD_SURFACE}`]);
    });

    test("a cmux timeout on a recorded ref is an error, never a gone pane", async () => {
        setSnapshot([pane({ id: "pane:9", cwd: "/elsewhere", surfaces: [surface({ id: "surface:3" })] })]);

        const { focusCommand } = await import("@app/claude/commands/cmux/focus");
        const run = focusCommand(
            SESSION_A,
            { activate: false, json: true },
            {
                fetchSnapshot: async () => snapshot,
                lookupSession: async () => ({ aliases: [], sessionId: SESSION_A, cwd: "/repo" }),
                lookupRefs: () => ({ ...staleRefs(), surfaceId: TIMEOUT_SURFACE }),
            }
        );

        await expect(run).rejects.toBeInstanceOf(CmuxTransportError);
        expect(await capturedResult()).not.toContain(`"gone"`);
    });

    test("a refusal other than not_found on a recorded ref is an error, never a gone pane", async () => {
        setSnapshot([pane({ id: "pane:9", cwd: "/elsewhere", surfaces: [surface({ id: "surface:3" })] })]);

        const { focusCommand } = await import("@app/claude/commands/cmux/focus");
        const run = focusCommand(
            SESSION_A,
            { activate: false, json: true },
            {
                fetchSnapshot: async () => snapshot,
                lookupSession: async () => ({ aliases: [], sessionId: SESSION_A, cwd: "/repo" }),
                lookupRefs: () => ({ ...staleRefs(), surfaceId: REFUSED_SURFACE }),
            }
        );

        await expect(run).rejects.toBeInstanceOf(CmuxRpcError);
        expect(await capturedResult()).not.toContain(`"gone"`);
    });

    test("a live recorded ref raises its tab, then its window and pane", async () => {
        const { focusCommand } = await import("@app/claude/commands/cmux/focus");
        await focusCommand(
            SESSION_A,
            { activate: false, json: true },
            {
                fetchSnapshot: async () => snapshot,
                lookupRefs: () => ({ ...staleRefs(), surfaceId: "live-surf" }),
            }
        );

        expect(process.exitCode ?? 0).toBe(0);
        expect(events.filter((event) => !event.includes("identify"))).toEqual([
            "focus-surface live-surf",
            `focus-window --window ${WINDOW_1}`,
            `focus-pane ws-uuid ${RECORDED_PANE_ID}`,
        ]);
    });
});

describe("focusRunningSession", () => {
    const RUNNING_SURFACE = "5E5E5E5E-0000-4000-8000-000000000005";
    const running = {
        sessionId: SESSION_A,
        title: "acme-conventions",
        cwd: "/repo",
        pid: 4242,
        // The process scan keys surfaces in lower case; cmux answers in upper case.
        surfaceId: RUNNING_SURFACE.toLowerCase(),
        surfaceRef: "surface:5",
    };

    function tree(surfaceIds: string[]): CmuxTree {
        return {
            fetchedAt: "2026-10-27T15:00:00.000Z",
            available: true,
            totalMs: 1,
            windows: [
                {
                    id: WINDOW_1,
                    index: 0,
                    key: true,
                    workspaces: [
                        {
                            id: "workspace:11",
                            name: "GenesisTools",
                            panes: [
                                {
                                    id: RECORDED_PANE_ID,
                                    title: "claude",
                                    active: false,
                                    surfaces: surfaceIds.map((id, index) => ({
                                        id,
                                        title: "claude",
                                        type: "terminal",
                                        index,
                                        selected: false,
                                        active: false,
                                    })),
                                },
                            ],
                        },
                    ],
                },
            ],
        };
    }

    test("raises the window, the pane and then the tab the process runs in", async () => {
        const { focusRunningSession } = await import("@app/claude/commands/cmux/focus");
        let activated = 0;
        const focused = await focusRunningSession(running, {
            fetchTree: async () => tree(["0THER000-0000-4000-8000-000000000000", RUNNING_SURFACE]),
            activate: async () => {
                activated++;
                return true;
            },
        });

        expect(focused).toBe(true);
        expect(events).toEqual([
            `focus-window --window ${WINDOW_1}`,
            `focus-pane workspace:11 ${RECORDED_PANE_ID}`,
            `focus-surface ${RUNNING_SURFACE}`,
        ]);
        expect(activated).toBe(1);
    });

    test("a running tab refusal or timeout never reports success or activates the app", async () => {
        const { focusRunningSession } = await import("@app/claude/commands/cmux/focus");

        for (const surfaceId of [REFUSED_SURFACE, TIMEOUT_SURFACE]) {
            events = [];
            let activated = false;
            const attempt = focusRunningSession(
                { ...running, surfaceId },
                {
                    fetchTree: async () => tree([surfaceId]),
                    activate: async () => {
                        activated = true;
                        return true;
                    },
                }
            );

            await expect(attempt).rejects.toThrow();
            expect(events).toContain(`focus-surface ${surfaceId}`);
            expect(activated).toBe(false);
        }
    });

    test("a tab that closed while the picker was open focuses nothing", async () => {
        const { focusRunningSession } = await import("@app/claude/commands/cmux/focus");
        const focused = await focusRunningSession(running, {
            fetchTree: async () => tree(["0THER000-0000-4000-8000-000000000000"]),
            activate: async () => {
                throw new Error("nothing may be raised for a closed tab");
            },
        });

        expect(focused).toBe(false);
        expect(events).toEqual([]);
    });
});
