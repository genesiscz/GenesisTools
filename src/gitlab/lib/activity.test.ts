import { describe, expect, test } from "bun:test";

import {
    type ActivityDay,
    type ActivityEvent,
    apiWindow,
    buildReport,
    describeEvent,
    localDay,
    parseDay,
    renderMarkdown,
    renderText,
    targetUrl,
} from "@app/gitlab/lib/activity";

const TZ = "Europe/Berlin";

function ev(partial: Partial<ActivityEvent> & { id: number; created_at: string }): ActivityEvent {
    return { project_id: 1, action_name: "commented on", target_type: "Note", ...partial } as ActivityEvent;
}

const PROJECTS = new Map([
    [1, "acme/web-app"],
    [2, "acme/tools"],
]);

describe("window and local days", () => {
    test("widens the exclusive API window by two days across a month boundary", () => {
        expect(apiWindow({ from: "2026-09-01", to: "2026-09-30" })).toEqual({
            after: "2026-08-30",
            before: "2026-10-02",
        });
    });

    // 22:30 UTC on 16.9 is 00:30 on 17.9 in Berlin (CEST, UTC+2).
    test("converts a late UTC timestamp to the next local day", () => {
        expect(localDay("2026-09-16T22:30:00Z", TZ)).toBe("2026-09-17");
        expect(localDay("2026-09-16T21:59:00Z", TZ)).toBe("2026-09-16");
    });

    test("rejects a date that is not YYYY-MM-DD", () => {
        expect(() => parseDay("16.9.2026", "--from")).toThrow("--from must be a date as YYYY-MM-DD");
        expect(parseDay("2026-09-16", "--from")).toBe("2026-09-16");
    });
});

describe("describeEvent", () => {
    test("a comment names the merge request it was written on", () => {
        const d = describeEvent(
            ev({
                id: 1,
                created_at: "2026-09-16T08:00:00Z",
                target_title: "Draft: move data fetching to hooks",
                note: { noteable_type: "MergeRequest", noteable_iid: 42, body: "x" },
            })
        );

        expect(d).toEqual({
            verb: "commented on",
            target: "!42",
            title: "Draft: move data fetching to hooks",
            commits: 0,
        });
    });

    test("a push names the branch and carries its commit count", () => {
        const d = describeEvent(
            ev({
                id: 2,
                created_at: "2026-09-16T08:00:00Z",
                action_name: "pushed to",
                target_type: null,
                push_data: {
                    commit_count: 12,
                    action: "pushed",
                    ref_type: "branch",
                    ref: "fix/session-timeout",
                    commit_from: "a",
                    commit_to: "b",
                    commit_title: "fix: retry the refresh",
                },
            })
        );

        expect(d).toEqual({
            verb: "pushed to",
            target: "fix/session-timeout",
            title: "fix: retry the refresh",
            commits: 12,
        });
    });

    test("a new branch push and a merge read as such", () => {
        const created = describeEvent(
            ev({
                id: 3,
                created_at: "2026-09-16T08:00:00Z",
                action_name: "pushed new",
                target_type: null,
                push_data: {
                    commit_count: 1,
                    action: "created",
                    ref_type: "branch",
                    ref: "feat/x",
                    commit_from: null,
                    commit_to: "c",
                    commit_title: "feat: x",
                },
            })
        );
        const merged = describeEvent(
            ev({
                id: 4,
                created_at: "2026-09-16T08:00:00Z",
                action_name: "accepted",
                target_type: "MergeRequest",
                target_iid: 43,
                target_title: "remove the legacy banner",
            })
        );

        expect(created.verb).toBe("pushed new branch");
        expect(merged).toEqual({ verb: "merged", target: "!43", title: "remove the legacy banner", commits: 0 });
    });
});

describe("buildReport", () => {
    const events: ActivityEvent[] = [
        ev({
            id: 10,
            created_at: "2026-09-16T08:00:00Z",
            target_title: "Draft: data hooks",
            note: { noteable_type: "MergeRequest", noteable_iid: 42, body: "first" },
        }),
        ev({
            id: 11,
            created_at: "2026-09-16T09:30:00Z",
            target_title: "Draft: data hooks",
            note: { noteable_type: "MergeRequest", noteable_iid: 42, body: "second" },
        }),
        ev({
            id: 12,
            created_at: "2026-09-16T12:00:00Z",
            target_title: "Draft: data hooks",
            note: { noteable_type: "MergeRequest", noteable_iid: 42, body: "third" },
        }),
        ev({
            id: 13,
            created_at: "2026-09-16T13:00:00Z",
            project_id: 2,
            action_name: "pushed to",
            target_type: null,
            push_data: {
                commit_count: 3,
                action: "pushed",
                ref_type: "branch",
                ref: "main",
                commit_from: "a",
                commit_to: "b",
                commit_title: "t",
            },
        }),
        ev({
            id: 14,
            created_at: "2026-09-16T14:00:00Z",
            project_id: 2,
            action_name: "pushed to",
            target_type: null,
            push_data: {
                commit_count: 4,
                action: "pushed",
                ref_type: "branch",
                ref: "main",
                commit_from: "b",
                commit_to: "c",
                commit_title: "t2",
            },
        }),
        // 21:30 UTC on 18.9 is 23:30 local on 18.9: inside the range.
        ev({
            id: 15,
            created_at: "2026-09-18T21:30:00Z",
            action_name: "approved",
            target_type: "MergeRequest",
            target_iid: 44,
            target_title: "rate limit",
        }),
        // 22:30 UTC on 18.9 is 00:30 local on 19.9 (Saturday): outside a range ending 18.9.
        ev({
            id: 16,
            created_at: "2026-09-18T22:30:00Z",
            action_name: "approved",
            target_type: "MergeRequest",
            target_iid: 1,
            target_title: "late",
        }),
        // 21:00 UTC on 15.9 is 23:00 local on 15.9: before the range.
        ev({
            id: 17,
            created_at: "2026-09-15T21:00:00Z",
            target_title: "early",
            note: { noteable_type: "Issue", noteable_iid: 5 },
        }),
        ev({
            id: 18,
            created_at: "2026-09-17T08:00:00Z",
            project_id: 99,
            action_name: "opened",
            target_type: "MergeRequest",
            target_iid: 3,
            target_title: "secret",
        }),
    ];

    const report = buildReport({
        events,
        projects: PROJECTS,
        range: { from: "2026-09-16", to: "2026-09-18" },
        tz: TZ,
        user: "alice",
        fetched: events.length,
        pages: 1,
        truncated: false,
    });

    function dayAt(index: number): ActivityDay {
        const day = report.days[index];

        if (!day) {
            throw new Error(`no day at index ${index}`);
        }

        return day;
    }

    test("keeps exactly the events whose LOCAL day is in the range", () => {
        expect(report.inRange).toBe(7);
        expect(report.days.map((d) => [d.day, d.total])).toEqual([
            ["2026-09-16", 5],
            ["2026-09-17", 1],
            ["2026-09-18", 1],
        ]);
    });

    test("three comments on one merge request become one group with its time span", () => {
        const day = dayAt(0);
        const comments = day.groups.find((g) => g.target === "!42");

        expect(comments).toMatchObject({
            verb: "commented on",
            count: 3,
            first: "10:00",
            last: "14:00",
            project: "acme/web-app",
        });
        expect(day.groups[0]?.target).toBe("!42");
    });

    test("pushes to one branch sum their commits", () => {
        const pushes = dayAt(0).groups.find((g) => g.verb === "pushed to");

        expect(pushes).toMatchObject({ target: "main", count: 2, commits: 7, project: "acme/tools" });
        expect(dayAt(0).commits).toBe(7);
    });

    test("an unreadable project is labelled by id, never dropped", () => {
        expect(dayAt(1).rows[0]?.project).toBe("project#99");
    });

    test("a weekday with no events still appears, a weekend day without events does not", () => {
        const quiet = buildReport({
            events: [],
            projects: PROJECTS,
            range: { from: "2026-09-18", to: "2026-09-21" },
            tz: TZ,
            user: "alice",
            fetched: 0,
            pages: 1,
            truncated: false,
        });

        expect(quiet.days.map((d) => d.day)).toEqual(["2026-09-18", "2026-09-21"]);
        expect(renderText(quiet)).toContain("(no events)");
    });

    test("the project filter keeps one project by path", () => {
        const one = buildReport({
            events,
            projects: PROJECTS,
            range: { from: "2026-09-16", to: "2026-09-16" },
            tz: TZ,
            user: "alice",
            fetched: events.length,
            pages: 1,
            truncated: false,
            project: "acme/tools",
        });

        expect(one.inRange).toBe(2);
    });

    test("the text summary reads as counts per action", () => {
        const text = renderText(report);

        expect(text).toContain("   3x commented on !42 Draft: data hooks");
        expect(text).toContain("=== 2026-09-16 Wed · 5 events · 7 commits pushed ===");
    });
});

describe("links", () => {
    const HOST = "https://gitlab.example.com";

    test("a comment links to its merge request, the row with the note anchor", () => {
        const e = ev({
            id: 1,
            created_at: "2026-09-16T08:00:00Z",
            note: { id: 555, noteable_type: "MergeRequest", noteable_iid: 42 },
        });

        expect(targetUrl(HOST, "acme/web-app", e, { anchor: false })).toBe(
            "https://gitlab.example.com/acme/web-app/-/merge_requests/42"
        );
        expect(targetUrl(HOST, "acme/web-app", e, { anchor: true })).toBe(
            "https://gitlab.example.com/acme/web-app/-/merge_requests/42#note_555"
        );
    });

    test("a push links to the branch's commits, an issue to the issue, an unknown project to nothing", () => {
        const push = ev({
            id: 2,
            created_at: "2026-09-16T08:00:00Z",
            action_name: "pushed to",
            target_type: null,
            push_data: {
                commit_count: 2,
                action: "pushed",
                ref_type: "branch",
                ref: "feat/a b",
                commit_from: "a",
                commit_to: "b",
                commit_title: "t",
            },
        });
        const issue = ev({
            id: 3,
            created_at: "2026-09-16T08:00:00Z",
            action_name: "opened",
            target_type: "Issue",
            target_iid: 12,
        });

        expect(targetUrl(HOST, "acme/tools", push, { anchor: false })).toBe(
            "https://gitlab.example.com/acme/tools/-/commits/feat%2Fa%20b"
        );
        expect(targetUrl(HOST, "acme/tools", issue, { anchor: false })).toBe(
            "https://gitlab.example.com/acme/tools/-/issues/12"
        );
        expect(targetUrl(HOST, "project#99", issue, { anchor: false })).toBeUndefined();
    });

    test("with a host, groups carry the target and project links and markdown uses them", () => {
        const report = buildReport({
            events: [
                ev({
                    id: 10,
                    created_at: "2026-09-16T08:00:00Z",
                    target_title: "Draft: data hooks",
                    note: { id: 7, noteable_type: "MergeRequest", noteable_iid: 42 },
                }),
            ],
            projects: PROJECTS,
            range: { from: "2026-09-16", to: "2026-09-16" },
            tz: TZ,
            user: "alice",
            fetched: 1,
            pages: 1,
            truncated: false,
            host: HOST,
        });
        const group = report.days[0]?.groups[0];

        expect(group?.url).toBe("https://gitlab.example.com/acme/web-app/-/merge_requests/42");
        expect(group?.projectUrl).toBe("https://gitlab.example.com/acme/web-app");
        expect(report.days[0]?.rows[0]?.url).toBe("https://gitlab.example.com/acme/web-app/-/merge_requests/42#note_7");
        expect(renderMarkdown(report)).toContain(
            "[commented on !42](https://gitlab.example.com/acme/web-app/-/merge_requests/42)"
        );
    });
});
