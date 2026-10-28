import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resetAiProxyConfigStore } from "@app/ai-proxy/lib/config-store";
import { getAiProxyStorage, resetAiProxyStorage } from "@app/ai-proxy/lib/storage";
import { registerModelsCommand } from "@app/codex/commands/models";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { captureOutput } from "@genesiscz/utils/test/capture-out";
import { Command } from "commander";

const originalHome = env.get("GENESIS_TOOLS_HOME");
let home: string;

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gt-codex-models-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    resetAiProxyConfigStore();
    resetAiProxyStorage();
});

afterEach(() => {
    resetAiProxyConfigStore();
    resetAiProxyStorage();
    rmSync(home, { recursive: true, force: true });

    if (originalHome === undefined) {
        env.testing.unset("GENESIS_TOOLS_HOME");
    } else {
        env.testing.set("GENESIS_TOOLS_HOME", originalHome);
    }
});

/** `tools codex models --json --model <slug>`: one model's merged record. */
async function modelRecord(slug: string): Promise<{ window: number; sources: Record<string, string> }> {
    const program = new Command();
    program.exitOverride();
    registerModelsCommand(program);
    const { stdout } = await captureOutput(async () => {
        await program.parseAsync(["node", "codex", "models", "--json", "--model", slug]);
    });

    return SafeJSON.parse(stdout, { strict: true });
}

describe("tools codex models", () => {
    it("still applies a window override written under the old codexModels key", async () => {
        const path = getAiProxyStorage().getConfigPath();
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, SafeJSON.stringify({ codexModels: { "gpt-6.1-sol": { window: 123_456 } } }));

        const record = await modelRecord("gpt-6.1-sol");

        expect([record.window, record.sources.window]).toEqual([123_456, "override"]);
    });
});
