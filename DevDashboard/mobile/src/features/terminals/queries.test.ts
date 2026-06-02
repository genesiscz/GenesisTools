import { describe, expect, it } from "bun:test";
import { mockDashboardClient } from "@/api/mock-client";
import {
    CMUX_INTERVAL_MS,
    SESSIONS_INTERVAL_MS,
    cmuxLayoutQuery,
    cmuxSnapshotQuery,
    createTmux,
    killTtyd,
    renameTtyd,
    spawnTtyd,
    terminalsKeys,
    tmuxSessionsQuery,
    ttydListQuery,
} from "@/features/terminals/queries";

/**
 * Exercises the Terminals data layer the way the Pulse reference test does: against the comprehensive
 * mock client (proving the fixtures every screen consumes are shaped right) AND the `queryOptions`
 * factories (key shape, polling interval, queryFn presence). No React renderer — the hooks are
 * one-liners with no logic, so the mock + factory + mutation-caller IS the meaningful seam (D20: a
 * test renderer would be a new lib decision; the pulse plan already settled this).
 */

describe("terminals mock fixtures (the data screens consume)", () => {
    it("tmux.sessions returns hub sessions with ttyd/cmux bindings", async () => {
        const res = await mockDashboardClient.tmux.sessions();

        expect(res.sessions.length).toBeGreaterThan(0);
        const dev = res.sessions.find((s) => s.name === "dev");
        expect(dev?.canAttachInTtyd).toBe(true);
        expect(dev?.ttydTabIds).toContain("ttyd-1");
    });

    it("ttyd.list returns live PTYs with an attachable id", async () => {
        const res = await mockDashboardClient.ttyd.list();

        expect(res.sessions.length).toBeGreaterThan(0);
        expect(res.sessions[0]?.id).toBeTruthy();
        expect(typeof res.sessions[0]?.port).toBe("number");
    });

    it("cmux.snapshot exposes workspaces + panes + surfaces", async () => {
        const res = await mockDashboardClient.cmux.snapshot();

        expect(res.snapshot.available).toBe(true);
        expect(res.snapshot.workspaces.length).toBeGreaterThan(0);
        expect(res.snapshot.panes[0]?.surfaces[0]?.type).toBe("terminal");
    });

    it("cmux.layout exposes the window/workspace/pane tree", async () => {
        const res = await mockDashboardClient.cmux.layout();

        expect(res.layout.available).toBe(true);
        expect(res.layout.windows[0]?.workspaces[0]?.panes.length).toBeGreaterThan(0);
    });

    it("ttyd.spawn returns the created session", async () => {
        const res = await spawnTtyd(mockDashboardClient, { tmuxSessionName: "dev" });

        expect(res.session.id).toBeTruthy();
    });

    it("ttyd.kill resolves ok", async () => {
        const res = await killTtyd(mockDashboardClient, { id: "ttyd-1" });

        expect(res.ok).toBe(true);
    });

    it("ttyd.rename resolves ok", async () => {
        const res = await renameTtyd(mockDashboardClient, { id: "ttyd-1", name: "renamed" });

        expect(res.ok).toBe(true);
    });

    it("tmux.create echoes the requested session name", async () => {
        const res = await createTmux(mockDashboardClient, { name: "scratch" });

        expect(res.sessionName).toBe("scratch");
    });
});

describe("terminals queryOptions factories", () => {
    it("tmuxSessionsQuery has the tmux key and the sessions interval", () => {
        const q = tmuxSessionsQuery(mockDashboardClient);

        expect([...q.queryKey]).toEqual([...terminalsKeys.tmux]);
        expect(q.refetchInterval).toBe(SESSIONS_INTERVAL_MS);
        expect(typeof q.queryFn).toBe("function");
    });

    it("ttydListQuery has the ttyd key", () => {
        const q = ttydListQuery(mockDashboardClient);

        expect([...q.queryKey]).toEqual([...terminalsKeys.ttyd]);
        expect(q.refetchInterval).toBe(SESSIONS_INTERVAL_MS);
    });

    it("cmux factories carry the cmux interval and distinct keys", () => {
        const snap = cmuxSnapshotQuery(mockDashboardClient);
        const layout = cmuxLayoutQuery(mockDashboardClient);

        expect([...snap.queryKey]).toEqual([...terminalsKeys.cmux.snapshot]);
        expect([...layout.queryKey]).toEqual([...terminalsKeys.cmux.layout]);
        expect(snap.refetchInterval).toBe(CMUX_INTERVAL_MS);
        expect([...snap.queryKey]).not.toEqual([...layout.queryKey]);
    });

    it("the factory queryFn actually calls through to the client", async () => {
        const q = tmuxSessionsQuery(mockDashboardClient);
        const res = await (q.queryFn as () => Promise<{ sessions: unknown[] }>)();

        expect(Array.isArray(res.sessions)).toBe(true);
    });
});
