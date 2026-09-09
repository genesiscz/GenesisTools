import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { historyCandidates } from "./search-candidates";
import type { NativeSessionSource } from "./types";

function source(filePath: string, searchPaths?: string[]): NativeSessionSource<string> {
    return {
        kind: "fixture",
        root: join(filePath, ".."),
        sourceHome: join(filePath, ".."),
        filePath,
        dataPaths: [filePath],
        metadataPaths: [],
        ...(searchPaths ? { searchPaths } : {}),
    };
}

test("candidate acceleration keeps literal substring hits, escaped JSON, projected sources, and colon paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "history-candidates-"));
    const matching = join(root, "match: source.jsonl");
    const escaped = join(root, "escaped.jsonl");
    const absent = join(root, "absent.jsonl");
    const projected = join(root, "projected.jsonl");
    writeFileSync(matching, '{"text":"prefix-needle-suffix rare-marker"}\n');
    writeFileSync(escaped, '{"text":"\\\\u0061lpha"}\n');
    writeFileSync(absent, '{"text":"marker-only"}\n');
    writeFileSync(projected, '{"text":"projection-only"}\n');

    const sources = [
        source(matching, [matching]),
        source(escaped, [escaped]),
        source(absent, [absent]),
        source(projected),
    ];
    const needle = await historyCandidates({ sources, filters: { query: "needle" } });
    const alpha = await historyCandidates({ sources, filters: { query: "alpha" } });
    const hyphenated = await historyCandidates({ sources, filters: { query: "rare-marker" } });

    // `escaped.jsonl` holds `alpha`, so it stays a candidate for a query whose needle shares
    // one of those characters and drops out of one that does not. Keeping every escaped source a
    // candidate for every query cost a scan of 2,041 of 12,111 real transcripts per search.
    expect(needle.map((candidate) => candidate.source.filePath)).toEqual([matching, projected]);
    expect(needle.find((candidate) => candidate.source.filePath === matching)?.matchCount).toBe(1);
    expect(alpha.map((candidate) => candidate.source.filePath)).toEqual([escaped, projected]);
    expect(alpha.find((candidate) => candidate.source.filePath === escaped)?.matchCount).toBeGreaterThan(0);
    expect(hyphenated.map((candidate) => candidate.source.filePath)).toEqual([matching, escaped, projected]);
    expect(hyphenated.find((candidate) => candidate.source.filePath === matching)?.matchCount).toBe(1);
});

test("candidate acceleration retains all sources for regex, short, and unsupported query shapes", async () => {
    const root = mkdtempSync(join(tmpdir(), "history-candidates-"));
    const first = join(root, "first.jsonl");
    const second = join(root, "second.jsonl");
    writeFileSync(first, '{"text":"alpha"}\n');
    writeFileSync(second, '{"text":"beta"}\n');
    const sources = [source(first, [first]), source(second, [second])];

    for (const filters of [{ query: "ab" }, { query: "Žluť" }, { query: "alpha.*", regex: true }]) {
        expect((await historyCandidates({ sources, filters })).map((candidate) => candidate.source.filePath)).toEqual([
            first,
            second,
        ]);
    }
});

test("candidate acceleration excludes only explicitly raw searchable absent sources and honours cancellation", async () => {
    const root = mkdtempSync(join(tmpdir(), "history-candidates-"));
    const raw = join(root, "raw.jsonl");
    const escaped = join(root, "escaped.jsonl");
    const projected = join(root, "projected.jsonl");
    writeFileSync(raw, '{"text":"ordinary"}\n');
    writeFileSync(escaped, '{"text":"\\\\u0061lpha"}\n');
    writeFileSync(projected, '{"text":"projection-only"}\n');
    const sources = [source(raw, [raw]), source(escaped, [escaped]), source(projected)];

    expect(
        (await historyCandidates({ sources, filters: { query: "absenttoken" } })).map(
            (candidate) => candidate.source.filePath
        )
    ).toEqual([escaped, projected]);
    const controller = new AbortController();
    controller.abort();
    await expect(
        historyCandidates({ sources, filters: { query: "alpha", signal: controller.signal } })
    ).rejects.toThrow();
});

test("time-order prefilter only checks membership while relevance retains occurrence counts", async () => {
    const root = mkdtempSync(join(tmpdir(), "history-candidate-counts-"));
    const path = join(root, "common.jsonl");
    writeFileSync(path, '{"text":"commonterm"}\n'.repeat(40));
    const sources = [source(path, [path])];
    const byTime = await historyCandidates({ sources, filters: { query: "commonterm" } });
    const byRelevance = await historyCandidates({ sources, filters: { query: "commonterm", sortByRelevance: true } });
    expect(byTime.map((candidate) => candidate.source.filePath)).toEqual([path]);
    expect(byTime[0]?.matchCount).toBe(1);
    expect(byRelevance[0]?.matchCount).toBe(20);
});

test("the commit prefilter narrows on seven characters and keeps a short recorded abbreviation", async () => {
    // Without a needle a commit search parsed every source: about 42 s for an absent hash on the
    // real corpus, 3 s with this. Seven is the floor because the reader only records
    // `\b[a-f0-9]{7,40}\b`, so any transcript that can match holds these seven characters.
    const directory = mkdtempSync(join(tmpdir(), "gt-candidates-commit-"));
    const full = join(directory, "full.jsonl");
    const abbreviated = join(directory, "abbreviated.jsonl");
    const unrelated = join(directory, "unrelated.jsonl");
    writeFileSync(full, '{"text":"git commit 4e7a3bcd28f0a1b2c3d4e5f60718293a4b5c6d7e"}\n');
    writeFileSync(abbreviated, '{"text":"git commit 4e7a3bc"}\n');
    writeFileSync(unrelated, '{"text":"git commit 9999999999999999999999999999999999999999"}\n');
    const sources = [full, abbreviated, unrelated].map((path) => source(path, [path]));

    const requested = await historyCandidates({
        sources,
        filters: { commitHash: "4e7a3bcd28f0a1b2c3d4e5f60718293a4b5c6d7e" },
    });
    const byPrefix = await historyCandidates({ sources, filters: { commitHash: "4e7a3bc" } });

    expect(requested.map((candidate) => candidate.source.filePath).sort()).toEqual([abbreviated, full].sort());
    expect(byPrefix.map((candidate) => candidate.source.filePath).sort()).toEqual([abbreviated, full].sort());
});

test("a query beside a commit hash still narrows on the query", async () => {
    const directory = mkdtempSync(join(tmpdir(), "gt-candidates-commit-query-"));
    const both = join(directory, "both.jsonl");
    const hashOnly = join(directory, "hash-only.jsonl");
    writeFileSync(both, '{"text":"rarequeryword git commit 4e7a3bcd28"}\n');
    writeFileSync(hashOnly, '{"text":"git commit 4e7a3bcd28"}\n');
    const sources = [both, hashOnly].map((path) => source(path, [path]));

    const candidates = await historyCandidates({
        sources,
        filters: { query: "rarequeryword", commitHash: "4e7a3bcd28" },
    });

    expect(candidates.map((candidate) => candidate.source.filePath)).toEqual([both]);
});
