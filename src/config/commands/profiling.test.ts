import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { env } from "@genesiscz/utils/env";
import { getGenesisToolsConfigPath, getProfilingConfig } from "@genesiscz/utils/GenesisTools";
import { isInside, realGenesisToolsRoot, rmTestPath } from "@genesiscz/utils/storage/real-home-guard";
import { Command } from "commander";
import { applyProfilingFlags, registerProfilingCommand, runProfilingCommand } from "./profiling";

describe("applyProfilingFlags", () => {
    /**
     * This suite deletes and rewrites the GenesisTools config file, so it is only
     * safe while GENESIS_TOOLS_HOME points at a sandbox. `preload-test-sandbox.ts`
     * guarantees that for every test process, but the guarantee is invisible from
     * here — and `rmSync` is a raw fs call that the real-home write guard cannot
     * see. So assert it, rather than trusting it (PR #343 review t12): if the
     * preload ever stops firing, this suite fails loudly instead of eating the
     * developer's live config.
     */
    it("runs against a sandbox home, never the real store", () => {
        expect(isInside(realGenesisToolsRoot(), getGenesisToolsConfigPath())).toBe(false);
    });

    beforeEach(() => {
        env.testing.unset("PROFILE");
        const path = getGenesisToolsConfigPath();

        rmTestPath(path);
    });

    afterEach(() => {
        const path = getGenesisToolsConfigPath();

        rmTestPath(path);
    });

    it("enables profiling in the GenesisTools config file", async () => {
        await applyProfilingFlags({ enable: true, scopes: "claude-history" });
        const cfg = getProfilingConfig();
        expect(cfg.enabled).toBe(true);
        expect(cfg.scopes).toEqual(["claude-history"]);
    });

    it("show with no flags does not create a config file", async () => {
        await applyProfilingFlags({});
        expect(existsSync(getGenesisToolsConfigPath())).toBe(false);
        expect(getProfilingConfig().enabled).toBe(false);
    });

    it("treats stderr false as an explicit disable", async () => {
        await applyProfilingFlags({ enable: true, stderr: true });
        await applyProfilingFlags({ stderr: false });
        expect(getProfilingConfig().stderr).toBe(false);
        expect(getProfilingConfig().enabled).toBe(true);
    });
});

describe("runProfilingCommand enumerated flags", () => {
    beforeEach(() => {
        const path = getGenesisToolsConfigPath();

        rmTestPath(path);
    });

    afterEach(() => {
        const path = getGenesisToolsConfigPath();

        rmTestPath(path);
    });

    it("the 'all' token clears the filter and is not treated as a scope name", async () => {
        // PR #343 review t26: my t30 validation rejected the token scopesToFlag
        // emits for the interactive all-scopes selection.
        for (const token of ["all", "ALL"]) {
            const result = await runProfilingCommand({ enable: true, scopes: token }, { interactive: false });

            // Status alone would still pass if the token were stored verbatim as
            // a scope NAME, which matches nothing and silently profiles nothing
            // (PR #343 review t23). Assert what landed in the config.
            expect(result.status).toBe("ok");
            expect(result.status === "ok" && result.stored.scopes).toEqual([]);
        }
    });

    it("an unknown --scopes value is rejected instead of silently stored", async () => {
        // PR #343 review t30: a typo was persisted, matched no profiler scope,
        // and profiling just stayed silent.
        const result = await runProfilingCommand({ enable: true, scopes: "claude-histry" }, { interactive: false });
        expect(result.status).toBe("missing-enum");

        if (result.status !== "missing-enum") {
            throw new Error("expected missing-enum");
        }

        expect(result.flag).toBe("--scopes");
        expect(result.help).toContain("claude-histry");
    });

    it("an invalid --detail value is named in the help, not called missing", async () => {
        // PR #343 review t32: the fixed "requires a value" wording contradicted
        // the value the user actually typed.
        const result = await runProfilingCommand({ detail: "fast" }, { interactive: false });
        expect(result.status).toBe("missing-enum");

        if (result.status !== "missing-enum") {
            throw new Error("expected missing-enum");
        }

        expect(result.help).toContain('does not accept "fast"');
        expect(result.help).not.toContain("--detail requires a value");
    });

    it("empty --scopes in non-TTY lists known scopes and a filled --scopes suggestion", async () => {
        const result = await runProfilingCommand({ scopes: true }, { interactive: false });
        expect(result.status).toBe("missing-enum");

        if (result.status !== "missing-enum") {
            throw new Error("expected missing-enum");
        }

        expect(result.help).toContain("Possible: claude-history");
        expect(result.help).toContain("du");
        expect(result.help).toContain("--scopes claude-history");
        expect(existsSync(getGenesisToolsConfigPath())).toBe(false);
    });

    it("empty --detail in non-TTY lists phases and all", async () => {
        const result = await runProfilingCommand({ detail: true }, { interactive: false });
        expect(result.status).toBe("missing-enum");

        if (result.status !== "missing-enum") {
            throw new Error("expected missing-enum");
        }

        expect(result.help).toContain("Possible: phases, all");
        expect(result.help).toContain("--detail phases");
    });

    it("invalid --detail in non-TTY lists phases and all", async () => {
        const result = await runProfilingCommand({ detail: "fast" }, { interactive: false });
        expect(result.status).toBe("missing-enum");

        if (result.status !== "missing-enum") {
            throw new Error("expected missing-enum");
        }

        expect(result.help).toContain("Possible: phases, all");
    });

    it("TTY empty --scopes writes the prompted scope list", async () => {
        const result = await runProfilingCommand(
            { scopes: true },
            { interactive: true, promptScopes: async () => ["claude-history"] }
        );
        expect(result.status).toBe("ok");
        expect(getProfilingConfig().scopes).toEqual(["claude-history"]);
    });

    it("TTY with no flags applies the prompted patch", async () => {
        const result = await runProfilingCommand(
            {},
            { interactive: true, promptEdit: async () => ({ enabled: true, detail: "all" }) }
        );
        expect(result.status).toBe("ok");
        expect(getProfilingConfig().enabled).toBe(true);
        expect(getProfilingConfig().detail).toBe("all");
    });

    it("TTY with no flags skips write when the editor is cancelled", async () => {
        const result = await runProfilingCommand({}, { interactive: true, promptEdit: async () => null });
        expect(result.status).toBe("ok");
        expect(existsSync(getGenesisToolsConfigPath())).toBe(false);
    });
});

describe("registerProfilingCommand option shape", () => {
    it("declares --scopes and --detail as optional values so a bare flag reaches the action", () => {
        const program = new Command();
        registerProfilingCommand(program);
        const profiling = program.commands.find((c) => c.name() === "profiling");
        const flags = profiling?.options.map((o) => o.flags) ?? [];
        expect(flags.some((f) => f.includes("--scopes") && f.includes("[list]"))).toBe(true);
        expect(flags.some((f) => f.includes("--detail") && f.includes("[mode]"))).toBe(true);
    });
});
