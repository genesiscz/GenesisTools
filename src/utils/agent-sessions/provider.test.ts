import { afterEach, expect, test } from "bun:test";
import { _resetBuiltInPluginsForTest } from "@genesiscz/utils/ai/providers/plugins";
import { _resetPluginsForTest, registerPlugin } from "@genesiscz/utils/ai/providers/registry";
import { resolveHistoryProvider } from "./provider";

afterEach(() => {
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest();
});

test("a registered fourth history provider can be resolved without an account alias", async () => {
    registerPlugin({
        id: "fixture-sub",
        kind: "subscription",
        capabilities: new Set(),
        credential: { fields: [], envKeys: [] },
        async bind() {
            throw new Error("History discovery must not bind credentials");
        },
        codingAgent: {
            kind: "fixture",
            parserVersion: "1",
            roots: () => [],
            async discover() {
                return { sources: [], issues: [], completeRoots: [] };
            },
            async read(source) {
                return {
                    session: {
                        kind: "fixture",
                        sessionId: "native-one",
                        title: "Invented conversation",
                        cwd: "/invented/project",
                        mtime: new Date("2026-08-15T12:00:00.000Z"),
                        filePath: source.filePath,
                    },
                    entries: [],
                    issues: [],
                };
            },
        },
    });
    const provider = resolveHistoryProvider("fixture-sub");
    const transcript = await provider.reader.read({
        kind: "fixture",
        root: "/invented/history",
        sourceHome: "/invented",
        filePath: "/invented/history/native-one",
        dataPaths: [],
        metadataPaths: [],
    });

    expect(provider.id).toBe("fixture-sub");
    expect(transcript.session.sessionId).toBe("native-one");
    expect(transcript.session.kind).toBe("fixture");
    expect(() => resolveHistoryProvider("missing-provider")).toThrow("Unknown AI provider");
});
