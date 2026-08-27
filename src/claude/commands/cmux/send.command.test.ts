import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { SessionCmuxRefs } from "@app/claude/lib/cmux/session-refs";
import type { CmuxLivePane, CmuxLiveSnapshot, CmuxLiveSurface } from "@genesiscz/utils/cmux/lib/live-snapshot";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";

const SESSION_A = "8b6e69bf-0efc-4990-ba3e-b77262498421";
const CALLER_PANE = "pane:2";
const LIVE_SURFACE_UUID = "22222222-2222-4222-8222-222222222222";
// A surface the app no longer knows: the send against it fails, which is what
// makes the recorded-ref path fall back to the matcher.
const DEAD_SURFACE_UUID = "44444444-4444-4444-8444-444444444444";

let snapshot: CmuxLiveSnapshot;
let events: string[] = [];
let stdout: string[] = [];
let originalWrite: typeof process.stdout.write;

mock.module("@genesiscz/utils/cmux/lib/cli", () => ({
    runCmuxJSON: async (args: string[]) => {
        events.push(args.join(" "));
        return { bundle_identifier: "com.cmuxterm.app", caller: { pane_ref: CALLER_PANE } };
    },
    runCmuxOk: async (args: string[]) => {
        events.push(args.join(" "));

        if (args.includes(DEAD_SURFACE_UUID)) {
            throw new Error("invalid_params: Surface is not a terminal");
        }

        return { code: 0, stdout: "", stderr: "" };
    },
    runCmux: async (args: string[]) => {
        events.push(args.join(" "));
        return { code: 0, stdout: "", stderr: "" };
    },
}));

const { deliverySurfaceId, sendCommand } = await import("./send");

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
        fetchedAt: "2026-08-26T13:00:00.000Z",
        available: true,
        workspaces: [{ id: "workspace:11", name: "GenesisTools" }],
        panes,
    };
}

const deps = {
    fetchSnapshot: async () => snapshot,
    lookupSession: async () => ({ aliases: [], sessionId: null }),
    lookupRefs: () => null,
};

function recordedRefs(overrides: Partial<SessionCmuxRefs> = {}): SessionCmuxRefs {
    return {
        sessionId: SESSION_A,
        workspaceId: "11111111-1111-4111-8111-111111111111",
        surfaceId: LIVE_SURFACE_UUID,
        workspaceRef: "workspace:11",
        paneRef: "pane:7",
        surfaceRef: "surface:41",
        windowRef: "window:1",
        tmuxPane: null,
        cwd: "/repo",
        at: Date.now(),
        ...overrides,
    };
}

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
        const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;

        if (typeof done === "function") {
            (done as (err?: Error | null) => void)(null);
        }

        return true;
    }) as typeof process.stdout.write;
});

afterEach(() => {
    process.stdout.write = originalWrite;
    process.exitCode = 0;
});

test("sends text then Enter to the pane whose tab carries the session marker", async () => {
    setSnapshot([
        pane({
            id: "pane:7",
            surfaces: [surface({ id: "surface:41", title: `genesis · ${SESSION_A.slice(0, 8)}`, selected: true })],
        }),
    ]);

    await sendCommand(SESSION_A.slice(0, 8), "Just poking", { first: true, enter: true, enterDelay: "0" }, deps);

    expect(events).toContain("send --surface surface:41 -- Just poking");
    expect(events).toContain("send-key --surface surface:41 enter");
    expect(events.indexOf("send --surface surface:41 -- Just poking")).toBeLessThan(
        events.indexOf("send-key --surface surface:41 enter")
    );
});

test("--no-enter sends the text only", async () => {
    setSnapshot([
        pane({
            id: "pane:7",
            surfaces: [surface({ id: "surface:41", title: `x · ${SESSION_A.slice(0, 8)}`, selected: true })],
        }),
    ]);

    await sendCommand(SESSION_A.slice(0, 8), "/keepalive", { first: true, enter: false, enterDelay: "0" }, deps);

    expect(events).toContain("send --surface surface:41 -- /keepalive");
    expect(events.some((event) => event.startsWith("send-key"))).toBe(false);
});

test("a pane-scope match falls back to the pane's selected surface", async () => {
    setSnapshot([
        pane({
            id: "pane:7",
            preview: `tools claude start -- --resume '${SESSION_A}'`,
            selectedSurfaceRef: "surface:90",
            surfaces: [surface({ id: "surface:90", selected: true })],
        }),
    ]);

    await sendCommand(SESSION_A, "hello", { first: true, enter: false, enterDelay: "0" }, deps);

    expect(events).toContain("send --surface surface:90 -- hello");
});

test("no match exits 1 with sent:false JSON", async () => {
    await sendCommand(SESSION_A, "hello", { json: true, enter: true, enterDelay: "0" }, deps);

    expect(process.exitCode).toBe(1);
    expect(SafeJSON.parse(await capturedResult())).toEqual({ query: SESSION_A, sent: false, matches: [] });
    expect(events.some((event) => event.startsWith("send"))).toBe(false);
});

test("the calling pane is excluded unless --include-self", async () => {
    setSnapshot([
        pane({
            id: CALLER_PANE,
            surfaces: [surface({ id: "surface:5", title: `me · ${SESSION_A.slice(0, 8)}`, selected: true })],
        }),
    ]);

    await sendCommand(SESSION_A.slice(0, 8), "hi", { first: true, json: true, enter: false, enterDelay: "0" }, deps);
    expect(SafeJSON.parse(await capturedResult()).sent).toBe(false);

    stdout = [];
    process.exitCode = 0;
    await sendCommand(
        SESSION_A.slice(0, 8),
        "hi",
        { first: true, includeSelf: true, enter: false, enterDelay: "0" },
        deps
    );
    expect(events).toContain(`send --surface surface:5 -- hi`);
});

test("dry run resolves but sends nothing", async () => {
    setSnapshot([
        pane({
            id: "pane:7",
            surfaces: [surface({ id: "surface:41", title: `x · ${SESSION_A.slice(0, 8)}`, selected: true })],
        }),
    ]);

    await sendCommand(SESSION_A.slice(0, 8), "hello", { first: true, dryRun: true, json: true, enter: true }, deps);

    const plan = SafeJSON.parse(await capturedResult());
    expect(plan.wouldSendTo.paneId).toBe("pane:7");
    expect(plan.surfaceId).toBe("surface:41");
    expect(events.some((event) => event.startsWith("send"))).toBe(false);
});

test("recorded refs from the session hook win without any snapshot fetch", async () => {
    let snapshotFetches = 0;
    const recordedDeps = {
        fetchSnapshot: async () => {
            snapshotFetches++;
            return snapshot;
        },
        lookupSession: async () => ({ aliases: [], sessionId: null }),
        lookupRefs: () => recordedRefs(),
    };

    await sendCommand(SESSION_A, "hi", { enter: false, enterDelay: "0" }, recordedDeps);

    expect(events).toContain(`send --surface ${LIVE_SURFACE_UUID} -- hi`);
    expect(snapshotFetches).toBe(0);
});

test("stale recorded refs fall back to the matcher", async () => {
    setSnapshot([
        pane({
            id: "pane:7",
            surfaces: [surface({ id: "surface:41", title: `x · ${SESSION_A.slice(0, 8)}`, selected: true })],
        }),
    ]);
    const staleDeps = {
        ...deps,
        lookupRefs: () =>
            recordedRefs({
                workspaceId: "33333333-3333-4333-8333-333333333333",
                surfaceId: DEAD_SURFACE_UUID,
            }),
    };

    await sendCommand(SESSION_A.slice(0, 8), "hi", { first: true, enter: false, enterDelay: "0" }, staleDeps);

    expect(events).toContain(`send --surface ${DEAD_SURFACE_UUID} -- hi`);
    expect(events).toContain("send --surface surface:41 -- hi");
});

test("a stale recorded ref falling back to two panes is still refused", async () => {
    // The fallback re-runs the matcher, so it can land on several panes exactly
    // like the first pass. It used to take targets[0] with no --first, which is
    // the wrong-agent case the ambiguity guard exists to prevent.
    setSnapshot([
        pane({
            id: "pane:7",
            cwd: "/repo",
            selectedSurfaceRef: "surface:1",
            surfaces: [surface({ id: "surface:1", selected: true })],
        }),
        pane({
            id: "pane:8",
            cwd: "/repo",
            selectedSurfaceRef: "surface:2",
            surfaces: [surface({ id: "surface:2", selected: true })],
        }),
    ]);
    const staleDeps = {
        ...deps,
        lookupSession: async () => ({ aliases: [], sessionId: SESSION_A, cwd: "/repo" }),
        lookupRefs: () =>
            recordedRefs({
                workspaceId: "33333333-3333-4333-8333-333333333333",
                surfaceId: DEAD_SURFACE_UUID,
            }),
    };

    await sendCommand(SESSION_A, "hi", { json: true, enter: false, enterDelay: "0" }, staleDeps);

    const result = SafeJSON.parse(await capturedResult());
    expect(result.sent).toBe(false);
    expect(result.ambiguous).toBe(true);
    // The dead recorded surface is attempted once; nothing lands on a live pane.
    expect(events.some((event) => event.includes("--surface surface:41"))).toBe(false);
});

test("refuses to type into an ambiguous working-directory match", async () => {
    setSnapshot([
        pane({
            id: "pane:7",
            cwd: "/repo",
            selectedSurfaceRef: "surface:1",
            surfaces: [surface({ id: "surface:1", selected: true })],
        }),
        pane({
            id: "pane:8",
            cwd: "/repo",
            selectedSurfaceRef: "surface:2",
            surfaces: [surface({ id: "surface:2", selected: true })],
        }),
    ]);
    const cwdDeps = {
        ...deps,
        lookupSession: async () => ({ aliases: [], sessionId: SESSION_A, cwd: "/repo" }),
    };

    await sendCommand(SESSION_A, "hi", { first: true, json: true, enter: false, enterDelay: "0" }, cwdDeps);

    const result = SafeJSON.parse(await capturedResult());
    expect(result.sent).toBe(false);
    expect(result.source).toBe("cwd");
    expect(events.some((event) => event.startsWith("send "))).toBe(false);
});

test("a single working-directory match still delivers", async () => {
    setSnapshot([
        pane({
            id: "pane:7",
            cwd: "/repo",
            selectedSurfaceRef: "surface:1",
            surfaces: [surface({ id: "surface:1", selected: true })],
        }),
    ]);
    const cwdDeps = {
        ...deps,
        lookupSession: async () => ({ aliases: [], sessionId: SESSION_A, cwd: "/repo" }),
    };

    await sendCommand(SESSION_A, "hi", { first: true, enter: false, enterDelay: "0" }, cwdDeps);

    expect(events).toContain("send --surface surface:1 -- hi");
});

test("deliverySurfaceId prefers the matched surface over the selected one", () => {
    const target = {
        workspaceId: "workspace:11",
        workspaceName: "GenesisTools",
        paneId: "pane:7",
        paneTitle: "zsh",
        surfaceId: "surface:41",
        sessionIds: [],
        matchedOn: "title-id" as const,
        score: 90,
        active: false,
    };

    expect(
        deliverySurfaceId(target, [
            { id: "pane:7", selectedSurfaceRef: "surface:90", surfaces: [{ id: "surface:90", selected: true }] },
        ])
    ).toBe("surface:41");
    expect(
        deliverySurfaceId({ ...target, surfaceId: undefined }, [
            { id: "pane:7", selectedSurfaceRef: "surface:90", surfaces: [{ id: "surface:90", selected: true }] },
        ])
    ).toBe("surface:90");
});
