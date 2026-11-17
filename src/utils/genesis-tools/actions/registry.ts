import { type AppBuilder, appBuilder as registeredAppBuilder } from "@genesiscz/utils/genesis-tools/app-builder";
import { type Facts, LIVE_FACTS } from "@genesiscz/utils/genesis-tools/capability/facts";
import { genesisAppRpc } from "@genesiscz/utils/macos/genesis-app-rpc";
import type { z } from "zod";
import type { ServiceDoor } from "../service/clients";
import { type ConfigStore, createConfigStore } from "./config";
import type { ActionOutcome, AnyActionDef, AppDoor, AreaDef, ArgsOf, ResultOf, RunOptions } from "./define";
import { type AreaEventBus, createAreaEventBus } from "./events";
import { runAction } from "./run";
import { createStateStore, type StateStore } from "./state";

/**
 * The areas of GenesisTools. Each area file adds itself by declaration merging:
 *
 *     declare module "@genesiscz/utils/genesis-tools/actions/registry" {
 *         interface GenesisToolsAreas { clipboard: typeof clipboard }
 *     }
 *
 * and `areas/index.ts` lists it in `AREAS`, which `satisfies Record<keyof GenesisToolsAreas, Area>`.
 */
// biome-ignore lint/suspicious/noEmptyInterface: every area merges itself into this interface.
export interface GenesisToolsAreas {}

// biome-ignore lint/suspicious/noExplicitAny: the registry holds areas of every config type.
export type Area = AreaDef<string, Record<string, AnyActionDef>, any>;

export type AreaClient<A> =
    A extends AreaDef<string, infer Actions, z.ZodObject>
        ? {
              [K in keyof Actions]: (
                  args: ArgsOf<Actions[K]>,
                  options?: RunOptions
              ) => Promise<ActionOutcome<ResultOf<Actions[K]>>>;
          }
        : never;

export type StitchedClients<T> = { [N in keyof T]: AreaClient<T[N]> };

/** `gt.<area>.<action>(args)`. */
export type AreaClients = StitchedClients<GenesisToolsAreas>;

/**
 * What a way sees as `ctx.<area>`: every area's client, except that `ctx.app` is the one-shot `rpc` door. The app
 * area's own actions are `gt.app.*`: typing them into `ctx.app` made every way that uses the door depend on the app
 * area's own type, which TypeScript refuses as a cycle (TS7022).
 */
export type ContextAreas = Omit<AreaClients, "app"> & { app: AppDoor };

export interface EngineDeps {
    config: ConfigStore;
    state: StateStore;
    facts: Facts;
    app: AppDoor;
    /** null: a `build` or `offer-build` fix decision degrades to a skip. */
    builder: AppBuilder | null;
    events: AreaEventBus;
    now: () => Date;
    service?: ServiceDoor | null;
}

export const LIVE_APP_DOOR: AppDoor = {
    rpc: (method, params, opts) => genesisAppRpc(method, params, { timeoutMs: opts?.timeoutMs }),
};

/** One bus per process, so an in-process listener hears every area's events. */
export const AREA_EVENTS: AreaEventBus = createAreaEventBus();

export function liveEngineDeps(registry: Record<string, Area>, overrides: Partial<EngineDeps> = {}): EngineDeps {
    return {
        config: overrides.config ?? createConfigStore({ registry }),
        state: overrides.state ?? createStateStore(),
        facts: overrides.facts ?? LIVE_FACTS,
        app: overrides.app ?? LIVE_APP_DOOR,
        builder: overrides.builder !== undefined ? overrides.builder : registeredAppBuilder(),
        events: overrides.events ?? AREA_EVENTS,
        now: overrides.now ?? (() => new Date()),
        service: overrides.service ?? null,
    };
}

/**
 * The clients of every area: `client.<area>.<action>(args)` runs the action through the engine. The deps are made on
 * the first call, so importing `gt` touches no file; the registered app builder is read at each call.
 */
export function stitchAreas<T extends Record<string, Area>>(
    areas: T,
    deps: Partial<EngineDeps> | (() => EngineDeps) = {}
): StitchedClients<T> {
    let made: EngineDeps | null = null;
    const resolveDeps = (): EngineDeps => {
        if (typeof deps === "function") {
            return deps();
        }

        made ??= liveEngineDeps(areas, deps);
        return deps.builder !== undefined ? made : { ...made, builder: registeredAppBuilder() };
    };

    return clientsOf(areas, resolveDeps);
}

/** Builds `{ <area>: { <action>: (args, options) => runAction(...) } }` over a deps getter. */
export function clientsOf<T extends Record<string, Area>>(areas: T, deps: () => EngineDeps): StitchedClients<T> {
    const clients: Record<string, Record<string, (args: unknown, options?: RunOptions) => Promise<unknown>>> = {};

    for (const [name, area] of Object.entries(areas)) {
        clients[name] = {};

        for (const action of Object.keys(area.actions)) {
            clients[name][action] = (args, options) => runAction(areas, `${name}.${action}`, args, deps(), options);
        }
    }

    // The loop above builds exactly the mapped type, one function per action of every area.
    return clients as StitchedClients<T>;
}
