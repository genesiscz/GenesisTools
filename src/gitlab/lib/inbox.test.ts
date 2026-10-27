import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    FAKE_HOST,
    FAKE_PROJECT_ID,
    FAKE_TOKEN,
    FakeGitLab,
    scoped,
    startFakeRuntime,
    stopFakeRuntime,
} from "@app/gitlab/lib/fake-gitlab";
import {
    advanceCheck,
    analyzeMr,
    buildInboxReport,
    collectInbox,
    type InboxDiscussion,
    type InboxMr,
    type InboxNote,
    type InboxTodo,
    isTodoNews,
    readInboxState,
    renderInboxText,
    writeInboxState,
} from "@app/gitlab/lib/inbox";

const SINCE = "2026-10-20T10:00:00Z";
const MR_URL = `${FAKE_HOST}/acme/widgets/-/merge_requests`;

function mr(iid: number, author: string, extra: Partial<InboxMr> = {}): InboxMr {
    return {
        projectId: FAKE_PROJECT_ID,
        iid,
        title: `MR ${iid}`,
        webUrl: `${MR_URL}/${iid}`,
        project: "acme/widgets",
        author,
        updatedAt: "2026-10-21T10:00:00Z",
        state: "opened",
        ...extra,
    };
}

function note(id: number, author: string, at: string, extra: Partial<InboxNote> = {}): InboxNote {
    return { id, author: { username: author }, created_at: at, body: `note ${id}`, system: false, ...extra };
}

function thread(notes: InboxNote[], resolved = false): InboxDiscussion {
    return { individual_note: false, notes: notes.map((n) => ({ ...n, resolvable: !n.system, resolved })) };
}

function single(n: InboxNote): InboxDiscussion {
    return { individual_note: true, notes: [n] };
}

describe("analyzeMr", () => {
    test("counts new comments by others per author and skips your own and the old ones", () => {
        const activity = analyzeMr({
            mr: mr(1, "me"),
            me: "me",
            since: SINCE,
            seenNoteId: undefined,
            discussions: [
                single(note(1, "bob", "2026-10-19T09:00:00Z")),
                single(note(2, "bob", "2026-10-20T11:00:00Z")),
                single(note(3, "bob", "2026-10-20T12:00:00Z")),
                single(note(4, "carol", "2026-10-20T13:00:00Z")),
                single(note(5, "me", "2026-10-20T14:00:00Z")),
            ],
            pipeline: null,
            todos: [],
        });

        expect(activity.role).toBe("author");
        expect(activity.comments).toEqual([
            { author: "bob", count: 2 },
            { author: "carol", count: 1 },
        ]);
        expect(activity.lastNoteId).toBe(5);
    });

    test("the note mark decides over the clock: a note above the mark is new even with an old timestamp", () => {
        const activity = analyzeMr({
            mr: mr(1, "me"),
            me: "me",
            since: SINCE,
            seenNoteId: 10,
            discussions: [
                single(note(9, "bob", "2026-10-21T00:00:00Z")),
                single(note(11, "bob", "2026-10-01T00:00:00Z")),
            ],
            pipeline: null,
            todos: [],
        });

        expect(activity.comments).toEqual([{ author: "bob", count: 1 }]);
    });

    test("reads pushes, approvals and the merge from system notes", () => {
        const at = "2026-10-21T08:00:00Z";
        const activity = analyzeMr({
            mr: mr(2, "alice"),
            me: "me",
            since: SINCE,
            seenNoteId: undefined,
            discussions: [
                single(note(20, "alice", at, { system: true, body: "added 2 commits\n\n* abc - one\n* def - two" })),
                single(note(21, "alice", at, { system: true, body: "added 1 commit\n\n* 123 - three" })),
                single(note(22, "bob", at, { system: true, body: "approved this merge request" })),
                single(note(23, "bob", at, { system: true, body: "merged" })),
                single(note(24, "me", at, { system: true, body: "approved this merge request" })),
            ],
            pipeline: null,
            todos: [],
        });

        expect(activity.role).toBe("reviewer");
        expect(activity.commits).toBe(3);
        expect(activity.approvedBy).toEqual(["bob"]);
        expect(activity.merged).toBe(true);
        expect(activity.comments).toEqual([]);
    });

    test("a reviewer waits only in a thread they wrote in; the author waits in any open thread", () => {
        const at = "2026-10-21T08:00:00Z";
        const discussions = [
            thread([note(30, "me", at), note(31, "alice", at)]),
            thread([note(40, "carol", at)]),
            thread([note(50, "me", at), note(51, "alice", at)], true),
            thread([note(60, "alice", at), note(61, "me", at)]),
        ];
        const asReviewer = analyzeMr({
            mr: mr(3, "alice"),
            me: "me",
            since: SINCE,
            seenNoteId: undefined,
            discussions,
            pipeline: null,
            todos: [],
        });
        const asAuthor = analyzeMr({
            mr: mr(3, "me"),
            me: "me",
            since: SINCE,
            seenNoteId: undefined,
            discussions,
            pipeline: null,
            todos: [],
        });

        expect(asReviewer.waiting.map((w) => w.noteId)).toEqual([31]);
        expect(asReviewer.waiting[0]?.url).toBe(`${MR_URL}/3#note_31`);
        expect(asAuthor.waiting.map((w) => w.noteId)).toEqual([31, 40]);
    });

    test("a failed pipeline counts only on your MR and only when it failed after the mark", () => {
        const failed = { status: "failed", web_url: "https://ci/1", updated_at: "2026-10-21T00:00:00Z" };
        const old = { ...failed, updated_at: "2026-10-19T00:00:00Z" };
        const base = { me: "me", since: SINCE, seenNoteId: undefined, discussions: [], todos: [] };

        expect(analyzeMr({ ...base, mr: mr(4, "me"), pipeline: failed }).pipelineFailed).toEqual({
            url: "https://ci/1",
        });
        expect(analyzeMr({ ...base, mr: mr(4, "me"), pipeline: old }).pipelineFailed).toBeNull();
        expect(analyzeMr({ ...base, mr: mr(4, "alice"), pipeline: failed }).pipelineFailed).toBeNull();
    });
});

describe("isTodoNews", () => {
    const todo = (action: string, author: string, createdAt: string): InboxTodo => ({
        id: 1,
        projectId: FAKE_PROJECT_ID,
        iid: 5,
        action,
        author,
        title: "MR 5",
        url: `${MR_URL}/5`,
        createdAt,
    });
    const opts = { me: { id: 99, username: "me" }, since: SINCE };

    test("pending to-dos remain visible across checks even if old or self-created", () => {
        expect(isTodoNews(todo("review_requested", "bob", "2026-10-19T00:00:00Z"), opts)).toBe(true);
        expect(isTodoNews(todo("marked", "me", "2026-10-19T00:00:00Z"), opts)).toBe(true);
    });
});

describe("the state file", () => {
    const dir = mkdtempSync(join(tmpdir(), "gitlab-inbox-"));

    test("a missing file is no check; a check round-trips; the marks only grow", () => {
        const path = join(dir, "inbox.json");
        expect(readInboxState(path)).toEqual({ checks: {} });

        const seen = analyzeMr({
            mr: mr(7, "me"),
            me: "me",
            since: SINCE,
            seenNoteId: undefined,
            discussions: [single(note(70, "bob", "2026-10-21T00:00:00Z"))],
            pipeline: null,
            todos: [],
        });
        const check = advanceCheck(
            { lastCheckedAt: SINCE, mrs: { "4242!7": 99, "4242!8": 5 } },
            "2026-10-22T00:00:00Z",
            [seen]
        );
        writeInboxState(path, { checks: { k: check } });

        expect(readInboxState(path).checks.k).toEqual({
            lastCheckedAt: "2026-10-22T00:00:00Z",
            mrs: { "4242!7": 99, "4242!8": 5 },
        });
    });

    test("a file that is not an inbox state is an error, never a silent reset", () => {
        const path = join(dir, "broken.json");
        writeFileSync(path, "[1, 2]");

        expect(() => readInboxState(path)).toThrow("is not an inbox state file");
    });
});

describe("collectInbox against a fake GitLab", () => {
    beforeAll(() => startFakeRuntime());
    afterAll(() => stopFakeRuntime());

    const api = { host: FAKE_HOST, token: FAKE_TOKEN };
    const at = "2026-10-21T08:00:00Z";
    const listed = (iid: number, author: string) => ({
        project_id: FAKE_PROJECT_ID,
        iid,
        title: `MR ${iid}`,
        web_url: `${MR_URL}/${iid}`,
        author: { username: author },
        updated_at: at,
        state: "opened",
    });

    function fakeGitLab(): FakeGitLab {
        const project = `/projects/${FAKE_PROJECT_ID}/merge_requests`;

        return new FakeGitLab()
            .get("/todos", [
                {
                    id: 1,
                    project: { id: FAKE_PROJECT_ID },
                    author: { username: "bob" },
                    action_name: "review_requested",
                    target_type: "MergeRequest",
                    target: { iid: 3, title: "MR 3" },
                    target_url: `${MR_URL}/3`,
                    created_at: at,
                },
                {
                    id: 2,
                    project: { id: FAKE_PROJECT_ID },
                    author: { username: "carol" },
                    action_name: "mentioned",
                    target_type: "Issue",
                    target: { iid: 9, title: "An issue" },
                    target_url: `${FAKE_HOST}/acme/widgets/-/issues/9`,
                    created_at: at,
                },
            ])
            .get(project, (request) =>
                request.query.get("author_username") === "me" ? [listed(1, "me")] : [listed(2, "alice")]
            )
            .get("/users/99/events", [
                {
                    project_id: FAKE_PROJECT_ID,
                    action_name: "commented on",
                    created_at: at,
                    note: { noteable_type: "MergeRequest", noteable_iid: 4 },
                },
            ])
            .get(`${project}/3`, listed(3, "bob"))
            .get(`${project}/4`, { ...listed(4, "dave"), updated_at: "2026-10-01T00:00:00Z" })
            .get(`${project}/1/discussions`, [single(note(10, "bob", at)), thread([note(11, "bob", at)])])
            .get(`${project}/1/pipelines`, [{ status: "failed", web_url: "https://ci/9", updated_at: at }])
            .get(`${project}/2/discussions`, [single(note(20, "alice", at, { system: true, body: "added 1 commit" }))])
            .get(`${project}/3/discussions`, [])
            .get(`${project}/4/discussions`, []);
    }

    test("lists your MRs, MRs you review and pending to-do MRs", async () => {
        const fake = fakeGitLab();
        const { value } = await scoped(fake, () =>
            collectInbox(api, {
                me: { id: 99, username: "me" },
                since: SINCE,
                role: "all",
                projectId: FAKE_PROJECT_ID,
                marks: {},
                lookbackDays: 30,
            })
        );
        const report = buildInboxReport({
            host: FAKE_HOST,
            user: "me",
            scope: "project acme/widgets",
            since: SINCE,
            sinceSource: "mark",
            seen: value.seen,
            otherTodos: value.otherTodos,
            errors: value.errors,
        });

        expect(value.errors).toEqual([]);
        expect(report.own.map((a) => a.mr.iid)).toEqual([1]);
        expect(report.reviewing.map((a) => a.mr.iid).sort()).toEqual([2, 3]);
        expect(report.own[0]?.pipelineFailed).toEqual({ url: "https://ci/9" });
        expect(report.own[0]?.waiting.map((w) => w.noteId)).toEqual([11]);
        expect(report.otherTodos.map((t) => t.title)).toEqual(["An issue"]);
        // one waiting thread, one review request, one other to-do
        expect(report.waits).toBe(3);
        expect(fake.calls("GET", "/todos")[0]?.query.get("project_id")).toBe(String(FAKE_PROJECT_ID));
        expect(fake.calls("GET", `/projects/${FAKE_PROJECT_ID}/merge_requests/4/discussions`)).toHaveLength(1);

        const text = renderInboxText(report);
        expect(text).toContain("1 of your MRs and 2 MRs you review have new activity. 3 items wait for you.");
        expect(text).toContain("Reviews you received\n  !1 MR 1  (acme/widgets)");
        expect(text).toContain(`🔴 bob waits for your reply: ${MR_URL}/1#note_11`);
        expect(text).toContain("📌 review requested by bob");
    });

    test("open waiting threads and pending to-dos survive the next check", async () => {
        const fake = fakeGitLab();
        const { value } = await scoped(fake, async () => {
            const base = {
                me: { id: 99, username: "me" },
                role: "all" as const,
                projectId: FAKE_PROJECT_ID,
                lookbackDays: 30,
            };
            const first = await collectInbox(api, { ...base, since: SINCE, marks: {} });
            const mark = advanceCheck(undefined, "2026-10-22T00:00:00Z", first.seen);
            const second = await collectInbox(api, { ...base, since: mark.lastCheckedAt, marks: mark.mrs });
            return { first, second };
        });
        expect(value.first.errors).toEqual([]);
        expect(value.second.errors).toEqual([]);
        expect(value.second.seen.find((a) => a.mr.iid === 1)?.waiting).toHaveLength(1);
        expect(value.second.seen.find((a) => a.mr.iid === 3)?.todos).toHaveLength(1);
        expect(value.second.otherTodos).toHaveLength(1);
    });

    test("a failed request is reported and the rest is still read", async () => {
        const fake = fakeGitLab().get(`/projects/${FAKE_PROJECT_ID}/merge_requests/2/discussions`, () =>
            Response.json({ message: "boom" }, { status: 400 })
        );
        const { value } = await scoped(fake, () =>
            collectInbox(api, {
                me: { id: 99, username: "me" },
                since: SINCE,
                role: "all",
                projectId: FAKE_PROJECT_ID,
                marks: {},
                lookbackDays: 30,
            })
        );

        expect(value.errors.some((e) => e.startsWith("!2 discussions"))).toBe(true);
        expect(value.seen.map((a) => a.mr.iid).sort()).toEqual([1, 3, 4]);
    });
});
