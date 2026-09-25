import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    listProposals,
    ProposalError,
    parseProposal,
    proposalFor,
    proposalKey,
    proposalMarkdown,
    saveProposal,
} from "./proposal";

function input(overrides: Record<string, unknown> = {}) {
    return {
        provider: "gitlab",
        host: "gitlab.example.com",
        project: "group/app",
        number: 42,
        title: "Invented MR",
        baseSha: "aaa",
        headSha: "bbb",
        author: { agent: "claude" },
        verdict: { decision: "request_changes", summary: "Two blockers.", confidence: 80 },
        drafts: [
            {
                id: "d1",
                path: "src/a.ts",
                line: 12,
                severity: "blocker",
                body: "This resets every observer.",
                meta: { verdict: "Race on reset", proof: "src/a.ts:12 runs before the POST resolves", confidence: 70 },
                status: "posted",
            },
        ],
        ...overrides,
    };
}

describe("review proposal", () => {
    test("parses input and never trusts a status from the agent", () => {
        const proposal = parseProposal(input());

        expect(proposal.drafts[0]?.status).toBe("proposed");
        expect(proposal.drafts[0]?.side).toBe("additions");
        expect(proposalKey(proposal)).toMatch(/^gitlab__gitlab\.example\.com-group-app-[0-9a-f]{1,8}__42$/);
    });

    test("keeps projects whose slugs collide in separate keys", () => {
        const dashed = parseProposal(input({ project: "group/a-b" }));
        const nested = parseProposal(input({ project: "group/a/b" }));

        expect(proposalKey(dashed)).not.toBe(proposalKey(nested));
    });

    test("rejects a misspelled side, a non-array drafts or threads value, and a thread on line zero", () => {
        const draft = { path: "a", line: 1, body: "x", meta: { verdict: "v" } };

        expect(() => parseProposal(input({ drafts: [{ ...draft, side: "deletion" }] }))).toThrow(
            "drafts[0].side must be one of additions, deletions"
        );
        expect(parseProposal(input({ drafts: [{ ...draft, side: "deletions" }] })).drafts[0]?.side).toBe("deletions");
        expect(() => parseProposal(input({ drafts: { d1: draft } }))).toThrow("drafts must be an array");
        expect(() => parseProposal(input({ drafts: null }))).toThrow("drafts must be an array");
        expect(parseProposal(input({ drafts: [] })).drafts).toEqual([]);
        expect(parseProposal(input({ drafts: undefined })).drafts).toEqual([]);
        expect(() => parseProposal(input({ threads: {} }))).toThrow("threads must be an array");
        expect(() => parseProposal(input({ threads: [{ threadId: "t1", line: 0, verdict: "valid" }] }))).toThrow(
            "threads[0].line must be a positive integer"
        );
    });

    test("rejects a draft without a meta verdict, a bad severity, or a duplicate id", () => {
        const noMeta = input({ drafts: [{ path: "a", line: 1, body: "x", meta: {} }] });
        const badSeverity = input({
            drafts: [{ path: "a", line: 1, body: "x", severity: "huge", meta: { verdict: "v" } }],
        });
        const twice = input({
            drafts: [
                { id: "same", path: "a", line: 1, body: "x", meta: { verdict: "v" } },
                { id: "same", path: "b", line: 2, body: "y", meta: { verdict: "v" } },
            ],
        });

        expect(() => parseProposal(noMeta)).toThrow(ProposalError);
        expect(() => parseProposal(badSeverity)).toThrow(ProposalError);
        expect(() => parseProposal(twice)).toThrow(ProposalError);
    });

    test("rejects a draft on line zero, because diff lines are 1-based", () => {
        const lineZero = input({ drafts: [{ path: "a", line: 0, body: "x", meta: { verdict: "v" } }] });
        const startZero = input({
            drafts: [{ path: "a", line: 3, startLine: 0, body: "x", meta: { verdict: "v" } }],
        });

        expect(() => parseProposal(lineZero)).toThrow("drafts[0].line must be a positive integer");
        expect(() => parseProposal(startZero)).toThrow("drafts[0].startLine must be a positive integer");
        expect(
            parseProposal(input({ verdict: { decision: "comment", summary: "s", confidence: 0 } })).verdict
        ).toBeDefined();
    });

    test("a second push keeps what was decided in the window and adds new drafts as proposed", async () => {
        const base = mkdtempSync(join(tmpdir(), "review-proposal-"));
        const first = await saveProposal(parseProposal(input()), base);
        const stored = SafeJSON.parse(readFileSync(first.path, "utf8"));
        stored.drafts[0].status = "edited";
        stored.drafts[0].editedBody = "Martin's wording";
        await Bun.write(first.path, SafeJSON.stringify(stored));

        const again = input({
            drafts: [
                ...input().drafts,
                { id: "d2", path: "src/b.ts", line: 3, body: "nit", severity: "nit", meta: { verdict: "naming" } },
            ],
        });
        const second = await saveProposal(parseProposal(again), base);
        const [saved] = listProposals(base);

        expect(second.kept).toBe(1);
        expect(saved?.drafts.map((draft) => draft.status)).toEqual(["edited", "proposed"]);
        expect(saved?.drafts[0]?.editedBody).toBe("Martin's wording");
    });

    test("a draft without an id keeps its decision when another draft is inserted before it", async () => {
        const base = mkdtempSync(join(tmpdir(), "review-proposal-"));
        const later = { path: "src/b.ts", line: 3, body: "nit", severity: "nit", meta: { verdict: "naming" } };
        const first = await saveProposal(parseProposal(input({ drafts: [later] })), base);
        const stored = SafeJSON.parse(readFileSync(first.path, "utf8"));
        stored.drafts[0].status = "rejected";
        writeFileSync(first.path, SafeJSON.stringify(stored));

        const inserted = { path: "src/a.ts", line: 1, body: "new finding", meta: { verdict: "new" } };
        const second = await saveProposal(parseProposal(input({ drafts: [inserted, later] })), base);
        const [saved] = listProposals(base);

        expect(second.kept).toBe(1);
        expect(saved?.drafts.map((draft) => [draft.body, draft.status])).toEqual([
            ["new finding", "proposed"],
            ["nit", "rejected"],
        ]);
    });

    test("list skips a stored file that is valid JSON but not a proposal", async () => {
        const base = mkdtempSync(join(tmpdir(), "review-proposal-"));
        const saved = await saveProposal(parseProposal(input()), base);
        writeFileSync(join(base, "proposals", "empty.json"), "{}");
        writeFileSync(join(base, "proposals", "null.json"), "null");

        expect(listProposals(base).map((item) => proposalKey(item))).toEqual([saved.key]);
    });

    test("a push onto a stored file that is not a proposal is refused and leaves the file alone", async () => {
        const base = mkdtempSync(join(tmpdir(), "review-proposal-"));
        const saved = await saveProposal(parseProposal(input()), base);
        writeFileSync(saved.path, "{}");

        await expect(saveProposal(parseProposal(input()), base)).rejects.toThrow(ProposalError);
        expect(readFileSync(saved.path, "utf8")).toBe("{}");
    });

    test("a push waits for the window's lock (a bare pid, as the Swift side writes it) and takes over a dead one", async () => {
        const base = mkdtempSync(join(tmpdir(), "review-proposal-"));
        const saved = await saveProposal(parseProposal(input()), base);
        const lock = `${saved.path}.lock`;
        writeFileSync(lock, `${process.pid}\n`);
        let done = false;
        const pending = saveProposal(parseProposal(input({ title: "Second push" })), base).then(() => {
            done = true;
        });
        await Bun.sleep(200);

        expect(done).toBe(false);
        unlinkSync(lock);
        await pending;
        expect(listProposals(base)[0]?.title).toBe("Second push");

        writeFileSync(lock, "999999999\n");
        await saveProposal(parseProposal(input({ title: "Third push" })), base);
        expect(listProposals(base)[0]?.title).toBe("Third push");
    });

    test("markdown goes through json2md and shows the edited text", () => {
        const proposal = parseProposal(input());
        proposal.drafts[0] = { ...proposal.drafts[0]!, status: "edited", editedBody: "Better wording" };
        const markdown = proposalMarkdown(proposal);

        expect(markdown).toContain("# !42 Invented MR");
        expect(markdown).toContain("Better wording");
        expect(markdown).toContain("Race on reset");
    });

    test("proposalFor finds the stored proposal of one PR by its key and counts undecided drafts", async () => {
        const base = mkdtempSync(join(tmpdir(), "review-proposal-"));
        const ref = { provider: "gitlab" as const, host: "gitlab.example.com", project: "group/app", number: 42 };
        expect(proposalFor(ref, base)).toBeNull();

        const saved = await saveProposal(parseProposal(input()), base);
        const summary = proposalFor(ref, base);

        expect(summary).toEqual({
            path: saved.path,
            decision: "request_changes",
            drafts: 1,
            pending: 1,
            updatedAt: expect.any(String),
            threads: 0,
            openThreads: 0,
            repoPath: null,
        });
        expect(proposalFor({ ...ref, number: 43 }, base)).toBeNull();

        // A decision made in the window (stored status) is not undecided any more.
        const stored = SafeJSON.parse(readFileSync(saved.path, "utf8"));
        stored.drafts[0].status = "rejected";
        writeFileSync(saved.path, SafeJSON.stringify(stored));
        expect(proposalFor(ref, base)).toEqual({
            path: saved.path,
            decision: "request_changes",
            drafts: 1,
            pending: 0,
            updatedAt: expect.any(String),
            threads: 0,
            openThreads: 0,
            repoPath: null,
        });
    });

    test("carries existing PR threads with their own content, with or without the agent's read", () => {
        const proposal = parseProposal(
            input({
                threads: [
                    {
                        threadId: "t1",
                        path: "src/a.ts",
                        line: 12,
                        author: "reviewer",
                        body: "Why reset here?",
                        noteCount: 2,
                        resolved: true,
                    },
                    {
                        threadId: "t2",
                        path: "src/b.ts",
                        line: 3,
                        author: "reviewer",
                        body: "Rename?",
                        resolved: false,
                        verdict: "valid",
                        proof: "src/b.ts:3",
                    },
                ],
            })
        );

        expect(proposal.threads?.[0]).toEqual({
            threadId: "t1",
            path: "src/a.ts",
            line: 12,
            author: "reviewer",
            body: "Why reset here?",
            noteCount: 2,
            resolved: true,
            verdict: undefined,
            proof: undefined,
            confidence: undefined,
            reasoning: undefined,
            fix: undefined,
            suggestedReply: undefined,
        });
        expect(proposal.threads?.[1]?.verdict).toBe("valid");
        expect(() => parseProposal(input({ threads: [{ threadId: "t1", resolved: "yes" }] }))).toThrow(
            "threads[0].resolved must be a boolean"
        );
        expect(() => parseProposal(input({ threads: [{ threadId: "t1", verdict: "maybe" }] }))).toThrow(
            "threads[0].verdict must be one of"
        );
    });

    test("a thread on your own PR carries the proposed fix, a confidence and the reasoning", () => {
        const fix = "Move the reset into the finally block:\n```diff\n- reset()\n+ finally { reset() }\n```";
        const proposal = parseProposal(
            input({
                threads: [{ threadId: "t1", verdict: "valid", confidence: 85, reasoning: "The race is real.", fix }],
            })
        );

        expect(proposal.threads?.[0]).toMatchObject({ confidence: 85, reasoning: "The race is real.", fix });
        expect(() => parseProposal(input({ threads: [{ threadId: "t1", confidence: -1 }] }))).toThrow(
            "threads[0].confidence must be a non-negative integer"
        );
    });

    test("proposalFor counts the window's decisions, which live only in the stored file", async () => {
        const base = mkdtempSync(join(tmpdir(), "review-proposal-"));
        const ref = { provider: "gitlab" as const, host: "gitlab.example.com", project: "group/app", number: 42 };
        const draft = (id: string) => ({ ...input().drafts[0], id });
        const saved = await saveProposal(parseProposal(input({ drafts: ["a", "b", "c", "d", "e"].map(draft) })), base);
        const stored = SafeJSON.parse(readFileSync(saved.path, "utf8")) as { drafts: Array<{ status: string }> };
        stored.drafts[0].status = "accepted";
        stored.drafts[1].status = "sent";
        stored.drafts[2].status = "drafted";
        stored.drafts[3].status = "posted";
        writeFileSync(saved.path, SafeJSON.stringify(stored));

        // a (accepted) and e (proposed) still wait for a send; b, c and d already went somewhere.
        expect(proposalFor(ref, base)).toMatchObject({ drafts: 5, pending: 2 });
    });

    test("a second push keeps the window's reworded thread reply and where it went", async () => {
        const base = mkdtempSync(join(tmpdir(), "review-proposal-"));
        const threads = [{ threadId: "t1", path: "src/a.ts", line: 3, suggestedReply: "Fixed in abc." }];
        const saved = await saveProposal(parseProposal(input({ threads })), base);
        const stored = SafeJSON.parse(readFileSync(saved.path, "utf8")) as { threads: Array<Record<string, unknown>> };
        stored.threads[0] = {
            ...stored.threads[0],
            editedReply: "Opraveno v abc.",
            replyStatus: "drafted",
            providerId: "n1",
        };
        writeFileSync(saved.path, SafeJSON.stringify(stored));

        const again = await saveProposal(
            parseProposal(input({ threads: [{ ...threads[0], suggestedReply: "Fixed in def." }] })),
            base
        );
        const after = SafeJSON.parse(readFileSync(again.path, "utf8")) as { threads: Array<Record<string, unknown>> };
        expect(after.threads[0]).toMatchObject({
            suggestedReply: "Fixed in def.",
            editedReply: "Opraveno v abc.",
            replyStatus: "drafted",
            providerId: "n1",
        });
        expect(again.kept).toBe(1);
    });

    test("proposalFor counts open threads and names the checkout only while it exists", async () => {
        const base = mkdtempSync(join(tmpdir(), "review-proposal-"));
        const checkout = mkdtempSync(join(tmpdir(), "review-checkout-"));
        const ref = { provider: "gitlab" as const, host: "gitlab.example.com", project: "group/app", number: 42 };
        const threads = [{ threadId: "t1", resolved: true }, { threadId: "t2", resolved: false }, { threadId: "t3" }];

        await saveProposal(parseProposal(input({ repoPath: checkout, threads })), base);
        expect(proposalFor(ref, base)).toMatchObject({ threads: 3, openThreads: 2, repoPath: checkout });

        await saveProposal(parseProposal(input({ repoPath: join(checkout, "gone"), threads })), base);
        expect(proposalFor(ref, base)?.repoPath).toBeNull();
    });
});
