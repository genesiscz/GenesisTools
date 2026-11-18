import { memoryStateStore } from "@genesiscz/utils/genesis-tools/actions/state";
import type { AppRpcMethod } from "@genesiscz/utils/genesis-tools/capability/generated/app-surface";
import type { NeedEnv } from "@genesiscz/utils/genesis-tools/capability/needs";

interface AppNeedFixtureOptions {
    installed?: boolean;
    routingOff?: boolean;
    methods?: AppRpcMethod[] | null;
    isTest?: boolean;
}

/** A bundle and its manifest in memory. No fixture may launch or build the app. */
export function appNeedFixture(options: AppNeedFixtureOptions = {}): NeedEnv {
    const unexpected = (): never => {
        throw new Error("unexpected app or builder call");
    };

    return {
        facts: {
            isTest: () => options.isTest ?? false,
            platform: () => "darwin",
            isAgent: () => false,
            hasDisplay: () => false,
            hasTerminal: () => false,
            appBundle: () => ({
                path: "/fixture/GenesisTools.app",
                installed: options.installed ?? true,
                routingOff: options.routingOff ?? false,
            }),
            appManifest: () => ({
                buildId: "fixture",
                parts: null,
                rpcMethods: options.methods === undefined ? [] : options.methods,
            }),
        },
        state: memoryStateStore(),
        app: { rpc: unexpected },
        builder: { build: unexpected, offerBuild: unexpected, buildCommand: () => "fixture-build" },
        now: () => new Date("2026-11-17T12:00:00Z"),
        fresh: false,
        write: false,
    };
}
