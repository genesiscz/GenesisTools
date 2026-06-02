import type { DashboardClient, QaLogRes, QaRow } from "@dd/contract";
import { describe, expect, it } from "bun:test";
import { mockDashboardClient } from "@/api/mock-client";
import { QA_LOG_DEFAULT_LIMIT, QA_LOG_INTERVAL_MS, qaKeys, qaLogQuery } from "@/features/qa/queries";

/**
 * Exercises the QA D32 data layer WITHOUT a React renderer (none is installed; adding one is a D20
 * lib decision — see plan-05 notes). We test the `queryOptions` factory (key shape, interval, and
 * that the queryFn routes to the client + applies the boundary cast) against a tiny fake client with
 * a FULL `QaRow` fixture, plus the live mock client for the "is wired" smoke. Full-`QaRow` field
 * assertions use a test-local fixture because the shipped `mockDashboardClient` serves only thin
 * `EnrichedQaEntry` fixtures (flagged in 18-impl-07 notes).
 */

function fullRow(over: Partial<QaRow> = {}): QaRow {
    return {
        id: "qa-1",
        ts: 1_717_000_000_000,
        sessionId: "sess-1",
        sessionTitle: null,
        project: "GenesisTools",
        repoRoot: "/repo",
        cwd: "/repo",
        branch: "feat/x",
        commitSha: null,
        isWorktree: false,
        worktreePath: null,
        aiAgent: null,
        agentLabel: null,
        tag: "question",
        question: "Why expo/fetch for SSE?",
        answerMd: "Core fetch has no ReadableStream on RN.",
        refs: [{ type: "file", value: "sse-parser.ts" }],
        source: "question",
        turnUuid: null,
        supersededBy: null,
        readAt: null,
        answerHtml: "<p>Core fetch has no ReadableStream on RN.</p>",
        answerHtmlPreview: "<p>Core fetch…</p>",
        questionHtml: "<p>Why expo/fetch for SSE?</p>",
        ...over,
    };
}

/** Minimal client stub: only the qa.log method the factory touches, returning a full QaRow. */
function fakeClient(entries: QaRow[]): DashboardClient {
    const log = async (): Promise<QaLogRes> => ({ entries } as unknown as QaLogRes);
    return { qa: { log } } as unknown as DashboardClient;
}

describe("qaKeys", () => {
    it("namespaces under a unique 'qa' root and encodes the params object", () => {
        expect([...qaKeys.log()]).toEqual(["qa", "log", {}]);
        expect([...qaKeys.log({ project: "X", tag: "action" })]).toEqual([
            "qa",
            "log",
            { project: "X", tag: "action" },
        ]);
    });
});

describe("qaLogQuery factory", () => {
    it("builds the log key + 30s interval + a queryFn that returns QaRow[]", async () => {
        const client = fakeClient([fullRow()]);
        const opts = qaLogQuery(client);
        expect([...opts.queryKey]).toEqual([...qaKeys.log()]);
        expect(opts.refetchInterval).toBe(QA_LOG_INTERVAL_MS);
        expect(typeof opts.queryFn).toBe("function");

        const rows = await (opts.queryFn as unknown as () => Promise<QaRow[]>)();
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe("qa-1");
        expect(rows[0].project).toBe("GenesisTools");
        expect(rows[0].tag).toBe("question");
        expect(rows[0].refs[0].value).toBe("sse-parser.ts");
    });

    it("passes project/tag params through to the key", () => {
        const opts = qaLogQuery(fakeClient([]), { project: "GenesisTools", tag: "directive" });
        expect([...opts.queryKey]).toEqual(["qa", "log", { project: "GenesisTools", tag: "directive" }]);
    });

    it("defaults the server limit but lets callers override", async () => {
        let captured: { limit?: number } | undefined;
        const client = {
            qa: {
                log: async (q?: { limit?: number }) => {
                    captured = q;
                    return { entries: [] } as unknown as QaLogRes;
                },
            },
        } as unknown as DashboardClient;

        await (qaLogQuery(client).queryFn as unknown as () => Promise<QaRow[]>)();
        expect(captured?.limit).toBe(QA_LOG_DEFAULT_LIMIT);

        await (qaLogQuery(client, { limit: 5 }).queryFn as unknown as () => Promise<QaRow[]>)();
        expect(captured?.limit).toBe(5);
    });
});

describe("mock dashboard client qa surface (smoke — wired, even if fixtures are thin)", () => {
    it("qa.log returns entries and qa.read resolves ok", async () => {
        const log = await mockDashboardClient.qa.log();
        expect(Array.isArray(log.entries)).toBe(true);
        const read = await mockDashboardClient.qa.read(["x"], false);
        expect(read.ok).toBe(true);
    });

    it("qa.subscribe emits then closes cleanly", async () => {
        const received = await new Promise<boolean>((resolve) => {
            const sub = mockDashboardClient.qa.subscribe(() => resolve(true));
            setTimeout(() => {
                sub.close();
                resolve(false);
            }, 2_000);
        });
        expect(received).toBe(true);
    });
});
