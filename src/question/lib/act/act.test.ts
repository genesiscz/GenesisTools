import { describe, expect, it } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Storage } from "@genesiscz/utils/storage/storage";
import { AnswerRefusedError } from "../decisions/answers";
import type { DecisionRecord } from "../decisions/store";
import type { AnswerDecisionInput, InboxAnswerResult } from "../inbox/answer";
import { type ActDeps, act } from "./act";
import { ACT_TOKEN_TTL_MS, fileActTokenStore, issueActTokens, issueReplyToken, memoryActTokenStore } from "./tokens";

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
