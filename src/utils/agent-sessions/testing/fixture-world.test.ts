import { describe, expect, test } from "bun:test";
import { existsSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { createFixtureWorld, FIXED_HISTORY_NOW } from "./fixture-world";

describe("history fixture world", () => {
    test("owns every mutable path and rejects host-home fallback", async () => {
        const world = await createFixtureWorld();
        try {
            expect(world.now.toISOString()).toBe(FIXED_HISTORY_NOW);
            expect(existsSync(world.root)).toBe(true);
            for (const path of [
                world.home,
                world.sources.claude,
                world.sources.codex,
                world.sources.grok,
                world.databases.legacy,
                world.databases.candidate,
                world.git.root,
            ]) {
                expect(relative(world.root, path).startsWith("..")).toBe(false);
            }
            expect(world.databases.legacy).not.toBe(world.databases.candidate);
            expect(() => world.assertOwnedPath(homedir())).toThrow("outside fixture world");
            const escapedLink = `${world.root}/escaped-link`;
            symlinkSync(homedir(), escapedLink);
            expect(() => world.assertOwnedPath(escapedLink)).toThrow("outside fixture world");
            expect(world.environment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
            expect(world.environment.HOME).toBe(world.home);
            expect(world.databases.legacy).toBe(
                join(world.environment.GENESIS_TOOLS_HOME!, ".genesis-tools", "claude-history", "index.db")
            );
            expect(world.environment.ANTHROPIC_API_KEY).toBe("");
            expect(world.git.head).toMatch(/^[0-9a-f]{40}$/);
        } finally {
            await world.dispose();
        }
        expect(existsSync(world.root)).toBe(false);
    });
});
