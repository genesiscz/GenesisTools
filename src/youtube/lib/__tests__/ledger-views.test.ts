import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { getLedgerPage, getUsageSummary, ledgerReasonGroup } from "@app/youtube/lib/ledger-views";

describe("ledgerReasonGroup", () => {
    const cases: Array<[string, string]> = [
        ["ask", "ask"],
        ["register-grant", "register-grant"],
        ["dev-topup", "dev-topup"],
        ["summary:long", "summary"],
        ["summary:timestamped", "summary"],
        ["summary:short", "summary"],
        ["stripe:cs_test_123", "stripe"],
        ["stripe-refund:ch_test_456", "stripe-refund"],
        ["reuse:summary:long:abc", "reuse"],
    ];

    for (const [reason, expected] of cases) {
        it(`groups "${reason}" as "${expected}"`, () => {
            expect(ledgerReasonGroup(reason)).toBe(expected);
        });
    }
});

describe("ledger-views", () => {
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

    describe("getUsageSummary", () => {
        it("returns exactly 30 zero-filled days, oldest first, ending today", () => {
            const user = createTestUser();
            db.grantCredits(user.id, 100, "register-grant");

            const summary = getUsageSummary(db, user.id);

            expect(summary.days).toHaveLength(30);
            const todayUtc = new Date().toISOString().slice(0, 10);
            expect(summary.days[summary.days.length - 1].date).toBe(todayUtc);
            // dates strictly ascending
            for (let i = 1; i < summary.days.length; i++) {
                expect(summary.days[i].date > summary.days[i - 1].date).toBe(true);
            }
        });

        it("buckets spent/earned per day and groups byReason correctly", () => {
            const user = createTestUser();
            db.grantCredits(user.id, 100, "register-grant");
            db.spendCredits(user.id, 5, "ask");
            db.spendCredits(user.id, 10, "summary:long");
            db.spendCredits(user.id, 5, "summary:short");
            db.grantCredits(user.id, 2000, "stripe:cs_abc");

            const summary = getUsageSummary(db, user.id);
            const todayUtc = new Date().toISOString().slice(0, 10);
            const today = summary.days.find((d) => d.date === todayUtc);

            expect(today?.spent).toBe(20);
            expect(today?.earned).toBe(2100);

            const byReasonMap = Object.fromEntries(summary.byReason.map((r) => [r.reason, r]));
            expect(byReasonMap["register-grant"]).toEqual({ reason: "register-grant", spent: 0, count: 1 });
            expect(byReasonMap.ask).toEqual({ reason: "ask", spent: 5, count: 1 });
            expect(byReasonMap.summary).toEqual({ reason: "summary", spent: 15, count: 2 });
            expect(byReasonMap.stripe).toEqual({ reason: "stripe", spent: 0, count: 1 });

            expect(summary.month.spent).toBe(20);
            expect(summary.month.earned).toBe(2100);
        });

        it("ignores other users' ledger rows", () => {
            const userA = createTestUser("a@example.com");
            const userB = createTestUser("b@example.com");
            db.grantCredits(userA.id, 100, "register-grant");
            db.grantCredits(userB.id, 100, "register-grant");
            db.spendCredits(userB.id, 50, "ask");

            const summaryA = getUsageSummary(db, userA.id);
            const byReasonA = Object.fromEntries(summaryA.byReason.map((r) => [r.reason, r]));

            expect(byReasonA.ask).toBeUndefined();
        });
    });

    describe("getLedgerPage", () => {
        it("paginates newest-first with a stable keyset when a row is inserted between pages", () => {
            const user = createTestUser();
            db.grantCredits(user.id, 100, "register-grant");

            for (let i = 0; i < 5; i++) {
                db.spendCredits(user.id, 1, "ask");
            }

            const firstPage = getLedgerPage(db, user.id, { limit: 3 });
            expect(firstPage.rows).toHaveLength(3);
            expect(firstPage.rows.map((r) => r.reason)).toEqual(["ask", "ask", "ask"]);
            expect(firstPage.nextBefore).not.toBeNull();

            // A new row lands between page 1 and page 2 — keyset pagination
            // (WHERE id < before) must not skip or duplicate existing rows.
            db.spendCredits(user.id, 1, "ask");

            const secondPage = getLedgerPage(db, user.id, { limit: 3, before: firstPage.nextBefore ?? undefined });
            expect(secondPage.rows).toHaveLength(3);

            const firstPageIds = new Set(firstPage.rows.map((r) => r.id));
            for (const row of secondPage.rows) {
                expect(firstPageIds.has(row.id)).toBe(false);
            }
        });

        it("nextBefore is null on the last page", () => {
            const user = createTestUser();
            db.grantCredits(user.id, 100, "register-grant");

            const page = getLedgerPage(db, user.id, { limit: 50 });
            expect(page.nextBefore).toBeNull();
        });

        it("resolves ask context via the nearest qa_history row within 2s, tolerating a miss", () => {
            const user = createTestUser();
            db.grantCredits(user.id, 100, "register-grant");
            db.insertQaHistory({
                userId: user.id,
                videoId: "vid123",
                question: "What is the thesis?",
                answer: "It's about X.",
                citations: [],
                creditsSpent: 5,
            });
            db.spendCredits(user.id, 5, "ask");
            // A summary spend has no qa_history counterpart at all.
            db.spendCredits(user.id, 10, "summary:long");

            const page = getLedgerPage(db, user.id);
            const askRow = page.rows.find((r) => r.reason === "ask");
            const summaryRow = page.rows.find((r) => r.reason === "summary:long");

            expect(askRow?.context).toBe("What is the thesis?");
            expect(summaryRow?.context).toBeNull();
        });
    });
});
