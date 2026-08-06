import { describe, expect, test } from "bun:test";
import type { TtydSession } from "@app/dev-dashboard/lib/ttyd/types";
import { buildTtydTabs } from "./terminal-tabs";

const s = (id: string, port: number, overrides: Partial<TtydSession> = {}): TtydSession => ({
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
            [s("a", 50245, { tmuxSessionName: "dev-dashboard-aaaa1111" }), s("b", 50261, { name: "deploy" })],
            "b"
        );
        expect(tabs).toEqual([
            { id: "a", label: "dev-dashboard-aaaa1111", active: false },
            { id: "b", label: "deploy", active: true },
        ]);
    });

    test("unbound sessions fall back to command:port", () => {
        expect(buildTtydTabs([s("a", 50245)], null)).toEqual([{ id: "a", label: "zsh :50245", active: false }]);
    });

    test("no active id → none active", () => {
        expect(buildTtydTabs([s("a", 1, { tmuxSessionName: "x" })], null)[0].active).toBe(false);
    });
});
