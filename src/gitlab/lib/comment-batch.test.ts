import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    appendLedger,
    isDuplicate,
    type LedgerEntry,
    ledgerFor,
    ledgerIdentity,
    legacyLedgerFor,
    readLedger,
} from "./comment-batch";

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

describe("GitLab comment receipts written with identity", () => {
    test("a receipt written from a resolved identity is found again by ledgerFor", async () => {
        let projectReads = 0;
        const server = Bun.serve({
            port: 0,
            fetch: () => {
                projectReads++;
                return Response.json({ id: 101 });
            },
        });

        try {
            const api = { host: `http://127.0.0.1:${server.port}/`, token: "t", project: "group/app" };
            const identity = await ledgerIdentity(api);
            const path = join(mkdtempSync(join(tmpdir(), "gt-comment-ledger-")), "comment-batch.jsonl");
            appendLedger(
                { ...identity, project: api.project, pr: "12", comment_id: 500, message: "Reviewed", ts: "t" },
                path
            );

            expect(identity).toEqual({ host: `http://127.0.0.1:${server.port}`, projectId: 101 });
            expect(ledgerFor(readLedger(path), { ...identity, iid: 12 }).map((e) => e.comment_id)).toEqual([500]);
            await ledgerIdentity(api);
            expect(projectReads).toBe(1);
        } finally {
            server.stop(true);
        }
    });

    test("legacyLedgerFor returns only hostless rows of the same project path and MR", () => {
        const legacy = receipt({ host: undefined, projectId: undefined });
        const ledger = [
            receipt(),
            legacy,
            receipt({ host: undefined, projectId: undefined, project: "group/other" }),
            receipt({ host: undefined, projectId: undefined, pr: "13" }),
        ];

        expect(legacyLedgerFor(ledger, { project: "group/app", iid: 12 })).toEqual([legacy]);
    });
});
