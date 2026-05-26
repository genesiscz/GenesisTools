import { describe, expect, it } from "bun:test";
import type { DashboardSession } from "@app/utils/log-viewer/log-source";
import {
    resolveSessionLastMessageTs,
    resolveSessionLiveStatusDisplay,
    resolveSessionLiveStatusKind,
} from "./session-live-status";

describe("session-live-status", () => {
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

    const now = 310_000;

    it("prefers latest line timestamp over session lastActivityAt", () => {
        expect(resolveSessionLastMessageTs(base, 5000)).toBe(5000);
    });

    it("classifies active sessions", () => {
        expect(resolveSessionLiveStatusKind(base, 5000)).toBe("active");
    });

    it("shows running with second-level last message ago", () => {
        const display = resolveSessionLiveStatusDisplay({
            session: base,
            latestLineTs: now - 135_000,
            now,
        });

        expect(display.phase).toBe("running");
        expect(display.stateLabel).toBe("running");
        expect(display.agoLabel).toBe("2m 15s ago");
    });

    it("shows killed with second-level ago from exitedAt", () => {
        const session: DashboardSession = {
            ...base,
            state: "exited",
            stateLabel: "exited (code 130)",
            exitCode: 130,
            exitedAt: now - 305_000,
            lastActivityAt: now - 305_000,
        };

        const display = resolveSessionLiveStatusDisplay({
            session,
            now,
        });

        expect(display.phase).toBe("killed");
        expect(display.stateLabel).toBe("killed");
        expect(display.agoLabel).toBe("5m 5s ago");
    });

    it("includes seconds after one minute", () => {
        const display = resolveSessionLiveStatusDisplay({
            session: base,
            latestLineTs: now - 180_000,
            now,
        });

        expect(display.agoLabel).toBe("3m 0s ago");
    });

    it("falls back for exited sessions without timestamps", () => {
        const session: DashboardSession = { ...base, state: "exited", stateLabel: "exited (code 0)" };

        expect(resolveSessionLiveStatusKind(session, 0)).toBe("fallback");
    });
});
