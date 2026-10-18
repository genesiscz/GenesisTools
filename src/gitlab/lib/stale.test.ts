import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closedBugFacts } from "@app/gitlab/lib/closed-bug";
import { mergeConfig, messagesOf, NEUTRAL_CONFIG } from "@app/gitlab/lib/config";
import { setDateStyle } from "@app/gitlab/lib/dates";
import {
    adoReads,
    adoWorkItems,
    BOB,
    baseRoutes,
    createStaleRepo,
    FAKE_HOST,
    FAKE_PROJECT,
    FAKE_TOKEN,
    FakeGitLab,
    installFakeAdo,
    mrRoutes,
    PROJECT_API,
    rawAdo,
    rawMr,
    rawNote,
    type StaleRepo,
    scoped,
    startFakeRuntime,
    status,
    stopFakeRuntime,
} from "@app/gitlab/lib/fake-gitlab";
import type { MrNote, MrSummary, MrWithNotes } from "@app/gitlab/lib/merge-requests";
import {
    closedBugContextOf,
    collectStaleReport,
    emptyReview,
    findReviewedMr,
    freshness,
    gitFacts,
    markLabelsApplied,
    markPosted,
    mergeReviews,
    normalizeEvidence,
    normalizeLabels,
    noteWindow,
    operationalState,
    pendingLabels,
    renderStaleReport,
    type StaleMr,
    type StaleReport,
    staleInstructions,
    unfilledReviews,
    withReportTarget,
} from "@app/gitlab/lib/stale-branches";
import {
    buildManifest,
    contactedAt,
    contactedMrs,
    diffManifest,
    labelFacts,
    type ManifestEntry,
    manifestEntry,
    manifestStatus,
    manifestSummary,
    reactionSince,
    renderManifestTable,
    type StaleManifest,
    sentTexts,
} from "@app/gitlab/lib/stale-manifest";
import {
    activitySince,
    type BranchDeleteOps,
    deleteUnusedBranch,
    findPublishedDraft,
    followupRow,
    notifiedAt,
    notifiedMrs,
    renderFollowupTable,
} from "@app/gitlab/lib/stale-phases";
import type { AdoWorkItem } from "@app/gitlab/lib/work-items";

// The date style starts from defaults.ts; these expectations are written in the neutral ISO style.
beforeEach(() => {
    setDateStyle("iso");
});

const MR_URL = "https://gitlab.example.com/acme/web-app/-/merge_requests";
const STALE = "Stale";

function mr(iid: number, review: Partial<StaleMr["review"]> = {}, extra: Partial<StaleMr> = {}): StaleMr {
    const ageDays = extra.ageDays ?? 200;

    return {
        iid,
        title: `MR ${iid}`,
        description: "",
        author: { username: "bob", name: "Bob Example", id: 7, state: "active" },
        sourceBranch: `feature/${iid}`,
        targetBranch: "main",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-02-01T00:00:00Z",
        draft: false,
        state: "opened",
        labels: [],
        webUrl: `${MR_URL}/${iid}`,
        hasConflicts: false,
        detailedMergeStatus: "mergeable",
        userNotesCount: 0,
        sha: "abc1234567",
        ageDays,
        daysSinceUpdate: 10,
        git: {
            sourceMissing: false,
            targetMissing: false,
            behind: 12,
            ahead: 1,
            lastCommitDate: "2026-01-02",
            lastCommitAuthor: "Bob Example",
            lastCommitEmail: "bob@example.com",
        },
        notes: [],
        lastNote: null,
        lastHumanNote: null,
        approvals: null,
        shipped: null,
        labelConflicts: [],
        siblings: [],
        ado: null,
        adoExtra: [],
        needsReview: ageDays > 90,
        review: {
            recommendation: null,
            confidence: null,
            reason: null,
            adoCommentsSummary: null,
            draftComment: null,
            ...review,
            labels: review.labels ?? [],
            evidence: review.evidence ?? [],
        },
        ...extra,
    };
}

/** An MR that went through review, as the phase and manifest tests need it. */
function reviewed(iid: number, review: Partial<StaleMr["review"]> = {}, extra: Partial<StaleMr> = {}): StaleMr {
    return mr(
        iid,
        {
            recommendation: "CLOSE",
            confidence: 80,
            reason: "r",
            draftComment: "Hi, this MR looks forgotten.",
            ...review,
        },
        extra
    );
}

function report(mrs: StaleMr[]): StaleReport {
    return {
        _instructions: "",
        generatedAt: "2026-09-08T12:00:00Z",
        asOfDate: "2026-09-08",
        host: "https://gitlab.example.com",
        project: "acme/web-app",
        defaultBranch: "main",
        repoRoot: "/repo",
        reviewMinAgeDays: 90,
        inactiveAfterDays: 30,
        mrs,
        authors: [
            {
                username: "bob",
                gitlabState: "active",
                lastGitlabEvent: "2026-09-08",
                lastGitlabEventError: null,
                gitIdentities: ["Bob Example <bob@example.com>"],
                lastCommitDate: "2026-09-08",
                openMrs: mrs.length,
                oldestMrAgeDays: Math.max(...mrs.map((m) => m.ageDays)),
                oldestMrIid: mrs[0]?.iid ?? 0,
            },
        ],
        shippedRefs: ["origin/staging", "origin/main"],
        shippedRoles: { uat: "origin/staging", production: "origin/main", test: null },
        failures: [],
        commands: [],
    };
}

function note(options: { id?: number; createdAt: string; author: string; body?: string; system?: boolean }): MrNote {
    return {
        id: options.id ?? 1,
        author: options.author,
        createdAt: options.createdAt,
        updatedAt: options.createdAt,
        system: options.system ?? false,
        body: options.body ?? "thanks, will look",
    };
}

function live(base: StaleMr, notes: MrNote[] = [], extra: Partial<MrWithNotes> = {}): MrWithNotes {
    return { ...base, notes, lastHumanNote: notes.find((n) => !n.system) ?? null, ...extra };
}

function workItem(extra: Partial<AdoWorkItem> = {}): AdoWorkItem {
    return {
        id: 1,
        title: "t",
        type: "Bug",
        state: "Closed",
        url: "u",
        assignee: null,
        tags: [],
        created: "2026-01-01",
        changed: "2026-09-01T00:00:00Z",
        changedBy: "Carol Example",
        description: "",
        parentId: null,
        comments: [],
        lastCommentDate: null,
        closedDate: null,
        closedBy: null,
        reason: null,
        environment: null,
        mergeRequestUrl: null,
        ...extra,
    };
}

const adoFacts = (item: AdoWorkItem) => ({
    id: item.id,
    source: "title" as const,
    item,
    effective: item,
    error: null,
    parentError: null,
});

describe("stale-branches: review bookkeeping", () => {
    test("unfilledReviews lists only reviewed MRs with an empty or invalid review", () => {
        const filled = mr(1, { recommendation: "CLOSE", confidence: 80, reason: "r", draftComment: "d" });
        const empty = mr(2);
        const young = mr(3, {}, { ageDays: 10 });
        const badValue = mr(4, { recommendation: "MAYBE" as never, confidence: 1, reason: "r", draftComment: "d" });

        expect(unfilledReviews(report([filled, empty, young, badValue]))).toEqual([2, 4]);
    });

    test("noteWindow keeps human and state-carrying system notes, newest first, and never drops the first human note", () => {
        const notes: MrNote[] = [
            note({ id: 1, createdAt: "2026-01-01T00:00:00Z", author: "bob", body: "Intent: fix the popup background" }),
            note({
                id: 2,
                createdAt: "2026-01-02T00:00:00Z",
                author: "bob",
                body: "changed target branch from develop to main",
                system: true,
            }),
            note({
                id: 3,
                createdAt: "2026-01-03T00:00:00Z",
                author: "bob",
                body: "mentioned in commit abc",
                system: true,
            }),
            note({
                id: 4,
                createdAt: "2026-01-04T00:00:00Z",
                author: "alice",
                body: "approved this merge request",
                system: true,
            }),
            ...Array.from({ length: 25 }, (_, i) =>
                note({
                    id: 10 + i,
                    createdAt: `2026-02-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
                    author: "carol",
                    body: `chat ${i}`,
                })
            ),
        ];
        const window = noteWindow(notes, 20);

        expect(window).toHaveLength(20);
        expect(window[0]?.body).toBe("chat 24");
        expect(window.at(-1)?.id).toBe(1);
        expect(window.some((n) => n.body === "mentioned in commit abc")).toBe(false);
        expect(noteWindow(notes.slice(0, 4), 20).map((n) => n.id)).toEqual([4, 2, 1]);
    });

    test("freshness reports every field that moved on the MR or its effective work item", () => {
        const item = (state: string, changed: string, comments = 1) =>
            workItem({
                id: 4242,
                state,
                changed,
                changedBy: "Carol Example",
                comments: Array.from({ length: comments }, (_, i) => ({
                    id: i,
                    author: "a",
                    date: "2026-01-01",
                    text: "t",
                })),
            });
        const stored = mr(1, {}, { ado: adoFacts(item("Closed", "2026-02-01")) });
        const liveMr: MrSummary = { ...stored, sha: "def9876543", draft: true, userNotesCount: 3, labels: [STALE] };
        const result = freshness(stored, liveMr, item("Active", "2026-09-16", 2));

        expect(result.changed).toBe(true);
        expect(result.details).toEqual([
            "new commits on the branch (abc12345 -> def98765)",
            "MR marked as draft",
            "notes 0 -> 3",
            "labels (none) -> Stale",
            "ADO 4242 state Closed -> Active",
            "ADO 4242 changed 2026-02-01 -> 2026-09-16 by Carol Example",
            "ADO 4242 comments 1 -> 2",
        ]);
        expect(freshness(stored, { ...stored }, item("Closed", "2026-02-01"))).toEqual({ changed: false, details: [] });
    });

    test("freshness names a closed or merged MR and a retargeted branch", () => {
        const stored = mr(1);
        const result = freshness(stored, { ...stored, state: "merged", targetBranch: "develop", draft: false }, null);

        expect(result).toEqual({
            changed: true,
            details: ["MR state opened -> merged", "target branch main -> develop"],
        });
        expect(freshness({ ...stored, draft: true }, { ...stored, draft: false }, null).details).toEqual([
            "MR marked ready",
        ]);
    });

    test("mergeReviews fills reviewed MRs from slice maps and previous reports, later sources win", () => {
        const target = report([mr(1), mr(2), mr(3, {}, { ageDays: 5 })]);
        const previous = report([mr(1, { recommendation: "KEEP", confidence: 50, reason: "old", draftComment: "x" })]);
        const slice = {
            "1": {
                recommendation: "CLOSE",
                confidence: "90",
                reason: "new",
                adoCommentsSummary: null,
                draftComment: "y",
                evidence: [" git show origin/main:a.ts "],
            },
        };

        expect(mergeReviews(target, [previous, slice as never])).toEqual({ filled: 1, missing: [2] });
        expect(target.mrs[0]?.review).toEqual({
            recommendation: "CLOSE",
            confidence: 90,
            reason: "new",
            adoCommentsSummary: null,
            draftComment: "y",
            labels: [],
            evidence: ["git show origin/main:a.ts"],
        });
        expect(target.mrs[2]?.review.recommendation).toBeNull();
        expect(() => mergeReviews(target, [{ "1": { ...slice["1"], evidence: "not a list" } } as never])).toThrow(
            "review.evidence must be an array of strings"
        );

        for (const confidence of ["oops", -1, 150]) {
            expect(() => mergeReviews(target, [{ "1": { ...slice["1"], confidence } } as never])).toThrow(
                "review.confidence must be a number from 0 to 100"
            );
        }
    });

    test("a re-merged judgment keeps what post, apply-labels and close recorded", () => {
        const target = report([
            reviewed(1, {
                postedNoteUrl: "u#note_1",
                postedAt: "2026-09-17T10:00:00Z",
                labelsAppliedAt: "2026-09-17T10:01:00Z",
                labelsBefore: [],
                labelsAfter: [STALE],
                closedAt: "2026-09-17T10:02:00Z",
            }),
        ]);
        mergeReviews(target, [
            {
                "1": {
                    recommendation: "CLOSE",
                    confidence: 95,
                    reason: "new",
                    adoCommentsSummary: null,
                    draftComment: "new",
                    labels: [],
                },
            } as never,
        ]);
        const r = target.mrs[0]?.review;

        expect(r?.draftComment).toBe("new");
        expect(r?.postedNoteUrl).toBe("u#note_1");
        expect(r?.labelsAfter).toEqual([STALE]);
        expect(r?.closedAt).toBe("2026-09-17T10:02:00Z");
    });

    test("findReviewedMr accepts only a reviewed MR with a draft that was not posted yet", () => {
        const drafted = reviewed(1, { draftComment: "Hi" });
        const rep = report([drafted, mr(2), mr(3, {}, { ageDays: 5 })]);

        expect(findReviewedMr(rep, 1)).toBe(drafted);
        expect(() => findReviewedMr(rep, 2)).toThrow("no drafted comment");
        expect(() => findReviewedMr(rep, 3)).toThrow("no drafted comment");
        expect(() => findReviewedMr(rep, 9)).toThrow("not in this report");
        expect(markPosted(drafted, 4242, new Date("2026-09-08T14:00:00Z"))).toBe(`${MR_URL}/1#note_4242`);
        expect(() => findReviewedMr(rep, 1)).toThrow("already posted");
    });

    test("mergeReviews validates labels and pendingLabels skips applied MRs", () => {
        const target = report([mr(1), mr(2), mr(3)]);
        const base = {
            recommendation: "CLOSE",
            confidence: 90,
            reason: "r",
            adoCommentsSummary: null,
            draftComment: "d",
        };
        mergeReviews(target, [
            {
                "1": {
                    ...base,
                    labels: [
                        { type: "add", label: STALE },
                        { type: "remove", label: "blocked" },
                    ],
                },
                "2": { ...base, labels: [{ type: "add", label: STALE }] },
                "3": base,
            } as never,
        ]);
        const second = target.mrs[1];
        if (!second) {
            throw new Error("fixture lost an MR");
        }

        markLabelsApplied(second, { before: ["a"], after: ["a", STALE], now: new Date("2026-09-08T17:00:00Z") });

        expect(pendingLabels(target).map((p) => [p.mr.iid, p.add, p.remove])).toEqual([[1, [STALE], ["blocked"]]]);
        expect(() => pendingLabels(target, 3)).toThrow("no pending label changes");
        expect(() =>
            mergeReviews(target, [{ "1": { ...base, labels: [{ type: "drop", label: "x" }] } } as never])
        ).toThrow("Invalid label action");

        const md = renderStaleReport(target, { createdAt: "2026-09-08 17:00", adoTags: [] });

        expect(md).toContain("- Labels: add `Stale`, remove `blocked`");
        expect(md).toContain("- Labels applied 2026-09-08: a to a, Stale");
    });
});

describe("stale-branches: renderStaleReport", () => {
    afterEach(() => {
        setDateStyle("iso");
    });

    const reviewedMr = () =>
        mr(
            1,
            {
                recommendation: "ASK AUTHOR",
                confidence: 70,
                reason: "Because.",
                draftComment: "Hi, let me know.",
                evidence: ["git log -1 origin/feature/1"],
            },
            {
                labels: ["NOT merged into develop"],
                labelConflicts: ['label "NOT merged into develop" but 2 of 2 sampled lines are in origin/develop'],
                approvals: { approved: true, approvedBy: ["alice"] },
                shipped: {
                    mergeBase: "abc",
                    filesChanged: 1,
                    insertions: 2,
                    deletions: 1,
                    refs: [
                        { ref: "origin/staging", matched: 0, sampled: 2, verdict: "absent" },
                        { ref: "origin/develop", matched: 2, sampled: 2, verdict: "present" },
                    ],
                    files: [],
                    verdict: "present",
                    note: null,
                },
                siblings: [
                    {
                        iid: 108,
                        title: "x",
                        state: "merged",
                        sourceBranch: "b",
                        targetBranch: "main",
                        updatedAt: "2026-09-16T00:00:00Z",
                        webUrl: `${MR_URL}/108`,
                        relation: "same-ado",
                    },
                ],
                notes: [
                    note({
                        id: 5,
                        createdAt: "2026-03-01T00:00:00Z",
                        author: "alice",
                        body: "approved this merge request",
                        system: true,
                    }),
                    note({ id: 4, createdAt: "2026-02-01T00:00:00Z", author: "carol", body: "Please rebase, thanks" }),
                ],
            }
        );

    test("puts the review verbatim into the MR section and marks unfilled ones", () => {
        const md = renderStaleReport(report([reviewedMr(), mr(2), mr(3, {}, { ageDays: 5 })]), {
            createdAt: "2026-09-08 15:00",
            adoTags: [4242],
        });

        expect(md).toContain("title: Open merge requests in acme/web-app");
        expect(md).toContain("ado: [4242]");
        expect(md).toContain("| Recommended ASK AUTHOR | 1 |");
        expect(md).toContain("| Branch content already on a target ref (shipped present) | 1 |");
        expect(md).toContain("| Label contradicted by the content check | 1 |");
        expect(md).toContain("**ASK AUTHOR** (70 % confidence)");
        expect(md).toContain("- Shipped: **present** (staging absent 0/2, develop present 2/2); 1 files, +2 -1");
        expect(md).toContain(
            '- Label conflict: label "NOT merged into develop" but 2 of 2 sampled lines are in origin/develop'
        );
        expect(md).toContain("- Approvals: alice");
        expect(md).toContain(`- Related MRs: [!108](${MR_URL}/108) merged, same ado, updated 2026-09-16`);
        expect(md).toContain("- Recent human notes (1 kept):");
        expect(md).toContain("    - 2026-02-01 carol: Please rebase, thanks");
        expect(md).toContain("- Evidence pulled by the reviewer: `git log -1 origin/feature/1`");
        expect(md).toContain("```\nHi, let me know.\n```");
        expect(md).toContain("- Shipped: not checked (branch missing)");
        expect(md).toContain(`| [!2](${MR_URL}/2)`);
        expect(md).toContain("UNFILLED");
        expect(md).toContain("Dates are YYYY-MM-DD.");
        expect(md).not.toContain("### [!3]");
    });

    test("d.m.YYYY dates on request, and an unreadable work item links through the URL template", () => {
        setDateStyle("dmy");
        const unreadable = mr(
            5,
            {},
            {
                ado: {
                    id: 99,
                    source: "title",
                    item: null,
                    effective: null,
                    error: { id: 99, error: "gone" },
                    parentError: null,
                },
            }
        );
        const md = renderStaleReport(report([unreadable]), {
            createdAt: "2026-09-08 15:00",
            adoTags: [],
            workItemUrlTemplate: "https://dev.azure.com/acme/web/_workitems/edit/{id}",
        });

        expect(md).toContain("Dates are d.m.YYYY.");
        expect(md).toContain("- ADO: [99](https://dev.azure.com/acme/web/_workitems/edit/99) unreadable: gone");
        expect(md).toContain("[MR 5](https://dev.azure.com/acme/web/_workitems/edit/99)");
        expect(md).toContain("| 1.1.2026 |");
    });
});

describe("stale-phases", () => {
    const since = "2026-09-18T10:00:00Z";

    test("notifiedAt takes the later stamp; notifiedMrs skips MRs never notified or already closed", () => {
        expect(notifiedAt(reviewed(1))).toBeNull();
        expect(
            notifiedAt(reviewed(2, { postedAt: "2026-09-18T10:00:00Z", labelsAppliedAt: "2026-09-18T10:05:00Z" }))
        ).toBe("2026-09-18T10:05:00Z");
        const list = [
            reviewed(1),
            reviewed(2, { postedAt: "2026-09-18T10:00:00Z" }),
            reviewed(3, { labelsAppliedAt: "2026-09-18T10:00:00Z", closedAt: "2026-09-26T00:00:00Z" }),
        ];

        expect(notifiedMrs(list).map((m) => m.iid)).toEqual([2]);
        expect(() => notifiedMrs(list, 1)).toThrow("was not notified");
        expect(() => notifiedMrs(list, 3)).toThrow("already closed");
    });

    test("findPublishedDraft matches the newest human note equal to the stored draft, only when a draft note exists", () => {
        const body = "Hi, I went through the old open MRs.\n\n- Work item: none";
        const drafted = reviewed(1, { draftComment: body, draftNoteId: 77 });
        const published = live(drafted, [
            note({ createdAt: "2026-09-18T10:00:00Z", author: "alice", body: `${body}\n` }),
            note({ createdAt: "2026-09-17T10:00:00Z", author: "alice", body }),
        ]);

        expect(findPublishedDraft(drafted, published)?.createdAt).toBe("2026-09-18T10:00:00Z");
        expect(
            findPublishedDraft(
                drafted,
                live(drafted, [note({ createdAt: since, author: "alice", body: "something else" })])
            )
        ).toBeNull();
        expect(
            findPublishedDraft(
                reviewed(2, { draftComment: "x" }),
                live(reviewed(2), [note({ createdAt: since, author: "alice", body: "x" })])
            )
        ).toBeNull();
    });

    describe("deleteUnusedBranch", () => {
        // The DELETE is the irreversible call. The spy records every call and THROWS when a guard
        // should have stopped it, so a path that leaks past a guard fails loudly.
        const ops = (live: { users?: number[]; protectedState?: boolean | null; armed?: boolean }) => {
            const removed: string[] = [];
            const spy: BranchDeleteOps = {
                liveUsers: async () => live.users ?? [],
                isProtected: async () => (live.protectedState === undefined ? false : live.protectedState),
                remove: async (branch) => {
                    removed.push(branch);

                    if (live.armed) {
                        throw new Error(`deleteBranch reached for ${branch}`);
                    }

                    return { ok: true, status: 204 };
                },
            };

            return { spy, removed };
        };

        test("refuses a branch that a live MR started using after the sweep", async () => {
            const { spy, removed } = ops({ users: [7, 42], armed: true });

            expect(await deleteUnusedBranch({ branch: "feat/x", closedIid: 7, ops: spy })).toEqual({
                outcome: "in-use",
                users: [42],
            });
            expect(removed).toEqual([]);
        });

        test("refuses a branch that became protected, and reports one that is already gone", async () => {
            const guarded = ops({ protectedState: true, armed: true });
            const gone = ops({ protectedState: null, armed: true });

            expect((await deleteUnusedBranch({ branch: "feat/x", closedIid: 7, ops: guarded.spy })).outcome).toBe(
                "protected"
            );
            expect((await deleteUnusedBranch({ branch: "feat/x", closedIid: 7, ops: gone.spy })).outcome).toBe(
                "missing"
            );
            expect([...guarded.removed, ...gone.removed]).toEqual([]);
        });

        test("deletes when every live guard passes, ignoring the MR this flow just closed", async () => {
            const { spy, removed } = ops({ users: [7] });

            expect(await deleteUnusedBranch({ branch: "feat/x", closedIid: 7, ops: spy })).toEqual({
                outcome: "deleted",
            });
            expect(removed).toEqual(["feat/x"]);
        });

        test("reports a DELETE that GitLab refused", async () => {
            const spy: BranchDeleteOps = {
                liveUsers: async () => [],
                isProtected: async () => false,
                remove: async () => ({ ok: false, status: 403, error: "forbidden" }),
            };

            expect(await deleteUnusedBranch({ branch: "feat/x", closedIid: 7, ops: spy })).toEqual({
                outcome: "failed",
                status: 403,
                error: "forbidden",
            });
        });
    });

    test("findPublishedDraft matches a draft whose side texts were folded in after the comment", () => {
        const comment = "Hi, I went through the old open MRs.";
        const sent = `${comment}\n\n---\nSide note for the branch owner.`;
        const drafted = reviewed(1, { draftComment: comment, sentBody: sent, draftNoteId: 77 });
        const published = live(drafted, [note({ createdAt: "2026-09-18T10:00:00Z", author: "alice", body: sent })]);

        expect(findPublishedDraft(drafted, published)?.createdAt).toBe("2026-09-18T10:00:00Z");

        // After `sync-note` the stored text is the comment alone, while the note keeps the side text.
        const synced = reviewed(1, { draftComment: comment, sentBody: comment, draftNoteId: 77 });

        expect(findPublishedDraft(synced, published)?.createdAt).toBe("2026-09-18T10:00:00Z");
    });

    test("silence for a week makes a close candidate; the notifier's own notes do not count", () => {
        const base = reviewed(1, { postedAt: since });
        const silent = live(base, [
            note({ createdAt: "2026-09-18T10:00:30Z", author: "alice", body: "Hi, this MR looks stale" }),
            note({ createdAt: "2026-09-19T00:00:00Z", author: "bot", body: "added label", system: true }),
        ]);

        expect(activitySince({ mr: base, live: silent, liveAdo: workItem(), since, ignoreAuthors: ["alice"] })).toEqual(
            []
        );
        const row = followupRow(
            base,
            { mr: silent, ado: null },
            { afterDays: 7, ignoreAuthors: ["alice"], now: new Date("2026-09-26T12:00:00Z") }
        );

        expect(row.candidate).toBe(true);
        expect(row.daysSince).toBe(8);
        const early = followupRow(
            base,
            { mr: silent, ado: null },
            { afterDays: 7, ignoreAuthors: ["alice"], now: new Date("2026-09-20T12:00:00Z") }
        );

        expect(early.candidate).toBe(false);
    });

    test("a reply, a push, a state change or a work-item change block the close", () => {
        const base = reviewed(1, { postedAt: since });
        const replied = live(base, [
            note({ createdAt: "2026-09-20T09:00:00Z", author: "bob", body: "Will rebase tomorrow." }),
        ]);

        expect(activitySince({ mr: base, live: replied, liveAdo: null, since, ignoreAuthors: ["alice"] })).toEqual([
            "1 note(s), newest 2026-09-20 by bob: Will rebase tomorrow.",
        ]);
        expect(
            activitySince({
                mr: base,
                live: live(base, [], { sha: "def9876543" }),
                liveAdo: null,
                since,
                ignoreAuthors: [],
            })
        ).toEqual(["new commits (abc12345 -> def98765)"]);
        expect(
            activitySince({
                mr: base,
                live: live(base, [], { state: "merged" }),
                liveAdo: null,
                since,
                ignoreAuthors: [],
            })
        ).toEqual(["MR is merged"]);
        const withAdo = { ...base, ado: adoFacts(workItem({ changed: "2026-09-01" })) };

        expect(
            activitySince({
                mr: withAdo,
                live: live(withAdo),
                liveAdo: workItem({ changed: "2026-09-21T00:00:00Z" }),
                since,
                ignoreAuthors: [],
            })
        ).toEqual(["ADO 1 changed 2026-09-21 by Carol Example (state Closed)"]);
        const row = followupRow(
            base,
            { mr: replied, ado: null },
            { afterDays: 7, ignoreAuthors: ["alice"], now: new Date("2026-09-30T00:00:00Z") }
        );

        expect(row.candidate).toBe(false);
        expect(renderFollowupTable([row])).toContain(
            `| [!1](${MR_URL}/1) | CLOSE | 2026-09-18 | 11 | 1 note(s), newest 2026-09-20 by bob: Will rebase tomorrow. | no |`
        );
    });
});

describe("stale-manifest", () => {
    const NOW = new Date("2026-09-21T12:00:00Z");
    const OPTIONS = { ignoreAuthors: ["alice"], staleLabel: STALE, now: NOW };
    const POSTED = { postedAt: "2026-09-17T16:00:00Z", postedNoteUrl: `${MR_URL}/1#note_1` };
    const LABELLED = { labelsAppliedAt: "2026-09-17T16:05:00Z", labelsBefore: ["Bug"], labelsAfter: ["Bug", STALE] };

    test("a side comment counts as contact, so a side-only MR is in the manifest", () => {
        const sideOnly = reviewed(
            3,
            {},
            {
                needsReview: false,
                sideComments: [{ key: "closedBug", body: "This MR is still open…", postedAt: "2026-09-17T18:00:00Z" }],
            }
        );

        expect(contactedAt(sideOnly)).toBe("2026-09-17T18:00:00Z");
        expect(contactedMrs([reviewed(1), reviewed(2, POSTED), sideOnly]).map((m) => m.iid)).toEqual([2, 3]);
    });

    test("contact is the latest stamp across comment, labels and side texts", () => {
        const both = reviewed(
            4,
            { ...POSTED, ...LABELLED },
            { sideComments: [{ key: "noWorkItem", body: "please link a work item", postedAt: "2026-09-17T17:00:00Z" }] }
        );

        expect(contactedAt(both)).toBe("2026-09-17T17:00:00Z");
        expect(contactedAt(reviewed(1))).toBeNull();
        expect(() => contactedMrs([reviewed(1)], 1)).toThrow("never written to");
    });

    test("sentTexts lists the review comment first, then each posted side text, and skips unposted ones", () => {
        const m = reviewed(1, POSTED, {
            sideComments: [
                {
                    key: "closedBug",
                    body: "This MR is still open, although its Bug is closed.",
                    postedAt: "2026-09-17T18:00:00Z",
                    postedNoteUrl: "u",
                },
                { key: "later", body: "not sent yet" },
            ],
        });

        expect(sentTexts(m).map((s) => s.kind)).toEqual(["review", "closedBug"]);
        expect(sentTexts(m)[0]?.excerpt).toBe("Hi, this MR looks forgotten.");
        expect(sentTexts(reviewed(1, LABELLED))).toEqual([]);
    });

    test("labelFacts reports the stale label as removed once it is gone from the live MR", () => {
        const m = reviewed(1, { ...POSTED, ...LABELLED });

        expect(labelFacts(m, live(m, [], { labels: ["Bug"] }), STALE).staleLabel).toBe("removed");
        expect(labelFacts(m, live(m, [], { labels: ["Bug", STALE] }), STALE).staleLabel).toBe("present");
        expect(labelFacts(m, live(m, [], { labels: ["Bug", STALE] }), STALE).applied).toEqual([STALE]);
        expect(labelFacts(reviewed(1, POSTED), live(m, [], { labels: [] }), STALE).staleLabel).toBe("never-applied");
    });

    test("a label already there when apply-labels ran is still ours; one apply-labels never ran on is not", () => {
        const kept = reviewed(1, {
            ...POSTED,
            labelsAppliedAt: "2026-09-17T16:05:00Z",
            labelsBefore: [STALE],
            labelsAfter: [STALE],
            labels: [{ type: "add", label: STALE }],
        });

        expect(labelFacts(kept, live(kept, [], { labels: [STALE] }), STALE).applied).toEqual([]);
        expect(labelFacts(kept, live(kept, [], { labels: [STALE] }), STALE).staleLabel).toBe("present");
        expect(labelFacts(kept, live(kept, [], { labels: [] }), STALE).staleLabel).toBe("removed");
        const planned = reviewed(1, { ...POSTED, labels: [{ type: "add", label: STALE }] });

        expect(labelFacts(planned, live(planned, [], { labels: [STALE] }), STALE).staleLabel).toBe("never-applied");
        expect(labelFacts(kept, live(kept, [], { labels: ["Dormant"] }), "Dormant").staleLabel).toBe("never-applied");
    });

    test("reactionSince ignores our own notes and notes older than the contact", () => {
        const m = reviewed(1, POSTED);
        const notes = [
            note({ createdAt: "2026-09-01T00:00:00Z", author: "bob" }),
            note({ createdAt: "2026-09-18T09:00:00Z", author: "alice" }),
            note({ createdAt: "2026-09-19T09:00:00Z", author: "bob", body: "merging tomorrow" }),
        ];
        const reaction = reactionSince({
            mr: m,
            live: live(m, notes),
            liveAdo: null,
            since: POSTED.postedAt,
            ignoreAuthors: ["alice"],
        });

        expect(reaction.notes).toBe(1);
        expect(reaction.newestNoteBy).toBe("bob");
        expect(reaction.newestNoteExcerpt).toBe("merging tomorrow");
        expect(reaction.newCommits).toBe(false);
    });

    test("a new head sha counts as a reaction, a work-item edit alone does not", () => {
        const m = reviewed(1, POSTED);
        const pushed = reactionSince({
            mr: m,
            live: live(m, [], { sha: "def7654321" }),
            liveAdo: null,
            since: POSTED.postedAt,
            ignoreAuthors: [],
        });

        expect(pushed.newCommits).toBe(true);
        expect(pushed.shaNow).toBe("def7654321");
        const adoOnly = reactionSince({
            mr: m,
            live: live(m),
            liveAdo: workItem({ id: 4242, changed: "2026-09-19T00:00:00Z", changedBy: "Automation" }),
            since: POSTED.postedAt,
            ignoreAuthors: [],
        });

        expect(adoOnly.adoChanged).toContain("4242");
        expect(adoOnly.notes).toBe(0);
        expect(adoOnly.newCommits).toBe(false);
    });

    test("manifestStatus: closed or merged wins, a removed label is its own answer, answered with the label on needs a human", () => {
        const silent = {
            notes: 0,
            newestNoteAt: null,
            newestNoteBy: null,
            newestNoteExcerpt: null,
            newCommits: false,
            shaAtContact: "a",
            shaNow: "a",
            draftChanged: false,
            adoChanged: null,
        };
        const answered = {
            ...silent,
            notes: 1,
            newestNoteAt: "2026-09-19T00:00:00Z",
            newestNoteBy: "bob",
            newestNoteExcerpt: "ok",
        };
        const present = {
            applied: [STALE],
            removed: [],
            appliedAt: LABELLED.labelsAppliedAt,
            staleLabel: "present" as const,
        };
        const gone = { ...present, staleLabel: "removed" as const };
        const never = { applied: [], removed: [], appliedAt: null, staleLabel: "never-applied" as const };

        expect(manifestStatus("merged", present, answered)).toBe("merged");
        expect(manifestStatus("closed", present, silent)).toBe("closed");
        expect(manifestStatus("opened", gone, silent)).toBe("label-removed");
        expect(manifestStatus("opened", gone, answered)).toBe("label-removed");
        expect(manifestStatus("opened", present, answered)).toBe("answered-label-kept");
        expect(manifestStatus("opened", never, answered)).toBe("answered-no-label");
        expect(manifestStatus("opened", present, silent)).toBe("silent");
        expect(
            manifestStatus("opened", present, { ...silent, adoChanged: "4242 2026-09-19 by Automation (state Closed)" })
        ).toBe("silent");
    });

    test("manifestEntry carries our side, their side and the day count, and refuses an MR we never wrote to", () => {
        const m = reviewed(
            109,
            { ...POSTED, ...LABELLED },
            {
                sideComments: [
                    {
                        key: "closedBug",
                        body: "This MR is still open…",
                        postedAt: "2026-09-17T18:00:00Z",
                        postedNoteUrl: "u",
                    },
                ],
            }
        );
        const entry = manifestEntry(
            m,
            {
                mr: live(m, [note({ createdAt: "2026-09-19T09:00:00Z", author: "bob" })], { labels: ["Bug"] }),
                ado: null,
            },
            OPTIONS
        );

        expect(entry.sent.map((s) => s.kind)).toEqual(["review", "closedBug"]);
        expect(entry.contactedAt).toBe("2026-09-17T18:00:00Z");
        expect(entry.daysSinceContact).toBe(3);
        expect(entry.labels.staleLabel).toBe("removed");
        expect(entry.status).toBe("label-removed");
        expect(entry.reaction.notes).toBe(1);
        expect(() => manifestEntry(reviewed(1), { mr: live(reviewed(1)), ado: null }, OPTIONS)).toThrow(
            "never written to"
        );
    });

    function entry(iid: number, status: ManifestEntry["status"]): ManifestEntry {
        const m = reviewed(iid, { ...POSTED, ...LABELLED });

        return { ...manifestEntry(m, { mr: live(m, [], { labels: ["Bug", STALE] }), ado: null }, OPTIONS), status };
    }

    test("the diff names every status that moved and every entry new to the manifest", () => {
        const previous: StaleManifest = buildManifest({
            source: "sweep.json",
            entries: [entry(1, "silent"), entry(2, "silent")],
            previous: null,
            now: new Date("2026-09-20T12:00:00Z"),
        });
        const { changed, added } = diffManifest(previous, [
            entry(1, "silent"),
            entry(2, "label-removed"),
            entry(3, "closed"),
        ]);

        expect(changed).toEqual([{ iid: 2, from: "silent", to: "label-removed" }]);
        expect(added).toEqual([3]);
    });

    test("the first run reports every entry as new; a rebuild records when the previous one was made", () => {
        const manifest = buildManifest({
            source: "sweep.json",
            entries: [entry(2, "silent"), entry(1, "silent")],
            previous: null,
            now: NOW,
        });

        expect(manifest.previousRunAt).toBeNull();
        expect(manifest.entries.map((e) => e.iid)).toEqual([1, 2]);
        expect(diffManifest(null, manifest.entries).added).toEqual([1, 2]);
        const first = buildManifest({
            source: "sweep.json",
            entries: [entry(1, "silent")],
            previous: null,
            now: new Date("2026-09-20T12:00:00Z"),
        });

        expect(
            buildManifest({ source: "sweep.json", entries: [entry(1, "closed")], previous: first, now: NOW })
                .previousRunAt
        ).toBe("2026-09-20T12:00:00.000Z");
    });

    test("the table and the summary name the status of every entry", () => {
        const rows = [entry(1, "silent"), entry(2, "answered-label-kept")];

        expect(renderManifestTable(rows)).toContain(`| [!1](${MR_URL}/1)`);
        expect(renderManifestTable(rows)).toContain("answered-label-kept");
        expect(manifestSummary(rows)).toContain("| silent | 1 |");
    });
});

describe("a sweep written before it recorded the host and project", () => {
    const old = (): StaleReport => ({ ...report([reviewed(1)]), host: "", project: "" });

    test("the target comes from the MR URLs it holds", () => {
        expect(withReportTarget(old())).toMatchObject({ host: "https://gitlab.example.com", project: "acme/web-app" });
        expect(withReportTarget({ ...old(), project: "acme/api" }).project).toBe("acme/api");
        expect(withReportTarget({ ...old(), mrs: [] })).toMatchObject({ host: "", project: "" });
    });

    test("render and the closed-bug context never print or use an empty project", () => {
        const md = renderStaleReport(old(), { createdAt: "2026-09-08 15:00", adoTags: [] });

        expect(md).toContain("# Open merge requests in acme/web-app");
        expect(md).toContain("every open MR in `acme/web-app`");
        expect(md).not.toContain("undefined");
        expect(closedBugContextOf(old(), mergeConfig({}, NEUTRAL_CONFIG)).projectPath).toBe("acme/web-app");
    });
});

describe("company-specific note and instruction text", () => {
    test("stale.noteTags, stale.contentCheckNote and stale.instructionsExtra default to nothing", () => {
        expect(NEUTRAL_CONFIG.stale).toMatchObject({ instructionsExtra: null, noteTags: [], contentCheckNote: null });
        expect(() => mergeConfig({ stale: { noteTags: "x" } }, NEUTRAL_CONFIG)).toThrow(
            "stale.noteTags must be an array of strings"
        );
    });

    test("render adds the configured tags and the content-check note", () => {
        const md = renderStaleReport(report([reviewed(1)]), {
            createdAt: "2026-09-08 15:00",
            adoTags: [],
            noteTags: ["web-app"],
            contentCheckNote: "The test branch lost its history before 2026-06-01.",
        });

        expect(md).toContain("  - cleanup\n  - web-app\nado: []");
        expect(md).toContain(
            "defeat it. A Closed work item with `absent` everywhere means the fix is gone, not shipped. The test branch lost its history before 2026-06-01."
        );
    });

    test("the preflight instructions carry stale.instructionsExtra before the render step", () => {
        const config = mergeConfig(
            { stale: { instructionsExtra: "Write the comment in the team voice." } },
            NEUTRAL_CONFIG
        );
        const text = staleInstructions(config);

        expect(text).toContain("Write the comment in the team voice. Then run:");
        expect(staleInstructions(mergeConfig({}, NEUTRAL_CONFIG))).not.toContain("team voice");
    });
});

describe("stale-branches: input validation", () => {
    test("normalizeEvidence trims entries, drops blanks and refuses anything but an array of strings", () => {
        expect(normalizeEvidence(undefined)).toEqual([]);
        expect(normalizeEvidence(null)).toEqual([]);
        expect(normalizeEvidence([" git log -1 ", "", "  "])).toEqual(["git log -1"]);
        expect(() => normalizeEvidence("git log")).toThrow("review.evidence must be an array of strings");
        expect(() => normalizeEvidence(["ok", 3])).toThrow('got ["ok",3]');
    });

    test("normalizeLabels keeps trimmed add and remove actions and names the entry it refuses", () => {
        expect(normalizeLabels(null)).toEqual([]);
        expect(
            normalizeLabels([
                { type: "add", label: " Stale " },
                { type: "remove", label: "blocked" },
            ])
        ).toEqual([
            { type: "add", label: "Stale" },
            { type: "remove", label: "blocked" },
        ]);
        expect(() => normalizeLabels("Stale")).toThrow("review.labels must be an array of {type, label}");
        expect(() => normalizeLabels([{ type: "toggle", label: "x" }])).toThrow(
            'Invalid label action {"type":"toggle"'
        );
        expect(() => normalizeLabels([{ type: "add", label: "   " }])).toThrow("Invalid label action");
    });

    test("mergeReviews refuses a confidence outside 0 to 100 and names the MR", () => {
        const target = report([mr(1)]);

        expect(() =>
            mergeReviews(target, [{ "1": { ...emptyReview(), recommendation: "KEEP", confidence: 150 } }])
        ).toThrow("!1: review.confidence must be a number from 0 to 100, got 150");
        expect(() =>
            mergeReviews(target, [{ "1": { ...emptyReview(), recommendation: "KEEP", confidence: "oops" as never } }])
        ).toThrow("review.confidence must be a number from 0 to 100");
    });

    test("pendingLabels refuses a label that is added and removed, and an MR with nothing pending", () => {
        const clash = mr(
            1,
            {
                labels: [
                    { type: "add", label: STALE },
                    { type: "remove", label: STALE },
                ],
            },
            {}
        );
        const done = mr(2, { labels: [{ type: "add", label: STALE }], labelsAppliedAt: "2026-09-08T00:00:00Z" });

        expect(() => pendingLabels(report([clash]))).toThrow("!1 adds and removes the same label: Stale");
        expect(() => pendingLabels(report([done]), 2)).toThrow("!2 has no pending label changes in this report");
        expect(pendingLabels(report([done]))).toEqual([]);
    });

    test("operationalState keeps only what post, apply-labels and close recorded", () => {
        expect(operationalState(undefined)).toEqual({});
        expect(
            operationalState({
                recommendation: "CLOSE",
                postedNoteUrl: `${MR_URL}/1#note_5`,
                labelsBefore: [],
                closedAt: undefined,
                draftNoteId: 0,
            })
        ).toEqual({ postedNoteUrl: `${MR_URL}/1#note_5`, labelsBefore: [], draftNoteId: 0 });
    });
});

describe("stale-branches: renderStaleReport for work items and closed bugs", () => {
    const task = workItem({
        id: 501,
        type: "Task",
        state: "Active",
        parentId: 600,
        url: "https://ado.example.com/501",
        assignee: "Dana Example",
    });
    const parent = workItem({
        id: 600,
        type: "Bug",
        state: "Closed",
        url: "https://ado.example.com/600",
        changed: "2026-08-01T00:00:00Z",
        comments: [
            { id: 1, author: "Eve", date: "2026-07-01T00:00:00Z", text: "works\n   on my machine" },
            { id: 2, author: "Fay", date: "2026-07-05T00:00:00Z", text: "still broken on UAT" },
        ],
        lastCommentDate: "2026-07-05T00:00:00Z",
    });
    const roles = { uat: "origin/staging", production: "origin/main", test: null };
    const shipped = {
        mergeBase: "abc",
        filesChanged: 3,
        insertions: 5,
        deletions: 0,
        refs: [
            { ref: "origin/staging", matched: 0, sampled: 4, verdict: "absent" as const },
            { ref: "origin/main", matched: 0, sampled: 4, verdict: "absent" as const },
        ],
        files: [],
        verdict: "absent" as const,
        note: null,
    };
    const context = { roles, messages: messagesOf(NEUTRAL_CONFIG), projectPath: "acme/web-app" };
    const taskUnderBug = (): StaleMr =>
        mr(
            1,
            { recommendation: "KEEP", confidence: null, reason: "r", draftComment: "d", adoCommentsSummary: "Broken." },
            {
                ado: {
                    id: 501,
                    source: "title",
                    item: task,
                    effective: parent,
                    error: null,
                    parentError: null,
                },
                adoExtra: [
                    adoFacts(workItem({ id: 7, type: "Story", state: "Active" })),
                    {
                        id: 8,
                        source: "branch",
                        item: null,
                        effective: null,
                        error: { id: 8, error: "TF401019: no access" },
                        parentError: null,
                    },
                ],
                shipped,
                closedBug: closedBugFacts({ item: parent, shipped, iid: 1, context }),
                sideComments: [
                    { key: "a", body: "x", postedNoteUrl: `${MR_URL}/1#note_9`, postedAt: "2026-09-01T00:00:00Z" },
                    { key: "b", body: "y", draftNoteId: 33 },
                    { key: "c", body: "z" },
                ],
            }
        );

    test("a Task under a Closed bug shows the parent state, the comments of the parent and the closed-bug line", () => {
        const md = renderStaleReport(report([taskUnderBug()]), { createdAt: "2026-09-08 15:00", adoTags: [] });

        expect(md).toContain("| Task: Active; parent Bug [600](https://ado.example.com/600): Closed |");
        expect(md).toContain(
            "- ADO Task: [501 t](https://ado.example.com/501), state **Active**, assignee Dana Example"
        );
        expect(md).toContain("- Corrected to parent Bug: [600 t](https://ado.example.com/600), state **Closed**");
        expect(md).toContain("- ADO last activity: 2026-08-01 by Carol Example; last comment 2026-07-05");
        expect(md).toContain("- Also names ADO Story: [7 t](u), state **Active**");
        expect(md).toContain("- Also names ADO 8 unreadable: TF401019: no access");
        expect(md).toContain("- What the comments say in the ADO (2 on 600): Broken.");
        expect(md).toContain("    - 2026-07-05 Fay: still broken on UAT\n    - 2026-07-01 Eve: works on my machine");
        expect(md).toContain("- Closed bug, open MR: nowhere (sample); staging 0/4, main 0/4; Closed ?");
        expect(md).toContain("**(fix not released)**");
        expect(md).toContain("| Closed bug, open MR, fix not on UAT or production (closed-bug) | 1 |");
        expect(md).toContain("| Work item Closed but content absent everywhere | 1 |");
        expect(md).toContain(`- Side texts of ours: a [posted 2026-09-01](${MR_URL}/1#note_9); b draft 33; c pending`);
        expect(md).toContain("- Recommended action: **KEEP**\n");
    });

    test("an unreadable parent is named, and a branch or work item that cannot be compared is said so", () => {
        const noParent = mr(
            2,
            { recommendation: "KEEP", confidence: 50, reason: "r", draftComment: "d" },
            {
                ado: {
                    id: 502,
                    source: "branch",
                    item: workItem({ id: 502, type: "Task", state: "Active", parentId: 650 }),
                    effective: workItem({ id: 502, type: "Task", state: "Active", parentId: 650 }),
                    error: null,
                    parentError: { id: 650, error: "TF401232: gone" },
                },
                git: { ...mr(2).git, sourceMissing: true, behind: null, ahead: null, lastCommitDate: null },
                shipped: { ...shipped, verdict: "unknown", refs: [], note: null },
                lastNote: note({ createdAt: "2026-02-03T00:00:00Z", author: "gitlab", system: true }),
            }
        );
        const targetGone = mr(3, {}, { git: { ...mr(3).git, targetMissing: true } });
        const md = renderStaleReport(report([noParent, targetGone]), { createdAt: "2026-09-08 15:00", adoTags: [] });

        expect(md).toContain("- Parent 650 unreadable: TF401232: gone");
        expect(md).toContain("source missing commits");
        expect(md).toContain("- Shipped: unknown (no sampled lines); 3 files, +5 -0");
        expect(md).toContain("(note 2026-02-03 by gitlab, system)");
        expect(md).toContain("| target missing |");
        expect(md).toContain("| source missing |");
        expect(md).toContain("KEEP (50 %)");
    });
});

describe("stale-branches: the sweep against a real checkout", () => {
    const NOW = new Date("2026-04-01T12:00:00Z");
    let repo: StaleRepo;

    beforeAll(async () => {
        repo = createStaleRepo();
        await installFakeAdo();
        startFakeRuntime();
    });

    afterAll(() => {
        stopFakeRuntime();
    });

    afterEach(() => {
        adoWorkItems.clear();
        adoReads.length = 0;
    });

    const api = { host: FAKE_HOST, token: FAKE_TOKEN, project: FAKE_PROJECT };

    async function sweep(fake: FakeGitLab, config = mergeConfig({}, NEUTRAL_CONFIG)) {
        const lines: string[] = [];
        const { value } = await scoped(fake, () =>
            collectStaleReport({
                api,
                config,
                cwd: repo.clone,
                reviewMinAgeDays: 60,
                inactiveAfterDays: 30,
                now: NOW,
                log: (line) => lines.push(line),
            })
        );

        return { report: value, lines };
    }

    function openMrs(fake: FakeGitLab, list: Array<Record<string, unknown>>) {
        fake.get(`${PROJECT_API}/merge_requests`, () => list);
        for (const raw of list) {
            mrRoutes(fake, raw.iid as number);
        }
    }

    test("gitFacts counts the commits behind and ahead and names the last commit of the branch", () => {
        expect(gitFacts(repo.clone, mr(1))).toEqual({
            sourceMissing: false,
            targetMissing: false,
            behind: 1,
            ahead: 1,
            lastCommitDate: "2026-02-01",
            lastCommitAuthor: "Alice Example",
            lastCommitEmail: "alice@example.com",
        });
        expect(gitFacts(repo.clone, mr(2))).toMatchObject({
            lastCommitDate: "2026-02-10",
            lastCommitAuthor: "Bob Example",
            lastCommitEmail: "bob@example.com",
        });
    });

    test("gitFacts leaves the distance empty when a branch is gone from origin", () => {
        const gone = { ...mr(9), sourceBranch: "feature/deleted" };
        const noTarget = { ...mr(1), targetBranch: "release/none" };

        expect(gitFacts(repo.clone, gone)).toEqual({
            sourceMissing: true,
            targetMissing: false,
            behind: null,
            ahead: null,
            lastCommitDate: null,
            lastCommitAuthor: null,
            lastCommitEmail: null,
        });
        expect(gitFacts(repo.clone, noTarget)).toMatchObject({
            sourceMissing: false,
            targetMissing: true,
            behind: null,
            ahead: null,
            lastCommitDate: "2026-02-01",
        });
    });

    test("a sweep records each MR's git distance, notes, content check, siblings and author activity", async () => {
        const fake = baseRoutes(new FakeGitLab());
        openMrs(fake, [
            rawMr(1, { created_at: "2026-01-01T00:00:00Z", updated_at: "2026-02-15T00:00:00Z" }),
            rawMr(2, {
                author: BOB,
                created_at: "2026-02-20T00:00:00Z",
                updated_at: "2026-03-30T00:00:00Z",
                labels: ["NOT merged into main"],
            }),
            rawMr(3, { target_branch: "feature/1", created_at: "2026-03-25T00:00:00Z" }),
        ]);
        mrRoutes(fake, 1, {
            approvedBy: ["dave"],
            notes: [
                rawNote(1, { author: "carol", body: "Please rebase", at: "2026-02-10T00:00:00Z" }),
                rawNote(2, { system: true, body: "added 2 commits", at: "2026-02-12T00:00:00Z" }),
                rawNote(3, { system: true, body: "assigned to @carol", at: "2026-02-13T00:00:00Z" }),
            ],
        });
        fake.get(`${PROJECT_API}/merge_requests/2/approvals`, status(404));
        fake.get(`${PROJECT_API}/merge_requests/3/notes`, status(404));
        fake.get("/users/11/events", [{ created_at: "2026-03-20T10:00:00Z" }]);
        fake.get("/users/12/events", status(403));

        const { report: result, lines } = await sweep(fake);
        const [first, second, third] = result.mrs;

        expect(result.mrs.map((m) => m.iid)).toEqual([1, 2, 3]);
        expect(result).toMatchObject({
            asOfDate: "2026-04-01",
            host: FAKE_HOST,
            project: FAKE_PROJECT,
            defaultBranch: "main",
            repoRoot: repo.clone,
            shippedRefs: ["origin/main"],
            shippedRoles: { uat: null, production: "origin/main", test: null },
        });
        expect(result._instructions).toBe(staleInstructions(mergeConfig({}, NEUTRAL_CONFIG)));
        expect(lines[0]).toBe("3 open MRs in acme/widgets");
        expect(lines.some((line) => line.startsWith("!1 90 d, work item none"))).toBe(true);

        expect(first).toMatchObject({ ageDays: 90, daysSinceUpdate: 45, needsReview: true });
        expect(first?.git).toMatchObject({ behind: 1, ahead: 1, lastCommitDate: "2026-02-01" });
        expect(first?.notes.map((n) => n.id)).toEqual([2, 1]);
        expect(first?.lastHumanNote?.body).toBe("Please rebase");
        expect(first?.approvals).toEqual({ approved: true, approvedBy: ["dave"] });
        expect(first?.shipped?.verdict).toBe("absent");

        expect(second).toMatchObject({ ageDays: 40, needsReview: false, approvals: null });
        expect(second?.shipped?.verdict).toBe("present");
        expect(second?.labelConflicts).toHaveLength(1);
        expect(second?.labelConflicts[0]).toContain('label "NOT merged into main"');

        expect(third?.notes).toEqual([]);
        expect(first?.siblings.map((s) => [s.iid, s.relation])).toEqual([[3, "stacked-on-this"]]);
        expect(third?.siblings.map((s) => [s.iid, s.relation])).toEqual([[1, "this-stacks-on"]]);

        expect(result.authors.map((a) => a.username)).toEqual(["alice", "bob"]);
        expect(result.authors[0]).toMatchObject({
            gitlabState: "active",
            lastGitlabEvent: "2026-03-20",
            lastGitlabEventError: null,
            gitIdentities: ["Alice Example <alice@example.com>"],
            lastCommitDate: "2026-03-01",
            openMrs: 2,
            oldestMrAgeDays: 90,
            oldestMrIid: 1,
        });
        expect(result.authors[1]).toMatchObject({
            gitlabState: "blocked",
            lastGitlabEvent: null,
            lastCommitDate: "2026-02-10",
        });
        expect(result.authors[1]?.lastGitlabEventError).toContain("403");

        expect(result.failures.some((f) => f.startsWith("approvals of !2:"))).toBe(true);
        expect(result.failures.some((f) => f.startsWith("notes of !3:"))).toBe(true);
        expect(result.failures.some((f) => f.startsWith("GitLab events of bob:"))).toBe(true);
        expect(result.commands.some((c) => c.includes("azure-devops"))).toBe(false);
    });

    test("a checkout without origin and a failing sibling search are recorded as failures, not thrown", async () => {
        const config = mergeConfig({ workItems: { idPattern: "AB#(\\d+)" } }, NEUTRAL_CONFIG);
        const fake = baseRoutes(new FakeGitLab());
        const list = [rawMr(1, { title: "AB#701 Lonely" })];
        openMrs(fake, list);
        fake.get(`${PROJECT_API}/merge_requests`, (request) =>
            request.query.get("state") === "all" ? status(403, { message: "403 Forbidden" }) : list
        );
        fake.get("/users/11/events", []);
        adoWorkItems.set(701, rawAdo(701));
        const bare = realpathSync(mkdtempSync(join(tmpdir(), "gt-gitlab-bare-")));
        // A repository of its own with no origin, so git can never walk up into a checkout that holds the temp root.
        expect(Bun.spawnSync(["git", "init", "-q", bare], { env: process.env }).exitCode).toBe(0);

        const { value: result } = await scoped(fake, () =>
            collectStaleReport({
                api,
                config,
                cwd: bare,
                reviewMinAgeDays: 60,
                inactiveAfterDays: 30,
                now: NOW,
            })
        );

        expect(result.failures[0]).toStartWith("git fetch origin --prune:");
        expect(result.failures.some((f) => f.startsWith("sibling MRs of work item 701:"))).toBe(true);
        expect(result.mrs[0]?.git.sourceMissing).toBe(true);
        expect(result.mrs[0]?.shipped).toBeNull();
        expect(result.mrs[0]?.siblings).toEqual([]);
    });

    test("work items named by a title, a branch or a description are read once each, a Task through its parent", async () => {
        const config = mergeConfig({ workItems: { idPattern: "AB#(\\d+)" } }, NEUTRAL_CONFIG);
        const fake = baseRoutes(new FakeGitLab());
        const list = [
            rawMr(1, { title: "AB#501 Fix popup", created_at: "2026-01-01T00:00:00Z" }),
            rawMr(2, { description: "Covers AB#502, AB#503 and AB#504", created_at: "2026-02-20T00:00:00Z" }),
            rawMr(4, {
                title: "AB#501 other attempt",
                source_branch: "other/4",
                created_at: "2026-03-01T00:00:00Z",
            }),
        ];
        openMrs(fake, list);
        fake.get(`${PROJECT_API}/merge_requests`, (request) =>
            request.query.get("state") === "all" ? list.filter((m) => String(m.title).includes("501")) : list
        );
        fake.get("/users/11/events", []);
        adoWorkItems.set(501, rawAdo(501, { type: "Task", parent: 600, title: "Popup task" }));
        adoWorkItems.set(600, rawAdo(600, { type: "Bug", state: "Closed", title: "Popup bug" }));
        adoWorkItems.set(502, rawAdo(502, { type: "Story", state: "Active" }));
        adoWorkItems.set(503, "TF401019: no access to project");
        adoWorkItems.set(504, rawAdo(504, { type: "Task", parent: 601 }));
        adoWorkItems.set(601, "TF401232: work item 601 does not exist");

        const { report: result } = await sweep(fake, config);
        const [first, second, other] = result.mrs;

        expect(first?.ado).toMatchObject({ id: 501, source: "title", error: null, parentError: null });
        expect(first?.ado?.item?.type).toBe("Task");
        expect(first?.ado?.effective).toMatchObject({ id: 600, type: "Bug", state: "Closed" });
        expect(first?.closedBug?.adoId).toBe(600);
        expect(first?.closedBug?.fix).toBe("nowhere");

        expect(second?.ado).toMatchObject({ id: 502, source: "description" });
        expect(second?.adoExtra.map((a) => [a.id, a.error?.error.slice(0, 11) ?? null])).toEqual([
            [503, "TF401019: n"],
            [504, null],
        ]);
        expect(second?.adoExtra[1]?.parentError?.id).toBe(601);

        expect(other?.shipped).toBeNull();
        expect(other?.git.sourceMissing).toBe(true);
        expect(other?.ado?.id).toBe(501);
        expect(other?.siblings.map((s) => [s.iid, s.relation])).toEqual([[1, "same-ado"]]);
        expect(first?.siblings.map((s) => [s.iid, s.relation])).toEqual([[4, "same-ado"]]);

        expect(adoReads.filter((id) => id === 501)).toHaveLength(1);
        expect([...new Set(adoReads)].sort()).toEqual([501, 502, 503, 504, 600, 601]);
        expect(result.failures).toContain("ADO 503 (from !2 description): TF401019: no access to project");
        expect(
            result.failures.some((f) => f.startsWith("ADO 504 is a Task and its parent 601 is unreadable (from !2)"))
        ).toBe(true);
        expect(result.commands.some((c) => c.includes("(sibling MRs, one call per work item)"))).toBe(true);
        expect(result.commands.some((c) => c.includes("azure-devops workitem"))).toBe(true);
    });
});
