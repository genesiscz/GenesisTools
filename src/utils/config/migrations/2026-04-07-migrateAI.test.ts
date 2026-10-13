import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { migrateAI } from "./2026-04-07-migrateAI";

const CLAUDE = `${SafeJSON.stringify(
    {
        accounts: {
            work: {
                accessToken: "sk-ant-oat01-fixture",
                refreshToken: "sk-ant-ort01-fixture",
                expiresAt: 1785312000000,
                label: "work",
            },
        },
        defaultAccount: "work",
    },
    null,
    2
)}\n`;

async function inHome(fn: (configPath: (tool: string) => string) => Promise<void>): Promise<void> {
    const home = mkdtempSync(join(tmpdir(), "gt-migrate-ai-"));
    const configPath = (tool: string): string => join(home, ".genesis-tools", tool, "config.json");
    await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, () => fn(configPath));
}

function plant(path: string, text: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
}

describe("migrateAI", () => {
    test("an old config that does not parse aborts the run before anything is written or deleted", async () => {
        await inHome(async (configPath) => {
            const truncated = '{\n  "accounts": [\n    { "name": "personal", "provider": "openai", "tok';
            plant(configPath("claude"), CLAUDE);
            plant(configPath("ai-accounts"), truncated);

            await expect(migrateAI.run()).rejects.toThrow(configPath("ai-accounts"));

            expect(readFileSync(configPath("claude"), "utf8")).toBe(CLAUDE);
            expect(readFileSync(configPath("ai-accounts"), "utf8")).toBe(truncated);
            expect(existsSync(configPath("ai"))).toBe(false);
        });
    });

    test("readable old configs are imported, and only then are the Claude accounts removed", async () => {
        await inHome(async (configPath) => {
            plant(configPath("claude"), CLAUDE);

            await migrateAI.run();

            const unified = SafeJSON.parse(readFileSync(configPath("ai"), "utf8"));
            expect(unified._schemaVersion).toBe(3);
            expect(unified.accounts).toEqual([
                expect.objectContaining({ name: "work", provider: "anthropic-sub", label: "work" }),
            ]);
            expect(SafeJSON.parse(readFileSync(configPath("claude"), "utf8"))).toEqual({});
        });
    });
});
