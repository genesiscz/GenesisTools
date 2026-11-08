import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import type { ChannelName, NotificationEvent } from "@genesiscz/utils/notifications";
import { memoryActTokenStore } from "../act/tokens";
import { postDecisionNotices } from "../decisions/notify";
import type { DecisionRecord } from "../decisions/store";
import { closeNoticeItems, NOTICE_IDS, type NoticeDeps, noticeItem, postNotice, recordNotice } from "./notices";
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
    test("registers a custom delivery before sending and reconciles its late closure", async () => {
        const { deps, store, retracted } = fakeDeps();
        const items = [noticeItem("decision", "custom")];
        deps.dispatch = async () => {
            throw new Error("generic channel must not be used");
        };
        const sent = await postNotice(
            {
                event: { app: "question", id: "qa-decision-custom", message: "custom", only: ["telegram"] },
                items,
                send: async () => {
                    expect(store.notices["qa-decision-custom"]).toBeDefined();
                    await closeNoticeItems(items, deps);
                    return true;
                },
            },
            deps
        );
        expect(sent).toBe(true);
        expect(store.notices).toEqual({});
        expect(retracted).toEqual([
            { channel: "telegram", id: "qa-decision-custom" },
            { channel: "telegram", id: "qa-decision-custom" },
        ]);
    });

    test("retracts late delivery after closure during dispatch", async () => {
        const { deps, store, retracted } = fakeDeps();
        let finish!: (value: boolean) => void;
        let entered!: () => void;
        const started = new Promise<void>((resolve) => {
            entered = resolve;
        });
        deps.dispatch = () => {
            entered();
            return new Promise<boolean>((resolve) => {
                finish = resolve;
            });
        };
        const posting = postNotice(
            {
                event: { app: "question", message: "form", id: "qa-form-f1", only: ["system"] },
                items: [noticeItem("form", "f1")],
            },
            deps
        );
        await started;
        await closeNoticeItems([noticeItem("form", "f1")], deps);
        finish(true);
        expect(await posting).toBe(true);
        expect(store.notices).toEqual({});
        expect(retracted).toHaveLength(2);
    });

    test("records every destination of the same notice", async () => {
        const { deps, store, retracted } = fakeDeps();
        const notice = { id: "qa-decision-d1", items: [noticeItem("decision", "d1")] };
        await recordNotice({ ...notice, channels: ["phone"] }, deps);
        await recordNotice({ ...notice, channels: ["telegram"] }, deps);
        expect(store.notices[notice.id].channels).toEqual(["phone", "telegram"]);
        await closeNoticeItems(notice.items, deps);
        expect(retracted.map(({ channel }) => channel)).toEqual(["phone", "telegram"]);
    });

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
                .filter((token) => token.surface === "phone" && !token.reply)
                .map((token) => token.option)
                .sort()
        ).toEqual(["a", "b"]);
        expect(push.phone?.answers?.tokens.a).toBeDefined();
        // The lock screen's Reply field answers with text through its own token.
        expect(tokens.tokens[push.phone?.answers?.tokens.reply ?? ""]).toMatchObject({ reply: true, surface: "phone" });

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

    test("a decision that takes several letters: the banner sends the recommended set, no letters anywhere", async () => {
        const { deps, posted } = fakeDeps();
        const tokens = memoryActTokenStore();
        const row = decision({ options: ["memory", "disk", "network"], recommended: "abc" });

        await postDecisionNotices([row], { notices: deps, tokens, bundle: tmpdir(), phoneEnabled: true });

        // The banner and the push go out side by side; the push, with no token to issue, may go first.
        const banner = posted.find((event) => event.id === NOTICE_IDS.post(row.id));
        const push = posted.find((event) => event.id === NOTICE_IDS.decision(row.id));
        expect(banner?.actions?.map((action) => action.title)).toEqual(["Open in hub", "Send a + b + c ★"]);
        expect(banner?.actions?.[1].execute).toContain(`banner:${NOTICE_IDS.post(row.id)}:abc`);
        expect(Object.values(tokens.tokens).filter((token) => token.surface === "banner")).toMatchObject([
            { option: "abc", decisionId: row.id },
        ]);

        // A lock-screen button answers one letter, and no category carries a Reply field alone.
        expect(push?.phone?.thread).toBe("s-one");
        expect(push?.phone?.answers).toBeUndefined();
        expect(push?.message).toContain("c) network");
        expect(Object.values(tokens.tokens).some((token) => token.surface === "phone")).toBe(false);
    });

    test("a decision that takes several letters and recommends none: the banner opens the hub only", async () => {
        const { deps, posted } = fakeDeps();
        const tokens = memoryActTokenStore();

        await postDecisionNotices([decision({ multiple: true, recommended: undefined })], {
            notices: deps,
            tokens,
            bundle: tmpdir(),
            phoneEnabled: false,
        });

        expect(posted[0].actions?.map((action) => action.id)).toEqual(["open-hub"]);
        expect(tokens.tokens).toEqual({});
    });

    test("the phone channel off: no push and no phone tokens", async () => {
        const { deps, posted } = fakeDeps();
        const tokens = memoryActTokenStore();

        await postDecisionNotices([decision()], { notices: deps, tokens, bundle: tmpdir(), phoneEnabled: false });

        expect(posted.map((event) => event.id)).toEqual([NOTICE_IDS.post("d_1_s-one")]);
        expect(Object.values(tokens.tokens).some((token) => token.surface === "phone")).toBe(false);
    });
});
