import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import type { ChannelName, NotificationEvent } from "@genesiscz/utils/notifications";
import { memoryActTokenStore } from "../act/tokens";
import { postDecisionNotices } from "../decisions/notify";
import type { DecisionRecord } from "../decisions/store";
import { closeNoticeItems, NOTICE_IDS, type NoticeDeps, noticeItem, postNotice } from "./notices";
import { memoryNoticeStore } from "./store";

function fakeDeps() {
    const store = memoryNoticeStore();
    const posted: NotificationEvent[] = [];
    const retracted: { channel: ChannelName; id: string }[] = [];
    const deps: NoticeDeps = {
        store,
        dispatch: async (event) => {
            posted.push(event);
            return true;
        },
        retract: async (channel, id) => {
            retracted.push({ channel, id });
            return true;
        },
        now: () => 1_000,
    };
    return { deps, store, posted, retracted };
}

function decision(over: Partial<DecisionRecord> = {}): DecisionRecord {
    return {
        id: "d_1_s-one",
        sessionId: "s-one",
        number: 1,
        prompt: "Which cache?",
        options: ["memory", "disk"],
        state: "open",
        createdTs: "2026-11-04T10:00:00.000Z",
        updatedTs: "2026-11-04T10:00:00.000Z",
        project: "work",
        recommended: "b",
        ...over,
    } as DecisionRecord;
}

describe("notices", () => {
    test("answering one item of a grouped notice keeps it; answering the last retracts it on every channel", async () => {
        const { deps, retracted } = fakeDeps();
        await postNotice(
            {
                event: { app: "question", message: "two wait", id: "qa-post-d1", only: ["system", "telegram"] },
                items: [noticeItem("decision", "d1"), noticeItem("decision", "d2")],
            },
            deps
        );

        expect(await closeNoticeItems([noticeItem("decision", "d1")], deps)).toEqual([]);
        expect(retracted).toEqual([]);

        expect(await closeNoticeItems([noticeItem("decision", "d2")], deps)).toEqual(["qa-post-d1"]);
        expect(retracted).toEqual([
            { channel: "system", id: "qa-post-d1" },
            { channel: "telegram", id: "qa-post-d1" },
        ]);
    });

    test("an item no notice names retracts nothing, and a closed notice is forgotten", async () => {
        const { deps, store, retracted } = fakeDeps();
        await postNotice(
            {
                event: { app: "question", message: "form", id: NOTICE_IDS.form("f1"), only: ["system"] },
                items: [noticeItem("form", "f1")],
            },
            deps
        );

        expect(await closeNoticeItems([noticeItem("form", "other")], deps)).toEqual([]);
        expect(await closeNoticeItems([noticeItem("form", "f1")], deps)).toEqual([NOTICE_IDS.form("f1")]);
        expect(store.notices).toEqual({});
        expect(retracted).toHaveLength(1);
    });
});

describe("decision notices", () => {
    test("one answerable decision: a banner with letter buttons, and a phone push with sealed-to-be tokens", async () => {
        const { deps, posted, store } = fakeDeps();
        const tokens = memoryActTokenStore();
        const row = decision();

        expect(await postDecisionNotices([row], { notices: deps, tokens, bundle: tmpdir(), phoneEnabled: true })).toBe(
            true
        );

        const [banner, push] = posted;
        expect(banner.id).toBe(NOTICE_IDS.post(row.id));
        expect(banner.only).not.toContain("phone");
        expect(banner.actions?.map((action) => action.title)).toEqual(["Open in hub", "a", "b ★"]);
        expect(banner.actions?.[1].execute).toContain(`banner:${NOTICE_IDS.post(row.id)}:a`);

        expect(push.id).toBe(NOTICE_IDS.decision(row.id));
        expect(push.only).toEqual(["phone"]);
        expect(push.phone?.answers?.letters).toEqual(["a", "b"]);
        expect(push.phone?.answers?.recommended).toBe("b");
        expect(push.message).toContain("a) memory");
        const issued = Object.values(tokens.tokens);
        expect(
            issued
                .filter((token) => token.surface === "phone")
                .map((token) => token.option)
                .sort()
        ).toEqual(["a", "b"]);
        expect(push.phone?.answers?.tokens.a).toBeDefined();

        expect(Object.keys(store.notices).sort()).toEqual(
            [NOTICE_IDS.decision(row.id), NOTICE_IDS.post(row.id)].sort()
        );
    });

    test("two decisions: one grouped banner without letters, one push each", async () => {
        const { deps, posted } = fakeDeps();
        const rows = [decision(), decision({ id: "d_2_s-one", number: 2 })];

        await postDecisionNotices(rows, {
            notices: deps,
            tokens: memoryActTokenStore(),
            bundle: tmpdir(),
            phoneEnabled: true,
        });

        expect(posted.map((event) => event.id)).toEqual([
            NOTICE_IDS.post("d_1_s-one"),
            NOTICE_IDS.decision("d_1_s-one"),
            NOTICE_IDS.decision("d_2_s-one"),
        ]);
        expect(posted[0].actions?.map((action) => action.id)).toEqual(["open-hub"]);
    });

    test("the phone channel off: no push and no phone tokens", async () => {
        const { deps, posted } = fakeDeps();
        const tokens = memoryActTokenStore();

        await postDecisionNotices([decision()], { notices: deps, tokens, bundle: tmpdir(), phoneEnabled: false });

        expect(posted.map((event) => event.id)).toEqual([NOTICE_IDS.post("d_1_s-one")]);
        expect(Object.values(tokens.tokens).some((token) => token.surface === "phone")).toBe(false);
    });
});
