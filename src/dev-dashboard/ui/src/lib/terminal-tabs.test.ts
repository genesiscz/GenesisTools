import { describe, expect, test } from "bun:test";
import type { TtydSession } from "@app/dev-dashboard/lib/ttyd/types";
import { buildTtydTabs } from "./terminal-tabs";

const s = ({ id, port, ...overrides }: { id: string; port: number } & Partial<TtydSession>): TtydSession => ({
    id,
    port,
    command: "/bin/zsh",
    cwd: "/x",
    pid: 1,
    startedAt: "now",
    ...overrides,
});

describe("buildTtydTabs", () => {
    test("maps sessions to tabs with tmux identity + active flag", () => {
        const tabs = buildTtydTabs(
            [
                s({ id: "a", port: 50245, tmuxSessionName: "dev-dashboard-aaaa1111" }),
                s({ id: "b", port: 50261, name: "deploy" }),
            ],
            "b"
        );
        expect(tabs).toEqual([
            { id: "a", label: "dev-dashboard-aaaa1111", active: false, lastLine: undefined },
            { id: "b", label: "deploy", active: true, lastLine: undefined },
        ]);
    });

    test("unbound sessions fall back to command:port", () => {
        expect(buildTtydTabs([s({ id: "a", port: 50245 })], null)).toEqual([
            { id: "a", label: "zsh :50245", active: false, lastLine: undefined },
        ]);
    });

    test("no active id → none active", () => {
        expect(buildTtydTabs([s({ id: "a", port: 1, tmuxSessionName: "x" })], null)[0].active).toBe(false);
    });

    // NAME vs TITLE: the topic rides along as secondary meta and must never become the label.
    test("Claude's topic is carried as lastLine, never as the label", () => {
        const tabs = buildTtydTabs(
            [s({ id: "a", port: 1, tmuxSessionName: "dev-dashboard-aaaa1111", title: "Fix v1.2 bug" })],
            "a"
        );

        expect(tabs[0].label).toBe("dev-dashboard-aaaa1111");
        expect(tabs[0].lastLine).toBe("Fix v1.2 bug");
    });
});
