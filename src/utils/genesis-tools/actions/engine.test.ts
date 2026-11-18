import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigStore, resolveConfig } from "@genesiscz/utils/genesis-tools/actions/config";
import { defineAction, defineArea } from "@genesiscz/utils/genesis-tools/actions/define";
import { createAreaEventBus } from "@genesiscz/utils/genesis-tools/actions/events";
import { clientsOf, type EngineDeps } from "@genesiscz/utils/genesis-tools/actions/registry";
import { explainAction, runAreaAction } from "@genesiscz/utils/genesis-tools/actions/run";
import { memoryStateStore, parseStateText } from "@genesiscz/utils/genesis-tools/actions/state";
import type { AppBuilder } from "@genesiscz/utils/genesis-tools/app-builder";
import { AREAS } from "@genesiscz/utils/genesis-tools/areas";
import { parseSwiftRpcMethods } from "@genesiscz/utils/genesis-tools/capability/app-surface-source";
import type { Facts } from "@genesiscz/utils/genesis-tools/capability/facts";
import { Need } from "@genesiscz/utils/genesis-tools/capability/needs";
import { SafeJSON } from "@genesiscz/utils/json";
import { z } from "zod";
import { APP_SURFACE_PATH, readAppSurfaceInput, renderAppSurface } from "../../../../scripts/gen-genesis-app-surface";

function fakeFacts(overrides: Partial<Facts> = {}): Facts {
    return {
        platform: () => "darwin",
        isAgent: () => false,
        isTest: () => false,
        appBundle: () => ({ installed: true, routingOff: false, path: "/Applications/Fake.app" }),
        appManifest: () => ({ buildId: "b1", parts: ["features"], rpcMethods: ["rpc.hello"] }),
        hasDisplay: () => true,
        hasTerminal: () => false,
        ...overrides,
    };
}

const calls: string[] = [];

const demo = defineArea({
    area: "demo",
    summary: "test area",
    config: z.object({ tone: z.string().default("area-default") }),
    events: { changed: z.object({ id: z.string() }) },
    actions: {
        greet: defineAction({
            summary: "greets",
            args: z.object({ name: z.string() }),
            result: z.object({ text: z.string(), via: z.string() }),
            config: z.object({ loud: z.boolean().default(false) }),
            native: {
                needs: [Need.app.part("hub")],
                run: (ctx) => {
                    calls.push("native");
                    return { text: `hi ${ctx.args.name}`, via: "native" };
                },
            },
            fallback: {
                linux: {
                    needs: [Need.platform.linux],
                    run: () => ({ text: "linux", via: "linux" }),
                },
                passes: (ctx) => ctx.pass("nothing to do here"),
                throws: () => {
                    throw new Error("boom");
                },
                last: (ctx) => {
                    ctx.emit("changed", { id: ctx.args.name });
                    return { text: `${ctx.config.loud}/${String(ctx.areaConfig.tone)}`, via: "last" };
                },
            },
            fix: (ctx) => ctx.build("hub"),
            manual: (args) => `greet ${args.name} by hand`,
        }),
    },
});

const REGISTRY = { demo };

function deps(overrides: Partial<EngineDeps> = {}): EngineDeps {
    const dir = mkdtempSync(join(tmpdir(), "gt-actions-"));
    return {
        config: createConfigStore({ registry: REGISTRY, file: join(dir, "config.json") }),
        state: memoryStateStore(),
        facts: fakeFacts(),
        app: { rpc: async () => ({ ok: false, error: { code: "refused_in_test", message: "test" } }) },
        builder: null,
        events: createAreaEventBus(),
        now: () => new Date("2026-11-17T12:00:00Z"),
        ...overrides,
    };
}

describe("runAreaAction", () => {
    test("tries the ways in order and names why each one was skipped", async () => {
        const events: unknown[] = [];
        const bus = createAreaEventBus();
        bus.on((event) => events.push(event));
        const outcome = await runAreaAction(REGISTRY, "demo.greet", { name: "alice" }, deps({ events: bus }));

        expect(outcome.status).toBe("ran");
        expect(outcome.status === "ran" && outcome.via).toBe("fallback.last");
        expect(outcome.skipped.map((skip) => [skip.way, skip.code])).toEqual([
            ["native", "part-missing"],
            ["fallback.linux", "platform"],
            ["fallback.passes", "passed"],
            ["fallback.throws", "threw"],
        ]);
        expect(outcome.skipped[0]?.fix?.command).toBe("tools macos permissions build --add-part hub");
        expect(events).toEqual([
            { area: "demo", event: "changed", payload: { id: "alice" }, at: "2026-11-17T12:00:00.000Z" },
        ]);
    });

    test("native runs when its needs hold, and a missing way list ends unreachable with the manual text", async () => {
        const facts = fakeFacts({ appManifest: () => ({ buildId: "b1", parts: ["hub"], rpcMethods: null }) });
        const ran = await runAreaAction(REGISTRY, "demo.greet", { name: "bob" }, deps({ facts }));
        expect(ran.status === "ran" && ran.value).toEqual({ text: "hi bob", via: "native" });

        const testFacts = fakeFacts({ isTest: () => true, platform: () => "freebsd" });
        const none = defineArea({
            area: "none",
            summary: "",
            actions: {
                act: defineAction({
                    summary: "",
                    args: z.object({}),
                    result: z.object({}),
                    native: { needs: [Need.app.installed], run: () => ({}) },
                    manual: () => "do it by hand",
                }),
            },
        });
        const config = createConfigStore({
            registry: { none },
            file: join(mkdtempSync(join(tmpdir(), "gt-actions-")), "config.json"),
        });
        const outcome = await runAreaAction({ none }, "none.act", {}, deps({ facts: testFacts, config }));
        expect(outcome).toEqual({
            status: "unreachable",
            skipped: [
                {
                    way: "native",
                    code: "in-test",
                    reason: "app.installed: a test process never reaches GenesisTools.app",
                    fix: null,
                },
            ],
            manual: "do it by hand",
        });
    });

    test("fix: a build decision builds, checks the need again and then runs the way", async () => {
        let parts = ["features"];
        const builds: Array<string | null> = [];
        const builder: AppBuilder = {
            build: async (part) => {
                builds.push(part);
                parts = [...parts, "hub"];
            },
            offerBuild: async () => false,
            buildCommand: () => "build-it",
        };
        const facts = fakeFacts({ appManifest: () => ({ buildId: "b2", parts, rpcMethods: null }) });
        const outcome = await runAreaAction(REGISTRY, "demo.greet", { name: "carol" }, deps({ facts, builder }));

        expect(builds).toEqual(["hub"]);
        expect(outcome.status === "ran" && outcome.via).toBe("native");
    });

    test("fix: a test process never builds, even with a builder", async () => {
        const builder: AppBuilder = {
            build: async () => {
                throw new Error("a test process must not build");
            },
            offerBuild: async () => {
                throw new Error("a test process must not offer a build");
            },
            buildCommand: () => "build-it",
        };
        const facts = fakeFacts({ isTest: () => true });
        const outcome = await runAreaAction(REGISTRY, "demo.greet", { name: "dan" }, deps({ facts, builder }));
        expect(outcome.skipped[0]?.code).toBe("in-test");
    });

    test("wrong args throw before any way runs", async () => {
        calls.length = 0;
        await expect(runAreaAction(REGISTRY, "demo.greet", { name: 3 }, deps())).rejects.toThrow(
            "the arguments do not match"
        );
        expect(calls).toEqual([]);
    });

    test("clientsOf runs the same engine as runAreaAction", async () => {
        const clients = clientsOf(REGISTRY, () => deps());
        const outcome = await clients.demo.greet({ name: "erin" });
        expect(outcome.status === "ran" && outcome.via).toBe("fallback.last");
    });
});

describe("config resolution", () => {
    test("schema defaults, then the area's stored values, then the action's", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-actions-config-"));
        const store = createConfigStore({ registry: REGISTRY, file: join(dir, "config.json") });

        expect(store.resolve("demo", "greet")).toEqual({ tone: "area-default", loud: false });
        await store.set("demo.tone", "area-set");
        expect(store.resolve("demo", "greet")).toEqual({ tone: "area-set", loud: false });
        await store.set("demo.greet.tone", "action-set");
        await store.set("demo.greet.loud", true);
        expect(store.resolve("demo", "greet")).toEqual({ tone: "action-set", loud: true });
        expect(store.read()).toEqual({
            version: 1,
            areas: { demo: { tone: "area-set", actions: { greet: { tone: "action-set", loud: true } } } },
        });
        await store.unset("demo.greet.tone");
        expect(store.get("demo.greet.tone")).toBe("area-set");
        await expect(store.set("demo.greet.loud", "yes")).rejects.toThrow("demo.greet.loud");
        await expect(store.set("demo.nope", 1)).rejects.toThrow('no config key "nope"');
    });

    test("a broken file refuses a set and resolves to the defaults", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-actions-config-"));
        const file = join(dir, "config.json");
        writeFileSync(file, "[1, 2");
        const store = createConfigStore({ registry: REGISTRY, file });

        expect(store.resolve("demo", "greet")).toEqual({ tone: "area-default", loud: false });
        await expect(store.set("demo.tone", "x")).rejects.toThrow();
    });

    test("resolveConfig is pure over a file", () => {
        const file = { version: 1 as const, areas: { demo: { tone: "t", actions: { greet: { loud: true } } } } };
        expect(resolveConfig(file, demo, "greet")).toEqual({ tone: "t", loud: true });
        expect(resolveConfig(file, demo)).toEqual({ tone: "t" });
    });
});

describe("state file", () => {
    const full = `${SafeJSON.stringify(
        {
            version: 1,
            areas: {
                app: {
                    installed: { value: true, at: "2026-11-17T12:00:00.000Z", source: "probe" },
                    rpcMethods: { value: ["rpc.hello"], at: "2026-11-17T12:00:00.000Z", source: "app", build: "b1" },
                    bad: { value: 1, at: 5, source: "probe" },
                },
            },
        },
        null,
        2
    )}\n`;

    test("every prefix of a state file reads without throwing, and keeps only well-formed values", () => {
        for (let length = 0; length <= full.length; length++) {
            const state = parseStateText(full.slice(0, length));
            expect(state.version).toBe(1);

            for (const values of Object.values(state.areas)) {
                for (const value of Object.values(values)) {
                    expect(typeof value.at).toBe("string");
                    expect(["build", "app", "probe"]).toContain(value.source);
                }
            }
        }

        expect(Object.keys(parseStateText(full).areas.app ?? {})).toEqual(["installed", "rpcMethods"]);
    });
});

describe("the real areas", () => {
    test("explain windows.open names the ways and changes no state without --fresh", async () => {
        const state = memoryStateStore();
        const before = SafeJSON.stringify(state.read());
        const dir = mkdtempSync(join(tmpdir(), "gt-actions-explain-"));
        const explain = await explainAction(
            AREAS,
            "windows.open",
            deps({ state, config: createConfigStore({ registry: AREAS, file: join(dir, "config.json") }) }),
            { args: { window: "--hub" } }
        );

        expect(explain.ways.map((way) => way.way)).toEqual(["native"]);
        expect(explain.ways[0]?.needs.map((need) => need.need)).toEqual([
            "platform.darwin",
            "app.installed",
            "app.part(hub)",
            "person.display",
        ]);
        expect(explain.first).toBeNull();
        expect(explain.config).toEqual({ fix: "offer" });
        expect(SafeJSON.stringify(state.read())).toBe(before);
    });
});

describe("the app surface generator", () => {
    test("reads the Swift method list from a fixture, and the committed file matches the sources", async () => {
        const fixture = 'import Foundation\nlet rpcMethods = ["rpc.hello", "notify.post"]\nfunc x() {}\n';
        expect(parseSwiftRpcMethods(fixture)).toEqual(["rpc.hello", "notify.post"]);
        expect(() => parseSwiftRpcMethods("let other = []")).toThrow("rpcMethods");

        const committed = await Bun.file(APP_SURFACE_PATH).text();
        expect(renderAppSurface(readAppSurfaceInput())).toBe(committed);
    });
});

test("app.hello reports methods to the injected state, and app.rpc returns the reply", async () => {
    const state = memoryStateStore();
    const value = { protocol: 1, bundleId: "example.fixture", version: "1", build: "fixture", methods: ["rpc.hello"] };
    const dir = mkdtempSync(join(tmpdir(), "gt-app-actions-"));
    const injected = deps({
        state,
        config: createConfigStore({ registry: AREAS, file: join(dir, "config.json") }),
        app: { rpc: async <T>() => ({ ok: true, result: value as T }) },
    });
    expect((await runAreaAction(AREAS, "app.hello", {}, injected)).status).toBe("ran");
    expect(state.get("app", "rpcMethods")?.value).toEqual(["rpc.hello"]);
    const reply = await runAreaAction(AREAS, "app.rpc", { method: "rpc.hello" }, injected);
    expect(reply.status === "ran" && reply.value).toEqual(value);
});
