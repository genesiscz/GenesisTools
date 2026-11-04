import { describe, expect, it } from "bun:test";
import { fixtureDashboardClient } from "@/api/fixture-wire";
import { MOCK_MEMOS } from "@/api/fixtures/memos";
import { actOnMemo, memosQuery, offeredActions } from "@/features/memos/queries";

describe("memo to action", () => {
    it("reads the memos and runs an action through the real client", async () => {
        const list = await memosQuery(fixtureDashboardClient).queryFn?.({} as never);
        const receipt = await actOnMemo(fixtureDashboardClient, { id: "12-1790000000000", action: "note", idempotencyKey: "k1" });

        expect(list).toEqual(MOCK_MEMOS);
        expect(receipt).toMatchObject({ action: "note", ok: false });
    });

    it("offers Reminders only with todos and the agent only with a task", () => {
        const [memo] = MOCK_MEMOS.memos;

        expect(offeredActions(memo)).toEqual(["reminders", "note", "agent"]);
        expect(offeredActions({ ...memo, todos: [], agentTask: null })).toEqual(["note"]);
    });
});
