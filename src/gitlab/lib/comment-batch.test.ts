import { describe, expect, test } from "bun:test";
import { isDuplicate, type LedgerEntry } from "./comment-batch";

function receipt(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
    return {
        host: "https://forge-a.example",
        projectId: 101,
        project: "group/app",
        pr: "12",
        comment_id: 500,
        message: "Reviewed",
        ts: "2026-10-06T00:00:00.000Z",
        ...overrides,
    };
}

describe("GitLab batch comment identity", () => {
    test("does not suppress the same project path, iid and message on another host", () => {
        const ledger = [receipt()];

        expect(
            isDuplicate(ledger, {
                host: "https://forge-b.example",
                projectId: 101,
                iid: "12",
                message: "Reviewed",
            })
        ).toBe(false);
    });

    test("deduplicates path and numeric aliases after both resolve to the same project id", () => {
        const ledger = [receipt({ project: "101" })];

        expect(
            isDuplicate(ledger, {
                host: "forge-a.example/",
                projectId: 101,
                iid: "12",
                message: "Reviewed",
            })
        ).toBe(true);
    });

    test("does not assign a legacy hostless receipt to the current host", () => {
        const ledger = [receipt({ host: undefined, projectId: undefined })];

        expect(
            isDuplicate(ledger, {
                host: "https://forge-a.example",
                projectId: 101,
                iid: "12",
                message: "Reviewed",
            })
        ).toBe(false);
    });
});
