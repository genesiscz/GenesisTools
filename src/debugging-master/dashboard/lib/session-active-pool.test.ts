import { describe, expect, it } from "bun:test";
import type { DashboardSession } from "@app/utils/log-viewer/log-source";
import { SESSION_ACTIVE_RETENTION_MS, isSessionInActivePool } from "./session-active-pool";

describe("session-active-pool", () => {
    const base: DashboardSession = {
        source: "task",
        name: "metro",
        badge: "task",
        projectPath: "",
        createdAt: 0,
        lastActivityAt: 1000,
        state: "active",
        stateLabel: "active",
    };

    it("keeps running sessions in the pool", () => {
        expect(isSessionInActivePool(base, 2000)).toBe(true);
    });

    it("keeps recently killed sessions in the pool for one hour", () => {
        const now = 3_600_000;
        const session: DashboardSession = {
            ...base,
            state: "exited",
            stateLabel: "killed",
            exitCode: 130,
            exitedAt: now - 5 * 60_000,
            lastActivityAt: now - 5 * 60_000,
        };

        expect(isSessionInActivePool(session, now)).toBe(true);
    });

    it("drops sessions inactive for at least one hour", () => {
        const now = SESSION_ACTIVE_RETENTION_MS + 5000;
        const session: DashboardSession = {
            ...base,
            state: "exited",
            stateLabel: "killed",
            exitCode: 130,
            exitedAt: 1000,
            lastActivityAt: 1000,
        };

        expect(isSessionInActivePool(session, now)).toBe(false);
    });
});
