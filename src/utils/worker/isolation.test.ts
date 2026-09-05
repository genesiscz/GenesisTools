import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    DEFAULT_SURFACES,
    ensureGrokWorkerConfig,
    grokSurfaceEnv,
    grokWorkerConfigToml,
    surfacesFromFlags,
} from "./isolation";

describe("surfacesFromFlags", () => {
    test("defaults on; an explicit false wins; an absent flag keeps the previous choice", () => {
        expect(surfacesFromFlags({})).toEqual({ skills: true, rules: true });
        expect(surfacesFromFlags({ skills: false })).toEqual({ skills: false, rules: true });
        expect(surfacesFromFlags({}, { skills: false, rules: true })).toEqual({ skills: false, rules: true });
        expect(surfacesFromFlags({ skills: true }, { skills: false, rules: false })).toEqual({
            skills: true,
            rules: false,
        });
    });
});

describe("grokSurfaceEnv", () => {
    test("maps the two surfaces onto the three compat toggles", () => {
        expect(grokSurfaceEnv(DEFAULT_SURFACES)).toEqual({
            GROK_CLAUDE_SKILLS_ENABLED: "1",
            GROK_CLAUDE_RULES_ENABLED: "1",
            GROK_CLAUDE_AGENTS_ENABLED: "1",
        });
        expect(grokSurfaceEnv({ skills: false, rules: false })).toEqual({
            GROK_CLAUDE_SKILLS_ENABLED: "0",
            GROK_CLAUDE_RULES_ENABLED: "0",
            GROK_CLAUDE_AGENTS_ENABLED: "0",
        });
    });
});

describe("grokWorkerConfigToml", () => {
    const grokOwn = "[marketplace]\ndefault_skills_installs_purged = true\n";

    test("--no-skills appends the marked ignore block after grok's own config", () => {
        const next = grokWorkerConfigToml(grokOwn, { skills: false, rules: true });
        expect(next.startsWith(grokOwn)).toBe(true);
        expect(next).toContain('[skills]\nignore = ["~/.agents", "~/.claude"]');
        expect(next).toContain("worker skills isolation (begin)");
    });

    test("turning skills back on removes exactly the marked block and is idempotent", () => {
        const off = grokWorkerConfigToml(grokOwn, { skills: false, rules: true });
        const on = grokWorkerConfigToml(off, { skills: true, rules: true });
        expect(on).toBe(grokOwn);
        expect(grokWorkerConfigToml(off, { skills: false, rules: true })).toBe(off);
        expect(grokWorkerConfigToml("", { skills: true, rules: true })).toBe("");
    });
});

describe("ensureGrokWorkerConfig", () => {
    test("writes the block into the worker home and leaves the file alone when nothing changes", () => {
        const home = mkdtempSync(join(tmpdir(), "grok-home-"));
        const path = join(home, "config.toml");
        writeFileSync(path, "[marketplace]\ndefault_skills_installs_purged = true\n");

        ensureGrokWorkerConfig(home, { skills: false, rules: true });
        expect(readFileSync(path, "utf8")).toContain('ignore = ["~/.agents", "~/.claude"]');

        ensureGrokWorkerConfig(home, { skills: true, rules: true });
        expect(readFileSync(path, "utf8")).toBe("[marketplace]\ndefault_skills_installs_purged = true\n");

        // A home that does not exist yet is created only when there is something to write.
        const fresh = join(home, "nested");
        ensureGrokWorkerConfig(fresh, { skills: true, rules: true });
        expect(() => readFileSync(join(fresh, "config.toml"), "utf8")).toThrow();
        ensureGrokWorkerConfig(fresh, { skills: false, rules: false });
        expect(readFileSync(join(fresh, "config.toml"), "utf8")).toContain("[skills]");
    });
});
