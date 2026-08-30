import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJsonlFile } from "@app/claude/lib/history/search";
import { env } from "@genesiscz/utils/env";
import { setProfilingConfig } from "@genesiscz/utils/GenesisTools";
import { SafeJSON } from "@genesiscz/utils/json";
import { flushProfilerFile, profiler, reloadProfiler } from "@genesiscz/utils/profile";

function profilingLogBodies(): string {
    // Records are BUFFERED, so any reader has to drain first. This used to pass
    // only because the buffer happened to be flushed on a microtask, which the
    // awaits in these tests reliably reached; batching that flush on a timer
    // (PR #343 review t2 round 12) made the dependency visible rather than
    // introducing it. Draining here covers every reader in this file.
    flushProfilerFile();

    const dir = join(env.tools.getHome(), ".genesis-tools", "logs");

    if (!existsSync(dir)) {
        return "";
    }

    return readdirSync(dir)
        .filter((name) => name.endsWith("-profiling.log"))
        .map((name) => readFileSync(join(dir, name), "utf8"))
        .join("");
}

describe("claude history parseJsonl profiling", () => {
    const filePath = join(tmpdir(), `hist-prof-${process.pid}.jsonl`);

    beforeEach(async () => {
        env.testing.unset("PROFILE");
        env.testing.unset("PROFILE_TO_STDERR");
        writeFileSync(
            filePath,
            `${SafeJSON.stringify({ type: "user", message: { role: "user", content: "hi" } }, { strict: true })}\n`
        );
        const logs = join(env.tools.getHome(), ".genesis-tools", "logs");

        if (existsSync(logs)) {
            rmSync(logs, { recursive: true });
        }
    });

    afterEach(() => {
        if (existsSync(filePath)) {
            rmSync(filePath);
        }

        reloadProfiler();
    });

    it("emits parseJsonl when profiling detail is all", async () => {
        await setProfilingConfig({ enabled: true, detail: "all", scopes: ["claude-history"] });
        reloadProfiler();
        expect(profiler.detail).toBe("all");

        const messages = await parseJsonlFile(filePath);
        expect(messages).toHaveLength(1);
        expect(profilingLogBodies()).toContain("[profile:claude-history] parseJsonl");
    });

    it("does not emit parseJsonl when detail is phases", async () => {
        await setProfilingConfig({ enabled: true, detail: "phases", scopes: ["claude-history"] });
        reloadProfiler();

        await parseJsonlFile(filePath);
        expect(profilingLogBodies()).not.toContain("parseJsonl");
    });
});
