import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { killAllTtyd, killTtyd, listTtyd, spawnTtyd, ttydLabel } from "@app/dev-dashboard/lib/ttyd/manager";
import type { TtydSession } from "@app/dev-dashboard/lib/ttyd/types";

// The spawn/kill/list cases launch real ttyd + tmux processes. Skip them when
// the binaries are absent (CI, Linux, non-Homebrew) so the suite stays green
// instead of hard-failing on a missing-binary throw.
const hasTtydDeps = existsSync("/opt/homebrew/bin/ttyd") && existsSync("/opt/homebrew/bin/tmux");

describe.skipIf(!hasTtydDeps)("ttyd manager", () => {
    afterEach(async () => {
        const sessions = await listTtyd();
        for (const session of sessions) {
            await killTtyd(session.id, { killTmux: true });
        }
        await killAllTtyd();
    });

    test("spawn registers sessions with unique ports", async () => {
        const a = await spawnTtyd({ command: "/bin/sh", cwd: process.cwd() });
        const b = await spawnTtyd({ command: "/bin/sh", cwd: process.cwd() });

        expect(a.id).not.toBe(b.id);
        expect(a.port).not.toBe(b.port);
        expect(a.pid).toBeGreaterThan(0);

        // Assert on the sessions this test created rather than the global list
        // length — the registry is process-global and hydrates persisted
        // sessions from config, so a stale entry would otherwise fail this.
        const ids = new Set((await listTtyd()).map((s) => s.id));
        expect(ids.has(a.id)).toBe(true);
        expect(ids.has(b.id)).toBe(true);
    });

    test("kill removes from registry and terminates process", async () => {
        const session = await spawnTtyd({ command: "/bin/sh", cwd: process.cwd() });
        const ok = await killTtyd(session.id, { killTmux: true });

        expect(ok).toBe(true);
        expect(await listTtyd()).toHaveLength(0);
    });

    test("kill without killTmux leaves tmux session registered until manual cleanup", async () => {
        const session = await spawnTtyd({ command: "/bin/sh", cwd: process.cwd() });
        const ok = await killTtyd(session.id, { killTmux: false });

        expect(ok).toBe(true);
        expect(await listTtyd()).toHaveLength(0);

        if (session.tmuxSessionName) {
            const { killTmuxSession } = await import("@app/utils/tmux/sessions");
            killTmuxSession(session.tmuxSessionName);
        }
    });

    test("killTtyd on unknown id returns false", async () => {
        const ok = await killTtyd("nope");

        expect(ok).toBe(false);
    });

    test("spawn attaches to existing tmux session when attachTmuxSession set", async () => {
        const base = await spawnTtyd({ command: "/bin/sh", cwd: process.cwd() });
        const tmuxName = base.tmuxSessionName;
        expect(tmuxName).toBeTruthy();

        await killTtyd(base.id, { killTmux: false });

        const attached = await spawnTtyd({ attachTmuxSession: tmuxName, cwd: process.cwd() });
        expect(attached.tmuxSessionName).toBe(tmuxName);

        await expect(spawnTtyd({ attachTmuxSession: tmuxName })).rejects.toThrow("already open in ttyd");

        await killTtyd(attached.id, { killTmux: true });
    });
});

describe.skipIf(!hasTtydDeps)("spawnTtyd persist-failure cleanup", () => {
    afterEach(async () => {
        const { __setPersistRegistryForTest } = await import("./manager");
        __setPersistRegistryForTest(null);

        const sessions = await listTtyd();
        for (const session of sessions) {
            await killTtyd(session.id, { killTmux: true });
        }
        await killAllTtyd();
    });

    test("kills the spawned child if registry persistence fails", async () => {
        const { spawnTtyd, __setPersistRegistryForTest } = await import("./manager");

        __setPersistRegistryForTest(async () => {
            throw new Error("disk full");
        });

        await expect(spawnTtyd({ cwd: "/tmp", command: "/bin/sh" })).rejects.toThrow("disk full");

        await new Promise((r) => setTimeout(r, 100));

        const ps = Bun.spawnSync(["pgrep", "-f", "ttyd.*--port"]);
        const survivors = new TextDecoder().decode(ps.stdout).trim();
        expect(survivors).toBe("");
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
