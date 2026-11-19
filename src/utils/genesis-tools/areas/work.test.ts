import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createConfigStore } from "@genesiscz/utils/genesis-tools/actions/config";
import { createAreaEventBus } from "@genesiscz/utils/genesis-tools/actions/events";
import type { EngineDeps } from "@genesiscz/utils/genesis-tools/actions/registry";
import { runAreaAction } from "@genesiscz/utils/genesis-tools/actions/run";
import { memoryStateStore } from "@genesiscz/utils/genesis-tools/actions/state";
import { AREAS } from "@genesiscz/utils/genesis-tools/areas";
import type { ServiceDoor } from "@genesiscz/utils/genesis-tools/service/clients";
import { okReply } from "@genesiscz/utils/output/reply";
import { makeTempDir } from "@genesiscz/utils/paths";
import { workMethods } from "@genesiscz/utils/work/api";
import { registerWorkDoor } from "@genesiscz/utils/work/door";

function deps(events = createAreaEventBus(), inService?: { agent: boolean }): EngineDeps {
    const dir = makeTempDir("gt-work-area-");
    return {
        config: createConfigStore({ registry: AREAS, file: join(dir, "config.json") }),
        state: memoryStateStore(),
        facts: {
            platform: () => "darwin",
            isAgent: () => inService?.agent ?? true,
            isTest: () => true,
            appBundle: () => ({ installed: false, launcher: false, routingOff: false, path: "/Applications/None.app" }),
            appManifest: () => null,
            hasDisplay: async () => false,
            hasTerminal: () => false,
        },
        app: { rpc: async () => ({ ok: false, error: { code: "refused_in_test", message: "test" } }) },
        builder: null,
        events,
        now: () => new Date("2026-11-18T01:00:00Z"),
        ...(inService !== undefined ? { service: SERVICE } : {}),
    };
}

/** A service door the work area never calls: it only tells the area that it runs inside the service. */
const SERVICE: ServiceDoor = {
    journal: {} as ServiceDoor["journal"],
    hasClient: () => false,
    present: async () => {
        throw new Error("not used");
    },
};

afterEach(() => registerWorkDoor(null));

describe("the work area (work-items P7)", () => {
    test("it is in AREAS with one action per method of the table, each with only a native way", () => {
        expect(Object.keys(AREAS.work.actions).sort()).toEqual(Object.keys(workMethods).sort());
        for (const action of Object.values(AREAS.work.actions)) {
            expect(action.fallback).toBeUndefined();
        }
    });

    test("a read calls the door with the params and the call options apart, and emits nothing", async () => {
        const seen: unknown[] = [];
        registerWorkDoor({
            call: async (method, params, options) => {
                seen.push({ method, params, options });
                return okReply("list", [{ ref: "w_a", state: "open", type: "bug", title: "x", project: "App" }]);
            },
        });
        const events: unknown[] = [];
        const bus = createAreaEventBus();
        bus.on((event) => events.push(event));
        const outcome = await runAreaAction(AREAS, "work.list", { project: "App", call: { request: "r1" } }, deps(bus));
        expect(outcome.status === "ran" && outcome.via).toBe("native");
        expect(seen).toEqual([{ method: "list", params: { project: "App" }, options: { request: "r1" } }]);
        expect(events).toEqual([]);
    });

    test("a write emits work.changed with the ids its reply names; a dry run emits nothing", async () => {
        registerWorkDoor({
            call: async (method) => okReply(method, { items: [{ id: "w_b" }] }),
        });
        const events: unknown[] = [];
        const bus = createAreaEventBus();
        bus.on((event) => events.push(event));
        await runAreaAction(AREAS, "work.drop", { refs: ["w_b"], why: "done" }, deps(bus));
        await runAreaAction(AREAS, "work.drop", { refs: ["w_b"], why: "done", call: { dryRun: true } }, deps(bus));
        expect(events).toEqual([
            {
                area: "work",
                event: "changed",
                payload: { method: "drop", items: ["w_b"] },
                at: "2026-11-18T01:00:00.000Z",
            },
        ]);
    });

    test("inside the service a person writes as the owner of the project; an agent's write is refused", async () => {
        const seen: unknown[] = [];
        registerWorkDoor({
            call: async (method, _params, options) => {
                seen.push(options);
                return okReply(method, { items: [] });
            },
        });
        await runAreaAction(
            AREAS,
            "work.drop",
            { refs: ["w_b"], why: "x", call: { project: "App" } },
            deps(undefined, { agent: false })
        );
        expect(seen).toEqual([{ atSurface: { project: "App" } }]);

        const refused = await runAreaAction(
            AREAS,
            "work.drop",
            { refs: ["w_b"], why: "x" },
            deps(undefined, { agent: true })
        );
        expect(refused.status).toBe("unreachable");
        expect(refused.skipped[0]?.reason).toContain("record its session");
        expect(seen).toHaveLength(1);
    });

    test("with no door the way passes with the reason, and the outcome is unreachable", async () => {
        const outcome = await runAreaAction(AREAS, "work.list", {}, deps());
        expect(outcome.status).toBe("unreachable");
        expect(outcome.skipped[0]).toMatchObject({ way: "native", code: "passed" });
        expect(outcome.skipped[0]?.reason).toContain("work door");
    });
});
