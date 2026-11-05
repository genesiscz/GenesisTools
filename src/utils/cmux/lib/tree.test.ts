import { describe, expect, test } from "bun:test";
import type { SessionPin } from "../../agent-sessions/pins";
import { fetchAgentCmuxTree } from "../agent-tree";
import type { SessionCmuxRefs } from "../session-refs";
import { fetchCmuxTree } from "../tree";
import type { CmuxLivePane, CmuxLiveSnapshot, CmuxLiveWindow, CmuxLiveWorkspace } from "./live-snapshot";
import { buildCmuxHierarchy } from "./tree";
import {
    type CmuxTreeBackoff,
    TREE_BACKOFF_FIRST_MS,
    TREE_BACKOFF_MAX_MS,
    type TreeBackoffStore,
    treeBackoffDelayMs,
} from "./tree-backoff";

function pane(id: string, workspaceId: string): CmuxLivePane {
    return { id, workspaceId, title: "zsh", active: false, surfaceCount: 1, surfaces: [] };
}

function workspace(id: string, windowRef?: string): CmuxLiveWorkspace {
    return { id, name: id, windowRef };
}

function snapshotOf(
    workspaces: CmuxLiveWorkspace[],
    panes: CmuxLivePane[],
    windows?: CmuxLiveWindow[]
): CmuxLiveSnapshot {
    return { fetchedAt: "2026-08-27T13:00:00.000Z", available: true, windows, workspaces, panes };
}

describe("buildCmuxHierarchy", () => {
    test("a snapshot with no window list collapses into one synthetic window", () => {
        const snapshot = snapshotOf(
            [workspace("workspace:11"), workspace("workspace:12", "window:9")],
            [pane("pane:1", "workspace:11"), pane("pane:2", "workspace:12")]
        );

        const windows = buildCmuxHierarchy(snapshot);

        expect(windows).toHaveLength(1);
        expect(windows[0].id).toBe("window:current");
        expect(windows[0].key).toBe(true);
        expect(windows[0].ref).toBeUndefined();
        // Every workspace belongs to it, including one carrying a windowRef of its own.
        expect(windows[0].workspaces.map((ws) => ws.id)).toEqual(["workspace:11", "workspace:12"]);
        expect(windows[0].workspaces[0].panes.map((p) => p.id)).toEqual(["pane:1"]);
    });

    test("an empty window list behaves like a missing one", () => {
        const snapshot = snapshotOf([workspace("workspace:11")], [pane("pane:1", "workspace:11")], []);

        const windows = buildCmuxHierarchy(snapshot);

        expect(windows).toHaveLength(1);
        expect(windows[0].id).toBe("window:current");
        expect(windows[0].workspaces.map((ws) => ws.id)).toEqual(["workspace:11"]);
    });

    test("listed windows take the workspaces their refs name", () => {
        const snapshot = snapshotOf(
            [workspace("workspace:11", "window:1"), workspace("workspace:22", "window:2")],
            [pane("pane:1", "workspace:11"), pane("pane:2", "workspace:22")],
            [
                { id: "win-a", ref: "window:1", index: 0, key: true, workspaceCount: 1 },
                { id: "win-b", ref: "window:2", index: 1, key: false, workspaceCount: 1 },
            ]
        );

        const windows = buildCmuxHierarchy(snapshot);

        expect(windows.map((w) => w.workspaces.map((ws) => ws.id))).toEqual([["workspace:11"], ["workspace:22"]]);
        expect(windows[1].workspaces[0].panes.map((p) => p.id)).toEqual(["pane:2"]);
    });

    test("a workspace with no ref lands in the key window only", () => {
        const snapshot = snapshotOf(
            [workspace("workspace:11")],
            [pane("pane:1", "workspace:11")],
            [
                { id: "win-a", ref: "window:1", index: 0, key: false, workspaceCount: 0 },
                { id: "win-b", ref: "window:2", index: 1, key: true, workspaceCount: 1 },
            ]
        );

        const windows = buildCmuxHierarchy(snapshot);

        expect(windows[0].workspaces).toEqual([]);
        expect(windows[1].workspaces.map((ws) => ws.id)).toEqual(["workspace:11"]);
    });

    test("panes in no listed workspace surface under the key window", () => {
        const snapshot = snapshotOf(
            [workspace("workspace:11", "window:1")],
            [pane("pane:1", "workspace:11"), pane("pane:9", "workspace:gone")],
            [
                { id: "win-a", ref: "window:1", index: 0, key: false, workspaceCount: 1 },
                { id: "win-b", ref: "window:2", index: 1, key: true, workspaceCount: 0 },
            ]
        );

        const windows = buildCmuxHierarchy(snapshot);

        expect(windows[1].workspaces.map((ws) => ws.id)).toEqual(["workspace:unmatched"]);
        expect(windows[1].workspaces[0].panes.map((p) => p.id)).toEqual(["pane:9"]);
    });
});

describe("fetchAgentCmuxTree", () => {
    const at = 1_758_700_000_000;
    const S1 = "11111111-AAAA-4AAA-8AAA-000000000001";
    const S2 = "11111111-AAAA-4AAA-8AAA-000000000002";
    const S3 = "11111111-AAAA-4AAA-8AAA-000000000003";
    const livePane: CmuxLivePane = {
        id: "pane:1",
        workspaceId: "workspace:1",
        title: "zsh",
        active: true,
        surfaceCount: 3,
        frame: { x: 0, y: 0, width: 800, height: 600 },
        container: { width: 1600, height: 600 },
        surfaces: [
            { id: S1, ref: "surface:1", title: "claude", type: "terminal", index: 0, selected: true, active: true },
            { id: S2, ref: "surface:2", title: "codex", type: "terminal", index: 1, selected: false, active: false },
            {
                id: S3,
                ref: "surface:3",
                title: "old · 1a2b3c4d",
                type: "terminal",
                index: 2,
                selected: false,
                active: false,
            },
        ],
    };
    const snapshot = snapshotOf([workspace("workspace:1")], [livePane]);

    function ref(
        sessionId: string,
        surfaceRef: string,
        provider?: "claude" | "codex",
        surfaceId: string | null = null
    ): SessionCmuxRefs {
        return {
            sessionId,
            provider,
            workspaceId: null,
            surfaceId,
            workspaceRef: "workspace:1",
            paneRef: "pane:1",
            surfaceRef,
            windowRef: null,
            tmuxPane: null,
            cwd: null,
            at,
        };
    }

    const claudeId = "aaaaaaaa-1111-4111-8111-111111111111";
    const codexId = "bbbbbbbb-2222-7222-8222-222222222222";
    // The Claude line is tagged; the Codex line predates the tag and only its pin names the agent.
    const refs = new Map([
        [claudeId, ref(claudeId, "surface:1", "claude", S1.toLowerCase())],
        [codexId, ref(codexId, "surface:2", undefined, S2)],
    ]);
    const codexPin: SessionPin = {
        sessionId: codexId,
        provider: "codex",
        account: null,
        model: null,
        cwd: "/tmp/project",
        workspaceId: null,
        source: "hook",
        at,
    };
    const deps = {
        fetchSnapshot: async () => snapshot,
        loadRefs: () => refs,
        loadPins: async () => new Map([[codexId, codexPin]]),
    };

    test("labels every agent, resolving an untagged line through its pin, and keeps frames", async () => {
        const tree = await fetchAgentCmuxTree(deps);
        const pane = tree.windows[0].workspaces[0].panes[0];

        expect(pane.surfaces.map((s) => [s.sessionId?.slice(0, 8) ?? null, s.provider])).toEqual([
            ["aaaaaaaa", "claude"],
            ["bbbbbbbb", "codex"],
            [null, null],
        ]);
        expect(pane.surfaces[2].sessionHint).toBe("1a2b3c4d");
        expect(pane.frame).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    });

    // 2026-10-14: after a cmux relaunch every `surface:N` ref is renumbered, so the journal's refs name
    // nothing live. The UUID survives the relaunch, and it is what finds the session.
    test("after a relaunch the session is found by surface UUID, not by the renumbered ref", async () => {
        const uuid = "5E0B4485-9AA4-452E-9814-5C366F66D8C2";
        const relaunched = snapshotOf(
            [workspace("workspace:1")],
            [
                {
                    ...livePane,
                    surfaces: [
                        {
                            id: uuid,
                            ref: "surface:9",
                            title: "nabidky-2.0",
                            type: "terminal",
                            index: 0,
                            selected: true,
                            active: true,
                        },
                    ],
                },
            ]
        );
        const journal = new Map([
            [claudeId, { ...ref(claudeId, "surface:1", "claude"), surfaceId: uuid.toLowerCase() }],
        ]);
        const tree = await fetchAgentCmuxTree({
            ...deps,
            fetchSnapshot: async () => relaunched,
            loadRefs: () => journal,
        });

        expect(tree.windows[0].workspaces[0].panes[0].surfaces[0].sessionId).toBe(claudeId);
    });

    // A record without a UUID names a tab only by a ref from its own cmux run, which can be another tab now.
    test("a journal line with only a ref labels no surface", async () => {
        const tree = await fetchAgentCmuxTree({
            ...deps,
            loadRefs: () => new Map([[claudeId, ref(claudeId, "surface:1", "claude")]]),
        });

        expect(tree.windows[0].workspaces[0].panes[0].surfaces.map((surface) => surface.sessionId)).toEqual([
            null,
            null,
            null,
        ]);
    });

    test("a provider filter drops the other agents' sessions", async () => {
        const tree = await fetchAgentCmuxTree({ ...deps, providers: ["claude"] });
        const surfaces = tree.windows[0].workspaces[0].panes[0].surfaces;

        expect(surfaces.map((s) => s.sessionId?.slice(0, 8) ?? null)).toEqual(["aaaaaaaa", null, null]);
    });
});

describe("fetchCmuxTree backoff after cmux does not answer", () => {
    const dead: CmuxLiveSnapshot = {
        fetchedAt: "2026-11-02T11:20:09.000Z",
        available: false,
        error: "cmux live snapshot: the cmux app is running (pid 42) but its socket does not answer",
        unresponsive: { state: "socket-dead", appPid: 42 },
        workspaces: [],
        panes: [],
    };
    const alive = snapshotOf([workspace("workspace:1")], [pane("pane:1", "workspace:1")]);

    function memoryStore(): TreeBackoffStore & { record: CmuxTreeBackoff | null } {
        return {
            record: null,
            read() {
                return this.record;
            },
            write(record) {
                this.record = record;
            },
        };
    }

    test("a dead socket is asked once per doubling delay, and a success clears the memory", async () => {
        const backoff = memoryStore();
        let clock = 1_000_000;
        let calls = 0;
        let next = dead;
        const deps = {
            backoff,
            appPid: () => 42,
            now: () => clock,
            fetchSnapshot: async () => {
                calls++;
                return next;
            },
        };

        expect((await fetchCmuxTree(deps)).available).toBe(false);
        expect(calls).toBe(1);
        expect(backoff.record?.until).toBe(clock + TREE_BACKOFF_FIRST_MS);

        clock += TREE_BACKOFF_FIRST_MS - 1;
        const skipped = await fetchCmuxTree(deps);
        expect(calls).toBe(1);
        expect(skipped.available).toBe(false);
        expect(skipped.error).toContain("its socket does not answer");
        expect(skipped.error).toContain("the next try is after");

        clock += 1;
        await fetchCmuxTree(deps);
        expect(calls).toBe(2);
        expect(backoff.record?.failures).toBe(2);
        expect(backoff.record?.until).toBe(clock + 2 * TREE_BACKOFF_FIRST_MS);

        clock = backoff.record?.until ?? clock;
        next = alive;
        expect((await fetchCmuxTree(deps)).available).toBe(true);
        expect(calls).toBe(3);
        expect(backoff.record).toBeNull();
    });

    test("a restarted cmux (another pid) is asked at once", async () => {
        const backoff = memoryStore();
        backoff.record = { failures: 3, until: Date.now() + 60_000, state: "socket-dead", appPid: 42, error: "dead" };
        let calls = 0;
        const tree = await fetchCmuxTree({
            backoff,
            appPid: () => 43,
            fetchSnapshot: async () => {
                calls++;
                return alive;
            },
        });

        expect(calls).toBe(1);
        expect(tree.available).toBe(true);
        expect(backoff.record).toBeNull();
    });

    test("a restarted cmux that fails starts at the shortest backoff", async () => {
        const backoff = memoryStore();
        backoff.record = { failures: 5, until: Date.now() + 300_000, state: "socket-dead", appPid: 42, error: "dead" };
        await fetchCmuxTree({
            backoff,
            appPid: () => 43,
            fetchSnapshot: async () => ({ ...dead, unresponsive: { state: "socket-dead", appPid: 43 } }),
        });
        expect(backoff.record?.failures).toBe(1);
        expect(backoff.record?.appPid).toBe(43);
    });

    test("a failure that is not cmux hanging leaves no memory", async () => {
        const backoff = memoryStore();
        await fetchCmuxTree({
            backoff,
            fetchSnapshot: async () => ({ ...dead, unresponsive: { state: "not-running" } }),
        });

        expect(backoff.record).toBeNull();
    });

    test("the delay doubles from 20 s and stops at 5 min", () => {
        expect([1, 2, 3, 4, 5, 6, 10].map(treeBackoffDelayMs)).toEqual([
            20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000,
        ]);
        expect(TREE_BACKOFF_MAX_MS).toBe(300_000);
    });
});
