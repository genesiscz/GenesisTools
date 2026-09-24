import { afterEach, describe, expect, test } from "bun:test";
import { setDateStyle } from "@app/gitlab/lib/dates";
import type { MrNote, MrSummary, MrWithNotes } from "@app/gitlab/lib/merge-requests";
import {
    findReviewedMr,
    freshness,
    markLabelsApplied,
    markPosted,
    mergeReviews,
    noteWindow,
    pendingLabels,
    renderStaleReport,
    type StaleMr,
    type StaleReport,
    unfilledReviews,
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
