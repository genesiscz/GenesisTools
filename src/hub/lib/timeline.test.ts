import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionRow } from "@app/ai/lib/sessions/agent-session-rows";
import type { DecisionRecord } from "@app/question/lib/decisions/store";
import { env } from "@genesiscz/utils/env";
import { Storage } from "@genesiscz/utils/storage";
import type { ThreadsResult } from "./pr";
import type { HubPr } from "./prs";
import {
    buildTimeline,
    cachedPatchIds,
    commentTitle,
    fullPrLists,
    keepsEvent,
    lastRecordedBranch,
    pageEvents,
    parsePushes,
    patchIdsOf,
    prListSince,
    prRangeLimit,
    realTimelineDeps,
    resolveRange,
    type SourceEvents,
    TIMELINE_DEFAULT_RANGE,
    TIMELINE_LIMITS,
    type TimelineDeps,
    type TimelineEvent,
    type TimelineNotifyItem,
    timelineLogArgs,
} from "./timeline";

const NOW = new Date("2026-03-02T15:00:00");
const SINCE = new Date("2026-03-02T00:00:00");
const at = (clock: string) => new Date(`2026-03-02T${clock}`).getTime();
const seconds = (clock: string) => Math.floor(at(clock) / 1000);

/** One commit in `git log -z LOG_FORMAT_WITH_SOURCE` form; `authored` is the author time when it differs (a pick). */
function logEntry(
    sha: string,
    subject: string,
    clock: string,
    email = "alice@example.com",
    { source = "refs/heads/main", authored }: { source?: string; authored?: string } = {}
): string {
    const epoch = String(seconds(clock));
    const authorEpoch = authored ? String(seconds(authored)) : epoch;
    const name = email.startsWith("alice") ? "Alice" : "Bob";
    return [sha, sha.slice(0, 7), "", name, email, authorEpoch, name, email, epoch, subject, "", source]
        .map((field) => `${field}\0`)
        .join("");
}

const REPO = { root: process.cwd(), commonDir: `${process.cwd()}/.git` };

function session(overrides: Partial<AgentSessionRow>): AgentSessionRow {
    return {
        provider: "claude",
        sessionId: "s-alpha",
        title: "parser work",
        cwd: process.cwd(),
        cwdShort: "app",
        project: "app",
        mtime: at("14:00:00"),
        model: null,
        account: "work",
        filePath: "/tmp/gt-timeline/s-alpha.jsonl",
        ...overrides,
    };
}

const PR: HubPr = {
    number: 7,
    title: "Parser rewrite",
    state: "MERGED",
    draft: false,
    author: "alice",
    headBranch: "feat/parser",
    baseBranch: "main",
    url: "https://github.com/acme/app/pull/7",
    createdAt: new Date(at("10:10:00")).toISOString(),
    updatedAt: new Date(at("12:00:00")).toISOString(),
    labels: [],
    reviewers: [],
    reviewDecision: null,
    approvals: null,
    ci: "failed",
    comments: null,
    headSha: null,
    crossRepository: false,
    headRepo: null,
    repo: "app",
    repoRoot: process.cwd(),
    origin: { kind: "github", host: "github.com", web: "https://github.com/acme/app" },
    localWorktree: null,
    isMine: true,
    proposal: null,
};

const THREADS: ThreadsResult = {
    pr: {
        provider: "github",
        host: "github.com",
        project: "acme/app",
        number: 7,
        url: "https://github.com/acme/app/pull/7",
        webUrl: "https://github.com/acme/app/pull/7",
        title: "Parser rewrite",
        state: "MERGED",
        draft: false,
        author: "alice",
        sourceBranch: "feat/parser",
        targetBranch: "main",
        headSha: null,
        baseSha: null,
        crossRepository: false,
        headRepo: null,
        repoPath: process.cwd(),
    },
    threads: [
        {
            id: "t1",
            path: "src/parse.ts",
            side: "additions",
            line: 12,
            outdated: false,
            resolved: false,
            resolvable: true,
            comments: [
                {
                    id: "c-old",
                    author: { name: "Bob", username: "bob" },
                    bodyMarkdown: "old",
                    createdAt: "2026-03-01T12:00:00.000Z",
                    isDraft: false,
                },
                {
                    id: "c-today",
                    author: { name: "Bob", username: "bob" },
                    bodyMarkdown: "🧹 Quality | Medium\n\n**Guard the empty input**\n\nmore",
                    createdAt: new Date(at("12:30:00")).toISOString(),
                    isDraft: false,
                },
            ],
        },
    ],
    draftCount: 0,
    viewer: "alice",
    cached: true,
    fetchedAt: "2026-03-02T12:31:00.000Z",
};

function decision(overrides: Partial<DecisionRecord>): DecisionRecord {
    return {
        id: "d_1_s-alpha",
        sessionId: "s-alpha",
        number: 1,
        prompt: "Keep the parser cache between runs?",
        options: ["a) keep it", "b) drop it"],
        state: "answered",
        option: "a",
        project: "app",
        cwd: process.cwd(),
        createdTs: new Date(at("12:40:00")).toISOString(),
        updatedTs: new Date(at("13:00:00")).toISOString(),
        ...overrides,
    };
}

const NOTIFY_ITEMS: TimelineNotifyItem[] = [
    {
        type: "ciFailed",
        key: "github.com/acme/app#7",
        provider: "github",
        project: "acme/app",
        number: 7,
        url: "https://github.com/acme/app/pull/7",
        title: "Parser rewrite",
        message: "CI failed",
        at: new Date(at("12:45:00")).toISOString(),
        posted: true,
    },
    {
        type: "thread",
        key: "github.com/acme/app#7",
        provider: "github",
        project: "acme/app",
        number: 7,
        url: "https://github.com/acme/app/pull/7",
        title: "Parser rewrite",
        message: "a thread",
        at: new Date(at("12:46:00")).toISOString(),
        posted: true,
    },
];

function deps(overrides: Partial<TimelineDeps> = {}): TimelineDeps {
    return {
        sessions: async () => [
            session({}),
            session({ sessionId: "s-old", title: "yesterday", mtime: at("00:00:00") - 3_600_000 }),
        ],
        birth: (path) => (path.endsWith("s-alpha.jsonl") ? at("09:00:00") : null),
        lastBranch: () => null,
        repoOf: async () => REPO,
        commits: async () => ({
            log:
                logEntry("a".repeat(40), "feat: parser", "10:00:00") +
                logEntry("b".repeat(40), "fix: cache", "11:00:00") +
                logEntry("c".repeat(40), "chore: bob's lint", "11:30:00", "bob@example.com"),
            email: "alice@example.com",
        }),
        commitCopies: async () => ({ patchIds: new Map(), onHead: new Set() }),
        remoteLogs: () => [
            {
                branch: "feat/parser",
                lines: [
                    `${"0".repeat(40)} ${"a".repeat(40)} Alice <alice@example.com> ${seconds("10:05:00")} +0100\tupdate by push`,
                    `${"a".repeat(40)} ${"b".repeat(40)} Alice <alice@example.com> ${seconds("11:05:00")} +0100\tfetch: fast-forward`,
                ],
            },
        ],
        prs: async () => [PR],
        threads: () => [THREADS],
        decisions: () => [
            decision({}),
            decision({
                id: "d_2_s-alpha",
                number: 2,
                state: "open",
                option: undefined,
                prompt: "Ship the parser today?",
                createdTs: new Date(at("13:30:00")).toISOString(),
                updatedTs: new Date(at("13:30:00")).toISOString(),
            }),
            decision({
                id: "d_3_s-alpha",
                number: 3,
                state: "dismissed",
                updatedTs: new Date(at("13:40:00")).toISOString(),
            }),
        ],
        notifyItems: () => NOTIFY_ITEMS,
        ...overrides,
    };
}

async function scratchStorage(): Promise<Storage> {
    const home = mkdtempSync(`${tmpdir()}/gt-timeline-`);
    let storage: Storage | undefined;
    await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, () => {
        storage = new Storage("hub");
    });

    if (!storage) {
        throw new Error("no scratch storage");
    }

    return storage;
}

function event(id: string, atText: string, extra: Partial<TimelineEvent> = {}): TimelineEvent {
    return { id, kind: "commit", at: atText, title: id, detail: null, project: null, repo: null, ...extra };
}

describe("timeline", () => {
    test("one feed of sessions, commits, pushes, PR events, comments, decisions and CI, newest first", async () => {
        const result = await buildTimeline({
            since: SINCE,
            now: NOW,
            deps: deps(),
            storage: await scratchStorage(),
            maxCacheAgeSeconds: 0,
        });

        expect(result.events.map((event) => [event.kind, event.detail])).toEqual([
            ["session.turn", "last turn"],
            ["decision", "#2 waiting"],
            ["decision", "#1 answered: a)"],
            ["ci", "CI failed · acme/app#7"],
            ["thread", "src/parse.ts:12 · acme/app#7"],
            ["pr", "merged acme/app#7"],
            ["commit", "cccccccc"],
            ["commit", "bbbbbbbb"],
            ["pr", "opened acme/app#7"],
            ["push", "new branch at aaaaaaaa"],
            ["commit", "aaaaaaaa"],
            ["session.start", "started"],
        ]);
        expect(result.events.find((event) => event.kind === "thread")?.title).toBe("Guard the empty input");
        expect(result.events[0]).toMatchObject({
            sessionId: "s-alpha",
            repo: process.cwd(),
            mine: true,
            cwd: process.cwd(),
        });
        expect(result.counts).toMatchObject({ commit: 3, push: 1, pr: 2, thread: 1, decision: 2, ci: 1 });
        expect(result).toMatchObject({ hasMore: false, nextBefore: null, truncated: [], before: null });
    });

    test("who did it and what needs me are marked on every row", async () => {
        const { events } = await buildTimeline({
            since: SINCE,
            now: NOW,
            deps: deps(),
            storage: await scratchStorage(),
            maxCacheAgeSeconds: 0,
        });
        const byId = new Map(events.map((event) => [event.id, event]));

        expect(byId.get(`commit:${"b".repeat(40)}`)?.mine).toBe(true);
        expect(byId.get(`commit:${"c".repeat(40)}`)?.mine).toBe(false);
        expect(byId.get("thread:c-today")).toMatchObject({
            mine: false,
            needsMe: true,
            threadId: "t1",
            path: "src/parse.ts",
            line: 12,
            state: "open",
        });
        expect(byId.get("decision:d_2_s-alpha")).toMatchObject({ needsMe: true, state: "open", sessionId: "s-alpha" });
        expect(byId.get("decision:d_1_s-alpha")?.needsMe).toBeUndefined();
        expect(byId.get("pr-open:acme/app#7")).toMatchObject({ mine: true, state: "MERGED", ci: "failed" });
        expect(events.find((event) => event.kind === "ci")).toMatchObject({
            needsMe: true,
            mine: true,
            state: "failed",
            project: "app",
            repo: process.cwd(),
        });
        // A push names the PR of its branch, so the row can open it without a lookup.
        expect(events.find((event) => event.kind === "push")).toMatchObject({
            pr: { ref: "acme/app#7" },
            fromSha: "0".repeat(40),
            mine: true,
        });
    });

    test("the feed is served from its cache unless asked fresh, and without PRs the network is not called", async () => {
        const storage = await scratchStorage();
        let listed = 0;
        const counting = deps({
            prs: async () => {
                listed++;
                return [];
            },
        });

        await buildTimeline({ since: SINCE, now: NOW, deps: counting, storage });
        const again = await buildTimeline({ since: SINCE, now: NOW, deps: counting, storage });
        await buildTimeline({ since: SINCE, now: NOW, deps: counting, storage, prs: false, maxCacheAgeSeconds: 0 });

        expect(again.cached).toBe(true);
        expect(listed).toBe(1);
    });

    test("a rolling range hits the cache within its minute, though its start moved", async () => {
        const storage = await scratchStorage();
        const minute = Math.floor(SINCE.getTime() / 60_000) * 60_000;
        const later = (ms: number) => new Date(minute + ms);

        await buildTimeline({ since: later(1_000), now: new Date(NOW.getTime() + 1_000), deps: deps({}), storage });
        const again = await buildTimeline({
            since: later(31_000),
            now: new Date(NOW.getTime() + 31_000),
            deps: deps({}),
            storage,
        });

        expect(again.cached).toBe(true);
    });

    test("a live page whose process started seconds after its end still shares the live cache", async () => {
        const storage = await scratchStorage();
        const minute = Math.floor(SINCE.getTime() / 60_000) * 60_000;
        const later = (ms: number) => new Date(minute + ms);
        // The hub sets `--until` to its own clock, then Bun starts: 3 s under load, so `now` is past `until`.
        const first = new Date(NOW.getTime() + 1_000);
        await buildTimeline({
            since: later(1_000),
            until: first,
            now: new Date(first.getTime() + 3_000),
            deps: deps({}),
            storage,
        });
        const second = new Date(NOW.getTime() + 21_000);
        const again = await buildTimeline({
            since: later(21_000),
            until: second,
            now: new Date(second.getTime() + 3_000),
            deps: deps({}),
            storage,
        });

        expect(again.cached).toBe(true);
    });

    test("a failing repository or PR list is a warning, not an empty feed", async () => {
        const result = await buildTimeline({
            since: SINCE,
            now: NOW,
            storage: await scratchStorage(),
            maxCacheAgeSeconds: 0,
            deps: deps({
                commits: async () => {
                    throw new Error("git log exited 128");
                },
                prs: async () => {
                    throw new Error("gh: not logged in");
                },
            }),
        });

        expect(result.warnings).toEqual([expect.stringContaining("git log exited 128"), "PRs: gh: not logged in"]);
        expect(result.counts["session.turn"]).toBe(1);
    });
});

describe("timeline: a change picked onto several branches is one row", () => {
    const D = "d".repeat(40);
    const E = "e".repeat(40);
    const F = "f".repeat(40);
    const G = "9".repeat(40);
    const H = "8".repeat(40);
    const subject = "fix(hub): stale rows";

    function picks(log: string, facts: Partial<{ patchIds: Map<string, string>; onHead: Set<string> }> = {}) {
        const asked: string[][] = [];
        return {
            asked,
            deps: deps({
                commits: async () => ({ log, email: "alice@example.com" }),
                commitCopies: async (_repo, shas) => {
                    asked.push(shas);
                    return { patchIds: facts.patchIds ?? new Map(), onHead: facts.onHead ?? new Set() };
                },
            }),
        };
    }

    async function commits(fixture: ReturnType<typeof picks>) {
        const page = await buildTimeline({
            since: SINCE,
            now: NOW,
            deps: fixture.deps,
            storage: await scratchStorage(),
            prs: false,
            maxCacheAgeSeconds: 0,
        });
        return { page, rows: page.events.filter((event) => event.kind === "commit") };
    }

    test("the copy on the checked-out branch stays, even when a newer pick exists, and names the others", async () => {
        // D landed on the checked-out branch at 12:00; E is the same change picked onto polish/hub-ui at 12:30
        // with a conflict resolved (another patch-id), F onto polish/perf at 12:40 with the same patch as D.
        const fixture = picks(
            logEntry(F, subject, "12:40:00", undefined, { source: "refs/heads/polish/perf", authored: "11:50:00" }) +
                logEntry(E, subject, "12:30:00", undefined, {
                    source: "refs/heads/polish/hub-ui",
                    authored: "11:50:00",
                }) +
                logEntry(D, subject, "12:00:00", undefined, { source: "refs/heads/feat/main", authored: "11:50:00" }) +
                logEntry("a".repeat(40), "feat: parser", "10:00:00"),
            {
                patchIds: new Map([
                    [D, "p1"],
                    [E, "p2"],
                    [F, "p1"],
                ]),
                onHead: new Set([D]),
            }
        );
        const { page, rows } = await commits(fixture);

        expect(rows.map((row) => row.sha)).toEqual([D, "a".repeat(40)]);
        expect(rows[0].alsoOn).toEqual([
            { sha: F, branch: "polish/perf" },
            { sha: E, branch: "polish/hub-ui" },
        ]);
        expect(rows[0].detail).toBe("dddddddd · also on polish/perf, polish/hub-ui");
        // The counts the hub's groups show are the rows it draws.
        expect(page.counts.commit).toBe(rows.length);
        expect(fixture.asked).toEqual([[F, E, D]]);
    });

    test("with no copy on the checked-out branch the newest landing stays; equal patch-ids fold a reworded pick", async () => {
        const fixture = picks(
            // G is H reworded while it was picked: the author time stays, the subject and the sha do not.
            logEntry(G, "fix: cache (picked)", "12:20:00", undefined, {
                source: "refs/remotes/origin/release",
                authored: "12:10:00",
            }) +
                logEntry(H, "fix: cache", "12:10:00", undefined, { source: "refs/heads/feat/x" }) +
                logEntry(E, "fix: cache", "12:00:00", undefined, { source: "refs/heads/feat/y" }),
            {
                patchIds: new Map([
                    [G, "p9"],
                    [H, "p9"],
                    [E, "p7"],
                ]),
            }
        );
        const { rows } = await commits(fixture);

        // G and H share a patch; E only a subject: another change with the same title stays its own row.
        expect(rows.map((row) => row.sha)).toEqual([G, E]);
        expect(rows[0].detail).toBe("99999999 · also on feat/x");
    });

    test("a change applied twice on the checked-out branch keeps both rows", async () => {
        const fixture = picks(
            logEntry(E, subject, "12:30:00", undefined, { authored: "11:50:00" }) +
                logEntry(D, subject, "12:00:00", undefined, { authored: "11:50:00" }),
            {
                patchIds: new Map([
                    [D, "p1"],
                    [E, "p1"],
                ]),
                onHead: new Set([D, E]),
            }
        );
        const { rows } = await commits(fixture);

        expect(rows.map((row) => row.sha)).toEqual([E, D]);
        expect(rows.every((row) => row.alsoOn === undefined)).toBe(true);
    });

    test("a page without a repeated subject or change asks git nothing more", async () => {
        const fixture = picks(logEntry(D, "one", "12:00:00") + logEntry(E, "two", "12:10:00"));
        await commits(fixture);

        expect(fixture.asked).toEqual([]);
    });

    test("patch-ids are computed once per sha, and a sha with no patch is not asked again", async () => {
        const storage = await scratchStorage();
        const computed: string[][] = [];
        const compute = async (missing: string[]) => {
            computed.push(missing);
            return new Map(missing.filter((sha) => sha !== F).map((sha) => [sha, `p-${sha.slice(0, 1)}`]));
        };

        const first = await cachedPatchIds({ repo: "/repo/.git", shas: [D, E, F], storage, compute });
        const again = await cachedPatchIds({ repo: "/repo/.git", shas: [D, F, G], storage, compute });

        expect(computed).toEqual([[D, E, F], [G]]);
        expect(first.patchIds.get(D)).toBe("p-d");
        expect(first.patchIds.has(F)).toBe(false);
        expect(again.computed).toBe(1);
    });

    test("patchIdsOf gives a cherry-pick the patch-id of its original", async () => {
        const repo = mkdtempSync(join(tmpdir(), "gt-timeline-picks-"));
        const run = (...args: string[]) => {
            const result = Bun.spawnSync(["git", ...args], {
                cwd: repo,
                env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
            });

            if (result.exitCode !== 0) {
                throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
            }

            return result.stdout.toString().trim();
        };
        run("init", "-q", "-b", "main");
        run("config", "user.email", "alice@example.com");
        run("config", "user.name", "Alice");
        writeFileSync(join(repo, "a.txt"), "one\n");
        run("add", "a.txt");
        run("commit", "-q", "-m", "base");
        run("checkout", "-q", "-b", "side");
        writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
        run("commit", "-q", "-am", "add two");
        const original = run("rev-parse", "HEAD");
        run("checkout", "-q", "main");
        // main moves on first, so the pick gets another parent (and sha) than the original.
        writeFileSync(join(repo, "b.txt"), "other\n");
        run("add", "b.txt");
        run("commit", "-q", "-m", "other work");
        run("cherry-pick", original);
        const picked = run("rev-parse", "HEAD");

        const found = await patchIdsOf(repo, [original, picked]);

        expect(picked).not.toBe(original);
        expect(found.get(original)).toBeDefined();
        expect(found.get(picked)).toBe(found.get(original));
    });
});

describe("timeline: the commits git is asked for", () => {
    test("every branch and remote, but not a stash's WIP and index commits", () => {
        const args = timelineLogArgs({
            window: { since: SINCE, upper: NOW },
            limit: 200,
            author: "all",
            email: "alice@example.com",
        });

        // An exclusion only applies to the `--all` after it.
        expect(args.indexOf("--exclude=refs/stash")).toBe(args.indexOf("--all") - 1);
        expect(args).not.toContain("--author=alice@example.com");
        expect(
            timelineLogArgs({
                window: { since: SINCE, upper: NOW },
                limit: 200,
                author: "me",
                email: "alice@example.com",
            })
        ).toContain("--author=alice@example.com");
    });
});

describe("timeline paging", () => {
    test("a page ends where a bounded source ran out, and the cursor continues from there", () => {
        const sources: SourceEvents[] = [
            {
                name: "app commits",
                events: [event("c1", "2026-03-02T12:00:00.000Z"), event("c2", "2026-03-02T10:00:00.000Z")],
                truncated: true,
                oldestAt: "2026-03-02T10:00:00.000Z",
            },
            {
                name: "sessions",
                events: [event("s1", "2026-03-02T11:00:00.000Z"), event("s2", "2026-03-02T09:00:00.000Z")],
                truncated: false,
                oldestAt: "2026-03-02T09:00:00.000Z",
            },
        ];
        const page = pageEvents(sources, 10);

        // s2 at 09:00 is older than the last commit read: it waits for the next page.
        expect(page.events.map((event) => event.id)).toEqual(["c1", "s1", "c2"]);
        expect(page).toMatchObject({
            hasMore: true,
            nextBefore: "2026-03-02T10:00:00.000Z",
            truncated: ["app commits"],
        });
    });

    test("a page shorter than the limit with no bounded source is the end", () => {
        const only = event("s1", "2026-03-02T11:00:00.000Z");
        const page = pageEvents([{ name: "sessions", events: [only], truncated: false, oldestAt: only.at }], 10);
        expect(page).toEqual({ events: [only], hasMore: false, nextBefore: null, truncated: [] });
    });

    test("the limit cuts a long page and the same id from two sources counts once", () => {
        const one = event("x", "2026-03-02T11:00:00.000Z");
        const page = pageEvents(
            [
                { name: "a", events: [one, event("y", "2026-03-02T10:00:00.000Z")], truncated: false, oldestAt: null },
                { name: "b", events: [one, event("z", "2026-03-02T09:00:00.000Z")], truncated: false, oldestAt: null },
            ],
            2
        );
        expect(page.events.map((event) => event.id)).toEqual(["x", "y"]);
        expect(page).toMatchObject({ hasMore: true, nextBefore: "2026-03-02T10:00:00.000Z" });
    });

    test("when the filters empty a truncated page the cursor is the floor, so paging still moves", () => {
        const page = pageEvents([{ name: "a", events: [], truncated: true, oldestAt: "2026-03-02T10:00:00.000Z" }], 10);
        expect(page).toMatchObject({ events: [], hasMore: true, nextBefore: "2026-03-02T10:00:00.000Z" });
    });

    test("buildTimeline pages with before and every event of the range is reached once", async () => {
        const storage = await scratchStorage();
        const all = await buildTimeline({ since: SINCE, now: NOW, deps: deps(), storage, maxCacheAgeSeconds: 0 });
        const seen: string[] = [];
        let before: Date | null = null;

        for (let pages = 0; pages < 10; pages++) {
            const page = await buildTimeline({
                since: SINCE,
                now: NOW,
                deps: deps(),
                storage,
                maxCacheAgeSeconds: 0,
                limit: 3,
                before,
            });
            expect(page.events.length).toBeLessThanOrEqual(3);
            expect(page.before).toBe(before ? before.toISOString() : null);

            for (const event of page.events) {
                if (!seen.includes(event.id)) {
                    seen.push(event.id);
                }
            }

            if (!page.hasMore || !page.nextBefore) {
                break;
            }

            before = new Date(page.nextBefore);
        }

        expect(seen).toEqual(all.events.map((event) => event.id));
    });

    test("an older page reads only its window: sessions and pushes after the cursor stay out", async () => {
        const page = await buildTimeline({
            since: SINCE,
            now: NOW,
            deps: deps(),
            storage: await scratchStorage(),
            maxCacheAgeSeconds: 0,
            before: new Date(at("10:30:00")),
        });
        expect(page.events.map((event) => event.id)).toEqual([
            "pr-open:acme/app#7",
            `push:feat/parser:${"a".repeat(40)}:${at("10:05:00")}`,
            `commit:${"a".repeat(40)}`,
            "start:s-alpha",
        ]);
        expect(page.before).toBe(new Date(at("10:30:00")).toISOString());
    });
});

describe("timeline filters", () => {
    test("author me asks git for my commits and drops what others did", async () => {
        const authors: string[] = [];
        const result = await buildTimeline({
            since: SINCE,
            now: NOW,
            storage: await scratchStorage(),
            maxCacheAgeSeconds: 0,
            filters: { author: "me" },
            deps: deps({
                commits: async (_repo, _window, _limit, author) => {
                    authors.push(author);
                    return { log: logEntry("a".repeat(40), "feat: parser", "10:00:00"), email: "alice@example.com" };
                },
            }),
        });
        expect(authors).toEqual(["me"]);
        expect(result.events.map((event) => event.kind)).not.toContain("thread");
        expect(result.events.some((event) => event.kind === "session.turn")).toBe(true);
        expect(result.events.some((event) => event.kind === "push")).toBe(true);
    });

    test("author others keeps other people's commits and comments, never my sessions", async () => {
        const result = await buildTimeline({
            since: SINCE,
            now: NOW,
            storage: await scratchStorage(),
            maxCacheAgeSeconds: 0,
            filters: { author: "others" },
            deps: deps(),
        });
        expect(result.events.map((event) => event.id)).toEqual(["thread:c-today", `commit:${"c".repeat(40)}`]);
    });

    test("needs me is the open decision, the failed CI on my PR and the thread waiting for my answer", async () => {
        const result = await buildTimeline({
            since: SINCE,
            now: NOW,
            storage: await scratchStorage(),
            maxCacheAgeSeconds: 0,
            filters: { needsMe: true },
            deps: deps(),
        });
        expect(result.events.map((event) => event.kind)).toEqual(["decision", "ci", "thread"]);
    });

    test("kinds narrows the page and the cache key follows the filters", async () => {
        const storage = await scratchStorage();
        const commits = await buildTimeline({
            since: SINCE,
            now: NOW,
            storage,
            filters: { kinds: ["commit"] },
            deps: deps(),
        });
        const pushes = await buildTimeline({
            since: SINCE,
            now: NOW,
            storage,
            filters: { kinds: ["push"] },
            deps: deps(),
        });
        expect(commits.events.every((event) => event.kind === "commit")).toBe(true);
        expect(pushes.events.map((event) => event.kind)).toEqual(["push"]);
        expect(pushes.cached).toBe(false);
    });

    test("keepsEvent treats an unknown author as someone else", () => {
        const unknown = event("x", "2026-03-02T11:00:00.000Z");
        expect(keepsEvent(unknown, { author: "me" })).toBe(false);
        expect(keepsEvent(unknown, { author: "others" })).toBe(true);
        expect(keepsEvent(unknown, { needsMe: true })).toBe(false);
        expect(keepsEvent(unknown, { kinds: [] })).toBe(true);
        expect(keepsEvent(unknown, { kinds: ["push"] })).toBe(false);
    });
});

describe("timeline parsers", () => {
    test("parsePushes keeps pushes inside the window only", () => {
        const lines = [
            `${"1".repeat(40)} ${"2".repeat(40)} A <a@example.com> ${seconds("08:00:00")} +0000\tupdate by push`,
            `${"2".repeat(40)} ${"3".repeat(40)} A <a@example.com> ${seconds("00:00:00") - 60} +0000\tupdate by push`,
            `${"3".repeat(40)} ${"4".repeat(40)} A <a@example.com> ${seconds("14:00:00")} +0000\tupdate by push`,
            "garbage",
        ];
        expect(parsePushes(lines, SINCE).map((push) => push.to[0])).toEqual(["2", "4"]);
        expect(parsePushes(lines, SINCE, new Date(at("12:00:00"))).map((push) => push.to[0])).toEqual(["2"]);
    });

    test("resolveRange names the presets the hub offers", () => {
        expect(resolveRange("today", NOW)).toEqual({ since: SINCE, until: NOW });
        expect(resolveRange("hour", NOW)).toEqual({ since: new Date(at("14:00:00")), until: NOW });
        expect(resolveRange("24h", NOW)).toEqual({ since: new Date("2026-03-01T15:00:00"), until: NOW });
        expect(TIMELINE_DEFAULT_RANGE).toBe("24h");
        expect(resolveRange("yesterday", NOW)).toEqual({
            since: new Date("2026-03-01T00:00:00"),
            until: new Date(SINCE.getTime() - 1),
        });
        expect(resolveRange("7d", NOW).since).toEqual(new Date("2026-02-24T00:00:00"));
        expect(resolveRange("30d", NOW).since).toEqual(new Date("2026-02-01T00:00:00"));
    });

    test("commentTitle prefers a bold finding over a badge line", () => {
        expect(commentTitle("badge | x\n\n**Fix the loop**\nbody")).toBe("Fix the loop");
        expect(commentTitle("plain `code` note\nmore")).toBe("plain code note");
        expect(commentTitle("")).toBe("(no text)");
    });

    test("lastRecordedBranch takes the newest non-empty branch a transcript records", () => {
        const lines = [
            `{"type":"user","gitBranch":"feat/first","message":{}}`,
            `{"type":"assistant","gitBranch":"feat/second","message":{}}`,
            `{"type":"system","gitBranch":""}`,
            `{"type":"summary"}`,
        ].join("\n");

        expect(lastRecordedBranch(lines)).toBe("feat/second");
        expect(lastRecordedBranch(`{"git_branch": "grok/topic"}`)).toBe("grok/topic");
        expect(lastRecordedBranch(`{"type":"summary"}`)).toBeNull();
    });
});

describe("timeline PR range", () => {
    const MONTH_AGO = new Date("2026-01-31T00:00:00");
    // Opened and merged weeks ago: never among the newest 30 PRs of a busy project.
    const OLD_PR: HubPr = {
        ...PR,
        number: 3,
        title: "Old parser",
        url: "https://github.com/acme/app/pull/3",
        createdAt: new Date("2026-02-10T09:00:00").toISOString(),
        updatedAt: new Date("2026-02-12T09:00:00").toISOString(),
    };

    test("the host is asked for the PRs updated since the range's start, so a 30-day range shows older PRs", async () => {
        const asked: Date[] = [];
        const { events, warnings } = await buildTimeline({
            since: MONTH_AGO,
            now: NOW,
            deps: deps({
                prs: async (_roots, since) => {
                    asked.push(since);
                    // The host's date bound: only PRs updated at or after `since`.
                    return [OLD_PR, PR].filter((pr) => Date.parse(pr.updatedAt) >= since.getTime());
                },
            }),
            storage: await scratchStorage(),
            maxCacheAgeSeconds: 0,
        });

        expect(asked).toEqual([MONTH_AGO]);
        const prDetails = events.filter((event) => event.kind === "pr").map((event) => event.detail);
        expect(prDetails).toContain("opened acme/app#3");
        expect(prDetails).toContain("merged acme/app#3");
        expect(warnings.filter((warning) => warning.startsWith("PR events"))).toEqual([]);
    });

    test("a project whose range list came back full says that older PRs are missing", async () => {
        const full = Array.from({ length: TIMELINE_LIMITS.prsInRange }, (_, index) => ({
            ...OLD_PR,
            number: 100 + index,
        }));
        const { warnings } = await buildTimeline({
            since: MONTH_AGO,
            now: NOW,
            deps: deps({ prs: async () => full }),
            storage: await scratchStorage(),
            maxCacheAgeSeconds: 0,
        });

        expect(warnings).toContain(
            `PR events: app has more than ${TIMELINE_LIMITS.prsInRange} PRs updated in this range; the least recently updated are missing`
        );
        expect(fullPrLists([PR, OLD_PR, { ...PR, repo: "web" }], 2)).toEqual(["app"]);
    });

    test("the fetch starts at the range start's hour, so one cached list serves a rolling range for the hour", () => {
        expect(prListSince(new Date("2026-03-01T14:37:12.345"))).toEqual(new Date("2026-03-01T14:00:00"));
        expect(prListSince(MONTH_AGO)).toEqual(MONTH_AGO);
    });

    test("a day's range asks for a day's page of PRs, a longer range for the larger bound", async () => {
        const day = new Date(NOW.getTime() - 24 * 3_600_000);
        expect(prRangeLimit(day, NOW)).toBe(TIMELINE_LIMITS.prsPerProject);
        expect(prRangeLimit(MONTH_AGO, NOW)).toBe(TIMELINE_LIMITS.prsInRange);

        const asked: number[] = [];
        await buildTimeline({
            since: day,
            now: NOW,
            deps: deps({
                prs: async (_roots, _since, limit) => {
                    asked.push(limit);
                    return [PR];
                },
            }),
            storage: await scratchStorage(),
            maxCacheAgeSeconds: 0,
        });
        expect(asked).toEqual([TIMELINE_LIMITS.prsPerProject]);
    });
});

describe("timeline session branch", () => {
    test("a last-turn row carries the branch of that turn, a start row the first branch", async () => {
        const { events } = await buildTimeline({
            since: SINCE,
            now: NOW,
            deps: deps({
                sessions: async () => [session({ gitBranch: "feat/first" })],
                lastBranch: () => "feat/now",
            }),
            storage: await scratchStorage(),
            maxCacheAgeSeconds: 0,
        });

        expect(events.find((event) => event.kind === "session.turn")?.branch).toBe("feat/now");
        expect(events.find((event) => event.kind === "session.start")?.branch).toBe("feat/first");
    });

    test("without a branch in the tail the turn keeps the session's first branch", async () => {
        const { events } = await buildTimeline({
            since: SINCE,
            now: NOW,
            deps: deps({ sessions: async () => [session({ gitBranch: "feat/first" })], lastBranch: () => null }),
            storage: await scratchStorage(),
            maxCacheAgeSeconds: 0,
        });

        expect(events.find((event) => event.kind === "session.turn")?.branch).toBe("feat/first");
    });

    test("the real read finds the newest branch in the file's tail, past a line larger than the first read", () => {
        const dir = mkdtempSync(`${tmpdir()}/gt-timeline-branch-`);
        const path = join(dir, "s.jsonl");
        const huge = `{"type":"user","message":{"content":"${"x".repeat(200 * 1024)}"}}`;
        writeFileSync(path, [`{"gitBranch":"feat/old"}`, `{"gitBranch":"feat/new"}`, huge, ""].join("\n"));

        expect(realTimelineDeps.lastBranch(path)).toBe("feat/new");
        expect(realTimelineDeps.lastBranch(join(dir, "missing.jsonl"))).toBeNull();
    });
});
