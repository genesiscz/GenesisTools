import type { AppDoor, Fix, UnavailableCode } from "@genesiscz/utils/genesis-tools/actions/define";
import type { StateStore, StateValue } from "@genesiscz/utils/genesis-tools/actions/state";
import { type AppBuilder, appBuilder, defaultBuildCommand } from "@genesiscz/utils/genesis-tools/app-builder";
import { type Facts, LIVE_FACTS } from "@genesiscz/utils/genesis-tools/capability/facts";
import type { AppPartId, AppRpcMethod } from "@genesiscz/utils/genesis-tools/capability/generated/app-surface";
import type { ServiceDoor } from "@genesiscz/utils/genesis-tools/service/clients";
import { macosPermissionsCommand } from "@genesiscz/utils/genesis-tools/tools/system";
import type { PermissionKindId } from "@genesiscz/utils/macos/permission-kinds";

/** Phase 2 fills it with the methods a connected face serves. */
export type ServiceClientMethod = "request.present";

export type NeedSpec =
    | { kind: "platform"; platform: "darwin" | "linux" }
    | { kind: "app.installed" }
    | { kind: "app.rpc"; method: AppRpcMethod }
    | { kind: "app.part"; part: AppPartId }
    | { kind: "app.grant"; grant: PermissionKindId }
    | { kind: "person.display" }
    | { kind: "person.terminal" }
    | { kind: "sudo.touchId" }
    | { kind: "rootHelper.enabled" }
    | { kind: "service.client"; method: ServiceClientMethod };

export type NeedKind = NeedSpec["kind"];

export const Need = {
    platform: {
        darwin: { kind: "platform", platform: "darwin" },
        linux: { kind: "platform", platform: "linux" },
    },
    app: {
        installed: { kind: "app.installed" },
        rpc: (method: AppRpcMethod): NeedSpec => ({ kind: "app.rpc", method }),
        part: (part: AppPartId): NeedSpec => ({ kind: "app.part", part }),
        grant: (grant: PermissionKindId): NeedSpec => ({ kind: "app.grant", grant }),
    },
    person: {
        display: { kind: "person.display" },
        terminal: { kind: "person.terminal" },
    },
    sudo: { touchId: { kind: "sudo.touchId" } },
    rootHelper: { enabled: { kind: "rootHelper.enabled" } },
    service: { client: (method: ServiceClientMethod): NeedSpec => ({ kind: "service.client", method }) },
} as const satisfies Record<string, Record<string, NeedSpec | ((value: never) => NeedSpec)>>;

export type NeedResult =
    | { ok: true; from: "state" | "probe" }
    | { ok: false; code: UnavailableCode; reason: string; fix: Fix | null; from: "state" | "probe" };

export interface NeedEnv {
    state: StateStore;
    facts: Facts;
    app: AppDoor;
    builder: AppBuilder | null;
    now: () => Date;
    /** Probe even when a state value could answer. */
    fresh: boolean;
    service?: ServiceDoor | null;
    /** Whether a probe may write what it measured into state (false for `explain` without `--fresh`). */
    write: boolean;
}

export type Checker<N extends NeedSpec> = (need: N, env: NeedEnv) => Promise<NeedResult>;

const APP_AREA = "app";
const GRANT_TTL_MS = 60 * 60 * 1000;

const OK_PROBE: NeedResult = { ok: true, from: "probe" };

function fail(
    code: UnavailableCode,
    reason: string,
    fix: Fix | null = null,
    from: "state" | "probe" = "probe"
): NeedResult {
    return { ok: false, code, reason, fix, from };
}

function buildFix(env: Pick<NeedEnv, "builder">, part: AppPartId | null, sentence: string): Fix {
    return { command: env.builder?.buildCommand(part) ?? defaultBuildCommand(part), sentence };
}

function inTest(env: Pick<NeedEnv, "facts">, what: string): NeedResult | null {
    return env.facts.isTest() ? fail("in-test", `a test process never reaches ${what}`) : null;
}

/** The installed bundle and its routing, or the reason it cannot be used. */
function appBundleUsable(env: Pick<NeedEnv, "facts" | "builder">): NeedResult {
    const bundle = env.facts.appBundle();

    if (!bundle.installed) {
        return fail(
            "app-missing",
            `GenesisTools.app is not installed at ${bundle.path}`,
            buildFix(env, null, "Builds and installs GenesisTools.app.")
        );
    }

    if (bundle.routingOff) {
        return fail(
            "app-missing",
            "GenesisTools.app routing is switched off (GENESIS_TOOLS_NO_APP or the window's switch)"
        );
    }

    return OK_PROBE;
}

/** The same app.installed need for callers that return a string or report synchronously. */
export function checkAppInstalled(
    env: Pick<NeedEnv, "facts" | "builder"> = { facts: LIVE_FACTS, builder: appBuilder() }
): NeedResult {
    return inTest(env, "GenesisTools.app") ?? appBundleUsable(env);
}

/** Human-readable diagnostic text. A satisfied need has nothing to explain. */
export function describeNeedFailure(result: NeedResult): string {
    if (result.ok) {
        return "";
    }

    return result.fix ? `${result.reason}. Run \`${result.fix.command}\`.` : result.reason;
}

/**
 * A state value that may answer now: present, not stale, not from another build, and young enough. `bound` also
 * refuses a value saved with no build while the installed build is known: a method list read before the install had
 * a manifest belongs to some earlier build, never provably to this one.
 */
function usable(
    value: StateValue | undefined,
    env: NeedEnv,
    rule: { buildId: string | null; bound: boolean; ttlMs: number | null }
): boolean {
    if (!value || value.stale || env.fresh) {
        return false;
    }

    if (value.build === undefined ? rule.bound && rule.buildId !== null : value.build !== rule.buildId) {
        return false;
    }

    return rule.ttlMs === null || env.now().getTime() - Date.parse(value.at) <= rule.ttlMs;
}

function isStringList(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Every checker, one per need kind: the compiler names a kind without one. */
export const NEED_CHECKERS: { [K in NeedKind]: Checker<Extract<NeedSpec, { kind: K }>> } = {
    platform: async (need, env) =>
        env.facts.platform() === need.platform
            ? OK_PROBE
            : fail("platform", `needs ${need.platform}, this is ${env.facts.platform()}`),

    "app.installed": async (_need, env) => checkAppInstalled(env),

    "app.part": async (need, env) => {
        const refused = inTest(env, "GenesisTools.app") ?? (appBundleUsable(env).ok ? null : appBundleUsable(env));

        if (refused) {
            return refused;
        }

        const parts = env.facts.appManifest()?.parts;

        if (parts === null || parts?.includes(need.part)) {
            return OK_PROBE;
        }

        return fail(
            "part-missing",
            parts === undefined
                ? `the install has no manifest, so the part ${need.part} cannot be shown to be built`
                : `the installed build does not link the part ${need.part} (it links ${parts.join(", ") || "none"})`,
            buildFix(env, need.part, `Builds GenesisTools.app with the ${need.part} part.`)
        );
    },

    "app.rpc": async (need, env) => {
        const refused = inTest(env, "GenesisTools.app") ?? (appBundleUsable(env).ok ? null : appBundleUsable(env));

        if (refused) {
            return refused;
        }

        const manifest = env.facts.appManifest();
        const missing = (from: "state" | "probe") =>
            fail(
                "rpc-missing",
                `the installed build does not answer ${need.method}`,
                buildFix(env, null, "Rebuilds GenesisTools.app from these sources."),
                from
            );

        if (manifest?.rpcMethods) {
            return manifest.rpcMethods.includes(need.method) ? OK_PROBE : missing("probe");
        }

        const saved = env.state.get(APP_AREA, "rpcMethods");

        if (
            usable(saved, env, { buildId: manifest?.buildId ?? null, bound: true, ttlMs: null }) &&
            isStringList(saved?.value)
        ) {
            return saved.value.includes(need.method) ? { ok: true, from: "state" } : missing("state");
        }

        if (!env.write) {
            return fail(
                "rpc-missing",
                `not known whether the installed build answers ${need.method}: its manifest lists no methods; --fresh asks the app`
            );
        }

        const hello = await env.app.rpc<{ methods?: unknown }>("rpc.hello");

        if (!hello.ok || !isStringList(hello.result.methods)) {
            return fail(
                "rpc-missing",
                hello.ok
                    ? "rpc.hello gave no method list"
                    : `rpc.hello failed: ${hello.error.code}: ${hello.error.message}`
            );
        }

        await env.state.report(APP_AREA, "rpcMethods", {
            value: hello.result.methods,
            at: env.now().toISOString(),
            source: "app",
            ...(manifest ? { build: manifest.buildId } : {}),
        });
        return hello.result.methods.includes(need.method) ? OK_PROBE : missing("probe");
    },

    "app.grant": async (need, env) => {
        const refused = inTest(env, "GenesisTools.app") ?? (appBundleUsable(env).ok ? null : appBundleUsable(env));

        if (refused) {
            return refused;
        }

        const saved = env.state.get(APP_AREA, `grant.${need.grant}`);

        // A grant belongs to the bundle's signature, not to one build, so a report with no build may answer for an hour.
        if (
            usable(saved, env, { buildId: env.facts.appManifest()?.buildId ?? null, bound: false, ttlMs: GRANT_TTL_MS })
        ) {
            return saved?.value === "granted"
                ? { ok: true, from: "state" }
                : fail("grant-missing", `the ${need.grant} grant is ${String(saved?.value)}`, null, "state");
        }

        return fail("grant-missing", `no recent report of the ${need.grant} grant; run ${macosPermissionsCommand()}`, {
            command: macosPermissionsCommand(),
            sentence: "Shows every privacy grant of GenesisTools.app.",
        });
    },

    "person.display": async (_need, env) =>
        inTest(env, "a person's screen") ??
        (env.facts.hasDisplay()
            ? OK_PROBE
            : fail("no-display", "no person can see a window here (no display, or an ssh session)")),

    "person.terminal": async (_need, env) =>
        env.facts.hasTerminal() ? OK_PROBE : fail("no-terminal", "stdin and stdout are not a terminal"),

    "sudo.touchId": async (_need, env) =>
        inTest(env, "sudo") ?? fail("no-touch-id", "the check for Touch ID on sudo is not built yet (Phase 3)"),

    "rootHelper.enabled": async (_need, env) =>
        inTest(env, "the root helper") ?? fail("helper-off", "the root helper is not built yet (Phase 5)"),

    "service.client": async (need, env) =>
        inTest(env, "the GenesisTools service") ??
        (env.service?.hasClient(need.method)
            ? OK_PROBE
            : fail("no-service", `no connected face serves ${need.method}`)),
};

export function checkNeed(need: NeedSpec, env: NeedEnv): Promise<NeedResult> {
    const checker = NEED_CHECKERS[need.kind] as Checker<NeedSpec>;
    return checker(need, env);
}

export function describeNeed(need: NeedSpec): string {
    switch (need.kind) {
        case "platform":
            return `platform.${need.platform}`;
        case "app.rpc":
            return `app.rpc(${need.method})`;
        case "app.part":
            return `app.part(${need.part})`;
        case "app.grant":
            return `app.grant(${need.grant})`;
        case "service.client":
            return `service.client(${need.method})`;
        case "app.installed":
        case "person.display":
        case "person.terminal":
        case "sudo.touchId":
        case "rootHelper.enabled":
            return need.kind;
        default: {
            const never: never = need;
            return String(never);
        }
    }
}
