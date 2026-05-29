import { describe, expect, it } from "bun:test";
import { formatLastMessageAgo } from "@app/utils/format";
import type { DashboardSession } from "@app/utils/log-viewer/log-source";
import { formatDashboardSessionStatusLabel } from "./session-status-label";

describe("formatLastMessageAgo", () => {
    it("formats seconds only", () => {
        expect(formatLastMessageAgo(5000)).toBe("5s ago");
        expect(formatLastMessageAgo(0)).toBe("0s ago");
    });

    it("formats minutes and seconds", () => {
        expect(formatLastMessageAgo(135_000)).toBe("2m 15s ago");
    });

    it("formats hours minutes seconds", () => {
        expect(formatLastMessageAgo(3_903_000)).toBe("1h 5m 3s ago");
    });
});

describe("formatDashboardSessionStatusLabel", () => {
    const base: DashboardSession = {
        source: "task",
        name: "metro",
        badge: "task",
        projectPath: "",
        createdAt: Date.now() - 600_000,
        lastActivityAt: Date.now() - 12_000,
        state: "active",
        stateLabel: "active (running 10m 0s)",
    };

    it("shows live last message ago for active sessions", () => {
        const label = formatDashboardSessionStatusLabel({
            session: base,
            now: base.lastActivityAt + 12_000,
        });

        expect(label).toBe("active · last message 12s ago");
    });

    it("prefers latest line timestamp over session lastActivityAt", () => {
        const now = Date.now();
        const session: DashboardSession = {
            ...base,
            lastActivityAt: now - 20_000,
        };

        const label = formatDashboardSessionStatusLabel({
            session,
            now,
            latestLineTs: now - 3000,
        });

        expect(label).toBe("active · last message 3s ago");
    });
});
