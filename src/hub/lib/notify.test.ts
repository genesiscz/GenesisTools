import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig as loadDaemonConfig } from "@app/daemon/lib/config";
import { parseInterval } from "@app/daemon/lib/interval";
import { NOTIFY_TASK_NAME, registerNotifyCommands } from "@app/hub/commands/notify";
import type { CommandRunner, ProjectRef } from "@genesiscz/utils/git";
import { SafeJSON } from "@genesiscz/utils/json";
import { Command } from "commander";
import { diffPr, isBotLogin, type PrMemory, type PrSnapshot, pruneMemory } from "./notify";
import {
    applyNotifySettings,
    daemonEvery,
    defaultNotifyConfig,
    type NotifyConfig,
    normalizeNotifyConfig,
    readNotifyConfig,
    repoEvents,
    updateNotifyConfig,
    watchedRepoPaths,
} from "./notify-config";
import {
    fetchGithubRepo,
    fetchGitlabRepo,
    HostError,
    parseGithubWatch,
    parseGitlabDiscussions,
    type RepoFetch,
} from "./notify-fetch";
import {
    backoffMinutes,
    hubPrRef,
    openHubCommand,
    type PollDeps,
    pollNotify,
    readNotifyState,
    testNotification,
} from "./notify-poll";
import { isHubPrRef } from "./pr-ref";
import type { RepoFacts } from "./repo";

const ALL_ON = { thread: true, ciFailed: true, ciPassed: true, botReview: true, merged: true };
const NOW = "2026-01-02T10:00:00.000Z";

function snap(over: Partial<PrSnapshot> = {}): PrSnapshot {
    return {
        key: "github.com/acme/web#7",
        provider: "github",
        project: "acme/web",
        number: 7,
        title: "Add the thing",
        url: "https://github.com/acme/web/pull/7",
        author: "alice",
        mine: true,
        state: "OPEN",
        headSha: "aaaaaaa1",
        ci: "running",
        threads: [],
        notes: null,
        botReviews: [],
        ...over,
    };
}

function memory(pr: PrSnapshot): PrMemory {
    return diffPr({ previous: undefined, pr, viewer: "alice", events: ALL_ON, onlyMine: false, now: NOW }).memory;
}

function diff(previous: PrMemory | undefined, pr: PrSnapshot, onlyMine = false) {
    return diffPr({ previous, pr, viewer: "alice", events: ALL_ON, onlyMine, now: NOW }).items;
}

// ─── config ───────────────────────────────────────────────────────────────────

describe("notify config", () => {
    test("any stored shape becomes a complete config; bad values fall back", () => {
        const config = normalizeNotifyConfig({
            enabled: "yes",
            intervalMinutes: 0.2,
            events: { ciPassed: true, bogus: true },
            repos: { "/work/web": { events: { merged: false } }, "/work/bad": 3 },
            botLogins: ["helper", 4, " "],
        });
        expect(config.enabled).toBe(true);
        expect(config.intervalMinutes).toBe(1);
        expect(config.events.ciPassed).toBe(true);
        expect(config.repos).toEqual({ "/work/web": { enabled: true, events: { merged: false } } });
        expect(config.botLogins).toEqual(["helper"]);
        expect(repoEvents(config, "/work/web").merged).toBe(false);
        expect(repoEvents(config, "/work/other").merged).toBe(true);
    });

    test("settings changes: global, per repo, reset, and the input config is never mutated", () => {
        const start = defaultNotifyConfig();
        const watched = applyNotifySettings(start, { repo: "/work/web", repoEnabled: true, events: { thread: false } });
        expect(start.repos).toEqual({});
        expect(watchedRepoPaths(watched)).toEqual(["/work/web"]);
        expect(repoEvents(watched, "/work/web").thread).toBe(false);

        const reset = applyNotifySettings(watched, { repo: "/work/web", resetRepoEvents: true });
        expect(reset.repos["/work/web"]).toEqual({ enabled: true });
        expect(watched.repos["/work/web"].events).toEqual({ thread: false });

        const global = applyNotifySettings(reset, { events: { ciPassed: true }, intervalMinutes: 500, onlyMine: true });
        expect(global.events.ciPassed).toBe(true);
        expect(global.intervalMinutes).toBe(60);
        expect(global.onlyMine).toBe(true);
    });

    test("update writes the file under its lock and reads back", async () => {
        const path = join(mkdtempSync(join(tmpdir(), "hub-notify-")), "notify.json");
        expect(readNotifyConfig(path)).toEqual(defaultNotifyConfig());
        await updateNotifyConfig({ repo: "/work/web", repoEnabled: true }, path);
        expect(readNotifyConfig(path).repos["/work/web"]).toEqual({ enabled: true });
    });
});

// ─── diff engine ──────────────────────────────────────────────────────────────

describe("diffPr", () => {
    test("a first sighting records a baseline and posts nothing", () => {
        const pr = snap({ ci: "failed", threads: [{ id: "t1", author: "bob", bot: false, path: "a.ts" }] });
        expect(diff(undefined, pr)).toEqual([]);
        expect(memory(pr)).toMatchObject({ threadIds: ["t1"], ciSeen: "aaaaaaa1:failed" });
    });

    test("new threads from people; not mine, not a bot's", () => {
        const before = memory(snap({ threads: [{ id: "t1", author: "bob", bot: false, path: "a.ts" }] }));
        const items = diff(
            before,
            snap({
                threads: [
                    { id: "t1", author: "bob", bot: false, path: "a.ts" },
                    { id: "t2", author: "bob", bot: false, path: "b.ts" },
                    { id: "t3", author: "alice", bot: false, path: "b.ts" },
                    { id: "t4", author: "helper[bot]", bot: true, path: "b.ts" },
                ],
            })
        );
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ type: "thread", message: "A new review thread from bob on b.ts" });
    });

    test("a bot's review is its own event, once", () => {
        const before = memory(snap());
        const pr = snap({ botReviews: [{ id: "r1", author: "helper", state: "COMMENTED" }] });
        expect(diff(before, pr).map((i) => i.type)).toEqual(["botReview"]);
        expect(diff(memory(pr), pr)).toEqual([]);
    });

    test("CI: one event per head and result; a rerun that passes is news, the same result again is not", () => {
        const pending = memory(snap({ ci: "pending" }));
        const failed = snap({ ci: "failed" });
        expect(diff(pending, failed).map((i) => i.type)).toEqual(["ciFailed"]);

        const afterFail = diffPr({
            previous: pending,
            pr: failed,
            viewer: "alice",
            events: ALL_ON,
            onlyMine: false,
            now: NOW,
        }).memory;
        expect(diff(afterFail, failed)).toEqual([]);
        expect(diff(afterFail, snap({ ci: "success" })).map((i) => i.type)).toEqual(["ciPassed"]);
        expect(diff(afterFail, snap({ ci: "running", headSha: "bbbbbbb2" }))).toEqual([]);
    });

    test("a switched-off event posts nothing, but the memory still moves on", () => {
        const before = memory(snap({ ci: "pending" }));
        const result = diffPr({
            previous: before,
            pr: snap({ ci: "success" }),
            viewer: "alice",
            events: { ...ALL_ON, ciPassed: false },
            onlyMine: false,
            now: NOW,
        });
        expect(result.items).toEqual([]);
        expect(result.memory.ciSeen).toBe("aaaaaaa1:success");
    });

    test("merged: only from a remembered open state", () => {
        const open = memory(snap());
        expect(diff(open, snap({ state: "MERGED", ci: null })).map((i) => i.type)).toEqual(["merged"]);
        expect(diff(memory(snap({ state: "MERGED" })), snap({ state: "MERGED" }))).toEqual([]);
    });

    test("only my PRs: someone else's PR changes silently", () => {
        const before = memory(snap({ mine: false }));
        expect(diff(before, snap({ mine: false, state: "MERGED" }), true)).toEqual([]);
        expect(diff(before, snap({ mine: false, state: "MERGED" }), false)).toHaveLength(1);
    });

    test("old memories are pruned, recent ones kept", () => {
        const kept = { ...memory(snap()), seenAt: "2026-01-01T00:00:00Z" };
        const old = { ...memory(snap()), seenAt: "2025-10-01T00:00:00Z" };
        expect(Object.keys(pruneMemory({ kept, old }, new Date(NOW)))).toEqual(["kept"]);
    });

    test("bot logins: host bots, [bot] names, GitLab project bots, configured names", () => {
        expect(isBotLogin("helper", [], true)).toBe(true);
        expect(isBotLogin("helper[bot]", [])).toBe(true);
        expect(isBotLogin("project_12_bot_abc", [])).toBe(true);
        expect(isBotLogin("Reviewer", ["reviewer"])).toBe(true);
        expect(isBotLogin("robotics-fan", [])).toBe(false);
        expect(isBotLogin(null, [])).toBe(false);
    });
});

// ─── host parsing ─────────────────────────────────────────────────────────────

const GITHUB: ProjectRef = { kind: "github", host: "github.com", path: "acme/web", web: "https://github.com/acme/web" };
const GITLAB: ProjectRef = {
    kind: "gitlab",
    host: "git.example.com",
    path: "group/app",
    web: "https://git.example.com/group/app",
};

describe("parseGithubWatch", () => {
    const answer = {
        data: {
            viewer: { login: "alice" },
            rateLimit: { cost: 5, remaining: 4900, resetAt: "2026-01-02T11:00:00Z" },
            repository: {
                open: {
                    nodes: [
                        {
                            number: 7,
                            title: "Add the thing",
                            url: "https://github.com/acme/web/pull/7",
                            headRefOid: "aaaaaaa1",
                            author: { login: "alice" },
                            reviewThreads: {
                                nodes: [
                                    {
                                        id: "t1",
                                        path: "a.ts",
                                        comments: { nodes: [{ author: { __typename: "User", login: "bob" } }] },
                                    },
                                    {
                                        id: "t2",
                                        path: "a.ts",
                                        comments: { nodes: [{ author: { __typename: "Bot", login: "helper" } }] },
                                    },
                                ],
                            },
                            reviews: {
                                nodes: [
                                    { id: "r1", state: "COMMENTED", author: { __typename: "Bot", login: "helper" } },
                                    { id: "r2", state: "APPROVED", author: { __typename: "User", login: "bob" } },
                                ],
                            },
                            commits: {
                                nodes: [{ commit: { oid: "aaaaaaa1", statusCheckRollup: { state: "FAILURE" } } }],
                            },
                        },
                    ],
                },
                merged: {
                    nodes: [
                        {
                            number: 5,
                            title: "Old",
                            url: "https://github.com/acme/web/pull/5",
                            author: { login: "bob" },
                        },
                    ],
                },
            },
        },
    };

    test("open and merged PRs with threads, bot reviews, CI and the rate budget", () => {
        const parsed = parseGithubWatch({ json: SafeJSON.stringify(answer), project: GITHUB, botLogins: [] });
        expect(parsed.viewer).toBe("alice");
        expect(parsed.rate).toEqual({ remaining: 4900, resetAt: "2026-01-02T11:00:00Z", cost: 5 });
        expect(parsed.prs).toHaveLength(2);
        expect(parsed.prs[0]).toMatchObject({
            key: "github.com/acme/web#7",
            mine: true,
            ci: "failed",
            threads: [
                { id: "t1", author: "bob", bot: false },
                { id: "t2", author: "helper", bot: true },
            ],
            botReviews: [{ id: "r1", author: "helper", state: "COMMENTED" }],
        });
        expect(parsed.prs[1]).toMatchObject({ number: 5, state: "MERGED", mine: false, ci: null });
    });

    test("owner and repo go to gh as raw strings, so a numeric repo name stays a String", async () => {
        const calls: string[][] = [];
        const runner: CommandRunner = async (cmd) => {
            calls.push(cmd);
            return { code: 0, stdout: SafeJSON.stringify(answer), stderr: "" };
        };
        await fetchGithubRepo({ project: { ...GITHUB, path: "acme/2048" }, botLogins: [], runner });

        const args = calls[0] ?? [];
        expect(args.slice(-4)).toEqual(["-f", "owner=acme", "-f", "repo=2048"]);
        expect(args).not.toContain("-F");
    });

    test("GraphQL errors become a HostError that knows a rate limit", () => {
        const json = SafeJSON.stringify({ errors: [{ message: "API rate limit exceeded for user" }] });
        let caught: unknown;

        try {
            parseGithubWatch({ json, project: GITHUB, botLogins: [] });
        } catch (err) {
            caught = err;
        }

        expect(caught).toBeInstanceOf(HostError);
        expect((caught as HostError).rateLimited).toBe(true);
    });
});

describe("GitLab", () => {
    test("discussions: threads only, system notes and single comments skipped, bots flagged", () => {
        const threads = parseGitlabDiscussions(
            SafeJSON.stringify([
                {
                    id: "d1",
                    individual_note: false,
                    notes: [{ author: { username: "bob" }, position: { new_path: "a.ts" } }],
                },
                { id: "d2", individual_note: true, notes: [{ author: { username: "bob" } }] },
                { id: "d3", individual_note: false, notes: [{ system: true, author: { username: "bob" } }] },
                { id: "d4", individual_note: false, notes: [{ author: { username: "project_9_bot_x" } }] },
            ]),
            []
        );
        expect(threads).toEqual([
            { id: "d1", author: "bob", bot: false, path: "a.ts" },
            { id: "d4", author: "project_9_bot_x", bot: true, path: null },
        ]);
    });

    test("discussions are fetched only when an MR's note count moved", async () => {
        const calls: string[] = [];
        const mr = (notes: number) => ({
            iid: 3,
            web_url: "https://git.example.com/group/app/-/merge_requests/3",
            title: "Fix",
            state: "opened",
            author: { username: "alice" },
            sha: "ccc",
            source_branch: "fix",
            target_branch: "main",
            user_notes_count: notes,
        });
        let notes = 2;
        const runner: CommandRunner = async (cmd) => {
            const line = cmd.join(" ");
            calls.push(line);

            if (line.includes("/discussions")) {
                return { code: 0, stdout: "[]", stderr: "" };
            }

            if (line.includes("/merge_requests?")) {
                return { code: 0, stdout: SafeJSON.stringify([mr(notes)]), stderr: "" };
            }

            return { code: 0, stdout: "[]", stderr: "" };
        };
        const first = await fetchGitlabRepo({ project: GITLAB, botLogins: [], memory: {}, viewer: "alice", runner });
        expect(calls.filter((c) => c.includes("/discussions"))).toHaveLength(1);

        const remembered = { [first.prs[0].key]: memory(first.prs[0]) };
        await fetchGitlabRepo({ project: GITLAB, botLogins: [], memory: remembered, viewer: "alice", runner });
        expect(calls.filter((c) => c.includes("/discussions"))).toHaveLength(1);

        notes = 3;
        const moved = await fetchGitlabRepo({
            project: GITLAB,
            botLogins: [],
            memory: remembered,
            viewer: "alice",
            runner,
        });
        expect(calls.filter((c) => c.includes("/discussions"))).toHaveLength(2);
        expect(moved.requests).toBe(3);
    });
});

// ─── poll ─────────────────────────────────────────────────────────────────────

function facts(path: string, url: string): RepoFacts {
    return {
        path,
        root: path,
        repo: "web",
        branch: "main",
        head: "h",
        origin: { url, host: "github.com", kind: "github", web: null },
        branchUrl: null,
        headUrl: null,
    };
}

function pollDeps({
    config,
    fetches,
    posted,
}: {
    config: NotifyConfig;
    fetches: Array<RepoFetch | Error>;
    posted: string[];
}): PollDeps & { calls: () => number } {
    let calls = 0;
    return {
        readConfig: () => config,
        readFacts: async (paths) => paths.map((path) => facts(path, "git@github.com:acme/web.git")),
        fetchGithub: async () => {
            const next = fetches[Math.min(calls, fetches.length - 1)];
            calls += 1;

            if (next instanceof Error) {
                throw next;
            }

            return next;
        },
        fetchGitlab: async () => {
            throw new Error("no GitLab here");
        },
        post: async (item, summary) => {
            posted.push(summary ? `summary:${summary.more}` : `${item.type}:${item.number}`);
            return true;
        },
        statePath: join(mkdtempSync(join(tmpdir(), "hub-notify-poll-")), "notify-state.json"),
        calls: () => calls,
    };
}

function watching(): NotifyConfig {
    return applyNotifySettings(defaultNotifyConfig(), { repo: "/work/web", repoEnabled: true });
}

describe("pollNotify", () => {
    test("off, unwatched and not-due polls ask no host", async () => {
        const posted: string[] = [];
        const off = pollDeps({ config: { ...watching(), enabled: false }, fetches: [], posted });
        expect((await pollNotify({ deps: off })).skipped).toContain("off");
        expect((await pollNotify({ deps: { ...off, readConfig: defaultNotifyConfig } })).skipped).toContain("no repo");

        const deps = pollDeps({
            config: watching(),
            fetches: [{ prs: [snap()], viewer: "alice", rate: null, requests: 1 }],
            posted,
        });
        await pollNotify({ deps, now: new Date(NOW) });
        const again = await pollNotify({ deps, now: new Date(Date.parse(NOW) + 60_000) });
        expect(again.skipped).toContain("not due");
        expect(deps.calls()).toBe(1);
    });

    test("baseline, then a change posts; a dry run posts and saves nothing", async () => {
        const posted: string[] = [];
        const deps = pollDeps({
            config: watching(),
            fetches: [
                { prs: [snap()], viewer: "alice", rate: null, requests: 1 },
                { prs: [snap({ state: "MERGED", ci: null })], viewer: "alice", rate: null, requests: 1 },
            ],
            posted,
        });
        const first = await pollNotify({ deps, now: new Date(NOW) });
        expect(first.items).toEqual([]);

        const dry = await pollNotify({ deps, now: new Date(Date.parse(NOW) + 10 * 60_000), dryRun: true });
        expect(dry.items.map((i) => i.type)).toEqual(["merged"]);
        expect(posted).toEqual([]);
        expect(readNotifyState(deps.statePath).prs["github.com/acme/web#7"].state).toBe("OPEN");

        const real = await pollNotify({ deps, now: new Date(Date.parse(NOW) + 20 * 60_000) });
        expect(real.posted).toBe(1);
        expect(posted).toEqual(["merged:7"]);
        expect(readNotifyState(deps.statePath).recent).toHaveLength(1);
    });

    test("a burst folds into four banners and one summary", async () => {
        const posted: string[] = [];
        const prs = Array.from({ length: 7 }, (_, i) => snap({ key: `github.com/acme/web#${i}`, number: i }));
        const deps = pollDeps({
            config: watching(),
            fetches: [
                { prs, viewer: "alice", rate: null, requests: 1 },
                {
                    prs: prs.map((pr) => ({ ...pr, state: "MERGED" as const, ci: null })),
                    viewer: "alice",
                    rate: null,
                    requests: 1,
                },
            ],
            posted,
        });
        await pollNotify({ deps, now: new Date(NOW) });
        const report = await pollNotify({ deps, force: true, now: new Date(NOW) });
        expect(report.items).toHaveLength(7);
        expect(posted).toEqual(["merged:0", "merged:1", "merged:2", "merged:3", "summary:3"]);
    });

    test("a failing repo backs off, doubling, and a rate limit waits at least 15 minutes", async () => {
        expect(backoffMinutes(3, 1, false)).toBe(3);
        expect(backoffMinutes(3, 3, false)).toBe(12);
        expect(backoffMinutes(3, 10, false)).toBe(60);
        expect(backoffMinutes(3, 1, true)).toBe(15);

        const posted: string[] = [];
        const deps = pollDeps({ config: watching(), fetches: [new HostError("boom", false)], posted });
        const failed = await pollNotify({ deps, now: new Date(NOW) });
        expect(failed.repos[0].error).toBe("boom");
        const status = readNotifyState(deps.statePath).repos["github.com/acme/web"];
        expect(status).toMatchObject({ failures: 1, nextAt: "2026-01-02T10:03:00.000Z" });

        const early = await pollNotify({ deps, now: new Date(Date.parse(NOW) + 3 * 60_000 - 30_000), force: false });
        expect(early.skipped).toContain("not due");
        const inBackoff = await pollNotify({ deps, now: new Date(Date.parse(NOW) + 2 * 60_000 + 50_000) });
        expect(inBackoff.repos[0].skipped).toContain("backing off");
        expect(deps.calls()).toBe(1);
    });

    test("a GitHub host near its hourly budget is skipped until the reset", async () => {
        const posted: string[] = [];
        const deps = pollDeps({
            config: watching(),
            fetches: [
                {
                    prs: [],
                    viewer: "alice",
                    rate: { remaining: 100, resetAt: "2026-01-02T11:00:00Z", cost: 5 },
                    requests: 1,
                },
            ],
            posted,
        });
        await pollNotify({ deps, now: new Date(NOW) });
        const next = await pollNotify({ deps, force: false, now: new Date(Date.parse(NOW) + 5 * 60_000) });
        expect(next.repos[0].skipped).toContain("GraphQL points left");
        expect(deps.calls()).toBe(1);
        expect(existsSync(deps.statePath)).toBe(true);
        expect(SafeJSON.parse(readFileSync(deps.statePath, "utf8"))).toMatchObject({
            hosts: { "github.com": { remaining: 100 } },
        });
    });
});

describe("the click", () => {
    test("opens the hub at the PR through Launch Services, every argument quoted", () => {
        expect(hubPrRef({ project: "group/app", number: 3, provider: "gitlab" })).toBe("group/app!3");
        expect(openHubCommand("acme/web#7", "/Apps/Genesis Tools.app")).toBe(
            "'/usr/bin/open' '-n' '/Apps/Genesis Tools.app' '--args' '--hub' '--mode' 'prs' '--pr' 'acme/web#7'"
        );
    });
});

describe("daemonEvery", () => {
    test("every interval the notifier can save parses in the daemon's own grammar", () => {
        for (const minutes of [0.2, 1, 3, 59.6, 60]) {
            expect(() => parseInterval(daemonEvery(minutes))).not.toThrow();
        }

        expect(daemonEvery(3)).toBe("every 3 minutes");
        expect(daemonEvery(1)).toBe("every 1 minute");
    });
});

describe("the test notification", () => {
    test("with or without a PR, the click opens the hub's PRs; --pr takes only what the hub's HubPRRef parses", () => {
        expect(testNotification(null, "/Apps/G.app").execute).toBe(
            "'/usr/bin/open' '-n' '/Apps/G.app' '--args' '--hub' '--mode' 'prs'"
        );
        expect(testNotification("group/app!12", "/Apps/G.app").execute).toBe(
            "'/usr/bin/open' '-n' '/Apps/G.app' '--args' '--hub' '--mode' 'prs' '--pr' 'group/app!12'"
        );
        expect(testNotification(null).title).toContain("TEST");

        for (const ref of ["42", "#42", "acme/web#42", "group/sub/app!12"]) {
            expect(isHubPrRef(ref)).toBe(true);
        }

        for (const ref of ["web", "acme/web#", "#x", "42a", ""]) {
            expect(isHubPrRef(ref)).toBe(false);
        }
    });
});

/** The real commander tree, parsed in-process under the test sandbox's GENESIS_TOOLS_HOME. */
async function runNotify(args: string[]): Promise<number> {
    const program = new Command().exitOverride();
    registerNotifyCommands(program);
    const before = process.exitCode;
    process.exitCode = 0;

    try {
        await program.parseAsync(["notify", ...args], { from: "user" });
        return Number(process.exitCode ?? 0);
    } finally {
        process.exitCode = before;
    }
}

describe("tools hub notify (the commands)", () => {
    test("set --interval outside 1..60 or not whole minutes exits 1 and saves nothing", async () => {
        const start = readNotifyConfig().intervalMinutes;

        for (const bad of ["0", "61", "2.5", "", "abc"]) {
            expect(await runNotify(["set", "--interval", bad])).toBe(1);
        }

        expect(readNotifyConfig().intervalMinutes).toBe(start);
        expect(await runNotify(["set", "--interval", "5"])).toBe(0);
        expect(readNotifyConfig().intervalMinutes).toBe(5);
    });

    test("test --pr with a ref the hub cannot parse exits 1 before posting anything", async () => {
        // The preload rejects every real dispatch, so reaching it would throw here instead.
        expect(await runNotify(["test", "--pr", "not-a-ref"])).toBe(1);
    });

    test("install registers a task the daemon's own config reader keeps, running the real poll script", async () => {
        expect(await runNotify(["install"])).toBe(0);
        const task = (await loadDaemonConfig()).tasks.find((t) => t.name === NOTIFY_TASK_NAME);
        expect(task).toBeDefined();
        expect(() => parseInterval(task?.every ?? "")).not.toThrow();
        const script = join(import.meta.dir, "notify-daemon.ts");
        expect(existsSync(script)).toBe(true);
        expect(task?.command).toContain(`'${script}'`);

        expect(await runNotify(["set", "--interval", "7"])).toBe(0);
        const moved = (await loadDaemonConfig()).tasks.find((t) => t.name === NOTIFY_TASK_NAME);
        expect(moved?.every).toBe("every 7 minutes");

        expect(await runNotify(["uninstall"])).toBe(0);
        expect((await loadDaemonConfig()).tasks.some((t) => t.name === NOTIFY_TASK_NAME)).toBe(false);
    });
});

describe("the argv HubNotify.swift sends", () => {
    test("every settings change the popover makes parses and saves", async () => {
        const repo = "/tmp/gt/web";

        for (const flags of [
            ["--enabled", "off"],
            ["--enabled", "on"],
            ["--event", "ciPassed=on"],
            ["--only-mine", "on"],
            ["--interval", "60"],
            ["--repo", repo, "--repo-enabled", "on"],
            ["--repo", repo, "--event", "thread=off"],
            ["--repo", repo, "--reset-repo-events"],
        ]) {
            expect(await runNotify(["set", ...flags, "--json"])).toBe(0);
        }

        const config = readNotifyConfig();
        expect(config).toMatchObject({ enabled: true, onlyMine: true, intervalMinutes: 60 });
        expect(config.events.ciPassed).toBe(true);
        expect(config.repos[repo]).toEqual({ enabled: true });
    });
});
