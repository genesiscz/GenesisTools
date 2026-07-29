import { beforeEach, describe, expect, it } from "bun:test";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { getRequestContext } from "@app/youtube/lib/request-context";
import {
    CONSOLE_CREDIT_GRANT,
    CONSOLE_USER_EMAIL,
    getOrCreateConsoleUser,
    withConsoleContext,
} from "@app/youtube/lib/service-user";

let db: YoutubeDatabase;

beforeEach(() => {
    db = new YoutubeDatabase(":memory:");
    db.initSchemaForTest();
});

describe("console service account", () => {
    it("creates the account once and returns the same row afterwards", async () => {
        const first = await getOrCreateConsoleUser(db);
        const second = await getOrCreateConsoleUser(db);

        expect(first.email).toBe(CONSOLE_USER_EMAIL);
        expect(second.id).toBe(first.id);
    });

    it("grants the standing balance through the ledger so credits reconcile", async () => {
        const user = await getOrCreateConsoleUser(db);

        expect(user.credits).toBe(CONSOLE_CREDIT_GRANT);
        expect(db.getUserByEmail(CONSOLE_USER_EMAIL)?.credits).toBe(CONSOLE_CREDIT_GRANT);
    });

    it("issues a ytu_-prefixed token, since auth resolves users only by that prefix", async () => {
        await getOrCreateConsoleUser(db);
        const stored = db.getUserByEmail(CONSOLE_USER_EMAIL);

        expect(stored?.apiToken.startsWith("ytu_")).toBe(true);
        expect(db.getUserByToken(stored?.apiToken ?? "")?.email).toBe(CONSOLE_USER_EMAIL);
    });

    it("exposes the console user as ambient request context, so usage lands in ai_calls", async () => {
        expect(getRequestContext()).toBeUndefined();

        const seen = await withConsoleContext(db, async (user) => {
            const ctx = getRequestContext();

            expect(ctx?.userId).toBe(user.id);

            return ctx?.userId;
        });

        expect(seen).toBeGreaterThan(0);
        expect(getRequestContext()).toBeUndefined();
    });

    it("owns its ask sessions and keeps them invisible to other users", async () => {
        const user = await getOrCreateConsoleUser(db);
        const session = db.createAskSession({
            userId: user.id,
            title: "bridgemind",
            scopeKind: "channel",
            scopeValue: "@bridgemindai",
            videoIds: ["abc12345678"],
        });

        expect(db.getAskSession(user.id, session.id)?.title).toBe("bridgemind");
        expect(db.getAskSession(user.id + 1, session.id)).toBeNull();
        expect(db.getAskSessionByTitle(user.id, "bridgemind")?.id).toBe(session.id);
    });
});
