import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { claudeHistoryReader } from "../compact-readers";
import { initializeCompactHistorySchema } from "../migrations";
import { type HistorySearchResult, HistoryService } from "../service";
import { HistorySyncRepository } from "../sync-repository";
import { type BaselineSearchResult, createBaselineOracle } from "./baseline-oracle";
import { createFixtureWorld } from "./fixture-world";
import { withBaseline } from "./with-baseline";

interface SummaryShape {
    sessionId: string;
    timestamp: string;
    customTitle: string | null;
    summary: string | null;
}

interface SummaryCases {
    prompt: SummaryShape[];
    title: SummaryShape[];
    undated: SummaryShape[];
    split: SummaryShape[];
}

function line(value: object): string {
    return `${SafeJSON.stringify(value, { strict: true })}\n`;
}

function baselineShape(result: BaselineSearchResult): SummaryShape {
    return {
        sessionId: result.sessionId,
        timestamp: result.timestamp.toISOString(),
        customTitle: result.customTitle ?? null,
        summary: result.summary ?? null,
    };
}

function candidateShape(result: HistorySearchResult): SummaryShape {
    return {
        sessionId: result.metadata.sessionId ?? result.metadata.nativeId ?? result.metadata.filePath,
        timestamp: result.timestamp.toISOString(),
        customTitle: result.metadata.customTitle,
        summary: result.metadata.summary,
    };
}

withBaseline("summary-only search preserves source-backed metadata parity beyond compact bounds", async () => {
    const world = await createFixtureWorld();
    const project = join(world.sources.claude, "-projects-shop");
    await mkdir(project, { recursive: true });
    const ids = {
        prompt: "11111111-2222-4333-8444-555555555551",
        title: "11111111-2222-4333-8444-555555555552",
        undated: "11111111-2222-4333-8444-555555555553",
        split: "11111111-2222-4333-8444-555555555554",
    };
    const prompt = `${"p".repeat(20_000)} prompt-tail-query`;
    const title = `${"t".repeat(5_000)} title-tail-query`;
    const promptPath = join(project, `${ids.prompt}.jsonl`);
    const titlePath = join(project, `${ids.title}.jsonl`);
    const undatedPath = join(project, `${ids.undated}.jsonl`);
    const splitPath = join(project, `${ids.split}.jsonl`);
    await writeFile(
        promptPath,
        line({
            type: "user",
            sessionId: ids.prompt,
            cwd: "/projects/shop",
            timestamp: "2026-08-10T10:00:00.000Z",
            message: { content: prompt },
        })
    );
    await writeFile(
        titlePath,
        line({
            type: "user",
            sessionId: ids.title,
            cwd: "/projects/shop",
            timestamp: "2026-08-11T10:00:00.000Z",
            message: { content: "short prompt" },
        }) + line({ type: "custom-title", sessionId: ids.title, customTitle: title })
    );
    await writeFile(
        undatedPath,
        line({
            type: "user",
            sessionId: ids.undated,
            cwd: "/projects/shop",
            message: { content: "undated summary needle" },
        })
    );
    await writeFile(
        splitPath,
        line({
            type: "user",
            sessionId: ids.split,
            cwd: "/projects/shop",
            timestamp: "2026-08-13T10:00:00.000Z",
            message: { content: "promptpiece" },
        }) +
            line({ type: "summary", sessionId: ids.split, summary: "summarypiece" }) +
            line({ type: "custom-title", sessionId: ids.split, customTitle: "titlepiece" })
    );
    const undatedMtime = new Date("2026-08-12T10:00:00.000Z");
    await utimes(undatedPath, undatedMtime, undatedMtime);

    const oracle = await createBaselineOracle({ world });
    let expected: SummaryCases;
    try {
        await oracle.list();
        expected = {
            prompt: (await oracle.searchSummaries({ query: "prompt-tail-query" })).map(baselineShape),
            title: (await oracle.searchSummaries({ query: "title-tail-query" })).map(baselineShape),
            undated: (
                await oracle.searchSummaries({
                    query: "undated summary needle",
                    since: new Date("2026-08-12T00:00:00.000Z"),
                    until: new Date("2026-08-12T23:59:59.999Z"),
                })
            ).map(baselineShape),
            split: (
                await oracle.searchSummaries({
                    query: "titlepiece summarypiece promptpiece",
                })
            ).map(baselineShape),
        };
    } finally {
        await oracle.close();
    }

    const database = new Database(":memory:");
    initializeCompactHistorySchema(database);
    const repository = new HistorySyncRepository(database);
    const history = new HistoryService({
        providerId: "anthropic-sub",
        reader: claudeHistoryReader,
        repository,
        roots: [world.sources.claude],
        now: () => world.now,
    });
    try {
        expect(expected.prompt.map((result) => result.sessionId)).toEqual([ids.prompt]);
        expect(expected.title.map((result) => result.sessionId)).toEqual([ids.title]);
        expect(expected.undated.map((result) => result.sessionId)).toEqual([ids.undated]);
        expect(expected.undated[0]?.timestamp).toBe(world.now.toISOString());
        expect(expected.split.map((result) => result.sessionId)).toEqual([ids.split]);

        const actual = {
            prompt: (await history.search({ summaryOnly: true, query: "prompt-tail-query" })).results.map(
                candidateShape
            ),
            title: (await history.search({ summaryOnly: true, query: "title-tail-query" })).results.map(candidateShape),
            undated: (
                await history.search({
                    summaryOnly: true,
                    query: "undated summary needle",
                    since: new Date("2026-08-12T00:00:00.000Z"),
                    until: new Date("2026-08-12T23:59:59.999Z"),
                })
            ).results.map(candidateShape),
            split: (
                await history.search({
                    summaryOnly: true,
                    query: "titlepiece summarypiece promptpiece",
                })
            ).results.map(candidateShape),
        };

        expect(actual).toEqual(expected);

        const storedPrompt = repository.metadata.getMetadataBySessionId({
            providerId: "anthropic-sub",
            sessionId: ids.prompt,
        });
        const storedTitle = repository.metadata.getMetadataBySessionId({
            providerId: "anthropic-sub",
            sessionId: ids.title,
        });
        expect(Buffer.byteLength(storedPrompt?.firstPrompt ?? "", "utf8")).toBeLessThanOrEqual(16_384);
        expect(storedPrompt?.firstPrompt).not.toContain("prompt-tail-query");
        expect(storedPrompt?.allUserText).toHaveLength(5_000);
        expect(storedPrompt?.allUserText).not.toContain("prompt-tail-query");
        expect(Buffer.byteLength(storedTitle?.customTitle ?? "", "utf8")).toBeLessThanOrEqual(4_096);
        expect(storedTitle?.customTitle).not.toContain("title-tail-query");
        const columns = database
            .query<{ name: string }, []>("PRAGMA table_info(session_metadata)")
            .all()
            .map((column) => column.name);
        expect(columns.filter((name) => /^full_/i.test(name))).toEqual([]);
    } finally {
        database.close();
        await world.dispose();
    }
});
