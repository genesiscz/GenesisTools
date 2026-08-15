import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
    argvTargetsTmux,
    claudeTopicForPane,
    killAllTtyd,
    killTtyd,
    listTtyd,
    retargetTtydTmuxBindings,
    spawnTtyd,
    ttydLabel,
} from "@app/dev-dashboard/lib/ttyd/manager";
import type { TtydSession } from "@app/dev-dashboard/lib/ttyd/types";
import { renameTmuxSession, sessionExists } from "@genesiscz/utils/tmux/sessions";

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
            const { killTmuxSession } = await import("@genesiscz/utils/tmux/sessions");
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

    test("retarget relaunches ttyd so argv tracks the renamed tmux session", async () => {
        const session = await spawnTtyd({ command: "/bin/sh", cwd: process.cwd() });
        const fromName = session.tmuxSessionName;
        expect(fromName).toBeTruthy();

        const toName = `retarget-test-${session.id.slice(0, 8)}`;
        await renameTmuxSession(fromName!, toName);

        await retargetTtydTmuxBindings(fromName!, toName);

        const listed = (await listTtyd()).find((s) => s.id === session.id);
        expect(listed?.tmuxSessionName).toBe(toName);
        expect(listed?.port).toBe(session.port);
        expect(listed?.id).toBe(session.id);
        expect(await sessionExists(toName)).toBe(true);
        expect(await sessionExists(fromName!)).toBe(false);

        // Live process must attach to the NEW name (this is the bug: config-only retarget).
        const ps = Bun.spawnSync(["/bin/ps", "-p", String(listed!.pid), "-o", "command="], {
            stdio: ["ignore", "pipe", "ignore"],
        });
        expect(ps.exitCode).toBe(0);
        const cmd = ps.stdout.toString();
        expect(cmd).toContain(`-t ${toName}`);
        expect(cmd).not.toContain(`-t ${fromName}`);
    });

    test("renameTtyd renames the bound tmux session and mirrors the display name", async () => {
        const { renameTtyd } = await import("./manager");
        const session = await spawnTtyd({ command: "/bin/sh", cwd: process.cwd() });
        const fromName = session.tmuxSessionName;
        expect(fromName).toBeTruthy();

        const toName = `tab-rename-${session.id.slice(0, 8)}`;
        const ok = await renameTtyd(session.id, toName);
        expect(ok).toBe(true);

        const listed = (await listTtyd()).find((s) => s.id === session.id);
        expect(listed?.name).toBe(toName);
        expect(listed?.tmuxSessionName).toBe(toName);
        expect(await sessionExists(toName)).toBe(true);
        expect(await sessionExists(fromName!)).toBe(false);
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

        const pgrepTtyd = (): string[] =>
            new TextDecoder()
                .decode(Bun.spawnSync(["pgrep", "-f", "ttyd.*--port"]).stdout)
                .trim()
                .split("\n")
                .filter(Boolean);

        // Diff against a pre-spawn snapshot instead of asserting on the global process
        // list — the dashboard's own ttyd terminals may legitimately be running
        // alongside this test.
        const before = new Set(pgrepTtyd());

        __setPersistRegistryForTest(async () => {
            throw new Error("disk full");
        });

        await expect(spawnTtyd({ cwd: "/tmp", command: "/bin/sh" })).rejects.toThrow("disk full");

        await new Promise((r) => setTimeout(r, 100));

        const survivors = pgrepTtyd().filter((pid) => !before.has(pid));
        expect(survivors).toEqual([]);
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
    test("falls back to tmux session name when bound", () => {
        expect(ttydLabel({ ...labelBase, tmuxSessionName: "dev-dashboard-abc12345" })).toBe("dev-dashboard-abc12345");
    });

    test("falls back to '<cmd-basename> :<port>' when unbound", () => {
        expect(ttydLabel(labelBase)).toBe("zsh :50245");
    });

    test("uses the custom name when set", () => {
        expect(ttydLabel({ ...labelBase, name: "deploy-watch", tmuxSessionName: "dev-dashboard-x" })).toBe(
            "deploy-watch"
        );
    });

    test("blank name falls back to tmux when bound", () => {
        expect(ttydLabel({ ...labelBase, name: "  ", tmuxSessionName: "bridge" })).toBe("bridge");
    });
});

// The heal sweep decides "is this live ttyd still attached to the session config
// says it is?" purely from this predicate, so its edge cases are pinned here — no
// ttyd/tmux binaries needed, unlike the lifecycle cases above.
describe("argvTargetsTmux", () => {
    const argv = (session: string) =>
        `/opt/homebrew/bin/ttyd -i 127.0.0.1 -b /ttyd/6f1c2f0e-1111-2222-3333-444455556666 -W -p 50245 /opt/homebrew/bin/tmux attach-session -t ${session}\n`;

    test("matches the session the process actually attached to", () => {
        expect(argvTargetsTmux(argv("bridge"), "bridge")).toBe(true);
    });

    test("a different session does not match", () => {
        expect(argvTargetsTmux(argv("bridge"), "dev-dashboard-abc12345")).toBe(false);
    });

    test("a session whose name merely PREFIXES the live one is not a match", () => {
        // The false positive that matters: reading `-t bridge-2` as "targets bridge"
        // makes the heal sweep leave a ttyd attached to the wrong session forever.
        expect(argvTargetsTmux(argv("bridge-2"), "bridge")).toBe(false);
        expect(argvTargetsTmux(argv("dev-dashboard-abc12345"), "dev-dashboard-abc1")).toBe(false);
    });

    test("the longer live name still matches itself", () => {
        expect(argvTargetsTmux(argv("bridge-2"), "bridge-2")).toBe(true);
    });

    test("a name appearing outside the attach target does not count", () => {
        expect(argvTargetsTmux("/opt/homebrew/bin/ttyd -b /ttyd/bridge -W -p 50245\n", "bridge")).toBe(false);
    });

    test("an empty session name never matches", () => {
        expect(argvTargetsTmux(argv("bridge"), "")).toBe(false);
    });
});

// Pure title derivation — no ttyd/tmux binaries needed, so it runs everywhere.
describe("claudeTopicForPane", () => {
    test("exposes the Claude topic with its punctuation intact", () => {
        expect(claudeTopicForPane({ command: "claude", title: "✳ Fix v1.2 bug" })).toBe("Fix v1.2 bug");
        expect(claudeTopicForPane({ command: "/opt/homebrew/bin/claude", title: "⠐ Debug: spacing" })).toBe(
            "Debug: spacing"
        );
    });

    test("omits non-Claude panes, stock titles and missing panes", () => {
        expect(claudeTopicForPane({ command: "zsh", title: "✳ testt" })).toBeNull();
        expect(claudeTopicForPane({ command: "claude", title: "✳ Claude Code" })).toBeNull();
        expect(claudeTopicForPane({ command: "claude", title: "" })).toBeNull();
        expect(claudeTopicForPane(undefined)).toBeNull();
    });
});
