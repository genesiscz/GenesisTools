import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { makeTempDir } from "@genesiscz/utils/paths";
import { workFormatters } from "../formatters";
import { callWork } from "../handlers";
import type { ContextStamp, ContextStampFact } from "../model/change";
import { type Actor, asItemId } from "../model/item";
import { showItem } from "../read";
import { type WorkContext, write } from "../service";
import { applyChange } from "../store/apply";
import { openWorkDb } from "../store/db";
import { migrateWorkConfig, WORK_CONFIG_VERSION, type WorkConfigMigration } from "./config";
import { loadWorkRules, readWorkConfig, setWorkConfigValue } from "./load";
import { resolveWorkRules } from "./resolve";

let dir: string;
let configPath: string;
let db: Database;
let n = 0;

beforeEach(() => {
    dir = makeTempDir("work-rules-");
    configPath = join(dir, "config.json");
    db = openWorkDb(":memory:");
});

afterEach(() => {
    db.close();
});

test("notification edits and restores obey repository rules for a different project", async () => {
    const initialized = Bun.spawnSync(["git", "init", "-q", dir], { env: process.env });
    expect(initialized.exitCode).toBe(0);
    writeFileSync(
        join(dir, ".git", "genesis-tools.config.json"),
        SafeJSON.stringify({ work: { version: 1, rules: { notify: { "*": { spotted: "off" } } } } })
    );
    writeFileSync(configPath, SafeJSON.stringify({ version: WORK_CONFIG_VERSION, projects: { App: {} } }));
    applyChange(db, {
        v: 1,
        ts: "2026-11-19T06:00:00.000Z",
        item: asItemId("w_fixture1"),
        actor: { ...actor("fixture"), project: "Orchard", repoRoot: dir },
        origin: { via: "local" },
        kind: "created",
        payload: { type: "bug", state: "spotted", project: "Orchard", title: "Check export", tags: [], fields: {} },
    });
    const session = {
        ctx: ctx("caller"),
        call: {},
        configPath,
        alive: async () => null,
        context: async () => {
            throw new Error("Unexpected request for context");
        },
    };
    const project = "Orchard";
    const cell = { type: "bug", action: "spotted" };
    const before = readFileSync(configPath, "utf8");
    for (const edit of [{ notify: { ...cell, level: "inbox" } }, { restore: [{ ...cell, from: "inbox", to: null }] }]) {
        expect(await callWork("configSet", { project, scope: "project", ...edit }, session)).toMatchObject({
            ok: false,
            diagnostics: [{ code: "REPO_RULE_LOCKED" }],
        });
    }
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(
        await callWork(
            "configSet",
            {
                project,
                scope: "project",
                notify: { type: "bug", action: "finished", level: "inbox" },
            },
            session
        )
    ).toMatchObject({ ok: true });
    expect(readWorkConfig(configPath).value.projects?.[project]?.rules?.notify?.bug?.finished).toBe("inbox");
    expect(
        await callWork(
            "configSet",
            {
                scope: "project",
                notify: { type: "bug", action: "finished", level: "off" },
            },
            session
        )
    ).toMatchObject({ ok: true });
    expect(readWorkConfig(configPath).value.projects?.App?.rules?.notify?.bug?.finished).toBe("off");
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
    test.each([
        "",
        "projects..App",
        "__proto__",
        "projects.constructor.setting",
        "projects.App.prototype",
        "unexpected",
        "projects.App.rules.types.bug.unexpected",
    ])("rejects the invalid path %j without writing the config", async (path) => {
        const before = SafeJSON.stringify({ version: WORK_CONFIG_VERSION });
        writeFileSync(configPath, before);
        expect(await setWorkConfigValue({ configPath, path, value: "ignored" })).toMatchObject({ ok: false });
        expect(readFileSync(configPath, "utf8")).toBe(before);
    });

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

        const beforeRefusal = readFileSync(configPath, "utf8");
        const refused = await setWorkConfigValue({
            path: "projects.App.rules.types.bug.fields.why",
            value: { level: "maybe" },
            configPath,
        });
        expect(refused.ok).toBe(false);
        expect(readFileSync(configPath, "utf8")).toBe(beforeRefusal);

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
                projects: {
                    App: {
                        rules: {
                            types: {
                                "*": { fields: { cost: { level: "optional" } } },
                                bug: { fields: { cost: { level: "required" } } },
                            },
                        },
                    },
                },
            })
        );
        const loaded = await loadWorkRules({ project: "App", configPath });
        const bug = loaded.rules.field("bug", "cost");
        expect(bug.value.level).toBe("required");
        expect(bug.from).toBe("config.project");
        expect(bug.layers.map((l) => l.layer)).toEqual(["default", "config.global", "config.project"]);
        expect(loaded.rules.field("idea", "cost").value.level).toBe("optional");
    });
});

describe("the write rules", () => {
    test("spot and worker deferral honor the project's explicit rules", async () => {
        const rules = resolveWorkRules([
            { layer: "config.project", rules: { types: { bug: { writes: { spot: ["owner"], edit: [] } } } } },
        ]);
        const spot = { verb: "spot", type: "bug", title: "report", fields: {} } as const;
        expect((await write(ctx("agent", { rules }), spot)).diagnostics[0].code).toBe("ROLE_REFUSED");
        expect((await write(ctx("owner", { rules, actor: actor("owner", "owner") }), spot)).ok).toBe(true);

        const made = await write(ctx("agent"), { verb: "add", type: "bug", title: "report" });
        const id = made.ok ? made.data.items[0].id : "";
        expect((await write(ctx("agent"), { verb: "claim", ref: id })).ok).toBe(true);
        expect(
            (await write(ctx("agent", { rules }), { verb: "edit", ref: id, fields: { why: "later" } })).diagnostics[0]
                .code
        ).toBe("ROLE_REFUSED");
    });

    test("a parent move is a reference; the poster may edit its own epic and notes, another session may not", async () => {
        const epic = await write(ctx("maker"), { verb: "add", type: "epic", title: "big" });
        const epicId = epic.ok ? epic.data.items[0].id : "";
        const risk = await write(ctx("finder"), { verb: "spot", type: "risk", title: "a risk", fields: {} });
        const riskId = risk.ok ? risk.data.items[0].id : "";
        expect((await write(ctx("maker"), { verb: "edit", ref: epicId, title: "bigger" })).ok).toBe(true);
        expect((await write(ctx("other"), { verb: "edit", ref: riskId, parent: epicId })).ok).toBe(true);
        expect((await write(ctx("other"), { verb: "edit", ref: epicId, title: "mine" })).diagnostics[0].code).toBe(
            "ROLE_REFUSED"
        );
        expect(
            (await write(ctx("other"), { verb: "edit", ref: riskId, parent: epicId, title: "renamed" })).diagnostics[0]
                .code
        ).toBe("ROLE_REFUSED");
        expect((await write(ctx("finder"), { verb: "edit", ref: riskId, title: "renamed" })).ok).toBe(true);
    });

    test("an unchanged title does not bypass a parent reference rule", async () => {
        const first = await write(ctx("maker"), { verb: "spot", type: "bug", title: "unchanged", fields: {} });
        const second = await write(ctx("maker"), { verb: "spot", type: "bug", title: "parent", fields: {} });
        if (!first.ok || !second.ok) {
            throw new Error("fixture items missing");
        }
        const rules = resolveWorkRules([
            {
                layer: "config.project",
                rules: {
                    types: { bug: { writes: { edit: "anyone", reference: ["owner"] } } },
                },
            },
        ]);
        const reply = await write(ctx("maker", { rules }), {
            verb: "edit",
            ref: first.data.items[0].id,
            title: "unchanged",
            parent: second.data.items[0].id,
        });
        expect(reply.ok).toBe(false);
        expect(reply.diagnostics[0].code).toBe("ROLE_REFUSED");
    });

    test("a released worker and a child with only its lead's session cannot edit", async () => {
        const made = await write(ctx("worker"), { verb: "add", type: "task", title: "work" });
        const id = made.ok ? made.data.items[0].id : "";
        expect((await write(ctx("worker"), { verb: "claim", ref: id })).ok).toBe(true);
        const rules = resolveWorkRules([
            { layer: "config.project", rules: { types: { task: { writes: { edit: ["worker"] } } } } },
        ]);
        const child = ctx("child", { rules });
        child.actor.sessionId = null;
        const { decide } = await import("../store/decide");
        const { sqlView } = await import("../store/view");
        const { envOf } = await import("../service");
        const edit = { verb: "edit", ref: id, title: "child edit" } as const;
        expect(decide(edit, sqlView(db), { ...(await envOf(child)), lineage: ["worker"] }).ok).toBe(false);
        expect((await write(ctx("worker"), { verb: "release", ref: id })).ok).toBe(true);
        expect((await write(ctx("worker", { rules }), edit)).diagnostics[0].code).toBe("ROLE_REFUSED");
    });

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

describe("the role override", () => {
    async function spotIdea(session: string): Promise<string> {
        const spotted = await write(ctx(session), { verb: "spot", title: "an idea", type: "idea", fields: {} });
        return spotted.ok ? spotted.data.items[0].id : "";
    }

    function overrideFacts(id: string): ContextStampFact[] {
        const row = db.query("SELECT stamp FROM changes WHERE item = ? AND kind = 'moved'").get(id) as {
            stamp: string | null;
        } | null;
        const stamp = row?.stamp ? (SafeJSON.parse(row.stamp) as ContextStamp) : null;
        return (stamp?.facts ?? []).filter((fact) => fact.path.startsWith("role-override"));
    }

    test("a poster finishes its idea only with a reason, and the journal and the log keep it", async () => {
        const id = await spotIdea("finder");
        const finish = { verb: "finish", ref: id, proof: "done" } as const;

        const refused = await write(ctx("finder"), finish);
        expect(refused.ok).toBe(false);
        expect(refused.diagnostics[0].code).toBe("ROLE_REFUSED");
        expect(refused.diagnostics[0].message).toContain("needs lead or owner; this session is poster.");
        expect(refused.diagnostics[0].message).toContain('Repeat with --override "<why this session does it>"');
        expect(refused.next[0].do).toContain("--override");
        expect(refused.next.at(-1)?.do).toBe("ask the owner");

        const blank = await write(ctx("finder", { override: "   " }), finish);
        expect(blank.ok).toBe(false);
        expect(blank.diagnostics[0].message).toContain("Repeat with --override");

        const done = await write(ctx("finder", { override: "  the owner asked to close it  " }), finish);
        expect(done.ok).toBe(true);
        expect(done.diagnostics.find((d) => d.code === "ROLE_OVERRIDE")?.message).toBe(
            `finish of ${id}: the role rule (lead or owner) was overridden; the journal keeps the reason.`
        );
        expect(overrideFacts(id)).toEqual([
            { path: "role-override", value: "the owner asked to close it", method: "given", source: "--override" },
            {
                path: "role-override.rule",
                value: "finish needs lead or owner; the session was poster",
                method: "read",
                source: "rules",
            },
        ]);
        const moved = db.query("SELECT actor FROM changes WHERE item = ? AND kind = 'moved'").get(id) as {
            actor: string;
        };
        expect(moved.actor).toContain('"sessionId":"finder"');

        const shown = showItem(db, id);
        const text = shown ? workFormatters({ section: "log" }).show.text(shown, { tty: false, width: 120 }) : [];
        expect(text.join("\n")).toContain(
            "[override: the owner asked to close it; finish needs lead or owner; the session was poster]"
        );

        const again = await write(ctx("finder", { override: "again" }), finish);
        expect(again.ok && again.data.noop).toBe(true);
        expect(again.diagnostics.some((d) => d.code === "ROLE_OVERRIDE" || d.code === "OVERRIDE_NOT_NEEDED")).toBe(
            false
        );
    });

    test("override audit output escapes terminal controls and bounds its reason while the journal keeps it", async () => {
        const id = await spotIdea("finder");
        const reason = `owner\nasked\u001b[31m ${"x".repeat(140)}`;
        const result = await write(ctx("finder", { override: reason }), { verb: "finish", ref: id, proof: "done" });
        expect(result.ok).toBe(true);
        const shown = showItem(db, id);
        if (!shown) {
            throw new Error("fixture item is missing");
        }
        const text = workFormatters({ section: "log" }).show.text(shown, { tty: false, width: 120 }).join("\n");
        const renderedReason = text.split("[override: ")[1]?.split(";")[0];
        expect(renderedReason).toHaveLength(100);
        expect(renderedReason).toStartWith("owner asked [31m ");
        expect(renderedReason).not.toContain("\u001b");
        expect(renderedReason).not.toContain("\n");
        expect(overrideFacts(id)[0].value).toBe(reason);
    });

    test("the built-in rules allow no override of accept, and a rule of nobody is never overridden", async () => {
        const id = await spotIdea("finder");
        const accept = await write(ctx("finder", { override: "I think it is good" }), { verb: "accept", refs: [id] });
        expect(accept.ok).toBe(false);
        expect(accept.diagnostics[0].code).toBe("ROLE_REFUSED");
        expect(accept.diagnostics[0].message).toContain(
            "The override cannot apply: the project's rules allow no override of accept for type idea."
        );
        expect(accept.next.map((step) => step.do)).toEqual(["ask the owner"]);

        const claim = await write(ctx("finder", { override: "I want it" }), { verb: "claim", ref: id });
        expect(claim.ok).toBe(false);
        expect(claim.diagnostics[0].message).toContain("needs nobody");
        expect(claim.diagnostics[0].message).toContain("The override cannot apply: the rule names nobody.");
    });

    test("project rules turn the override of a verb off or on", async () => {
        const off = resolveWorkRules([
            { layer: "config.project", rules: { types: { idea: { overrides: { finish: [] } } } } },
        ]);
        const first = await spotIdea("finder");
        const refused = await write(ctx("finder", { rules: off, override: "the owner asked" }), {
            verb: "finish",
            ref: first,
            proof: "done",
        });
        expect(refused.ok).toBe(false);
        expect(refused.diagnostics[0].message).toContain("allow no override of finish for type idea");
        expect(off.mayOverride("idea", "finish")).toMatchObject({ value: [], from: "config.project" });

        const on = resolveWorkRules([
            { layer: "config.project", rules: { types: { idea: { overrides: { accept: "anyone" } } } } },
        ]);
        const second = await spotIdea("finder");
        const accepted = await write(ctx("finder", { rules: on, override: "the owner said yes in chat" }), {
            verb: "accept",
            refs: [second],
        });
        expect(accepted.ok).toBe(true);
        expect(overrideFacts(second).map((fact) => fact.value)).toEqual([
            "the owner said yes in chat",
            "accept needs owner; the session was poster",
        ]);
    });

    test("an override that was not needed writes no trace and says so", async () => {
        const spotted = await write(ctx("finder"), { verb: "spot", title: "a bug", type: "bug", fields: {} });
        const id = spotted.ok ? spotted.data.items[0].id : "";
        const done = await write(ctx("finder", { override: "just in case" }), { verb: "finish", ref: id, proof: "ok" });
        expect(done.ok).toBe(true);
        expect(overrideFacts(id)).toEqual([]);
        expect(done.diagnostics.find((d) => d.code === "OVERRIDE_NOT_NEEDED")?.message).toBe(
            `this session may finish ${id}; --override was not used.`
        );
    });
});
