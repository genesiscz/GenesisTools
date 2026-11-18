import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCmuxTree } from "@genesiscz/utils/cmux/agent-tree";
import type { SessionCmuxRefs } from "@genesiscz/utils/cmux/session-refs";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    readT3ThreadPlace,
    readT3ThreadPlaces,
    t3EnvironmentId,
    t3ThreadDesktopLink,
} from "@genesiscz/utils/t3code/thread-place";
import { type CmuxHostDeps, createCmuxSessionHost } from "./hosts/cmux";
import { createT3SessionHost, type T3HostDeps } from "./hosts/t3";
import { actOnSessionHost, describeSessionHosts, noHostReason, type SessionHostTable } from "./registry";
import { type SessionHostAdapter, type SessionHostView, WAKE_TEXT } from "./types";

const ENV_ID = "env-0000-fixture";
const THREAD = "mcp:launch:fixture-thread";

function t3Deps(overrides: Partial<T3HostDeps> = {}): T3HostDeps & { opened: string[]; sent: string[] } {
    const opened: string[] = [];
    const sent: string[] = [];
    return {
        opened,
        sent,
        home: () => "/fixture/t3",
        threads: () => new Map([["codex-session-1", { threadId: THREAD, parent: null }]]),
        pins: async () => new Map(),
        places: (threadIds) =>
            new Map(
                threadIds.map((threadId) => [
                    threadId,
                    { threadId, title: "Fixture thread", archived: false, deleted: false, live: false },
                ])
            ),
        environmentId: () => ENV_ID,
        appInstalled: async () => true,
        cliInstalled: () => true,
        open: async ({ link }) => {
            opened.push(link);
            return { opened: true };
        },
        send: async (threadId, message) => {
            sent.push(`${threadId}|${message}`);
            return { kind: "sent", messageId: "m1", runId: null, delivery: "started" };
        },
        ...overrides,
    };
}

function cmuxTree(
    surfaces: Array<{ sessionId?: string; hint?: string; title: string }>,
    available = true
): AgentCmuxTree {
    return {
        fetchedAt: "2026-01-01T00:00:00Z",
        totalMs: 0,
        available,
        ...(available ? {} : { error: "socket refused" }),
        windows: [
            {
                id: "w1",
                index: 0,
                key: true,
                workspaces: [
                    {
                        id: "ws1",
                        name: "fixtures",
                        panes: [
                            {
                                id: "p1",
                                title: "pane",
                                active: true,
                                surfaces: surfaces.map((surface, index) => ({
                                    id: `s${index}`,
                                    title: surface.title,
                                    type: "terminal",
                                    index,
                                    selected: index === 0,
                                    active: index === 0,
                                    sessionId: surface.sessionId ?? null,
                                    provider: null,
                                    sessionHint: surface.hint ?? null,
                                })),
                            },
                        ],
                    },
                ],
            },
        ],
    };
}

function journal(sessionId: string): SessionCmuxRefs {
    return {
        sessionId,
        workspaceId: "ws1",
        surfaceId: "gone-surface",
        workspaceRef: "workspace:3",
        paneRef: "pane:4",
        surfaceRef: "surface:9",
        windowRef: null,
        tmuxPane: null,
        cwd: "/work",
        at: 1,
    };
}

function cmuxDeps(overrides: Partial<CmuxHostDeps> = {}): CmuxHostDeps & { runs: string[][] } {
    const runs: string[][] = [];
    return {
        runs,
        tree: async () =>
            cmuxTree([
                { sessionId: "claude-live", title: "gt-fixes" },
                { hint: "abcd1234", title: "x · abcd1234" },
            ]),
        refs: () => new Map([["claude-closed", journal("claude-closed")]]),
        run: async (args) => {
            runs.push(args);
            return { exitCode: 0, stdout: SafeJSON.stringify({ focused: { paneId: "p1" }, sent: true }), stderr: "" };
        },
        ...overrides,
    };
}

describe("the T3 Code host", () => {
    test("names the thread by its title and opens its desktop link", async () => {
        const deps = t3Deps();
        const host = createT3SessionHost(deps);
        const view = (await host.describe(["codex-session-1", "other"])).get("codex-session-1");

        expect(view).toMatchObject({ kind: "t3", place: "T3 Code thread", label: "Fixture thread", live: false });
        expect(view?.actions.focus.enabled).toBe(true);
        expect(view?.actions.keepalive).toEqual({
            enabled: false,
            reason: "T3 Code has no keepalive command. Wake sends a message instead.",
        });
        expect(await host.act("focus", "codex-session-1")).toEqual({
            ok: true,
            detail: 'Opened "Fixture thread" in T3 Code.',
        });
        expect(deps.opened).toEqual([`t3code://threads/${ENV_ID}/mcp%3Alaunch%3Afixture-thread`]);
    });

    test("Wake sends the poke as the thread's next message", async () => {
        const deps = t3Deps();
        const result = await createT3SessionHost(deps).act("wake", "codex-session-1");

        expect(result.ok).toBe(true);
        expect(deps.sent).toEqual([`${THREAD}|${WAKE_TEXT}`]);
    });

    test("a newest pin with no host means the session left T3 Code", async () => {
        const host = createT3SessionHost(t3Deps({ pins: async () => new Map([["codex-session-1", {}]]) }));

        expect((await host.describe(["codex-session-1"])).size).toBe(0);
    });

    test("a deleted thread, a missing app or a missing environment id disables Focus with the reason", async () => {
        const deleted = createT3SessionHost(
            t3Deps({
                places: (threadIds) =>
                    new Map(
                        threadIds.map((threadId) => [
                            threadId,
                            { threadId, title: null, archived: false, deleted: true, live: false },
                        ])
                    ),
            })
        );
        const view = (await deleted.describe(["codex-session-1"])).get("codex-session-1");
        expect(view?.label).toBe(THREAD);
        expect(view?.actions.focus).toEqual({ enabled: false, reason: "The T3 Code thread was deleted." });
        expect(view?.actions.wake.enabled).toBe(false);

        const noApp = createT3SessionHost(t3Deps({ appInstalled: async () => false }));
        expect((await noApp.describe(["codex-session-1"])).get("codex-session-1")?.actions.focus).toEqual({
            enabled: false,
            reason: "T3 Code is not installed on this Mac.",
        });

        const noEnv = createT3SessionHost(t3Deps({ environmentId: () => undefined }));
        expect((await noEnv.describe(["codex-session-1"])).get("codex-session-1")?.actions.focus.enabled).toBe(false);
    });

    test("a describe of many sessions reads the places and asks for the app once; each act asks again", async () => {
        const asked = { app: 0, places: [] as string[][] };
        const deps = t3Deps({
            threads: () =>
                new Map([
                    ["codex-session-1", { threadId: "thread-1", parent: null }],
                    ["codex-session-2", { threadId: "thread-2", parent: null }],
                    ["codex-session-3", { threadId: "thread-3", parent: null }],
                ]),
            places: (threadIds) => {
                asked.places.push([...threadIds]);
                return new Map();
            },
            appInstalled: async () => {
                asked.app += 1;
                return true;
            },
        });
        const host = createT3SessionHost(deps);

        const views = await host.describe(["codex-session-1", "codex-session-2", "codex-session-3", "other"]);
        expect(views.size).toBe(3);
        expect(asked).toEqual({ app: 1, places: [["thread-1", "thread-2", "thread-3"]] });

        expect((await host.act("focus", "codex-session-2")).ok).toBe(true);
        expect(asked.app).toBe(2);

        expect((await host.describe(["other"])).size).toBe(0);
        expect(asked.app).toBe(2);
    });
});

describe("the cmux host", () => {
    test("a live surface holds a session by its id or by the short id in its tab title", async () => {
        const host = createCmuxSessionHost(cmuxDeps());
        const views = await host.describe(["claude-live", "abcd1234-0000-fixture", "claude-closed", "nowhere"]);

        expect(views.get("claude-live")).toMatchObject({ label: "fixtures · gt-fixes", live: true });
        expect(views.get("claude-live")?.actions.wake.enabled).toBe(true);
        expect(views.get("abcd1234-0000-fixture")?.live).toBe(true);
        expect(views.get("claude-closed")).toMatchObject({ label: "workspace:3 · surface:9", live: false });
        expect(views.get("claude-closed")?.actions.focus.enabled).toBe(true);
        expect(views.get("claude-closed")?.actions.wake).toEqual({
            enabled: false,
            reason: "No live cmux pane holds this session.",
        });
        expect(views.has("nowhere")).toBe(false);
    });

    test("a reused tab whose title still names an older session holds only the session the journal places there", async () => {
        const host = createCmuxSessionHost(
            cmuxDeps({
                tree: async () =>
                    cmuxTree([{ sessionId: "bbbbbbbb-new-session", hint: "aaaaaaaa", title: "old · aaaaaaaa" }]),
                refs: () => new Map(),
            })
        );
        const views = await host.describe(["aaaaaaaa-old-session", "bbbbbbbb-new-session"]);

        expect(views.has("aaaaaaaa-old-session")).toBe(false);
        expect(views.get("bbbbbbbb-new-session")?.live).toBe(true);
    });

    test("an upper-case id finds its journal record, which the journal keys lower case", async () => {
        const id = "cccccccc-dddd-4eee-8fff-000000000001";
        const host = createCmuxSessionHost(
            cmuxDeps({ tree: async () => cmuxTree([]), refs: () => new Map([[id, journal(id)]]) })
        );
        const views = await host.describe([id.toUpperCase()]);

        expect(views.get(id.toUpperCase())).toMatchObject({ label: "workspace:3 · surface:9", live: false });
    });

    test("an unreachable cmux disables every action with its error", async () => {
        const host = createCmuxSessionHost(cmuxDeps({ tree: async () => cmuxTree([], false) }));
        const view = (await host.describe(["claude-closed"])).get("claude-closed");

        expect(view?.live).toBeNull();
        expect(view?.actions.focus).toEqual({ enabled: false, reason: "cmux is not reachable: socket refused" });
    });

    test("Focus and Keepalive run the cmux commands; a miss reports the CLI's line", async () => {
        const deps = cmuxDeps();
        const host = createCmuxSessionHost(deps);

        expect((await host.act("focus", "claude-live")).ok).toBe(true);
        expect((await host.act("keepalive", "claude-live")).ok).toBe(true);
        expect(deps.runs).toEqual([
            // An automated action never takes the matcher's guesses (a topic alias, text on a screen, a pane of the same folder).
            ["claude", "cmux", "focus", "claude-live", "--exact", "--first", "--json"],
            ["claude", "cmux", "send", "claude-live", "/keepalive", "--exact-session", "--first", "--json"],
        ]);

        const missing = createCmuxSessionHost(
            cmuxDeps({
                run: async () => ({
                    exitCode: 1,
                    stdout: SafeJSON.stringify({ focused: null }),
                    stderr: '✘ No cmux pane matches "claude-live".\n  Searched 6 panes.',
                }),
            })
        );
        expect(await missing.act("focus", "claude-live")).toEqual({
            ok: false,
            reason: 'No cmux pane matches "claude-live".',
        });
    });
});

describe("the host table", () => {
    function fixedHost(
        kind: "cmux" | "t3",
        place: string,
        held: Record<string, SessionHostView>
    ): SessionHostAdapter & { acts: string[] } {
        const acts: string[] = [];
        return {
            kind,
            place,
            acts,
            describe: async (ids) => new Map(ids.flatMap((id) => (held[id] ? [[id, held[id]] as const] : []))),
            act: async (action, id) => {
                acts.push(`${action}:${id}`);
                return { ok: true, detail: "done" };
            },
        };
    }

    const view = (kind: "cmux" | "t3", label: string, wakeEnabled = true): SessionHostView => ({
        kind,
        place: kind,
        label,
        live: true,
        note: "",
        actions: {
            focus: { enabled: true, tip: "" },
            wake: wakeEnabled ? { enabled: true, tip: "" } : { enabled: false, reason: "asleep" },
            keepalive: { enabled: false, reason: "no keepalive" },
        },
    });

    test("the first host in order answers, and a session no host holds gets one sentence naming every host", async () => {
        const t3 = fixedHost("t3", "T3 Code thread", { both: view("t3", "thread") });
        const cmux = fixedHost("cmux", "cmux pane", { both: view("cmux", "pane"), pane: view("cmux", "pane") });
        const table: SessionHostTable = { hosts: { t3, cmux }, order: ["t3", "cmux"] };

        const answers = await describeSessionHosts(["both", "pane", "none"], table);

        expect(answers.map((answer) => answer.host?.label ?? null)).toEqual(["thread", "pane", null]);
        expect(answers[2]).toEqual({
            sessionId: "none",
            host: null,
            reason: "No T3 Code thread or cmux pane holds this session.",
        });
        expect(noHostReason(table)).toBe("No T3 Code thread or cmux pane holds this session.");
    });

    test("a host that throws is skipped, and a disabled action answers its reason without acting", async () => {
        const broken: SessionHostAdapter = {
            kind: "t3",
            place: "T3 Code thread",
            describe: async () => {
                throw new Error("database locked");
            },
            act: async () => ({ ok: false, reason: "never" }),
        };
        const cmux = fixedHost("cmux", "cmux pane", { s: view("cmux", "pane", false) });
        const table: SessionHostTable = { hosts: { t3: broken, cmux }, order: ["t3", "cmux"] };

        expect(await actOnSessionHost({ sessionId: "s", action: "wake" }, table)).toMatchObject({
            ok: false,
            reason: "asleep",
        });
        expect(await actOnSessionHost({ sessionId: "s", action: "focus" }, table)).toMatchObject({ ok: true });
        expect(cmux.acts).toEqual(["focus:s"]);
    });
});

describe("T3 Code's state", () => {
    let home: string;

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "gt-t3-place-"));
    });

    afterEach(() => {
        rmSync(home, { recursive: true, force: true });
    });

    test("a thread's title, deletion and live run come from the state database; the link encodes the thread id", () => {
        mkdirSync(join(home, "userdata"));
        writeFileSync(join(home, "userdata", "environment-id"), `${ENV_ID}\n`);
        const db = new Database(join(home, "userdata", "statev2.sqlite"));
        db.exec("CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, payload_json TEXT)");
        db.exec("CREATE TABLE orchestration_v2_projection_runs (thread_id TEXT, status TEXT)");
        const insert = db.query("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?)");
        insert.run("busy", SafeJSON.stringify({ title: "Busy thread", archivedAt: null, deletedAt: null }));
        insert.run(
            "done",
            SafeJSON.stringify({ title: "Done thread", archivedAt: "2026-01-01T00:00:00Z", deletedAt: null })
        );
        db.query("INSERT INTO orchestration_v2_projection_runs VALUES (?, ?)").run("busy", "running");
        db.query("INSERT INTO orchestration_v2_projection_runs VALUES (?, ?)").run("done", "completed");
        db.close();

        expect(readT3ThreadPlace("busy", home)).toEqual({
            threadId: "busy",
            title: "Busy thread",
            archived: false,
            deleted: false,
            live: true,
        });
        expect(readT3ThreadPlace("done", home)).toMatchObject({ archived: true, live: false });
        expect(readT3ThreadPlace("unknown", home)).toBeUndefined();
        expect(readT3ThreadPlace("busy", join(home, "missing"))).toBeUndefined();
        const both = readT3ThreadPlaces(["busy", "done", "unknown"], home);
        expect([...both.keys()].sort()).toEqual(["busy", "done"]);
        expect(both.get("busy")?.live).toBe(true);
        expect(readT3ThreadPlaces([], home).size).toBe(0);
        expect(t3EnvironmentId(home)).toBe(ENV_ID);
        expect(t3EnvironmentId(join(home, "missing"))).toBeUndefined();
        expect(t3ThreadDesktopLink({ environmentId: ENV_ID, threadId: "mcp:launch:a/b" })).toBe(
            `t3code://threads/${ENV_ID}/mcp%3Alaunch%3Aa%2Fb`
        );
    });
});
