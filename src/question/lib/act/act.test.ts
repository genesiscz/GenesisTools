import { describe, expect, it } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Storage } from "@genesiscz/utils/storage/storage";
import { AnswerRefusedError } from "../decisions/answers";
import type { DecisionRecord } from "../decisions/store";
import type { AnswerDecisionInput, InboxAnswerResult } from "../inbox/answer";
import type { DraftInput } from "../inbox/drafts";
import { type ActDeps, act, press, replyLetters, toggledPick } from "./act";
import {
    ACT_TOKEN_TTL_MS,
    fileActTokenStore,
    issueActTokens,
    issueReplyToken,
    issueToggleTokens,
    memoryActTokenStore,
} from "./tokens";

const NOW = Date.parse("2026-11-03T10:00:00Z");

function row(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
    return {
        id: "d_3_s-alpha",
        sessionId: "s-alpha",
        number: 3,
        prompt: "Which way?",
        options: ["keep it", "drop it"],
        state: "open",
        revision: 2,
        provider: "claude",
        updatedTs: "2026-11-03T09:00:00Z",
        ...overrides,
    };
}

function deps(rows: DecisionRecord[], answer: ActDeps["answer"]) {
    const store = memoryActTokenStore();
    const calls: AnswerDecisionInput[] = [];
    const recorded: ActDeps = {
        store,
        rows: () => rows,
        answer: async (input) => {
            calls.push(input);
            return answer(input);
        },
    };
    return { store, calls, deps: recorded };
}

const delivered: InboxAnswerResult = {
    session: "s-alpha",
    text: "3b",
    channel: "cmux",
    delivered: true,
    detail: "cmux",
};

describe("issueActTokens", () => {
    it("issues one token per option letter with the revision the button shows", async () => {
        const store = memoryActTokenStore();
        let next = 0;
        const issued = await issueActTokens({
            row: row(),
            surface: "telegram",
            store,
            now: NOW,
            newToken: () => `tok-${next++}`,
        });

        expect(issued).toEqual([
            { letter: "a", token: "tok-0" },
            { letter: "b", token: "tok-1" },
        ]);
        expect(store.tokens["tok-1"]).toMatchObject({ option: "b", revision: 2, expiresAt: NOW + ACT_TOKEN_TTL_MS });
        // No kind: a letter token reads the same as one stored before the kinds existed.
        expect(store.tokens["tok-1"].kind).toBeUndefined();
    });
});

describe("fileActTokenStore", () => {
    it("writes the token file owner-only, since a token answers without the dashboard login", async () => {
        const storage = new Storage("act-tokens-mode-test");
        await issueActTokens({ row: row(), surface: "telegram", store: fileActTokenStore(storage), now: NOW });

        expect(statSync(join(storage.getCacheDir(), "act-tokens.json")).mode & 0o777).toBe(0o600);
    });
});

describe("act with an unknown token", () => {
    it("refuses it without a write: the token file is never created", async () => {
        const storage = new Storage("act-unknown-token-test");
        const { deps: d, calls } = deps([row()], async () => delivered);

        const receipt = await act({
            token: "AAAAAAAAAAAAAAAAAAAAAA",
            key: "http:probe",
            deps: { ...d, store: fileActTokenStore(storage) },
            now: NOW,
        });

        expect(receipt.outcome).toMatchObject({ kind: "refused", code: "unknown-token" });
        expect(calls).toEqual([]);
        expect(existsSync(join(storage.getCacheDir(), "act-tokens.json"))).toBe(false);
    });
});

describe("issueActTokens on a row with no revision", () => {
    it("stores revision 1, so an act on the button carries it and a re-posted text refuses it", async () => {
        const { deps: d, calls, store } = deps([row({ revision: undefined })], async () => delivered);
        const [a] = await issueActTokens({
            row: row({ revision: undefined }),
            surface: "telegram",
            store: d.store,
            now: NOW,
        });

        await act({ token: a.token, key: "telegram:q-rev", deps: d, now: NOW + 1 });

        expect(store.tokens[a.token].revision).toBe(1);
        expect(calls[0]?.expectedRevision).toBe(1);
    });
});

describe("act", () => {
    it("answers through the door with the key as the delivery key, and a retry returns the first receipt", async () => {
        const { deps: d, calls } = deps([row()], async () => delivered);
        const [, b] = await issueActTokens({ row: row(), surface: "telegram", store: d.store, now: NOW });

        const first = await act({ token: b.token, key: "telegram:q1", deps: d, now: NOW + 1 });
        const retry = await act({ token: b.token, key: "telegram:q1", deps: d, now: NOW + 2 });

        expect(first.outcome).toEqual({ kind: "delivered", detail: "cmux" });
        expect(retry).toEqual(first);
        expect(calls).toEqual([
            {
                session: "s-alpha",
                number: 3,
                option: "b",
                expectedRevision: 2,
                provider: "claude",
                deliveryKey: "telegram:q1",
            },
        ]);
    });

    it("refuses an expired token without answering", async () => {
        const { deps: d, calls } = deps([row()], async () => delivered);
        const [a] = await issueActTokens({ row: row(), surface: "phone", store: d.store, now: NOW });

        const receipt = await act({ token: a.token, key: "k1", deps: d, now: NOW + ACT_TOKEN_TTL_MS + 1 });

        expect(receipt.outcome).toMatchObject({ kind: "refused", code: "expired" });
        expect(calls).toEqual([]);
    });

    it("refuses a closed decision without answering", async () => {
        const { deps: d, calls } = deps([row({ state: "sent" })], async () => delivered);
        const [a] = await issueActTokens({ row: row(), surface: "telegram", store: d.store, now: NOW });

        expect((await act({ token: a.token, key: "k1", deps: d, now: NOW })).outcome).toMatchObject({
            kind: "refused",
            code: "closed",
        });
        expect(calls).toEqual([]);
    });

    it("refuses an unknown token", async () => {
        const { deps: d } = deps([row()], async () => delivered);

        expect((await act({ token: "nope", key: "k1", deps: d, now: NOW })).outcome).toMatchObject({
            code: "unknown-token",
        });
    });

    it("maps the door's refusals and outcomes onto the closed set", async () => {
        const stale = deps([row()], async () => {
            throw new AnswerRefusedError("stale-revision", "DECISION 3 changed: the agent posted a new text");
        });
        const [a] = await issueActTokens({ row: row(), surface: "telegram", store: stale.store, now: NOW });
        expect((await act({ token: a.token, key: "k1", deps: stale.deps, now: NOW })).outcome).toMatchObject({
            code: "changed",
        });

        const queued = deps([row()], async () => ({ ...delivered, channel: "queued", delivered: false }));
        const [qa] = await issueActTokens({ row: row(), surface: "telegram", store: queued.store, now: NOW });
        expect((await act({ token: qa.token, key: "k2", deps: queued.deps, now: NOW })).outcome.kind).toBe("queued");

        const crashed = deps([row()], async () => {
            throw new Error("pane went away");
        });
        const [ca] = await issueActTokens({ row: row(), surface: "telegram", store: crashed.store, now: NOW });
        expect((await act({ token: ca.token, key: "k3", deps: crashed.deps, now: NOW })).outcome).toEqual({
            kind: "uncertain",
            detail: "pane went away",
        });
    });
});

describe("act with a reply token", () => {
    it("answers with the text, not a letter, and refuses an empty reply without claiming the key", async () => {
        const fixture = deps([row()], async () => delivered);
        const token = await issueReplyToken({
            row: row(),
            surface: "phone",
            store: fixture.store,
            now: NOW,
            newToken: () => "tok-reply",
        });

        const empty = await act({ token, key: "push:1:reply", deps: fixture.deps, text: "  ", now: NOW });
        expect(empty.outcome).toMatchObject({ kind: "refused", code: "invalid" });
        expect(fixture.calls).toEqual([]);

        const receipt = await act({
            token,
            key: "push:2:reply",
            deps: fixture.deps,
            text: "use the disk cache",
            now: NOW,
        });
        expect(receipt.outcome.kind).toBe("delivered");
        expect(fixture.calls).toHaveLength(1);
        expect(fixture.calls[0]).toMatchObject({ session: "s-alpha", number: 3, text: "use the disk cache" });
        expect(fixture.calls[0].option).toBeUndefined();
    });
});

/** A decision that takes several letters, its staged pick kept by a fake staging door the way the store keeps it. */
function several(overrides: Partial<DecisionRecord> = {}) {
    let current = row({ options: ["memory", "disk", "network"], multiple: true, ...overrides });
    const store = memoryActTokenStore();
    const staged: DraftInput[] = [];
    const answers: AnswerDecisionInput[] = [];
    const d: ActDeps = {
        store,
        rows: () => [current],
        answer: async (input) => {
            answers.push(input);
            return delivered;
        },
        stage: async (input) => {
            staged.push(input);
            const draftOption = input.option ?? "";
            current = { ...current, draftOption, state: draftOption ? "drafted" : "open" };
            return current;
        },
    };
    const keyboard = () => issueToggleTokens({ row: current, count: 3, surface: "telegram", store, now: NOW });
    return {
        deps: d,
        store,
        staged,
        answers,
        keyboard,
        set: (patch: Partial<DecisionRecord>) => {
            current = { ...current, ...patch };
        },
    };
}

describe("toggle and send tokens of a decision that takes several letters", () => {
    it("a toggle ticks its letter through the staging door at the token's revision, and a second press unticks it", async () => {
        const fixture = several();
        const { letters } = await fixture.keyboard();
        const [a, , c] = letters;

        const first = await press({ token: a.token, key: "telegram:t1", deps: fixture.deps, now: NOW });
        const second = await press({ token: c.token, key: "telegram:t2", deps: fixture.deps, now: NOW });
        const third = await press({ token: a.token, key: "telegram:t3", deps: fixture.deps, now: NOW });

        expect(first).toMatchObject({ outcome: { kind: "staged", option: "a" }, tokenKind: "toggle" });
        expect(second.outcome).toEqual({ kind: "staged", option: "ac" });
        expect(third.outcome).toEqual({ kind: "staged", option: "c" });
        expect(fixture.staged.map((input) => input.option)).toEqual(["a", "ac", "c"]);
        expect(fixture.staged[0]).toMatchObject({ session: "s-alpha", number: 3, expectedRevision: 2 });
        expect(fixture.answers).toEqual([]);
    });

    it("two presses at once both land when the door runs each read and write as one step", async () => {
        const fixture = several();
        const { letters } = await fixture.keyboard();
        const [a, , c] = letters;
        // The staging door takes a moment between the read and the write, as the file store does.
        const stage = fixture.deps.stage;
        fixture.deps.stage = async (input) => {
            await Bun.sleep(5);
            return stage?.(input);
        };
        let queue: Promise<unknown> = Promise.resolve();
        fixture.deps.exclusive = <T>(step: () => Promise<T>) => {
            const run = queue.then(step);
            queue = run.catch(() => undefined);
            return run;
        };

        await Promise.all([
            press({ token: a.token, key: "telegram:p1", deps: fixture.deps, now: NOW }),
            press({ token: c.token, key: "telegram:p2", deps: fixture.deps, now: NOW }),
        ]);

        expect(fixture.staged.map((input) => input.option)).toEqual(["a", "ac"]);
    });

    it("a retried callback id returns the first receipt and does not untick what the first delivery ticked", async () => {
        const fixture = several();
        const { letters } = await fixture.keyboard();

        const first = await press({ token: letters[1].token, key: "telegram:r1", deps: fixture.deps, now: NOW });
        const retry = await press({ token: letters[1].token, key: "telegram:r1", deps: fixture.deps, now: NOW + 1 });

        expect(retry).toEqual(first);
        expect(fixture.staged).toHaveLength(1);
    });

    it("send answers with the staged letters through the answer door, and refuses while nothing is ticked", async () => {
        const fixture = several();
        const { send } = await fixture.keyboard();

        const empty = await press({ token: send, key: "telegram:s1", deps: fixture.deps, now: NOW });
        expect(empty.outcome).toMatchObject({ kind: "refused", code: "invalid" });
        expect(fixture.answers).toEqual([]);

        fixture.set({ state: "drafted", draftOption: "ca" });
        const sent = await press({ token: send, key: "telegram:s2", deps: fixture.deps, now: NOW });

        expect(sent).toMatchObject({ outcome: { kind: "delivered" }, decision: { option: "ac" }, tokenKind: "send" });
        expect(fixture.answers).toEqual([
            {
                session: "s-alpha",
                number: 3,
                option: "ac",
                expectedRevision: 2,
                provider: "claude",
                deliveryKey: "telegram:s2",
            },
        ]);
    });

    it("a toggle after the decision closed, or after the agent re-posted it, refuses like an answer", async () => {
        const fixture = several();
        const { letters } = await fixture.keyboard();
        fixture.set({ state: "sent" });

        const closed = await press({ token: letters[0].token, key: "telegram:c1", deps: fixture.deps, now: NOW });
        expect(closed.outcome).toMatchObject({ kind: "refused", code: "closed" });
        expect(fixture.staged).toEqual([]);

        const reposted = several();
        const fresh = await reposted.keyboard();
        reposted.deps.stage = async () => {
            throw new AnswerRefusedError("stale-revision", "DECISION 3 changed: the agent posted a new text");
        };
        const changed = await press({
            token: fresh.letters[0].token,
            key: "telegram:c2",
            deps: reposted.deps,
            now: NOW,
        });
        expect(changed.outcome).toMatchObject({ kind: "refused", code: "changed" });
    });

    it("act refuses a toggle token without staging: only the Telegram keyboard ticks letters", async () => {
        const fixture = several();
        const { letters } = await fixture.keyboard();

        const receipt = await act({ token: letters[0].token, key: "http:x1", deps: fixture.deps, now: NOW });

        expect(receipt.outcome).toMatchObject({ kind: "refused", code: "invalid" });
        expect(fixture.staged).toEqual([]);
    });

    it("a reply that names only letters answers them as the option; a word, or a letter past the options, stays text", async () => {
        const fixture = several();
        const token = await issueReplyToken({ row: row(), surface: "phone", store: fixture.store, now: NOW });

        const letters = await act({ token, key: "push:1:reply", deps: fixture.deps, text: "a, c", now: NOW });
        await act({ token, key: "push:2:reply", deps: fixture.deps, text: "yes", now: NOW });
        await act({ token, key: "push:3:reply", deps: fixture.deps, text: "a d", now: NOW });

        expect(letters.decision?.option).toBe("ac");
        expect(fixture.answers.map((input) => [input.option, input.text])).toEqual([
            ["ac", undefined],
            [undefined, "yes"],
            [undefined, "a d"],
        ]);
    });

    it("a reply of letters to a single-choice decision stays text", async () => {
        const fixture = deps([row()], async () => delivered);
        const token = await issueReplyToken({ row: row(), surface: "phone", store: fixture.store, now: NOW });

        await act({ token, key: "push:1:reply", deps: fixture.deps, text: "a, b", now: NOW });

        expect(fixture.calls[0]).toMatchObject({ text: "a, b" });
        expect(fixture.calls[0].option).toBeUndefined();
    });
});

describe("replyLetters and toggledPick", () => {
    it("reads letters with separators or a rising run, and leaves words and repeats as text", () => {
        expect(["a d", "a, c", "ac", "c a", "a+c", "a and c", "A, C"].map((text) => replyLetters(text, 4))).toEqual([
            "ad",
            "ac",
            "ac",
            "ac",
            "ac",
            "ac",
            "ac",
        ]);
        expect(["bad", "yes", "add", "a, a", "a e", "", "a) yes"].map((text) => replyLetters(text, 4))).toEqual([
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
        ]);
    });

    it("adds a letter in letter order and takes out one that is there", () => {
        expect(toggledPick(undefined, "b")).toBe("b");
        expect(toggledPick("c", "a")).toBe("ac");
        expect(toggledPick("ac", "a")).toBe("c");
        expect(toggledPick("a", "a")).toBe("");
    });
});
