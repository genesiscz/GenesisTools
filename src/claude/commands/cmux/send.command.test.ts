import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { OpenQuestion } from "@genesiscz/utils/agents/dialogs/types";
import type { CmuxLivePane, CmuxLiveSnapshot, CmuxLiveSurface } from "@genesiscz/utils/cmux/lib/live-snapshot";
import type { SessionCmuxRefs } from "@genesiscz/utils/cmux/session-refs";
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
        return { bundle_identifier: "com.cmuxterm.app", caller: { pane_id: CALLER_PANE, pane_ref: CALLER_PANE } };
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

const { deliverySurfaceId, sendCommand, sendWithin } = await import("./send");

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

test("paste submits one literal multiline message without chunking paths or issuing extra Enter keys", async () => {
    setSnapshot([pane({ id: "pane:7", surfaces: [surface({ id: "surface:41", title: SESSION_A, selected: true })] })]);
    const text =
        '<fromImage>\n{"path":"/fixture/' + "long-directory-".repeat(1200) + 'image-漢字.png"}\n</fromImage>\n';
    expect(await sendCommand(SESSION_A, text, { paste: true, enter: true }, deps)).toBe(true);
    expect(events.filter((event) => event.startsWith("paste"))).toEqual([
        "paste --surface surface:41 --submit -- " + text,
    ]);
    expect(events.some((event) => event.startsWith("send"))).toBe(false);
});

test("paste can leave the complete message unsubmitted and never retries an uncertain paste", async () => {
    setSnapshot([pane({ id: "pane:7", surfaces: [surface({ id: "surface:41", title: SESSION_A, selected: true })] })]);
    expect(await sendCommand(SESSION_A, "a\nb\\n", { paste: true, enter: false }, deps)).toBe(true);
    expect(events).toContain("paste --surface surface:41 -- a\nb\\n");
    const dead = { ...deps, lookupRefs: () => recordedRefs({ surfaceId: DEAD_SURFACE_UUID }) };
    await expect(sendCommand(SESSION_A, "a\nb", { paste: true }, dead)).rejects.toThrow("Surface is not a terminal");
    expect(events.filter((event) => event.includes(DEAD_SURFACE_UUID))).toHaveLength(1);
});

test("cmux being unreachable still prints the --json receipt, flushed, before the exit", async () => {
    snapshot = { ...snapshot, available: false, error: "socket refused" };
    const exit = spyOn(process, "exit").mockImplementation((() => {
        throw new Error("exited");
    }) as typeof process.exit);

    try {
        await expect(sendCommand(SESSION_A, "hi", { json: true }, deps)).rejects.toThrow("exited");
        expect(exit).toHaveBeenCalledWith(1);
        expect(stdout.join("")).toContain('"unavailable": true');
        expect(SafeJSON.parse(stdout.join(""))).toMatchObject({
            sent: false,
            unavailable: true,
            reason: "socket refused",
        });
    } finally {
        exit.mockRestore();
    }
});

test("an open dialog in the session refuses the send before any keystroke; --force types anyway", async () => {
    setSnapshot([pane({ id: "pane:7", surfaces: [surface({ id: "surface:41", title: SESSION_A, selected: true })] })]);
    const asked: string[] = [];
    const dialog = { kind: "permission" as const, question: "Allow Bash?", signal: "hook" as const };
    const guarded = {
        ...deps,
        openDialog: async (sessionId: string) => {
            asked.push(sessionId);
            return dialog;
        },
    };

    expect(await sendCommand(SESSION_A, "DECISION 1: a) yes", { paste: true, json: true }, guarded)).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(asked).toEqual([SESSION_A]);
    expect(events.filter((event) => event.startsWith("paste") || event.startsWith("send"))).toEqual([]);
    expect(SafeJSON.parse(await capturedResult())).toMatchObject({
        query: SESSION_A,
        sent: false,
        reason: expect.stringContaining("a permission prompt is open in the session (Allow Bash?)"),
        dialog,
        sessionId: SESSION_A,
    });

    process.exitCode = 0;
    const forced = {
        ...deps,
        openDialog: async (): Promise<never> => {
            throw new Error("--force must not ask the dialog guard");
        },
    };
    expect(await sendCommand(SESSION_A, "typed anyway", { paste: true, force: true }, forced)).toBe(true);
    expect(events).toContain("paste --surface surface:41 --submit --force -- typed anyway");

    // Control: no dialog, the same send types as before.
    events = [];
    const idle = { ...deps, openDialog: async () => null };
    expect(await sendCommand(SESSION_A, "hello", { paste: true }, idle)).toBe(true);
    expect(events).toContain("paste --surface surface:41 --submit -- hello");
});

test("the dialog guard checks a continued session before sending and after stale refs", async () => {
    const successor = "77777777-7777-4777-8777-777777777777";
    setSnapshot([pane({ id: "pane:7", surfaces: [surface({ id: "surface:41", title: successor, selected: true })] })]);
    const asked: string[] = [];
    let allowFirst = false;
    const continued = {
        ...deps,
        continuedIn: async (id: string) => (id === SESSION_A ? successor : undefined),
        lookupRefs: (id: string) =>
            id === successor ? recordedRefs({ sessionId: successor, surfaceId: DEAD_SURFACE_UUID }) : null,
        openDialog: async (id: string) => {
            asked.push(id);
            if (allowFirst && asked.length === 1) {
                return null;
            }
            return id === successor
                ? { kind: "permission" as const, question: "Allow?", signal: "hook" as const }
                : null;
        },
    };

    expect(await sendCommand(SESSION_A, "hello", { enter: false }, continued)).toBe(false);
    expect(asked).toEqual([successor]);
    expect(events.some((event) => event.startsWith("send"))).toBe(false);

    events = [];
    asked.length = 0;
    process.exitCode = 0;
    allowFirst = true;
    expect(await sendCommand(SESSION_A, "hello", { enter: false }, continued)).toBe(false);
    expect(asked).toEqual([successor, successor]);
    expect(events).toContain(`send --surface ${DEAD_SURFACE_UUID} -- hello`);
    expect(events.some((event) => event.includes("--surface surface:41"))).toBe(false);
});

function askRecord(overrides: Partial<OpenQuestion> = {}): OpenQuestion {
    return {
        provider: "claude",
        sessionId: SESSION_A,
        toolCallId: "toolu_fixture_1",
        kind: "decision",
        question: "Which colour?",
        options: ["Red", "Green", "Blue"],
        questionCount: 1,
        askedAt: "2026-10-30T20:00:00.000Z",
        source: "hook",
        ...overrides,
    };
}

test("the send deadline bounds the structured delivery rung", async () => {
    const outcome = await sendWithin(SESSION_A, "hello", { timeout: "0.001" }, deps, () => new Promise(() => {}));
    expect(outcome).toBe("timeout");
});

test("--option presses the option's digit into the open dialog, never text plus Enter, and leaves its record open", async () => {
    setSnapshot([pane({ id: "pane:7", surfaces: [surface({ id: "surface:41", title: SESSION_A, selected: true })] })]);
    const closed: string[] = [];
    const answering = {
        ...deps,
        openDialog: async (): Promise<never> => {
            throw new Error("the option path reads the records, not the free-text guard");
        },
        openRecords: () => [askRecord()],
        closeRecord: (record: OpenQuestion) => {
            closed.push(record.toolCallId);
        },
    };

    expect(await sendCommand(SESSION_A, "", { option: "c", json: true }, answering)).toBe(false);
    expect(events.filter((event) => event.startsWith("send") || event.startsWith("paste"))).toEqual([
        "send --surface surface:41 --force -- 3",
    ]);
    expect(closed).toEqual([]);
    expect(SafeJSON.parse(await capturedResult())).toMatchObject({
        sent: false,
        unconfirmed: true,
        option: "c",
        index: 2,
        label: "Blue",
        dialog: `claude:${SESSION_A}:toolu_fixture_1`,
        presses: [{ text: "3" }],
    });
});

test("--option refuses after a continuation and presses nothing into the successor's pane", async () => {
    const successor = "77777777-7777-4777-8777-777777777777";
    setSnapshot([pane({ id: "pane:7", surfaces: [surface({ id: "surface:41", title: successor, selected: true })] })]);
    const read: string[] = [];
    const answering = {
        ...deps,
        continuedIn: async (id: string) => (id === SESSION_A ? successor : undefined),
        openRecords: (id: string) => {
            read.push(id);
            return [askRecord({ sessionId: id })];
        },
    };

    expect(await sendCommand(SESSION_A, "", { option: "b", json: true }, answering)).toBe(false);
    expect(read).toEqual([]);
    expect(events.filter((event) => event.startsWith("send"))).toEqual([]);
    expect(SafeJSON.parse(await capturedResult())).toMatchObject({ sent: false, sessionId: successor });
});

test("--option skips the queried id's recorded pane, so a continuation is still refused", async () => {
    const successor = "77777777-7777-4777-8777-777777777777";
    setSnapshot([pane({ id: "pane:7", surfaces: [surface({ id: "surface:41", title: successor, selected: true })] })]);
    const read: string[] = [];
    const answering = {
        ...deps,
        lookupRefs: (id: string) => (id === SESSION_A ? recordedRefs() : null),
        continuedIn: async (id: string) => (id === SESSION_A ? successor : undefined),
        openRecords: (id: string) => {
            read.push(id);
            return [askRecord({ sessionId: id })];
        },
    };

    expect(await sendCommand(SESSION_A, "", { option: "b", json: true }, answering)).toBe(false);
    expect(read).toEqual([]);
    expect(events.filter((event) => event.startsWith("send"))).toEqual([]);

    // An ordinary send keeps the recorded shortcut.
    events = [];
    process.exitCode = 0;
    await sendCommand(
        SESSION_A,
        "hi",
        { enter: false, enterDelay: "0" },
        { ...answering, openDialog: async () => null }
    );
    expect(events).toContain(`send --surface ${LIVE_SURFACE_UUID} -- hi`);
});

test("--option does not close a dialog when writing a digit cannot confirm submission", async () => {
    setSnapshot([pane({ id: "pane:7", surfaces: [surface({ id: "surface:41", title: SESSION_A, selected: true })] })]);
    const closed: OpenQuestion[] = [];
    const answering = {
        ...deps,
        openRecords: () => [askRecord()],
        closeRecord: (record: OpenQuestion) => closed.push(record),
    };

    await sendCommand(SESSION_A, "", { option: "a", json: true }, answering);
    expect(closed).toEqual([]);
    expect(SafeJSON.parse(await capturedResult())).toMatchObject({ sent: false, unconfirmed: true });
});

test("--option refuses when the current dialog differs from the expected dialog", async () => {
    setSnapshot([pane({ id: "pane:7", surfaces: [surface({ id: "surface:41", title: SESSION_A, selected: true })] })]);
    const answering = { ...deps, openRecords: () => [askRecord()] };

    expect(
        await sendCommand(SESSION_A, "", { option: "a", json: true, expectedDialog: "claude:other:call" }, answering)
    ).toBe(false);
    expect(events.some((event) => event.startsWith("send") || event.startsWith("paste"))).toBe(false);
});

test("--option refuses before any key press with no open dialog, an option past the list, or text beside it", async () => {
    setSnapshot([pane({ id: "pane:7", surfaces: [surface({ id: "surface:41", title: SESSION_A, selected: true })] })]);
    const closeRecord = () => {
        throw new Error("a refused press must not close the record");
    };

    expect(await sendCommand(SESSION_A, "", { option: "a", json: true }, { ...deps, openRecords: () => [] })).toBe(
        false
    );
    expect(process.exitCode).toBe(1);
    expect(SafeJSON.parse(await capturedResult())).toMatchObject({
        sent: false,
        reason: "no question dialog is open in the session; send the answer as text instead",
    });

    stdout = [];
    process.exitCode = 0;
    const open = { ...deps, openRecords: () => [askRecord()], closeRecord };
    expect(await sendCommand(SESSION_A, "", { option: "d", json: true }, open)).toBe(false);
    expect(SafeJSON.parse(await capturedResult())).toMatchObject({
        sent: false,
        reason: 'option "d" is not in the dialog; its options are a) Red, b) Green, c) Blue',
    });
    expect(events.some((event) => event.startsWith("send") || event.startsWith("paste"))).toBe(false);

    await expect(sendCommand(SESSION_A, "b) Green", { option: "b" }, open)).rejects.toThrow("leave out the text");
});

test("the dialog guard asks about the session the matched pane runs when the query is not an id", async () => {
    setSnapshot([
        pane({
            id: "pane:7",
            surfaces: [surface({ id: "surface:41", title: "release-train", selected: true })],
            preview: `claude --resume ${SESSION_A}`,
        }),
    ]);
    const asked: string[] = [];
    const named = {
        ...deps,
        lookupSession: async () => ({ aliases: ["release-train"], sessionId: SESSION_A }),
        openDialog: async (sessionId: string) => {
            asked.push(sessionId);
            return { kind: "decision" as const, question: "Ship it?", signal: "turn-state" as const };
        },
    };

    expect(await sendCommand("release-train", "hi", { first: true, enter: false }, named)).toBe(false);
    expect(asked).toEqual([SESSION_A]);
    expect(events.some((event) => event.startsWith("send") || event.startsWith("paste"))).toBe(false);
});

test("--timeout ends a send whose lookup never answers, and rejects a bad value", async () => {
    const stuck = { ...deps, fetchSnapshot: () => new Promise<CmuxLiveSnapshot>(() => {}) };
    const started = Date.now();

    expect(await sendWithin("abcd1234", "hi", { first: true, timeout: "0.05" }, stuck)).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(events.filter((event) => event.startsWith("send"))).toEqual([]);
    await expect(sendWithin("abcd1234", "hi", { timeout: "soon" }, deps)).rejects.toThrow("--timeout must be");
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

test("an automated exact-session reply refuses even one working-directory match", async () => {
    setSnapshot([
        pane({
            id: "pane:7",
            cwd: "/repo",
            selectedSurfaceRef: "surface:1",
            surfaces: [surface({ id: "surface:1", selected: true })],
        }),
    ]);
    const cwdDeps = { ...deps, lookupSession: async () => ({ aliases: [], sessionId: SESSION_A, cwd: "/repo" }) };
    await sendCommand(SESSION_A, "media reply", { exactSession: true, paste: true, json: true }, cwdDeps);
    const result = SafeJSON.parse(await capturedResult());
    expect(result.sent).toBe(false);
    expect(result.source).toBe("cwd");
    expect(events.some((event) => event.startsWith("paste ") || event.startsWith("send "))).toBe(false);
});

test("an automated exact-session reply refuses a lone pane that only prints the id or shares the topic title", async () => {
    const printed = pane({
        id: "pane:7",
        selectedSurfaceRef: "surface:1",
        surfaces: [surface({ id: "surface:1", selected: true, preview: `discussing ${SESSION_A} in another agent` })],
    });
    const topical = pane({
        id: "pane:7",
        selectedSurfaceRef: "surface:1",
        surfaces: [surface({ id: "surface:1", selected: true, title: "Pricing rewrite" })],
    });
    const aliasDeps = { ...deps, lookupSession: async () => ({ aliases: ["Pricing rewrite"], sessionId: SESSION_A }) };

    for (const [fixture, fixtureDeps, matchedOn] of [
        [printed, deps, "session-id"],
        [topical, aliasDeps, "session-name"],
    ] as const) {
        events = [];
        stdout = [];
        setSnapshot([fixture]);
        await sendCommand(SESSION_A, "media reply", { exactSession: true, paste: true, json: true }, fixtureDeps);
        const result = SafeJSON.parse(await capturedResult());
        expect(result.sent).toBe(false);
        expect(result.source).toBe("titles");
        expect(result.matches[0].matchedOn).toBe(matchedOn);
        expect(events.some((event) => event.startsWith("paste ") || event.startsWith("send "))).toBe(false);
    }

    // Control: without --exact-session an interactive send still takes the printed id.
    events = [];
    setSnapshot([printed]);
    expect(await sendCommand(SESSION_A, "hi", { paste: true }, deps)).toBe(true);
    expect(events).toContain("paste --surface surface:1 --submit -- hi");
});

test("an automated exact-session reply still reaches the pane resuming the session", async () => {
    setSnapshot([
        pane({
            id: "pane:7",
            selectedSurfaceRef: "surface:1",
            surfaces: [
                surface({ id: "surface:1", selected: true, preview: `tools claude start -- --resume '${SESSION_A}'` }),
            ],
        }),
        pane({
            id: "pane:8",
            selectedSurfaceRef: "surface:2",
            surfaces: [surface({ id: "surface:2", selected: true, preview: `discussing ${SESSION_A}` })],
        }),
    ]);
    expect(await sendCommand(SESSION_A, "media reply", { exactSession: true, paste: true }, deps)).toBe(true);
    expect(events).toContain("paste --surface surface:1 --submit -- media reply");
    expect(events.some((event) => event.includes("surface:2"))).toBe(false);
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

test("a session in tmux is typed into the tab running its tmux client, and refused while its pane is off screen", async () => {
    setSnapshot([
        pane({
            id: "pane:9",
            title: "tools tmux session attach dd-045c53d3",
            surfaces: [surface({ id: "surface:51", selected: true, tty: "ttys001" })],
        }),
    ]);
    const host = { session: "dd-045c53d3", pane: "%200", visible: true, clientTtys: ["/dev/ttys001"] };

    expect(
        await sendCommand(
            SESSION_A,
            "hello",
            { exactSession: true, enter: false, enterDelay: "0" },
            { ...deps, tmuxHosts: async () => [host] }
        )
    ).toBe(true);
    expect(events).toContain("send --surface surface:51 -- hello");

    events = [];
    expect(
        await sendCommand(
            SESSION_A,
            "hello",
            { first: true, json: true, enter: false, enterDelay: "0" },
            { ...deps, tmuxHosts: async () => [{ ...host, visible: false }] }
        )
    ).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(await capturedResult()).toContain(`"hidden": true`);
    expect(events.filter((event) => event.startsWith("send"))).toEqual([]);
});

test("Claude liveness uses the transcript's own registry and keeps unknown evidence unknown", async () => {
    const { claudeNativeSessionAlive } = await import("@genesiscz/utils/agent-sessions/readers/claude-dialog");
    const transcriptPath = `/fixture/other-account/projects/project/${SESSION_A}.jsonl`;
    let directory = "";
    expect(
        claudeNativeSessionAlive(transcriptPath, SESSION_A, (path) => {
            directory = path;
            return new Set([SESSION_A.toLowerCase()]);
        })
    ).toBe(true);
    expect(directory).toBe("/fixture/other-account/sessions");
    expect(claudeNativeSessionAlive(transcriptPath, SESSION_A, () => new Set())).toBe(false);
    expect(claudeNativeSessionAlive(transcriptPath, SESSION_A, () => null)).toBeNull();
    expect(claudeNativeSessionAlive("/fixture/unknown/session.jsonl", SESSION_A, () => new Set())).toBeNull();
});

test("Claude's registry status `waiting` is an open dialog for that session only, never for a parked copy", async () => {
    const { claudeRegistryDialog } = await import("@app/claude/lib/cmux/dialog-guard");
    const entry = {
        pid: 42,
        sessionId: SESSION_A,
        name: "fixture",
        cwd: "/fixture",
        status: "waiting",
        kind: "interactive",
        socketPath: "/fixture/42.sock",
        file: "/fixture/sessions/42.json",
    };

    expect(claudeRegistryDialog(SESSION_A, () => [entry])).toEqual({
        kind: "decision",
        question: null,
        signal: "registry",
    });
    expect(claudeRegistryDialog(SESSION_A, () => [{ ...entry, status: "idle" }])).toBeNull();
    expect(claudeRegistryDialog(SESSION_A, () => [{ ...entry, status: "busy" }])).toBeNull();
    expect(claudeRegistryDialog(SESSION_A, () => [{ ...entry, parkedJobId: "job-1" }])).toBeNull();
    expect(claudeRegistryDialog("another-session", () => [entry])).toBeNull();
});

test("Claude waiting status reads the registry that owns the transcript", async () => {
    const { claudeRegistryDialog } = await import("@app/claude/lib/cmux/dialog-guard");
    const { claudeHistoryReader } = await import("@genesiscz/utils/agent-sessions/compact-readers");
    const transcript = `/fixture/other-account/projects/project/${SESSION_A}.jsonl`;
    const entry = {
        pid: 42,
        sessionId: SESSION_A,
        name: null,
        cwd: null,
        status: "waiting",
        kind: "interactive",
        socketPath: "/fixture/42.sock",
        file: "/fixture/other-account/sessions/42.json",
    };
    let directory: string | undefined;
    const dialog = claudeRegistryDialog(
        SESSION_A,
        (dir) => {
            directory = dir;
            return dir === "/fixture/other-account/sessions" ? [entry] : [];
        },
        claudeHistoryReader.dialog.registryDirectory(transcript)
    );
    expect(directory).toBe("/fixture/other-account/sessions");
    expect(dialog?.signal).toBe("registry");
});

test("multi-line text goes as one paste even without --paste; a single line keeps the typed path", async () => {
    setSnapshot([pane({ id: "pane:7", surfaces: [surface({ id: "surface:41", title: SESSION_A, selected: true })] })]);

    expect(await sendCommand(SESSION_A, "first line\nsecond line", { enterDelay: "0" }, deps)).toBe(true);
    expect(events.filter((event) => event.startsWith("paste") || event.startsWith("send"))).toEqual([
        "paste --surface surface:41 --submit -- first line\nsecond line",
    ]);

    events = [];
    expect(await sendCommand(SESSION_A, "one line", { enterDelay: "0" }, deps)).toBe(true);
    expect(events.filter((event) => event.startsWith("paste") || event.startsWith("send"))).toEqual([
        "send --surface surface:41 -- one line",
        "send-key --surface surface:41 enter",
    ]);
});

test("every pane send receipt reads back as the outcome it printed, so no caller parses the JSON itself", async () => {
    const { paneSendReceipt, readPaneReceipt } = await import("@app/claude/lib/cmux/pane-send");
    const target = {
        workspaceId: "workspace:11",
        workspaceName: "GenesisTools",
        paneId: "pane:7",
        paneTitle: "agent",
        surfaceId: "surface:41",
        sessionIds: [SESSION_A],
        matchedOn: "recorded" as const,
        score: 100,
        active: true,
    };
    const read = (outcome: Parameters<typeof paneSendReceipt>[0]) =>
        readPaneReceipt(SafeJSON.stringify(paneSendReceipt(outcome)));

    expect(
        read({ kind: "typed", query: SESSION_A, target, surfaceId: "surface:41", enter: true, source: "recorded" })
    ).toEqual({ kind: "typed", pane: { workspaceName: "GenesisTools", paneTitle: "agent" } });
    expect(
        read({
            kind: "dialog",
            query: SESSION_A,
            reason: "a question dialog is open",
            dialog: { kind: "decision", question: null, signal: "registry" },
            sessionId: SESSION_A,
            target,
        })
    ).toEqual({ kind: "refused", reason: "a question dialog is open", dialog: true, ambiguous: false });
    expect(read({ kind: "ambiguous", query: SESSION_A, matches: [target, target] })).toEqual({
        kind: "refused",
        dialog: false,
        ambiguous: true,
        matches: 2,
    });
    expect(read({ kind: "no-match", query: SESSION_A })).toEqual({
        kind: "refused",
        dialog: false,
        ambiguous: false,
        matches: 0,
    });
    expect(
        read({
            kind: "option-pressed",
            query: SESSION_A,
            option: "a",
            index: 0,
            label: "Yes",
            dialog: `claude:${SESSION_A}:tool-1`,
            presses: [{ key: "1" }],
            target,
            surfaceId: "surface:41",
            source: "recorded",
        })
    ).toMatchObject({ kind: "unconfirmed" });
    expect(readPaneReceipt("not json")).toEqual({ kind: "unreadable" });
    expect(readPaneReceipt('{"matches":[]}')).toEqual({ kind: "unreadable" });
});

test("--harness takes a harness id only, and refuses anything else before any lookup", async () => {
    events = [];
    await expect(sendCommand(SESSION_A, "hi", { harness: "claude-code" }, deps)).rejects.toThrow(
        "--harness is one of claude, codex, grok"
    );
    expect(events).toEqual([]);
});
