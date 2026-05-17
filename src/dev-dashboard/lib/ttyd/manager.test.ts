import { afterEach, describe, expect, test } from "bun:test";
import { killAllTtyd, killTtyd, listTtyd, spawnTtyd, ttydLabel } from "@app/dev-dashboard/lib/ttyd/manager";
import type { TtydSession } from "@app/dev-dashboard/lib/ttyd/types";

describe("ttyd manager", () => {
    afterEach(async () => {
        await killAllTtyd();
    });

    test("spawn registers sessions with unique ports", async () => {
        const a = await spawnTtyd({ command: "/bin/sh", cwd: process.cwd() });
        const b = await spawnTtyd({ command: "/bin/sh", cwd: process.cwd() });

        expect(a.id).not.toBe(b.id);
        expect(a.port).not.toBe(b.port);
        expect(a.pid).toBeGreaterThan(0);
        expect(await listTtyd()).toHaveLength(2);
    });

    test("kill removes from registry and terminates process", async () => {
        const session = await spawnTtyd({ command: "/bin/sh", cwd: process.cwd() });
        const ok = await killTtyd(session.id);

        expect(ok).toBe(true);
        expect(await listTtyd()).toHaveLength(0);
    });

    test("killTtyd on unknown id returns false", async () => {
        const ok = await killTtyd("nope");

        expect(ok).toBe(false);
    });
});

const labelBase: TtydSession = {
    id: "a",
    port: 50245,
    command: "/bin/zsh",
    cwd: "/x",
    pid: 1,
    startedAt: "now",
};

describe("ttydLabel", () => {
    test("falls back to '<cmd-basename> :<port>' when no name", () => {
        expect(ttydLabel(labelBase)).toBe("zsh :50245");
    });

    test("uses the custom name when set", () => {
        expect(ttydLabel({ ...labelBase, name: "deploy-watch" })).toBe("deploy-watch");
    });

    test("blank name falls back", () => {
        expect(ttydLabel({ ...labelBase, name: "  " })).toBe("zsh :50245");
    });
});
