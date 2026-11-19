import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeLocalRepoConfig } from "@genesiscz/utils/git/repo-config";
import { TestRepo } from "@genesiscz/utils/git/test-repo";
import { makeTempDir } from "@genesiscz/utils/paths";
import { workHandlers } from "./handlers";
import type { Actor } from "./model/item";
import { defaultNotify, type NotifyDeps, type NotifyLine, resolveNotify, runNotifyOnce } from "./notify";
import { type LoadProjectRules, loadWorkRules, projectRuleLoader, setWorkConfigValue } from "./rules/load";
import { type WorkContext, write } from "./service";
import { openWorkDb } from "./store/db";

let db: Database;
let configPath: string;
let n = 0;
const loadRules: LoadProjectRules = (location) => loadWorkRules({ ...location, configPath });

function ctx(sessionId: string): WorkContext {
    const actor: Actor = {
        kind: "agent",
        harness: "claude",
        sessionId,
        sessionTitle: null,
        model: null,
        host: null,
        subagentId: null,
        project: "App",
        repoRoot: null,
        branch: null,
        commitSha: null,
    };
    return {
        db,
        actor,
        project: "App",
        ports: {
            legacy: { write: async () => ({ ok: false }), check: async (actions) => actions.map(() => ({ ok: true })) },
            delivery: { place: async () => null, deliver: async () => ({ outcome: "unknown", to: null, at: "" }) },
        },
        random: () => `n${String(n++).padStart(7, "0")}`,
    };
}

beforeEach(() => {
    db = openWorkDb(":memory:");
    configPath = join(makeTempDir("work-notify-"), "config.json");
});

afterEach(() => {
    db.close();
});

describe("the notifier (P8 decision 3)", () => {
    test("a failed inbox write retries its line without repeating acknowledged lines", async () => {
        const delivered: string[] = [];
        const deps = {
            db,
            loadRules,
            inbox: async (line: NotifyLine) => void delivered.push(line.text.split("\n")[0]),
        };
        await runNotifyOnce(deps);
        await write(ctx("s1"), { verb: "spot", title: "first", type: "bug", fields: { production: true } });
        await write(ctx("s1"), { verb: "spot", title: "second", type: "bug", fields: { production: true } });

        await expect(
            runNotifyOnce({
                ...deps,
                inbox: async (line) => {
                    if (line.text.startsWith("second")) {
                        throw new Error("inbox unavailable");
                    }

                    await deps.inbox(line);
                },
            })
        ).rejects.toThrow("inbox unavailable");
        expect(delivered).toEqual(["first"]);
        await runNotifyOnce(deps);
        expect(delivered).toEqual(["first", "second"]);
    });

    test("defaults: a production bug and an undelivered high reopen are inbox lines; the rest is the tree only", () => {
        expect(defaultNotify({ type: "bug", action: "spotted", production: true })).toBe("inbox");
        expect(defaultNotify({ type: "bug", action: "spotted" })).toBe("list");
        expect(defaultNotify({ type: "task", action: "reopen-undelivered", severity: "high" })).toBe("inbox");
        expect(defaultNotify({ type: "task", action: "reopen-undelivered", severity: "low" })).toBe("list");
        expect(defaultNotify({ type: "task", action: "finished" })).toBe("list");
    });

    test("the strongest layer that names a level decides, a severity floor falls through, the surface key is last", () => {
        const layers = [
            { layer: "config.global" as const, rules: { notify: { "*": { finished: "inbox" as const } } } },
            {
                layer: "config.project" as const,
                rules: { notify: { task: { finished: { level: "off" as const, minSeverity: "high" as const } } } },
            },
        ];
        expect(resolveNotify(layers, { type: "task", action: "finished", severity: "low" })).toMatchObject({
            level: "inbox",
            from: "config.global",
        });
        expect(resolveNotify(layers, { type: "task", action: "finished", severity: "critical" })).toMatchObject({
            level: "off",
            from: "config.project",
        });
        const widget = { id: "widget" as const, rules: { notify: { task: { finished: "banner" as const } } } };
        expect(resolveNotify(layers, { type: "task", action: "finished" }, widget)).toMatchObject({
            level: "banner",
            from: "surface.widget",
        });
    });

    test("the consumer starts at the journal's head, sends one line per inbox-level change, and never sends one twice", async () => {
        await write(ctx("s1"), { verb: "spot", title: "old bug", type: "bug", fields: { production: true } });
        const lines: NotifyLine[] = [];
        const deps = { db, loadRules, inbox: async (line: NotifyLine) => void lines.push(line) };
        expect((await runNotifyOnce(deps)).sent).toBe(0);

        await write(ctx("s1"), { verb: "spot", title: "live bug", type: "bug", fields: { production: true } });
        await write(ctx("s1"), { verb: "spot", title: "quiet bug", type: "bug", fields: {} });
        const report = await runNotifyOnce(deps);
        expect(report.sent).toBe(1);
        expect(lines.map((l) => [l.action, l.level, l.text.split("\n")[0]])).toEqual([
            ["spotted", "inbox", "live bug"],
        ]);
        expect((await runNotifyOnce(deps)).sent).toBe(0);
    });

    test("the config grid reads both saved surface keys and inherits the hub level when the widget key is cleared", async () => {
        const repo = await TestRepo.create({ prefix: "work-notify-repo-" });
        const cell = async () => {
            const reply = await workHandlers.config(
                { project: "Other", type: ["bug"] },
                {
                    ctx: ctx("s1"),
                    loadRules: projectRuleLoader({ project: "App", configPath }),
                    call: {},
                    alive: async () => null,
                    context: async () => {
                        throw new Error("unused");
                    },
                }
            );
            return reply.ok && reply.data.rows[0].notify.find(({ action }) => action === "spotted")?.resolved;
        };
        const set = async (path: string, value: unknown) => {
            expect((await setWorkConfigValue({ configPath, path, value })).ok).toBe(true);
        };
        const widget = "projects.Other.surfaces.widget.notify.bug.spotted";

        try {
            await writeLocalRepoConfig(repo.dir, {
                work: { version: 1, rules: { notify: { bug: { spotted: "off" } } } },
            });
            await set("projects.Other.roots", [repo.dir]);
            await set("global.rules.notify.*.spotted", "list");
            await set("projects.Other.rules.notify.bug.spotted", "list");
            await set("projects.Other.surfaces.hub.notify.*.spotted", "inbox");
            await set(widget, "banner");
            expect(await cell()).toEqual({
                level: "banner",
                from: "surface.widget",
                layers: [
                    { layer: "default", value: "list" },
                    { layer: "config.global", value: "list" },
                    { layer: "config.repo", value: "off" },
                    { layer: "config.project", value: "list" },
                    { layer: "surface.hub", value: "inbox" },
                    { layer: "surface.widget", value: "banner" },
                ],
            });
            await set(widget, undefined);
            expect(await cell()).toMatchObject({ level: "inbox", from: "surface.hub" });
        } finally {
            repo.cleanup();
        }
    });

    test("a pass from App resolves Other once and delivers its project and widget levels in journal order", async () => {
        for (const [path, value] of [
            ["projects.App.rules.notify.*.spotted", "off"],
            ["projects.Other.rules.notify.*.spotted", "inbox"],
            ["projects.Other.surfaces.widget.notify.bug.spotted", "banner"],
        ]) {
            expect((await setWorkConfigValue({ configPath, path, value })).ok).toBe(true);
        }

        const loads: string[] = [];
        const lines: NotifyLine[] = [];
        const loadFromApp = projectRuleLoader({ project: "App", configPath });
        const deps: NotifyDeps = {
            db,
            loadRules: (location) => {
                loads.push(location.project);
                return loadFromApp(location);
            },
            inbox: async (line: NotifyLine) => void lines.push(line),
        };
        await runNotifyOnce(deps);
        const app = ctx("s1");
        const other = { ...app, project: "Other" };
        await write(other, { verb: "spot", title: "first", type: "task", fields: {} });
        await write(app, { verb: "spot", title: "quiet", type: "bug", fields: { production: true } });
        await write(other, { verb: "spot", title: "last", type: "bug", fields: {} });
        expect((await runNotifyOnce(deps)).sent).toBe(2);
        expect(loads).toEqual(["Other", "App"]);
        expect(lines.map(({ level, text }) => [level, text])).toEqual([
            ["inbox", "first\n\nOther · decided by config.project"],
            ["banner", "last\n\nOther · decided by surface.widget"],
        ]);
    });

    test("a failed load leaves the cursor retryable and concurrent retries only send the line once", async () => {
        const lines: NotifyLine[] = [];
        const deps = { db, loadRules, inbox: async (line: NotifyLine) => void lines.push(line) };
        await runNotifyOnce(deps);
        await write(ctx("s1"), { verb: "spot", title: "retry", type: "bug", fields: { production: true } });
        await expect(
            runNotifyOnce({
                ...deps,
                loadRules: async () => {
                    throw new Error("unavailable");
                },
            })
        ).rejects.toThrow("unavailable");

        const firstLoad = Promise.withResolvers<void>();
        const secondLoad = Promise.withResolvers<void>();
        const retry = (barrier: Promise<void>) =>
            runNotifyOnce({
                ...deps,
                loadRules: async (location) => {
                    await barrier;
                    return loadRules(location);
                },
            });
        const first = retry(firstLoad.promise);
        await write(ctx("s1"), { verb: "spot", title: "later", type: "bug", fields: { production: true } });
        const second = retry(secondLoad.promise);
        firstLoad.resolve();
        expect((await first).sent).toBe(1);
        secondLoad.resolve();
        expect((await second).sent).toBe(1);
        expect(lines.map((line) => line.text.split("\n")[0])).toEqual(["retry", "later"]);
    });
});
