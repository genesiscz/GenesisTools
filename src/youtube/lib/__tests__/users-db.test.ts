import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AskCitation } from "@app/youtube/lib/qa.types";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { InsufficientCreditsError } from "@app/youtube/lib/users.types";

let db: YoutubeDatabase;

beforeEach(() => {
    db = new YoutubeDatabase(":memory:");
});

afterEach(() => {
    db.close();
});

function createTestUser(email = "user@example.com") {
    return db.createUser({ email, passwordHash: "hash", apiToken: `ytu_${email}` });
}

describe("YoutubeDatabase users", () => {
    it("creates the users, credit_ledger and qa_history tables", () => {
        const tables = db
            .getDb()
            .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .all() as Array<{ name: string }>;
        const names = tables.map((table) => table.name);

        expect(names).toContain("users");
        expect(names).toContain("credit_ledger");
        expect(names).toContain("qa_history");
    });

    it("createUser starts at 0 credits (grant goes through the ledger)", () => {
        const user = createTestUser();

        expect(user.id).toBeGreaterThan(0);
        expect(user.email).toBe("user@example.com");
        expect(user.credits).toBe(0);
        expect(user.createdAt).toMatch(/Z$/);
    });

    it("getUserByEmail returns secrets, getUserByToken does not", () => {
        createTestUser();
        const byEmail = db.getUserByEmail("user@example.com");
        const byToken = db.getUserByToken("ytu_user@example.com");

        expect(byEmail?.passwordHash).toBe("hash");
        expect(byEmail?.apiToken).toBe("ytu_user@example.com");
        expect(byToken?.email).toBe("user@example.com");
        expect(byToken && "passwordHash" in byToken).toBe(false);
    });

    it("email lookup is case-insensitive and duplicate emails are rejected", () => {
        createTestUser("User@Example.com");

        expect(db.getUserByEmail("user@example.com")?.email).toBe("User@Example.com");
        expect(() => db.createUser({ email: "USER@EXAMPLE.COM", passwordHash: "x", apiToken: "ytu_other" })).toThrow();
    });

    it("getUserByToken returns null for unknown tokens", () => {
        expect(db.getUserByToken("ytu_nope")).toBeNull();
    });

    it("touchUserLogin stamps last_login_at", () => {
        const user = createTestUser();
        db.touchUserLogin(user.id);
        const row = db
            .getDb()
            .query("SELECT last_login_at FROM users WHERE id = ?")
            .get(user.id) as { last_login_at: string | null };

        expect(row.last_login_at).toMatch(/Z$/);
    });
});

describe("YoutubeDatabase credits", () => {
    it("grantCredits and spendCredits update the balance and ledger", () => {
        const user = createTestUser();

        expect(db.grantCredits(user.id, 100, "register-grant")).toBe(100);
        expect(db.spendCredits(user.id, 5, "ask")).toBe(95);

        const ledger = db
            .getDb()
            .query("SELECT delta, reason, balance_after FROM credit_ledger WHERE user_id = ? ORDER BY id")
            .all(user.id) as Array<{ delta: number; reason: string; balance_after: number }>;

        expect(ledger).toEqual([
            { delta: 100, reason: "register-grant", balance_after: 100 },
            { delta: -5, reason: "ask", balance_after: 95 },
        ]);
    });

    it("ledger deltas always sum to the balance", () => {
        const user = createTestUser();
        db.grantCredits(user.id, 100, "register-grant");
        db.spendCredits(user.id, 10, "summary:long");
        db.grantCredits(user.id, 100, "dev-topup");

        const sum = db
            .getDb()
            .query("SELECT SUM(delta) AS sum FROM credit_ledger WHERE user_id = ?")
            .get(user.id) as { sum: number };

        expect(sum.sum).toBe(190);
        expect(db.getUserByToken(`ytu_${user.email}`)?.credits).toBe(190);
    });

    it("spendCredits throws InsufficientCreditsError without touching balance or ledger", () => {
        const user = createTestUser();
        db.grantCredits(user.id, 4, "dev-topup");

        expect(() => db.spendCredits(user.id, 5, "ask")).toThrow(InsufficientCreditsError);

        try {
            db.spendCredits(user.id, 5, "ask");
        } catch (error) {
            expect(error).toBeInstanceOf(InsufficientCreditsError);
            expect((error as InsufficientCreditsError).balance).toBe(4);
            expect((error as InsufficientCreditsError).required).toBe(5);
        }

        const ledgerCount = db
            .getDb()
            .query("SELECT COUNT(*) AS count FROM credit_ledger WHERE user_id = ? AND delta < 0")
            .get(user.id) as { count: number };

        expect(ledgerCount.count).toBe(0);
        expect(db.getUserByEmail(user.email)?.credits).toBe(4);
    });

    it("grantCredits throws for an unknown user", () => {
        expect(() => db.grantCredits(999, 100, "dev-topup")).toThrow("user 999 not found");
    });
});

describe("YoutubeDatabase qa history", () => {
    const citations: AskCitation[] = [{ videoId: "vid1", chunkIdx: 0, startSec: 12.5, endSec: 30 }];

    it("insertQaHistory round-trips citations and metadata", () => {
        const user = createTestUser();
        const item = db.insertQaHistory({
            userId: user.id,
            videoId: "vid1",
            question: "What is discussed?",
            answer: "Something **important**.",
            citations,
            creditsSpent: 5,
        });

        expect(item.id).toBeGreaterThan(0);
        expect(item.videoId).toBe("vid1");
        expect(item.citations).toEqual(citations);
        expect(item.creditsSpent).toBe(5);
        expect(item.createdAt).toMatch(/Z$/);
    });

    it("listQaHistory returns newest first, scoped by user and video", () => {
        const alice = createTestUser("alice@example.com");
        const bob = createTestUser("bob@example.com");
        db.insertQaHistory({ userId: alice.id, videoId: "v1", question: "q1", answer: "a1", citations: [], creditsSpent: 5 });
        db.insertQaHistory({ userId: alice.id, videoId: "v2", question: "q2", answer: "a2", citations: [], creditsSpent: 5 });
        db.insertQaHistory({ userId: alice.id, videoId: "v1", question: "q3", answer: "a3", citations: [], creditsSpent: 5 });
        db.insertQaHistory({ userId: bob.id, videoId: "v1", question: "bob-q", answer: "bob-a", citations: [], creditsSpent: 5 });

        const all = db.listQaHistory(alice.id);
        const v1Only = db.listQaHistory(alice.id, "v1");

        expect(all.map((item) => item.question)).toEqual(["q3", "q2", "q1"]);
        expect(v1Only.map((item) => item.question)).toEqual(["q3", "q1"]);
    });

    it("listQaHistory respects the limit", () => {
        const user = createTestUser();

        for (let i = 0; i < 5; i++) {
            db.insertQaHistory({ userId: user.id, videoId: "v1", question: `q${i}`, answer: "a", citations: [], creditsSpent: 5 });
        }

        expect(db.listQaHistory(user.id, undefined, 2).map((item) => item.question)).toEqual(["q4", "q3"]);
    });
});
