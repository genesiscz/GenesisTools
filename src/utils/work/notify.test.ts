import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Actor } from "./model/item";
import { defaultNotify, type NotifyLine, resolveNotify, runNotifyOnce } from "./notify";
import { type WorkContext, write } from "./service";
import { openWorkDb } from "./store/db";

let db: Database;
let n = 0;

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
            legacy: { write: async () => ({ ok: false }) },
            delivery: { place: async () => null, deliver: async () => ({ outcome: "unknown", to: null, at: "" }) },
        },
        random: () => `n${String(n++).padStart(7, "0")}`,
    };
}

beforeEach(() => {
    db = openWorkDb(":memory:");
});

afterEach(() => {
    db.close();
});

describe("the notifier (P8 decision 3)", () => {
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
        const deps = { db, layers: () => [], inbox: async (line: NotifyLine) => void lines.push(line) };
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
});
