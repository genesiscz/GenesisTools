import { describe, expect, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import { getPortOwner } from "@genesiscz/utils/network";
import { resolveCommandForLaunchd } from "./launchd";
import { canKillPortOwner } from "./portConflict";
import { stopUiServerOnPort } from "./stopUiServerOnPort";

/** A bun child of ours listening on 127.0.0.1, with `args` in its argv (what a ps command line shows). */
async function startListener(args: string[]): Promise<{ child: Bun.Subprocess; port: number }> {
    const code = `const s = require("node:net").createServer().listen(0, "127.0.0.1", () => console.log(s.address().port));`;
    const child = Bun.spawn([process.execPath, "-e", code, ...args], {
        env: process.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
    });
    const { value } = await child.stdout.getReader().read();
    return { child, port: Number(new TextDecoder().decode(value).trim()) };
}

describe.skipIf(process.platform !== "darwin")("port owners on live listeners", () => {
    test("getPortOwner names our listener's pid and our user; a free port has none", async () => {
        const { child, port } = await startListener([`gt-owner-probe-${crypto.randomUUID()}`]);
        const spawn = spyOn(Bun, "spawn");

        try {
            const owner = await getPortOwner(port);
            const spawned = spawn.mock.calls.length;
            spawn.mockRestore();

            expect(owner?.pid).toBe(child.pid);
            expect(owner?.sameUser).toBe(true);
            // From libproc: neither lsof nor ps was started.
            expect(spawned).toBe(0);
        } finally {
            spawn.mockRestore();
            child.kill();
            await child.exited;
        }

        expect(await getPortOwner(port)).toBeNull();
    });

    test("getPortOwner gives the whole command line, which the ai-proxy ownership check matches against", async () => {
        // `ps -o command=,uid=` cut the command at 16 characters ("/Users/someone/.b"), so no owner ever matched.
        const marker = `gt-owner-probe-${crypto.randomUUID()}`;
        const { child, port } = await startListener([marker]);

        try {
            const command = Bun.spawnSync(["ps", "-p", String(child.pid), "-o", "command="], { env: process.env })
                .stdout.toString()
                .trim();

            expect((await getPortOwner(port))?.command).toBe(command);
            expect(command).toContain(marker);
        } finally {
            child.kill();
            await child.exited;
        }
    });

    test("stopUiServerOnPort stops this tool's ui-server and leaves any other listener alone", async () => {
        const marker = `gt-stop-probe-${crypto.randomUUID()}`;
        const uiServer = await startListener(["__ui-server", marker]);
        const stranger = await startListener([marker]);

        try {
            const spawnSync = spyOn(Bun, "spawnSync");
            let commands: string[] = [];

            try {
                stopUiServerOnPort(uiServer.port, { commandMatch: marker });
                stopUiServerOnPort(stranger.port, { commandMatch: marker });
                commands = spawnSync.mock.calls.map((call) => (Array.isArray(call[0]) ? String(call[0][0]) : "?"));
            } finally {
                spawnSync.mockRestore();
            }

            await uiServer.child.exited;

            // The listeners and their command lines came from libproc; only pgrep (children) still spawns.
            expect(commands.filter((command) => command === "lsof" || command === "ps")).toEqual([]);

            expect(uiServer.child.signalCode).toBe("SIGTERM");
            expect(stranger.child.exitCode).toBeNull();
            expect(stranger.child.signalCode).toBeNull();
        } finally {
            uiServer.child.kill();
            stranger.child.kill();
            await Promise.all([uiServer.child.exited, stranger.child.exited]);
        }
    });
});

describe("resolveCommandForLaunchd", () => {
    test("resolves bare bun and relative script paths", () => {
        const projectRoot = resolve(import.meta.dirname, "../../..");
        const bunPath = Bun.which("bun") ?? process.execPath;
        const { command, env } = resolveCommandForLaunchd(
            ["bun", "run", "src/youtube/lib/server/index.ts"],
            projectRoot
        );

        expect(command[0]).toBe(bunPath);
        expect(command[2]).toBe(resolve(projectRoot, "src/youtube/lib/server/index.ts"));
        expect(env.PATH).toContain("/usr/bin");
        expect(env.HOME).toBeTruthy();
    });
});

describe("canKillPortOwner", () => {
    const owner = { pid: 42, command: "bun", sameUser: true };

    test("rejects foreign-user owners when sameUserOnly", async () => {
        const ok = await canKillPortOwner(3000, { ...owner, sameUser: false }, { sameUserOnly: true });
        expect(ok).toBe(false);
    });

    test("rejects when pid changed since shutdown started", async () => {
        const ok = await canKillPortOwner(3000, owner, { expectOwnerPid: 99 });
        expect(ok).toBe(false);
    });

    test("allows same-user owner with matching expectOwnerPid", async () => {
        const ok = await canKillPortOwner(3000, owner, { expectOwnerPid: 42 });
        expect(ok).toBe(true);
    });
});
