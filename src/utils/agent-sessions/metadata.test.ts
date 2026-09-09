import { expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { boundHistoryMetadata, boundHistoryText, HISTORY_METADATA_LIMITS } from "./metadata";
import type { HistoryMetadataRecord } from "./types";

function metadata(overrides: Partial<HistoryMetadataRecord> = {}): HistoryMetadataRecord {
    return {
        providerId: "anthropic-sub",
        sourceKey: '["anthropic-sub","/invented/home","session-main"]',
        sourceHome: "/invented/home",
        nativeId: "session-main",
        root: "/invented/home/.claude/projects",
        filePath: "/invented/home/.claude/projects/-projects-shop/session-main.jsonl",
        sessionId: "session-main",
        customTitle: "Short title",
        summary: "Short summary",
        firstPrompt: "Short prompt",
        gitBranch: "feature/invented",
        project: "shop",
        cwd: "/projects/shop",
        mtime: 1_788_255_600_000,
        firstTimestamp: "2026-09-01T10:00:00.000Z",
        lastTimestamp: "2026-09-01T11:00:00.000Z",
        isSubagent: false,
        allUserText: "Short user corpus",
        archived: false,
        resumeMode: "native",
        boundedFields: ["lastTimestamp"],
        storageTruncatedFields: [],
        ...overrides,
    };
}

test("clips UTF-8 prefixes at complete code points", () => {
    expect(boundHistoryText({ value: "🙂🙂a", limitBytes: 5 })).toEqual({
        value: "🙂",
        bounded: true,
    });
});

test("preserves null and short text values", () => {
    expect(boundHistoryText({ value: null, limitBytes: 4 })).toEqual({ value: null, bounded: false });
    expect(boundHistoryText({ value: "café", limitBytes: 5 })).toEqual({ value: "café", bounded: false });
});

test("caps metadata payloads with monotonic bounded flags", () => {
    const result = boundHistoryMetadata(
        metadata({
            customTitle: `${"🙂".repeat(2_000)}TITLE_TAIL_SECRET`,
            summary: "s".repeat(20_000),
            firstPrompt: "f".repeat(20_000),
            allUserText: "🙂".repeat(6_000),
            boundedFields: ["lastTimestamp", "summary"],
        })
    );

    expect(Buffer.byteLength(result.customTitle ?? "", "utf8")).toBe(4_096);
    expect(Buffer.byteLength(result.summary ?? "", "utf8")).toBe(16_384);
    expect(Buffer.byteLength(result.firstPrompt ?? "", "utf8")).toBe(16_384);
    expect(Buffer.byteLength(result.allUserText ?? "", "utf8")).toBe(20_000);
    // biome-ignore format: Preserve the assertion snapshot witnessed by the TDD gate.
    expect(result.boundedFields).toEqual([
        "lastTimestamp",
        "summary",
        "customTitle",
        "firstPrompt",
        "allUserText",
    ]);
    expect(result.sourceKey).toBe('["anthropic-sub","/invented/home","session-main"]');
    expect(result.firstTimestamp).toBe("2026-09-01T10:00:00.000Z");
    expect(result.lastTimestamp).toBe("2026-09-01T11:00:00.000Z");
    expect(Object.keys(result).sort()).toEqual(Object.keys(metadata()).sort());
    expect(result.storageTruncatedFields).toEqual(["customTitle", "summary", "firstPrompt", "allUserText"]);
    expect(SafeJSON.stringify(result)).not.toContain("TITLE_TAIL_SECRET");
});

test("retains joined user-text separators below the byte guard", () => {
    const joinedCorpus = `${"u".repeat(5_000)}${" ".repeat(100)}`;
    const result = boundHistoryMetadata(metadata({ allUserText: joinedCorpus }));

    expect(HISTORY_METADATA_LIMITS).toEqual({
        customTitleBytes: 4_096,
        summaryBytes: 16_384,
        firstPromptBytes: 16_384,
        allUserTextCollectedChars: 5_000,
        allUserTextBytes: 20_000,
    });
    expect(result.allUserText).toBe(joinedCorpus);
    expect(result.allUserText?.length).toBe(5_100);
    expect(result.boundedFields).toEqual(["lastTimestamp"]);
});

test("normalizes prior bounded fields as a set", () => {
    const result = boundHistoryMetadata(
        metadata({
            boundedFields: ["summary", "summary", "lastTimestamp"],
        })
    );

    expect(result.boundedFields).toEqual(["summary", "lastTimestamp"]);
});

test("older readers retain conservative storage-cut fallback without treating dates as text", () => {
    const legacy = metadata({ boundedFields: ["summary", "lastTimestamp"] });
    delete legacy.storageTruncatedFields;
    expect(boundHistoryMetadata(legacy).storageTruncatedFields).toEqual(["summary"]);
    expect(boundHistoryMetadata(metadata({ boundedFields: ["allUserText"] })).storageTruncatedFields).toEqual([]);
});
