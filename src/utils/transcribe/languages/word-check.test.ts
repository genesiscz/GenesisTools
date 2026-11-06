import { describe, expect, spyOn, test } from "bun:test";
import { UrlSource } from "@genesiscz/utils/ai/local/artifacts/sources/url";
import { ui } from "@genesiscz/utils/cli/ui";
import { findSuspectTerms, findUnknownWords, rawTermEvidence } from "@genesiscz/utils/transcribe/terms";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { CZECH } from "./cs";
import { ensureDownload } from "./downloads";
import { macos } from "./spell/macos";
import type { SpellEngine } from "./spell/types";
import { createWordCheck, type WordCheck } from "./word-check";

function engine(words: string[], calls: string[][] = []): SpellEngine {
    const known = new Set(words);

    return {
        accepted: (asked) => {
            calls.push(asked);
            return new Set(asked.filter((word) => known.has(word)));
        },
        dispose: () => undefined,
    };
}

function check(options: { czech?: string[]; english?: string[]; counts?: Record<string, number> } = {}): WordCheck {
    return createWordCheck({
        provider: "test",
        language: "cs",
        rules: CZECH,
        engine: engine(options.czech ?? ["peníze", "jaký", "sdílím", "modelujeme", "kočka", "tady", "je", "fajn"]),
        loanEngine: engine(options.english ?? ["merge", "boolean"]),
        counts: new Map(Object.entries(options.counts ?? { bysme: 19635 })),
        loanWords: new Set(["backend", "ui"]),
    });
}

function entry(text: string, startSec = 0): TranscriptEntry {
    return { speaker: "Petr", startSec, text };
}

describe("word check", () => {
    test("each layer accepts its kind of word and the rest stays unknown", () => {
        const words = check();
        const verdict = (word: string) => {
            const { class: kind, via } = words.verdict(word);
            return via ? `${kind} ${via}` : kind;
        };

        expect(verdict("peníze")).toBe("dictionary");
        expect(verdict("bysme")).toBe("spoken");
        expect(verdict("jakej")).toBe("spoken jaký");
        expect(verdict("vysdílím")).toBe("derived sdílím");
        expect(verdict("renamodelujeme")).toBe("derived modelujeme");
        expect(verdict("zamergovat")).toBe("loan merge");
        expect(verdict("backendový")).toBe("loan backend");
        expect(verdict("UIčko")).toBe("loan UI");
        expect(verdict("booleans")).toBe("loan boolean");
        expect(verdict("data.tile")).toBe("code");
        expect(verdict("40px")).toBe("code");
        expect(verdict("teoreti-")).toBe("fragment");
        // "ne" is no prefix the check strips: a misheard "nepeníze" must not pass as "peníze".
        expect(verdict("nepeníze")).toBe("unknown");
        expect(verdict("proklizuje")).toBe("unknown");
    });

    test("the transcript's words go to the spell checker in one call", () => {
        const calls: string[][] = [];
        const words = createWordCheck({
            provider: "test",
            language: "cs",
            rules: CZECH,
            engine: engine(["kočka"], calls),
            counts: new Map(),
            loanWords: new Set(),
            words: ["kočka", "jakej", "zvrlk"],
        });

        expect(calls).toHaveLength(1);
        expect(words.verdict("kočka").class).toBe("dictionary");
        expect(words.verdict("zvrlk").class).toBe("unknown");
        expect(calls).toHaveLength(1);
    });
});

describe("findSuspectTerms with a word check", () => {
    test("a word with a Czech letter that no layer accepts is compared with the vocabulary", () => {
        const entries = [entry("Ten Zuštent je fajn.")];
        const vocab = [{ term: "Zustand", source: "glossary" }];

        expect(findSuspectTerms({ entries, vocab })).toEqual([]);
        expect(findSuspectTerms({ entries, vocab, wordCheck: check() }).map((s) => s.heard)).toEqual(["Zuštent"]);
    });

    test("a common word and a spoken form are speech even when they sound like a term", () => {
        const entries = [entry("To bysme dali na novou stránku.")];
        const vocab = [
            { term: "Biome", source: "glossary" },
            { term: "nova-3", source: "glossary" },
        ];
        const words = check({ czech: ["novou"], counts: { bysme: 19635, novou: 9000 } });

        expect(findSuspectTerms({ entries, vocab }).map((s) => s.heard)).toEqual(["bysme", "novou"]);
        expect(findSuspectTerms({ entries, vocab, wordCheck: words })).toEqual([]);
    });
});

describe("findSuspectTerms with a word check, longer runs", () => {
    test("a run of dictionary words is speech, a run with a foreign word is still compared", () => {
        const entries = [entry("Je to jako skripty a ten chess benefit.")];
        const vocab = [
            { term: "JavaScript", source: "glossary" },
            { term: "čez benefit", source: "dictionary" },
        ];
        const words = check({ czech: ["Je", "to", "jako", "skripty", "a", "ten", "benefit"] });

        expect(findSuspectTerms({ entries, vocab }).map((s) => s.heard)).toEqual(["chess benefit", "jako skripty"]);
        expect(findSuspectTerms({ entries, vocab, wordCheck: words }).map((s) => s.heard)).toEqual(["chess benefit"]);
    });
});

describe("findUnknownWords", () => {
    test("lists a word no layer accepts, and skips inflected terms, code, cut words and suspects", () => {
        const entries = [entry("Pak to proklizuje do Figmy a data.tile, teoreti- teoreti… a Zuštent.", 12)];
        const vocab = [{ term: "Figma", source: "glossary" }];
        const unknown = findUnknownWords({ entries, vocab, wordCheck: check(), skip: new Set(["zuštent"]) });

        expect(unknown.map((word) => word.heard)).toEqual(["proklizuje"]);
        expect(unknown[0]!.examples[0]).toMatchObject({
            atSec: 12,
            sentence: expect.stringContaining("==proklizuje=="),
        });
    });

    test("the raw term evidence carries each word's verdict and the unknown words", () => {
        const raw = rawTermEvidence({
            entries: [entry("Ten Zuštent a proklizuje.")],
            vocab: [{ term: "Zustand", source: "glossary" }],
            wordCheck: check(),
        });

        expect(raw.wordCheck).toEqual({ available: true, provider: "test", language: "cs" });
        expect(raw.runs.map((run) => run.words)).toEqual([
            [{ word: "Zuštent", verdict: { class: "unknown", count: 0 } }],
        ]);
        expect(raw.unknown.map((word) => word.heard)).toEqual(["proklizuje"]);
        expect(rawTermEvidence({ entries: [], vocab: [], unavailable: "no network" }).wordCheck).toEqual({
            available: false,
            reason: "no network",
        });
    });
});

describe.skipIf(process.platform !== "darwin")("macos spell checker", () => {
    test("a batch after a misspelled word still checks every later word", async () => {
        const english = await macos.open("en");

        expect([...english.accepted(["house", "housse", "garden", "xqzvw", "tree"])].sort()).toEqual([
            "garden",
            "house",
            "tree",
        ]);
    });

    test("words the checker skips (a capital inside, digits) are never vouched for", async () => {
        const english = await macos.open("en");

        expect([...english.accepted(["DTLe", "OHP", "a1b2", "house"])]).toEqual(["house"]);
    });
});

describe("a first download (R2-MC2)", () => {
    test("says one short line per file; the URL and the licence details go to the day log only", async () => {
        const fetched = spyOn(UrlSource.prototype, "ensure").mockResolvedValue({ path: "/fake/cs.dic", cached: false });
        const lines: string[] = [];
        const dim = spyOn(ui, "dim").mockImplementation((line: string) => {
            lines.push(line);
        });

        try {
            await ensureDownload({
                file: `r2-mc2-${process.pid}/cs.dic`,
                url: "https://example.com/cs.dic",
                sha256: "0".repeat(64),
                license: "GPL-2.0",
            });
        } finally {
            fetched.mockRestore();
            dim.mockRestore();
        }

        expect(lines).toEqual(["Downloading cs.dic for the word check (GPL-2.0); only this once."]);
    });
});
