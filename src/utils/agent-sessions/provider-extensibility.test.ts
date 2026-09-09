import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetBuiltInPluginsForTest } from "@genesiscz/utils/ai/providers/plugins";
import { _resetPluginsForTest, registerPlugin } from "@genesiscz/utils/ai/providers/registry";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { Command } from "commander";
import { registerAgentHistoryCommand } from "./history-cli";
import { createNativeHistoryAdapter } from "./native-adapter";
import { openHistoryService } from "./open-service";
import { createClaudeHistoryOperations } from "./readers/claude";
import { discoverClaudeHistorySources } from "./readers/claude-discovery";
import type { NativeSessionSource } from "./types";

afterEach(() => {
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest();
});

test("a registered fourth provider supports listing, content, detail and unavailable statistics in the shared service", async () => {
    const root = mkdtempSync(join(tmpdir(), "history-fourth-provider-"));
    const project = join(root, "-projects-fixture");
    mkdirSync(project);
    const nativeId = "11111111-2222-4333-8444-555555555555";
    writeFileSync(
        join(project, `${nativeId}.jsonl`),
        `${SafeJSON.stringify({ type: "user", sessionId: nativeId, cwd: "/projects/fixture", timestamp: "2026-09-01T00:00:00Z", message: { content: "Fourth provider content" } })}\n`
    );
    const operations = createClaudeHistoryOperations();
    const asClaude = (source: NativeSessionSource<string>): NativeSessionSource<"claude"> => ({
        ...source,
        kind: "claude",
        metadata: source.metadata ? { ...source.metadata, kind: "claude" } : undefined,
    });
    registerPlugin({
        id: "fixture-sub",
        kind: "subscription",
        capabilities: new Set(),
        credential: { fields: [], envKeys: [] },
        async bind() {
            throw new Error("Local history must not authenticate");
        },
        codingAgent: {
            kind: "fixture",
            parserVersion: "1",
            roots: () => [root],
            discover: async (roots, options) => {
                const discovered = await discoverClaudeHistorySources(roots, options);
                return { ...discovered, sources: discovered.sources.map((source) => ({ ...source, kind: "fixture" })) };
            },
            readMetadata: (source, options) => operations.readMetadata(asClaude(source), options),
            scan: (source, options) => operations.scan(asClaude(source), options),
            readRecords: (source, options) => operations.readRecords(asClaude(source), options),
            read: async () => {
                throw new Error("Shared history must use source operations");
            },
        },
    });
    const database = new Database(":memory:");
    try {
        const service = openHistoryService({ provider: "fixture-sub", database });
        const listed = await service.search({ summaryOnly: true });
        expect(listed.results.map((row) => [row.metadata.providerId, row.session.kind, row.session.sessionId])).toEqual(
            [["fixture-sub", "fixture", nativeId]]
        );
        expect((await service.search({ query: "Fourth provider" })).results).toHaveLength(1);
        expect((await service.detail(nativeId)).results[0]?.matchedRecords).toHaveLength(1);
        expect((await service.refreshStatistics()).coverage).toBe("unsupported");
        const adapter = createNativeHistoryAdapter({
            kind: "fixture",
            provider: "fixture-sub",
            roots: [root],
            database,
        });
        const stdout = spyOn(out, "print").mockImplementation(() => undefined);
        try {
            const program = new Command().exitOverride();
            registerAgentHistoryCommand(program, adapter, "fixture");
            await program.parseAsync(["history", "--all", "--json"], { from: "user" });
            const rendered = String(stdout.mock.calls.at(-1)?.[0]);
            const rows = SafeJSON.parse(rendered, { strict: true }) as Array<{ kind: string; sessionId: string }>;
            expect(rows.map((row) => [row.kind, row.sessionId])).toEqual([["fixture", nativeId]]);
            expect((await adapter.status?.())?.sessions).toBe(1);
        } finally {
            stdout.mockRestore();
        }
        expect(
            database.query("SELECT count(*) AS n FROM session_metadata WHERE provider='anthropic-sub'").get()
        ).toEqual({ n: 0 });
    } finally {
        database.close();
    }
});
