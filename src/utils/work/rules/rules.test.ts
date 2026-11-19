import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import type { Actor } from "../model/item";
import { type WorkContext, write } from "../service";
import { openWorkDb } from "../store/db";
import { migrateWorkConfig, WORK_CONFIG_VERSION, type WorkConfigMigration } from "./config";
import { loadWorkRules, readWorkConfig, setWorkConfigValue } from "./load";
import { resolveWorkRules } from "./resolve";

let dir: string;
let configPath: string;
let db: Database;
let n = 0;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "work-rules-"));
    configPath = join(dir, "config.json");
    db = openWorkDb(":memory:");
});

afterEach(() => {
    db.close();
});

function actor(sessionId: string, kind: Actor["kind"] = "agent"): Actor {
    return {
        kind,
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
}

function ctx(sessionId: string, over: Partial<WorkContext> = {}): WorkContext {
    return {
        db,
        actor: actor(sessionId),
        project: "App",
        ports: {
            legacy: { write: async () => ({ ok: false }), check: async (actions) => actions.map(() => ({ ok: true })) },
            delivery: { place: async () => null, deliver: async () => ({ outcome: "unknown", to: null, at: "" }) },
        },
        random: () => `r${String(n++).padStart(7, "0")}`,
        ...over,
    };
}

describe("the config file", () => {
    test.each(["", "projects..App", "__proto__", "projects.constructor.setting", "projects.App.prototype"])(
        "rejects the invalid path %j without writing the config",
        async (path) => {
            const before = SafeJSON.stringify({ version: WORK_CONFIG_VERSION });
            writeFileSync(configPath, before);
            expect(await setWorkConfigValue({ configPath, path, value: "ignored" })).toMatchObject({ ok: false });
            expect(readFileSync(configPath, "utf8")).toBe(before);
        }
    );

    test("an old fixture loads, a set round-trips, a newer file gives defaults and a problem", async () => {
        writeFileSync(
            configPath,
            SafeJSON.stringify({
                version: 1,
                projects: { App: { rules: { types: { bug: { fields: { where: { level: "required" } } } } } } },
            })
        );
        expect(readWorkConfig(configPath).problems).toEqual([]);
        expect(SafeJSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({ version: 1 });

        const set = await setWorkConfigValue({
            path: "projects.App.rules.types.bug.fields.why",
            value: { level: "required", measure: "one sentence" },
            configPath,
        });
        expect(set.ok).toBe(true);
        const reread = readWorkConfig(configPath).value;
        expect(reread.projects?.App?.rules?.types?.bug?.fields?.why).toEqual({
            level: "required",
            measure: "one sentence",
        });
        expect(reread.projects?.App?.rules?.types?.bug?.fields?.where).toEqual({ level: "required" });

        const refused = await setWorkConfigValue({
            path: "projects.App.rules.types.bug.fields.why",
            value: { level: "maybe" },
            configPath,
        });
        expect(refused.ok).toBe(false);
        expect(SafeJSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({ version: WORK_CONFIG_VERSION });

        writeFileSync(configPath, SafeJSON.stringify({ version: 7 }));
        const newer = readWorkConfig(configPath);
        expect(newer.value).toEqual({ version: WORK_CONFIG_VERSION });
        expect(newer.problems[0].code).toBe("CONFIG_UNUSABLE");
    });

    test("the surface migration preserves version 1 project rules and runs only once", () => {
        const projects = { App: { rules: { notify: { bug: { spotted: "inbox" } } } } };
        const first = migrateWorkConfig({ version: 1, projects });
        expect(first.ok && first.migrated).toEqual(["project-surface-notify"]);
        expect(first.ok && first.raw).toEqual({ version: WORK_CONFIG_VERSION, projects });
        const second = migrateWorkConfig(first.ok ? first.raw : {});
        expect(second.ok && second.migrated).toEqual([]);
        expect(second.ok && second.raw).toEqual(first.ok ? first.raw : {});
    });

    test("a second migration run changes nothing", () => {
        const chain: WorkConfigMigration[] = [
            { from: 1, to: 2, id: "rename", describe: "x", run: (raw) => ({ ...raw, renamed: true }) },
        ];
        const first = migrateWorkConfig({ version: 1 }, chain, 2);
        expect(first.ok && first.migrated).toEqual(["rename"]);
        expect(first.ok && first.raw).toEqual({ version: 2, renamed: true });
        const second = migrateWorkConfig(first.ok ? first.raw : {}, chain, 2);
        expect(second.ok && second.migrated).toEqual([]);
        expect(second.ok && second.raw).toEqual(first.ok ? first.raw : {});
    });

    test("each value keeps the layer that set it; the exact type beats * in a layer", async () => {
        writeFileSync(
            configPath,
            SafeJSON.stringify({
                version: 1,
                global: { rules: { types: { "*": { fields: { cost: { level: "recommended" } } } } } },
                projects: { App: { rules: { types: { bug: { fields: { cost: { level: "required" } } } } } } },
            })
        );
        const loaded = await loadWorkRules({ project: "App", configPath });
        const bug = loaded.rules.field("bug", "cost");
        expect(bug.value.level).toBe("required");
        expect(bug.from).toBe("config.project");
        expect(bug.layers.map((l) => l.layer)).toEqual(["default", "config.global", "config.project"]);
        expect(loaded.rules.field("idea", "cost").from).toBe("config.global");
    });

    test("a warm load is fast", async () => {
        writeFileSync(configPath, SafeJSON.stringify({ version: 1 }));
        await loadWorkRules({ project: "App", configPath });
        const start = performance.now();
        await loadWorkRules({ project: "App", configPath });
        expect(performance.now() - start).toBeLessThan(50);
    });
});

describe("the write rules", () => {
    const strict = resolveWorkRules([
        {
            layer: "config.project",
            rules: { types: { bug: { fields: { where: { level: "required", measure: "path:line of the defect" } } } } },
        },
    ]);

    test("a missing required field refuses the write and prints the measure line", async () => {
        const reply = await write(ctx("s1", { rules: strict }), { verb: "spot", title: "x", type: "bug", fields: {} });
        expect(reply.ok).toBe(false);
        expect(reply.diagnostics[0]).toMatchObject({ code: "FIELD_REQUIRED", field: "where" });
        expect(reply.diagnostics[0].message).toContain("path:line of the defect");
        expect(db.query("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 0 });
    });

    test("a missing recommended field writes and warns", async () => {
        const reply = await write(ctx("s1", { rules: strict }), {
            verb: "spot",
            title: "x",
            type: "bug",
            fields: { where: "a.ts:1" },
        });
        expect(reply.ok).toBe(true);
        expect(reply.diagnostics.filter((d) => d.code === "FIELD_RECOMMENDED").map((d) => d.field)).toEqual([
            "why",
            "userSees",
        ]);
    });

    test("accepting an idea requires an owner actor and records the supplied words", async () => {
        const spotted = await write(ctx("finder"), { verb: "spot", title: "an idea", type: "idea", fields: {} });
        const id = spotted.ok ? spotted.data.items[0].id : "";
        const refused = await write(ctx("other"), { verb: "accept", refs: [id] });
        expect(refused.ok).toBe(false);
        expect(refused.diagnostics[0].code).toBe("ROLE_REFUSED");

        const claimed = await write(ctx("other", { ownerSaid: "yes, take the idea" }), { verb: "accept", refs: [id] });
        expect(claimed.diagnostics[0].code).toBe("ROLE_REFUSED");

        const allowed = await write(
            ctx("other", {
                actor: actor("other", "owner"),
                ownerSaid: "yes, take the idea",
            }),
            { verb: "accept", refs: [id] }
        );
        expect(allowed.ok).toBe(true);
        const row = db.query("SELECT stamp FROM changes WHERE item = ? AND kind = 'moved'").get(id) as {
            stamp: string;
        };
        expect(row.stamp).toContain("yes, take the idea");
    });

    test("the finder may accept its own bug; a routing rule may accept and place it at once", async () => {
        const own = await write(ctx("finder"), { verb: "spot", title: "b", type: "bug", fields: {} });
        const id = own.ok ? own.data.items[0].id : "";
        expect((await write(ctx("finder"), { verb: "accept", refs: [id] })).ok).toBe(true);

        const routed = resolveWorkRules([
            {
                layer: "config.project",
                // biome-ignore lint/suspicious/noThenProperty: the routing rule's shape is { when, then }
                rules: { routing: { spotted: [{ when: { minSeverity: "high" }, then: { accept: true } }] } },
            },
        ]);
        const high = await write(ctx("finder", { rules: routed }), {
            verb: "spot",
            title: "h",
            type: "bug",
            severity: "critical",
            fields: {},
        });
        expect(high.ok && high.data.items[0].state).toBe("open");
        const low = await write(ctx("finder", { rules: routed }), {
            verb: "spot",
            title: "l",
            type: "bug",
            severity: "low",
            fields: {},
        });
        expect(low.ok && low.data.items[0].state).toBe("spotted");
    });
});
