import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { resolveCommandForLaunchd } from "./launchd";
import { canKillPortOwner } from "./portConflict";

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
