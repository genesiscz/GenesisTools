import type { AttentionRes, DashboardClient } from "@dd/contract";
import { describe, expect, it } from "bun:test";
import { mockDashboardClient } from "@/api/mock-client";
import { ATTENTION_INTERVAL_MS, attentionKeys, attentionQuery } from "@/features/needs-input-inbox/queries";

/**
 * Exercises the Needs-Input Inbox D32 data layer WITHOUT a React renderer (none is installed). We
 * test the `queryOptions` factory (key shape, interval, queryFn routing to `client.attention.list()`)
 * against a tiny fake client, plus the live mock client for the "is wired" smoke.
 */

const FIXTURE: AttentionRes = {
    items: [
        {
            id: "qa:1",
            kind: "agent-question",
            title: "Approve?",
            subtitle: "GenesisTools",
            ts: 1_717_000_000_000,
            deepLink: { kind: "qa", qaId: "1" },
        },
    ],
    count: 1,
};

function fakeClient(res: AttentionRes): DashboardClient {
    const list = async (): Promise<AttentionRes> => res;
    return { attention: { list } } as unknown as DashboardClient;
}

describe("attentionKeys", () => {
    it("namespaces under a unique 'attention' root", () => {
        expect([...attentionKeys.list]).toEqual(["attention", "list"]);
    });
});

describe("attentionQuery factory", () => {
    it("builds the list key + 15s interval + a queryFn that routes to client.attention.list()", async () => {
        const opts = attentionQuery(fakeClient(FIXTURE));
        expect([...opts.queryKey]).toEqual([...attentionKeys.list]);
        expect(opts.refetchInterval).toBe(ATTENTION_INTERVAL_MS);
        expect(typeof opts.queryFn).toBe("function");

        const res = await (opts.queryFn as unknown as () => Promise<AttentionRes>)();
        expect(res.count).toBe(1);
        expect(res.items[0].id).toBe("qa:1");
        expect(res.items[0].deepLink).toEqual({ kind: "qa", qaId: "1" });
    });
});

describe("mock dashboard client attention surface (smoke — wired)", () => {
    it("attention.list returns the fixture items + count", async () => {
        const res = await mockDashboardClient.attention.list();
        expect(Array.isArray(res.items)).toBe(true);
        expect(res.count).toBe(res.items.length);
        expect(res.items.some((i) => i.kind === "agent-question")).toBe(true);
        expect(res.items.some((i) => i.kind === "agent-session")).toBe(true);
    });
});
