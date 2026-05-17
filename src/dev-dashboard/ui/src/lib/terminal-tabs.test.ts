import { describe, expect, test } from "bun:test";
import type { TtydSession } from "@app/dev-dashboard/lib/ttyd/types";
import { buildTtydTabs } from "./terminal-tabs";

const s = (id: string, port: number, name?: string): TtydSession => ({
    id,
    port,
    command: "/bin/zsh",
    cwd: "/x",
    pid: 1,
    startedAt: "now",
    name,
});

describe("buildTtydTabs", () => {
    test("maps sessions to tabs with label fallback + active flag", () => {
        const tabs = buildTtydTabs([s("a", 50245), s("b", 50261, "deploy")], "b");
        expect(tabs).toEqual([
            { id: "a", label: "zsh :50245", active: false },
            { id: "b", label: "deploy", active: true },
        ]);
    });

    test("no active id → none active", () => {
        expect(buildTtydTabs([s("a", 1)], null)[0].active).toBe(false);
    });
});
