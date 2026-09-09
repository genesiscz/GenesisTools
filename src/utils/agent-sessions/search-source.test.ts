import { expect, test } from "bun:test";
import type { CachedHistoryMetadata } from "./repository";
import { searchHistorySource } from "./search-source";
import type { HistorySourceRecord, NativeSessionReader, NativeSessionSource } from "./types";

const START = "2026-09-01T10:00:00.000Z";
const SOURCE: NativeSessionSource<string> = {
    kind: "fixture",
    root: "/invented/sessions",
    sourceHome: "/invented",
    filePath: "/invented/sessions/fixture.jsonl",
    dataPaths: ["/invented/sessions/fixture.jsonl"],
    metadataPaths: [],
};

function metadata(): CachedHistoryMetadata {
    return {
        providerId: "fixture-provider",
        sourceKey: "fixture-source-key",
        sourceHome: "/invented",
        nativeId: "fixture-native-id",
        parentNativeId: null,
        root: SOURCE.root,
        filePath: SOURCE.filePath,
        sessionId: "fixture-session",
        customTitle: "Initial fixture title",
        summary: null,
        firstPrompt: "Initial fixture prompt",
        allUserText: "Initial fixture prompt",
        gitBranch: null,
        project: "fixture",
        cwd: "/invented/project",
        mtime: 1,
        firstTimestamp: START,
        lastTimestamp: null,
        projectDirectory: null,
        isSubagent: false,
        archived: false,
        resumeMode: "native",
        identityStatus: "resolved",
        boundedFields: [],
    };
}

function entry(options: {
    role?: "user" | "assistant" | "tool" | "thinking" | "system";
    text: string;
    tool?: string;
    toolEvent?: "call" | "result";
    inputText?: string;
    paths?: string[];
    commits?: string[];
    timestamp?: string;
}) {
    return {
        line: 1,
        role: options.role ?? "assistant",
        text: options.text,
        tool: options.tool,
        toolEvent: options.toolEvent,
        inputText: options.inputText,
        paths: options.paths ?? [],
        commits: options.commits ?? [],
        timestamp: options.timestamp,
    };
}

function record(options: {
    position: number;
    locator: string;
    entries?: ReturnType<typeof entry>[];
    role?: "user" | "assistant" | "tool" | "thinking" | "system";
    timestamp?: string;
    metadataChanges?: { sessionId?: string; gitBranch?: string; cwd?: string; summary?: string; customTitle?: string };
}): HistorySourceRecord {
    return {
        position: options.position,
        locator: options.locator,
        entries: options.entries ?? [],
        original: `{ "fixture": ${options.position} }`,
        role: options.role,
        timestamp: options.timestamp,
        metadataChanges: options.metadataChanges,
    };
}

function reader(records: HistorySourceRecord[]): NativeSessionReader<string> {
    return {
        kind: "fixture",
        parserVersion: "fixture-v1",
        roots: () => [SOURCE.root],
        discover: async () => ({ sources: [SOURCE], issues: [], completeRoots: [SOURCE.root] }),
        read: async () => {
            throw new Error("fixture reader does not read transcripts");
        },
        scan: async function* () {
            yield* records;
        },
    };
}

async function search(records: HistorySourceRecord[], filters: Parameters<typeof searchHistorySource>[0]["filters"]) {
    return searchHistorySource({
        source: SOURCE,
        reader: reader(records),
        metadata: metadata(),
        filters,
        now: new Date(START),
    });
}

test("source search keeps dense original-record context around a multi-token match", async () => {
    const result = await search(
        [
            record({ position: 0, locator: "record:0", role: "system" }),
            record({
                position: 1,
                locator: "record:1",
                role: "user",
                entries: [entry({ role: "user", text: "before" })],
            }),
            record({
                position: 2,
                locator: "record:2",
                role: "assistant",
                timestamp: START,
                entries: [entry({ text: "alpha" }), entry({ text: "beta" })],
            }),
            record({ position: 3, locator: "record:3", entries: [entry({ text: "after" })] }),
            record({ position: 4, locator: "record:4", entries: [entry({ text: "later" })] }),
        ],
        { query: "alpha beta", context: 2 }
    );

    expect(result?.matchedLocators).toEqual(["record:2"]);
    expect(result?.contextLocators).toEqual(["record:0", "record:1", "record:2", "record:3", "record:4"]);
    expect(result?.firstPrompt).toBe("before");
});

test("source search applies file filters to tool call input rather than result prose", async () => {
    const resultOnly = [
        record({
            position: 0,
            locator: "result",
            entries: [entry({ role: "tool", text: "result mentions src/input.ts", tool: "Bash", toolEvent: "result" })],
        }),
    ];
    const call = record({
        position: 1,
        locator: "call",
        entries: [
            entry({
                role: "tool",
                text: "git diff",
                tool: "Bash",
                toolEvent: "call",
                inputText: "git diff src/input.ts",
                paths: ["src/input.ts"],
            }),
        ],
    });

    expect(await search(resultOnly, { file: "src/input.ts" })).toBeNull();
    expect((await search([...resultOnly, call], { file: "src/input.ts" }))?.matchedLocators).toEqual(["call"]);
});

test("source search applies exclusions and conversation dates after metadata last-wins updates", async () => {
    const records = [
        record({
            position: 0,
            locator: "metadata:old",
            metadataChanges: { sessionId: "first-id", customTitle: "Old title", summary: "Old summary" },
        }),
        record({
            position: 1,
            locator: "user",
            role: "user",
            timestamp: START,
            entries: [entry({ role: "user", text: "find the fixture" })],
        }),
        record({
            position: 2,
            locator: "metadata:new",
            metadataChanges: {
                sessionId: "last-id",
                customTitle: "Last title",
                summary: "Last summary",
                cwd: "/invented/last",
                gitBranch: "fixture-branch",
            },
        }),
    ];

    const result = await search(records, { query: "fixture" });
    expect(result?.metadata).toMatchObject({
        sessionId: "last-id",
        customTitle: "Last title",
        summary: "Last summary",
        cwd: "/invented/last",
        gitBranch: "fixture-branch",
    });
    expect(await search(records, { query: "fixture", excludeSessions: ["last-id"] })).toBeNull();
    expect(
        await search(records, { query: "fixture", conversationDate: new Date("2026-09-02T00:00:00.000Z") })
    ).toBeNull();
});

test("source search returns null when no original record matches", async () => {
    const result = await search([record({ position: 0, locator: "only", entries: [entry({ text: "unrelated" })] })], {
        query: "missing",
    });

    expect(result).toBeNull();
});

test("source search matches a full requested commit against an abbreviated recorded hash", async () => {
    // Regression test: PR #370 review thread 15 — the shared path kept only one prefix direction.
    const result = await search(
        [
            record({
                position: 0,
                locator: "commit",
                entries: [entry({ text: "Committed change", commits: ["abcdef1"] })],
            }),
        ],
        { commitHash: "abcdef1234567890abcdef1234567890abcdef12" }
    );

    expect(result?.matchedLocators).toEqual(["commit"]);
});

test("source search honours an already-cancelled signal", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
        search([record({ position: 0, locator: "only", entries: [entry({ text: "fixture" })] })], {
            query: "fixture",
            signal: controller.signal,
        })
    ).rejects.toThrow();
});
