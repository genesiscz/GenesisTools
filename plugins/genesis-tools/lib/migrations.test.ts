import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The migrations, end to end, against a sandboxed home.
 *
 * They run once per install from inside the plugin scripts, so the thing worth testing is not a
 * function but the whole invocation: a fresh install must not be disturbed, an install with the
 * old files must end up with the new ones, a second run must do nothing, and a broken legacy file
 * must leave BOTH sides untouched rather than half-migrating.
 *
 * `GENESIS_TOOLS_HOME` is the sandbox root the rest of this repo already uses, so none of this
 * touches the real home.
 */

const RESEARCH = join(import.meta.dir, "../skills/research/scripts/resolve.ts");
const WRAPUP = join(import.meta.dir, "../skills/wrap-up/scripts/resolve.ts");

const homes: string[] = [];

function sandbox(): string {
    const home = mkdtempSync(join(tmpdir(), "gt-migrate-"));

    homes.push(home);

    return home;
}

afterEach(() => {
    for (const home of homes.splice(0)) {
        rmSync(home, { recursive: true, force: true });
    }
});

function write(path: string, body: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body, null, 2));
}

function read(path: string): Record<string, unknown> {
    return JSON.parse(readFileSync(path, "utf8"));
}

async function run(
    script: string,
    home: string,
    args: string[] = []
): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["bun", script, ...args], {
        env: { ...process.env, GENESIS_TOOLS_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);

    return { code: await proc.exited, stdout, stderr };
}

const paths = (home: string) => ({
    config: join(home, ".genesis-tools/plugins/config.json"),
    registry: join(home, ".genesis-tools/plugins/vault-registry.json"),
    legacyResearch: join(home, ".genesis-tools/skills/research/config.json"),
    legacyRegistry: join(home, ".claude/handoff-registry.json"),
    legacyObsidian: join(home, ".genesis-tools/obsidian/config.json"),
});

function archived(path: string): string[] {
    const dir = dirname(path);

    return existsSync(dir) ? readdirSync(dir).filter((name) => name.includes(".migrated-")) : [];
}

describe("research config migration", () => {
    it("moves the standalone file into the research key and archives the original", async () => {
        const home = sandbox();
        const p = paths(home);

        write(p.legacyResearch, {
            version: 1,
            defaultPath: "/vault/Research",
            pathKind: "absolute",
            updatedAt: "2026-01-01 00:00",
        });

        const { code } = await run(RESEARCH, home, ["config"]);

        expect(code).toBe(0);
        expect(read(p.config).research).toEqual({ defaultPath: "/vault/Research", pathKind: "absolute" });
        // `version` and `updatedAt` belonged to the standalone file's schema and are dropped.
        expect(existsSync(p.legacyResearch)).toBe(false);
        expect(archived(p.legacyResearch)).toHaveLength(1);
    });

    it("is a no-op on a second run", async () => {
        const home = sandbox();
        const p = paths(home);

        write(p.legacyResearch, { defaultPath: "/vault/Research" });
        await run(RESEARCH, home, ["config"]);
        const after = readFileSync(p.config, "utf8");
        const second = await run(RESEARCH, home, ["config"]);

        expect(second.stderr).not.toContain("migrated");
        expect(readFileSync(p.config, "utf8")).toBe(after);
        expect(archived(p.legacyResearch)).toHaveLength(1);
    });

    it("never overwrites a research key that already exists", async () => {
        const home = sandbox();
        const p = paths(home);

        write(p.config, { research: { defaultPath: "/already/here" } });
        write(p.legacyResearch, { defaultPath: "/vault/Research" });
        await run(RESEARCH, home, ["config"]);

        expect((read(p.config).research as Record<string, unknown>).defaultPath).toBe("/already/here");
        // The source is left in place rather than archived: nothing was taken from it.
        expect(existsSync(p.legacyResearch)).toBe(true);
    });

    it("leaves both sides untouched when the legacy file is corrupt", async () => {
        const home = sandbox();
        const p = paths(home);

        write(p.legacyResearch, "{ not json");
        const { code } = await run(RESEARCH, home, ["config"]);

        expect(code).toBe(0);
        expect(existsSync(p.legacyResearch)).toBe(true);
        // Nothing is written at all, not even an empty config: a half-migrated state is worse
        // than an unmigrated one, so the whole attempt is abandoned.
        expect(existsSync(p.config)).toBe(false);
    });

    it("does nothing on a fresh install with no legacy file", async () => {
        const home = sandbox();
        const p = paths(home);

        await run(RESEARCH, home, ["config"]);

        expect(archived(p.legacyResearch)).toHaveLength(0);
        expect(existsSync(p.legacyRegistry)).toBe(false);
    });
});

describe("vault registry migration", () => {
    const entries = [
        { projectDir: "/repos/a", branch: "main", obsidianDir: "/vault/A" },
        { projectDir: "/repos/b", obsidianDir: "/vault/B" },
    ];

    it("moves the handoff registry and keeps every entry", async () => {
        const home = sandbox();
        const p = paths(home);

        write(p.legacyRegistry, { entries });
        const { code, stdout } = await run(WRAPUP, home, ["doctor"]);

        expect(code).toBe(0);
        expect(JSON.parse(stdout).entries).toBe(2);
        expect(read(p.registry).entries).toEqual(entries);
        expect(existsSync(p.legacyRegistry)).toBe(false);
        expect(archived(p.legacyRegistry)).toHaveLength(1);
    });

    it("is reached by the research skill too, from the same legacy file", async () => {
        const home = sandbox();
        const p = paths(home);

        write(p.legacyRegistry, { entries });
        await run(RESEARCH, home, ["config"]);

        expect(read(p.registry).entries).toEqual(entries);
    });

    it("is a no-op on a second run", async () => {
        const home = sandbox();
        const p = paths(home);

        write(p.legacyRegistry, { entries });
        await run(WRAPUP, home, ["doctor"]);
        const after = readFileSync(p.registry, "utf8");
        const second = await run(WRAPUP, home, ["doctor"]);

        expect(second.stderr).not.toContain("migrated");
        expect(readFileSync(p.registry, "utf8")).toBe(after);
    });

    it("never overwrites an existing registry", async () => {
        const home = sandbox();
        const p = paths(home);

        write(p.registry, { entries: [{ projectDir: "/repos/keep", obsidianDir: "/vault/Keep" }] });
        write(p.legacyRegistry, { entries });
        await run(WRAPUP, home, ["doctor"]);

        expect((read(p.registry).entries as unknown[]).length).toBe(1);
        expect(existsSync(p.legacyRegistry)).toBe(true);
    });

    it("respects an explicit registryPath and migrates nothing", async () => {
        const home = sandbox();
        const p = paths(home);
        const custom = join(home, "custom-registry.json");

        write(custom, { entries: [{ projectDir: "/repos/c", obsidianDir: "/vault/C" }] });
        write(p.config, { "wrap-up": { registryPath: custom } });
        write(p.legacyRegistry, { entries });

        const { stdout } = await run(WRAPUP, home, ["doctor"]);

        expect(JSON.parse(stdout).registry).toBe(custom);
        expect(JSON.parse(stdout).entries).toBe(1);
        expect(existsSync(p.legacyRegistry)).toBe(true);
        expect(existsSync(p.registry)).toBe(false);
    });

    it("leaves both sides untouched when the legacy registry is corrupt", async () => {
        const home = sandbox();
        const p = paths(home);

        write(p.legacyRegistry, "]]]not json[[[");
        const { code, stdout } = await run(WRAPUP, home, ["doctor"]);

        expect(code).toBe(0);
        expect(JSON.parse(stdout).entries).toBe(0);
        expect(existsSync(p.legacyRegistry)).toBe(true);
    });
});

describe("both migrations together", () => {
    it("moves each file exactly once and leaves the other plugin's key alone", async () => {
        const home = sandbox();
        const p = paths(home);

        write(p.legacyResearch, { defaultPath: "/vault/Research" });
        write(p.legacyRegistry, { entries: [{ projectDir: "/repos/a", obsidianDir: "/vault/A" }] });
        write(p.config, { "wrap-up": { vaultDir: "/vault" } });

        await run(RESEARCH, home, ["config"]);
        await run(WRAPUP, home, ["doctor"]);

        const config = read(p.config);

        expect(config["wrap-up"]).toEqual({ vaultDir: "/vault" });
        expect(config.research).toEqual({ defaultPath: "/vault/Research" });
        expect((read(p.registry).entries as unknown[]).length).toBe(1);
        expect(archived(p.legacyResearch)).toHaveLength(1);
        expect(archived(p.legacyRegistry)).toHaveLength(1);
    });
});
