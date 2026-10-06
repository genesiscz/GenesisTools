import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { InsufficientCreditsError } from "@app/youtube/lib/users.types";

let db: YoutubeDatabase;

beforeEach(() => {
    db = new YoutubeDatabase(":memory:");
});

afterEach(() => {
    db.close();
});

function createFundedUser(credits = 100, email = "holds@example.com") {
    const user = db.createUser({ email, passwordHash: "hash", apiToken: `ytu_${email}` });
    db.grantCredits(user.id, credits, "register-grant");
    return user;
}

function balanceOf(userId: number): number {
    const row = db.getDb().query("SELECT credits FROM users WHERE id = ?").get(userId) as { credits: number };
    return row.credits;
}

function lastLedgerRow(userId: number) {
    return db
        .getDb()
        .query("SELECT reason, delta, balance_after FROM credit_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 1")
        .get(userId) as { reason: string; delta: number; balance_after: number };
}

describe("reserveCredits", () => {
    it("decrements the balance and records a held hold with a hold: ledger row", () => {
        const user = createFundedUser();
        const reserved = db.reserveCredits({ userId: user.id, amount: 10, reason: "summary:long", context: "vid1" });

        expect(reserved.credits).toBe(90);
        expect(balanceOf(user.id)).toBe(90);

        const hold = db.getCreditHold(reserved.holdId);
        expect(hold?.status).toBe("held");
        expect(hold?.amount).toBe(10);
        expect(hold?.reason).toBe("summary:long");
        expect(hold?.context).toBe("vid1");
        expect(hold?.resolvedAt).toBeNull();

        const ledger = lastLedgerRow(user.id);
        expect(ledger.reason).toBe("hold:summary:long:vid1");
        expect(ledger.delta).toBe(-10);
        expect(ledger.balance_after).toBe(90);
    });

    it("throws InsufficientCreditsError and leaves no hold nor ledger row", () => {
        const user = createFundedUser(5);

        expect(() => db.reserveCredits({ userId: user.id, amount: 10, reason: "summary:long" })).toThrow(
            InsufficientCreditsError
        );
        expect(balanceOf(user.id)).toBe(5);
        expect(lastLedgerRow(user.id).reason).toBe("register-grant");

        const holds = db.getDb().query("SELECT COUNT(*) AS n FROM credit_holds").get() as { n: number };
        expect(holds.n).toBe(0);
    });

    it("a second reserve over an exhausted balance is rejected", () => {
        const user = createFundedUser(10);

        db.reserveCredits({ userId: user.id, amount: 10, reason: "ask" });
        expect(() => db.reserveCredits({ userId: user.id, amount: 10, reason: "ask" })).toThrow(
            InsufficientCreditsError
        );
        expect(balanceOf(user.id)).toBe(0);
    });
});

describe("commitHold", () => {
    it("keeps the money spent and rewrites the ledger reason to the final reason", () => {
        const user = createFundedUser();
        const reserved = db.reserveCredits({ userId: user.id, amount: 10, reason: "summary:long", context: "vid1" });

        db.commitHold(reserved.holdId);

        expect(balanceOf(user.id)).toBe(90);
        expect(db.getCreditHold(reserved.holdId)?.status).toBe("committed");
        expect(db.getCreditHold(reserved.holdId)?.resolvedAt).not.toBeNull();

        const ledger = lastLedgerRow(user.id);
        expect(ledger.reason).toBe("summary:long");
        expect(ledger.delta).toBe(-10);
        expect(ledger.balance_after).toBe(90);
    });

    it("throws on a hold that is not held", () => {
        const user = createFundedUser();
        const reserved = db.reserveCredits({ userId: user.id, amount: 10, reason: "ask" });
        db.commitHold(reserved.holdId);

        expect(() => db.commitHold(reserved.holdId)).toThrow('is committed, expected "held"');
        expect(() => db.commitHold(999)).toThrow('is missing, expected "held"');
    });
});

describe("releaseHold", () => {
    it("refunds the amount with a hold-release: ledger row", () => {
        const user = createFundedUser();
        const reserved = db.reserveCredits({ userId: user.id, amount: 10, reason: "summary:long", context: "vid1" });

        const credits = db.releaseHold(reserved.holdId);

        expect(credits).toBe(100);
        expect(balanceOf(user.id)).toBe(100);
        expect(db.getCreditHold(reserved.holdId)?.status).toBe("released");

        const ledger = lastLedgerRow(user.id);
        expect(ledger.reason).toBe("hold-release:summary:long:vid1");
        expect(ledger.delta).toBe(10);
        expect(ledger.balance_after).toBe(100);
    });

    it("throws on a hold that is not held", () => {
        const user = createFundedUser();
        const reserved = db.reserveCredits({ userId: user.id, amount: 10, reason: "ask" });
        db.releaseHold(reserved.holdId);

        expect(() => db.releaseHold(reserved.holdId)).toThrow('is released, expected "held"');
    });

    it("cannot double-settle: committing then releasing (or vice versa) throws", () => {
        const user = createFundedUser();
        const committed = db.reserveCredits({ userId: user.id, amount: 10, reason: "ask" });
        db.commitHold(committed.holdId);

        expect(() => db.releaseHold(committed.holdId)).toThrow('is committed, expected "held"');
        expect(balanceOf(user.id)).toBe(90);
    });
});

describe("releaseStaleHolds", () => {
    it("refunds every held hold and leaves resolved ones alone", () => {
        const user = createFundedUser();
        const orphanA = db.reserveCredits({ userId: user.id, amount: 10, reason: "summary:long" });
        const orphanB = db.reserveCredits({ userId: user.id, amount: 5, reason: "ask" });
        const committed = db.reserveCredits({ userId: user.id, amount: 5, reason: "transcript:translate" });
        db.commitHold(committed.holdId);
        expect(balanceOf(user.id)).toBe(80);

        const released = db.releaseStaleHolds();

        expect(released).toBe(2);
        expect(balanceOf(user.id)).toBe(95);
        expect(db.getCreditHold(orphanA.holdId)?.status).toBe("released");
        expect(db.getCreditHold(orphanB.holdId)?.status).toBe("released");
        expect(db.getCreditHold(committed.holdId)?.status).toBe("committed");
    });

    it("is a no-op when nothing is held", () => {
        expect(db.releaseStaleHolds()).toBe(0);
    });
});

describe("reconcileJobCreditHolds", () => {
    it("preserves a pending job reservation across reopen and releases only orphaned or terminal holds", () => {
        const dbPath = join(mkdtempSync(join(tmpdir(), "youtube-hold-recovery-")), "youtube.db");
        let reopened = new YoutubeDatabase(dbPath);
        const user = reopened.createUser({ email: "queue@example.com", passwordHash: "hash", apiToken: "ytu_queue" });
        reopened.grantCredits(user.id, 100, "register-grant");
        const pending = reopened.reserveCredits({ userId: user.id, amount: 10, reason: "ask" });
        const pendingJob = reopened.enqueueJob({
            targetKind: "video",
            target: "vidPending1",
            stages: ["qa"],
            userId: user.id,
            params: { holdId: pending.holdId, question: "What?" },
        }).job;
        const owner = reopened
            .getDb()
            .query<{ credit_hold_id: number | null }, [number]>("SELECT credit_hold_id FROM jobs WHERE id = ?")
            .get(pendingJob.id);
        expect(owner?.credit_hold_id).toBe(pending.holdId);
        const interrupted = reopened.reserveCredits({ userId: user.id, amount: 10, reason: "ask" });
        const interruptedJob = reopened.enqueueJob({
            targetKind: "video",
            target: "vidRunning01",
            stages: ["qa"],
            userId: user.id,
            params: { holdId: interrupted.holdId, question: "What?" },
        }).job;
        reopened.getDb().run("UPDATE jobs SET status = 'running' WHERE id = ?", [interruptedJob.id]);
        reopened.close();

        reopened = new YoutubeDatabase(dbPath);
        expect(reopened.reconcileJobCreditHolds()).toEqual({ preserved: 2, released: 0 });
        expect(reopened.getCreditHold(pending.holdId)?.status).toBe("held");
        expect(reopened.getCreditHold(interrupted.holdId)?.status).toBe("held");
        expect(reopened.markInterruptedJobsForRequeue()).toBe(1);
        reopened.commitHold(pending.holdId);
        reopened.commitHold(interrupted.holdId);
        expect(reopened.getCreditHold(pending.holdId)?.status).toBe("committed");

        const orphan = reopened.reserveCredits({ userId: user.id, amount: 5, reason: "ask" });
        const terminal = reopened.reserveCredits({ userId: user.id, amount: 5, reason: "ask" });
        const terminalJob = reopened.enqueueJob({
            targetKind: "video",
            target: "vidFailed001",
            stages: ["qa"],
            userId: user.id,
            params: { holdId: terminal.holdId, question: "What?" },
        }).job;
        reopened.getDb().run("UPDATE jobs SET status = 'failed' WHERE id = ?", [terminalJob.id]);

        expect(reopened.reconcileJobCreditHolds()).toEqual({ preserved: 0, released: 2 });
        expect(reopened.getCreditHold(orphan.holdId)?.status).toBe("released");
        expect(reopened.getCreditHold(terminal.holdId)?.status).toBe("released");
        expect(reopened.reconcileJobCreditHolds()).toEqual({ preserved: 0, released: 0 });
        const balance = reopened
            .getDb()
            .query<{ credits: number }, [number]>("SELECT credits FROM users WHERE id = ?")
            .get(user.id);
        expect(balance?.credits).toBe(80);
        reopened.close();
    });
});
