import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

test("a same-line search keeps a file only when one line can hold both query words", async () => {
    // A line-local reader's hit needs every word inside one record, which is one line, so a file
    // that holds each word only on a line of its own cannot match. "battery guard" scanned 58 such
    // transcripts (666 MB) of the real corpus for 30 hits.
    const root = mkdtempSync(join(tmpdir(), "history-candidates-same-line-"));
    const apart = join(root, "apart.jsonl");
    const together = join(root, "together.jsonl");
    const escaped = join(root, "escaped.jsonl");
    const invalid = join(root, "invalid.jsonl");
    writeFileSync(apart, '{"text":"alpha only"}\n{"text":"bravo only"}\n');
    writeFileSync(together, '{"text":"Bravo before ALPHA"}\n');
    writeFileSync(escaped, '{"text":"alph\\u0061 and bravo"}\n');
    // The Unicode `.` stops at invalid UTF-8 while JS decodes past it, so a gap of bad bytes
    // between the words must not hide the line.
    writeFileSync(
        invalid,
        Buffer.concat([Buffer.from('{"text":"alpha '), Buffer.from([0xff, 0xfe]), Buffer.from(' bravo"}\n')])
    );
    const sources = [apart, together, escaped, invalid].map((path) => source(path, [path]));
    const paths = async (options: { sameLine?: boolean; sortByRelevance?: boolean }) =>
        (
            await historyCandidates({
                sources,
                filters: { query: "alpha bravo", sortByRelevance: options.sortByRelevance },
                sameLine: options.sameLine,
            })
        ).map((candidate) => candidate.source.filePath);

    expect(await paths({ sameLine: true })).toEqual([together, escaped, invalid]);
    // Negative controls: without the flag, and for a relevance count, the one-word pass still runs.
    expect(await paths({})).toEqual([apart, together, escaped, invalid]);
    expect(await paths({ sameLine: true, sortByRelevance: true })).toEqual([apart, together, escaped, invalid]);
});

test("a same-line search sees every raw form that the search lowercases into a query letter", async () => {
    // Each line below decodes and lowercases to hold both words, so dropping it would drop a hit:
    // an escaped capital, a dotted capital I (ripgrep does not fold it to `i`), and an escaped
    // Kelvin sign (ripgrep folds the sign itself to `k`, but not its escape).
    const root = mkdtempSync(join(tmpdir(), "history-candidates-same-line-forms-"));
    const capital = join(root, "capital.jsonl");
    const dotted = join(root, "dotted.jsonl");
    const kelvin = join(root, "kelvin.jsonl");
    const apart = join(root, "apart.jsonl");
    writeFileSync(capital, '{"text":"alpha \\u0042ravo"}\n');
    writeFileSync(dotted, '{"text":"alpha OMNİ"}\n');
    writeFileSync(kelvin, '{"text":"alpha \\u212Ailo"}\n');
    writeFileSync(apart, '{"text":"alpha"}\n{"text":"bravo omni kilo"}\n');
    const sources = [capital, dotted, kelvin, apart].map((path) => source(path, [path]));
    const paths = async (query: string) =>
        (await historyCandidates({ sources, filters: { query }, sameLine: true })).map(
            (candidate) => candidate.source.filePath
        );

    expect(await paths("alpha bravo")).toContain(capital);
    expect(await paths("alpha omni")).toContain(dotted);
    expect(await paths("alpha kilo")).toContain(kelvin);
    expect(await paths("alpha bravo")).not.toContain(apart);
});

test("a same-line search keeps words that share characters and a query of one distinct word", async () => {
    const root = mkdtempSync(join(tmpdir(), "history-candidates-same-line-overlap-"));
    const merged = join(root, "merged.jsonl");
    const apart = join(root, "apart.jsonl");
    // `stack` and `tackle` share `tack`, so `stackle` holds both words in seven characters, with the
    // shorter word first; `tacklens` holds `tackle` and `lens`, with the longer word first.
    writeFileSync(merged, '{"text":"a stackle here"}\n{"text":"a tacklens there"}\n');
    writeFileSync(apart, '{"text":"stack lens"}\n{"text":"tackle"}\n');
    const sources = [merged, apart].map((path) => source(path, [path]));
    const paths = async (query: string) =>
        (await historyCandidates({ sources, filters: { query }, sameLine: true })).map(
            (candidate) => candidate.source.filePath
        );

    expect(await paths("stack tackle")).toEqual([merged]);
    expect(await paths("tackle lens")).toEqual([merged]);
    // `tack` sits inside `tackle`, so only one word is left and the one-word pass decides.
    expect(await paths("tack tackle")).toEqual([merged, apart]);
});

test("candidates are found at every depth under a shared root", async () => {
    // Ripgrep walks only the top-level entries holding a member, to the deepest member's depth.
    // One level short and the deepest member reads as checked-and-absent, so it would vanish.
    const root = mkdtempSync(join(tmpdir(), "history-candidates-depth-"));
    const top = join(root, "top.jsonl");
    const shallow = join(root, "-project-a", "shallow.jsonl");
    const deep = join(root, "-project-b", "session", "subagents", "deep.jsonl");
    mkdirSync(join(root, "-project-a"), { recursive: true });
    mkdirSync(join(root, "-project-b", "session", "subagents"), { recursive: true });
    for (const path of [top, shallow, deep]) {
        writeFileSync(path, '{"text":"depthneedle"}\n');
    }
    const sources = [top, shallow, deep].map((path) => ({ ...source(path, [path]), root }));

    const found = await historyCandidates({ sources, filters: { query: "depthneedle" } });
    const absent = await historyCandidates({ sources, filters: { query: "missingneedle" } });

    expect(found.map((candidate) => candidate.source.filePath)).toEqual([top, shallow, deep]);
    expect(absent).toEqual([]);
});
