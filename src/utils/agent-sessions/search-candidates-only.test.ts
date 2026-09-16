import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { claudeHistoryReader } from "./compact-readers";
import { initializeCompactHistorySchema } from "./migrations";
import { HistoryService } from "./service";
import { HistorySyncRepository } from "./sync-repository";

function session(root: string, id: string, body: string, stamp: number): void {
    const file = join(root, `${id}.jsonl`);
    writeFileSync(
        file,
        `${SafeJSON.stringify({ type: "user", sessionId: id, cwd: "/projects/fixture", timestamp: "2026-09-01T00:00:00Z", message: { content: body } })}\n`
    );
    utimesSync(file, new Date(stamp), new Date(stamp));
}

test("candidatesOnly answers a content query from the ripgrep gate and metadata, scanning no transcript", async () => {
    const root = mkdtempSync(join(tmpdir(), "history-candidates-only-"));
    const hit = "11111111-2222-4333-8444-000000000001";
    const miss = "11111111-2222-4333-8444-000000000002";
    session(root, hit, "ticket 7404 reconciled the invoice split", 1_700_000_001_000);
    session(root, miss, "an unrelated conversation about nothing", 1_700_000_002_000);
    let scans = 0;
    const scan = claudeHistoryReader.scan!;
    const database = new Database(":memory:");
    initializeCompactHistorySchema(database);
    const service = new HistoryService({
        providerId: "anthropic-sub",
        roots: [root],
        repository: new HistorySyncRepository(database),
        reader: {
            ...claudeHistoryReader,
            async *scan(source, options) {
                scans++;
                yield* scan(
                    {
                        ...source,
                        kind: "claude",
                        metadata: source.metadata ? { ...source.metadata, kind: "claude" } : undefined,
                    },
                    options
                );
            },
        },
    });

    try {
        const hydrated = await service.search({ query: "7404", limit: 20 });
        const scansForHydrated = scans;
        const light = await service.search({ query: "7404", limit: 20, candidatesOnly: true });

        expect(hydrated.results.map((result) => result.session.sessionId)).toEqual([hit]);
        expect(light.results.map((result) => result.session.sessionId)).toEqual([hit]);
        expect(light.results[0].matchedEntries).toEqual([]);
        expect(light.results[0].matchedText).toContain("ticket 7404 reconciled the invoice split");
        expect(light.results[0].relevanceScore).toBeGreaterThan(0);
        expect(scansForHydrated).toBeGreaterThan(0);
        expect(scans).toBe(scansForHydrated);
    } finally {
        database.close();
        rmSync(root, { recursive: true, force: true });
    }
});

test("a session that matches only inside a uuid sorts below one that matches in prose", async () => {
    const root = mkdtempSync(join(tmpdir(), "history-candidates-identifier-"));
    // The query appears in this session's own id and nowhere in what anyone wrote.
    const identifier = "97404aaa-2222-4333-8444-000000000001";
    const prose = "11111111-2222-4333-8444-000000000002";
    session(root, identifier, "an unrelated conversation about nothing", 1_700_000_009_000);
    session(root, prose, "ticket 7404 reconciled the invoice split", 1_700_000_001_000);
    const database = new Database(":memory:");
    initializeCompactHistorySchema(database);
    const service = new HistoryService({
        providerId: "anthropic-sub",
        roots: [root],
        repository: new HistorySyncRepository(database),
        reader: claudeHistoryReader,
    });

    try {
        const light = await service.search({ query: "7404", limit: 20, candidatesOnly: true });
        const ids = light.results.map((result) => result.session.sessionId);

        // The identifier-only session is newer, so mtime order alone would put it first.
        expect(ids).toContain(prose);
        expect(ids.indexOf(prose)).toBeLessThan(ids.indexOf(identifier));
        expect(light.results[ids.indexOf(prose)]?.matchedText).toContain("ticket 7404");
    } finally {
        database.close();
        rmSync(root, { recursive: true, force: true });
    }
});

test("a hit inside a longer number is incidental, so the session that names the ticket comes first", async () => {
    const root = mkdtempSync(join(tmpdir(), "history-candidates-token-"));
    const counter = "33333333-2222-4333-8444-000000000001";
    const real = "44444444-2222-4333-8444-000000000002";
    // The shape that put nine sessions above the eleven real ones: a running token counter.
    session(root, counter, "<total_tokens>14997404 tokens left</total_tokens>", 1_700_000_009_000);
    session(root, real, "MR !7404 is the saga to react-query migration", 1_700_000_001_000);
    const database = new Database(":memory:");
    initializeCompactHistorySchema(database);
    const service = new HistoryService({
        providerId: "anthropic-sub",
        roots: [root],
        repository: new HistorySyncRepository(database),
        reader: claudeHistoryReader,
    });

    try {
        const light = await service.search({ query: "7404", limit: 20, candidatesOnly: true });
        const ids = light.results.map((result) => result.session.sessionId);

        // Both still offered: ripgrep saw a bounded number of windows, so "no prose hit" is
        // evidence and never proof.
        expect(ids).toContain(counter);
        expect(ids.indexOf(real)).toBeLessThan(ids.indexOf(counter));
    } finally {
        database.close();
        rmSync(root, { recursive: true, force: true });
    }
});
