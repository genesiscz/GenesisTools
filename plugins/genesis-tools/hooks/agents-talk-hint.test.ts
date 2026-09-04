import { afterAll, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

const isolatedPluginDir = mkdtempSync(join(tmpdir(), "agents-talk-hint-"));
const isolatedHook = join(isolatedPluginDir, "agents-talk-hint.ts");

copyFileSync(join(import.meta.dir, "agents-talk-hint.ts"), isolatedHook);

afterAll(() => {
    rmSync(isolatedPluginDir, { recursive: true, force: true });
});

// Regression test: SessionStart report 2026-09-02 — installed hooks cannot resolve monorepo dependencies.
test("emits the agents-talk reminder from a dependency-free plugin directory", () => {
    const proc = Bun.spawnSync([process.execPath, isolatedHook], {
        stdin: Buffer.from("{}"),
        stdout: "pipe",
        stderr: "pipe",
    });

    expect(proc.exitCode).toBe(0);
    expect(SafeJSON.parse(proc.stdout.toString(), { strict: true })).toEqual({
        hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext:
                "Before spawning subagents that need to communicate with each other or with you, invoke the `genesis-tools:agents-talk` skill (the cross-agent messaging protocol via `tools agents`). The Skill tool only accepts that full id — `gt:agents-talk` is not a valid skill name.",
        },
    });
    expect(proc.stderr.toString()).toBe("");
});
