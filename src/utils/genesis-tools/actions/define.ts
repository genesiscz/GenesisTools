import type { Facts } from "@genesiscz/utils/genesis-tools/capability/facts";
import type { AppPartId, AppRpcMethod } from "@genesiscz/utils/genesis-tools/capability/generated/app-surface";
import type { NeedSpec } from "@genesiscz/utils/genesis-tools/capability/needs";
import type { ServiceDoor } from "@genesiscz/utils/genesis-tools/service/clients";
import type { GenesisAppRpcOutcome } from "@genesiscz/utils/macos/genesis-app-rpc";
import type { z } from "zod";
import type { ContextAreas } from "./registry";
import type { StateValue } from "./state";

/**
 * The declarative actions of GenesisTools (spec `.claude/plans/specs/genesis-tools-actions/actions.v1.md`). An action
 * declares typed `needs`, a `native` way and named `fallback` ways; the engine (`run.ts`) runs the first way this
 * machine can run and says why it skipped the others.
 */

export type WayName = "native" | `fallback.${string}`;

/** Why a way did not run. One closed set for every area. */
export type UnavailableCode =
    | "platform"
    | "app-missing"
    | "app-stale"
    | "rpc-missing"
    | "part-missing"
    | "grant-missing"
    | "no-display"
    | "no-terminal"
    | "no-touch-id"
    | "helper-off"
    | "no-service"
    | "in-test"
    | "passed"
    | "threw"
    | "timed-out";

/** The need codes a `fix` decision can remove by building the app. */
export const BUILD_FIXABLE_CODES: ReadonlySet<UnavailableCode> = new Set(["app-missing", "app-stale", "part-missing"]);

export interface Fix {
    /** The command that removes the reason, e.g. `tools macos permissions build --add-part hub`. */
    command: string;
    /** One sentence for a person: what the command does. */
    sentence: string;
}

export interface SkippedWay {
    way: WayName;
    code: UnavailableCode;
    reason: string;
    fix: Fix | null;
}

export type ActionOutcome<R> =
    | { status: "ran"; via: WayName; value: R; skipped: SkippedWay[] }
    | { status: "unreachable"; skipped: SkippedWay[]; manual: string | null };

/** The brand of `ctx.pass(why)`: a symbol no JSON result can carry, so a result shaped `{ pass, reason }` stays a result. */
const PASS: unique symbol = Symbol("genesis-tools.actions.pass");

export interface Pass {
    readonly [PASS]: true;
    readonly reason: string;
}

export function passFor(reason: string): Pass {
    return { [PASS]: true, reason };
}

export function isPass(value: unknown): value is Pass {
    return typeof value === "object" && value !== null && PASS in value;
}

/** The one-shot `GenesisTools --rpc` door. A test process gets `{ ok: false, error: { code: "refused_in_test" } }`. */
export interface AppDoor {
    rpc<T = unknown>(
        method: AppRpcMethod,
        params?: Record<string, unknown>,
        opts?: { timeoutMs?: number }
    ): Promise<GenesisAppRpcOutcome<T>>;
}

export interface AreaStateView {
    report(key: string, value: StateValue): Promise<void>;
    get<T = unknown>(key: string): StateValue<T> | undefined;
}

export interface RunOptions {
    /** The budget of the whole run, from its entry: need checks, fixes and ways. Default: the action's own. */
    timeoutMs?: number;
    /** The caller's cancel (a closed connection, an RPC deadline): no further step starts, and `ctx.signal` aborts. */
    signal?: AbortSignal;
}

/**
 * What every way gets. `AreaClients` (every area as `ctx.<area>.<action>()`) is added by the registry, which knows the
 * areas; `ctx.app` is the app area's actions plus the `rpc` door.
 */
export interface ActionContextBase<A, C> {
    args: A;
    /** Schema defaults, then the area's stored values, then the action's. */
    config: C;
    areaConfig: Record<string, unknown>;
    /** The calling area's slice of state.json. */
    state: AreaStateView;
    facts: Facts;
    service: ServiceDoor | null;
    /** What is left of the run's budget when this way starts. */
    timeoutMs: number;
    /** Aborts when the run's deadline passes or its caller cancels; a way checks it before an effect it cannot undo. */
    signal: AbortSignal;
    pass(reason: string): Pass;
    /** Emits `<area>.<event>`; the payload is checked against the area's `events` schema and a mismatch throws. */
    emit(event: string, payload: unknown): void;
}

export type ActionContext<A, C> = ActionContextBase<A, C> & ContextAreas;

export type WayRun<A, R, C> = (ctx: ActionContext<A, C>) => R | Pass | Promise<R | Pass>;
/** A way's needs: a fixed list, or a list computed from the parsed args (a window's part depends on the window). */
export type WayNeeds<A> = readonly NeedSpec[] | ((args: A) => readonly NeedSpec[]);
export type Way<A, R, C> = WayRun<A, R, C> | { needs?: WayNeeds<A>; run: WayRun<A, R, C> };

/** What `fix(ctx)` decides when a need of a way failed with a code a build removes. */
export type FixDecision =
    | { kind: "build"; part: AppPartId | null }
    | { kind: "offer-build"; part: AppPartId | null }
    | { kind: "skip" };

export interface FixContext<A, C> {
    args: A;
    config: C;
    /** The machine facts, so a fix can see whether a person at a terminal can watch a build. */
    facts: Facts;
    failed: { way: WayName; need: NeedSpec; code: UnavailableCode };
    build(part?: AppPartId | null): FixDecision;
    offerBuild(part?: AppPartId | null): FixDecision;
    skip(): FixDecision;
}

// biome-ignore lint/complexity/noBannedTypes: an action without config keys resolves to an empty object.
type EmptyConfig = z.ZodObject<{}>;

export interface ActionSpec<TArgs extends z.ZodType, TResult extends z.ZodType, TConfig extends z.ZodObject> {
    summary: string;
    args: TArgs;
    result: TResult;
    onTimeout?: (args: z.output<TArgs>) => z.output<TResult>;
    timeoutMs?: number;
    /** Per-action config keys with defaults; resolved into ctx.config. */
    config?: TConfig;
    native?: Way<z.output<TArgs>, z.output<TResult>, z.output<TConfig>>;
    /** Named fallbacks, tried in key order after native. */
    fallback?: Record<string, Way<z.output<TArgs>, z.output<TResult>, z.output<TConfig>>>;
    /** Default: ctx.skip(). */
    fix?: (ctx: FixContext<z.output<TArgs>, z.output<TConfig>>) => FixDecision;
    /** The text an unreachable outcome carries for a person to do by hand. */
    manual?: (args: z.output<TArgs>) => string | null;
}

export interface ActionDef<TArgs extends z.ZodType, TResult extends z.ZodType, TConfig extends z.ZodObject>
    extends ActionSpec<TArgs, TResult, TConfig> {
    readonly kind: "action";
}

// biome-ignore lint/suspicious/noExplicitAny: the registry holds actions of every argument and result type.
export type AnyActionDef = ActionDef<any, any, any>;

export type ArgsOf<Action> = Action extends ActionDef<infer TArgs, z.ZodType, z.ZodObject> ? z.input<TArgs> : never;
export type ResultOf<Action> =
    Action extends ActionDef<z.ZodType, infer TResult, z.ZodObject> ? z.output<TResult> : never;

export function defineAction<
    TArgs extends z.ZodType,
    TResult extends z.ZodType,
    TConfig extends z.ZodObject = EmptyConfig,
>(spec: ActionSpec<TArgs, TResult, TConfig>): ActionDef<TArgs, TResult, TConfig> {
    return { ...spec, kind: "action" };
}

export interface AreaSpec<N extends string, Actions extends Record<string, AnyActionDef>, TConfig extends z.ZodObject> {
    area: N;
    summary: string;
    /** Area-wide config keys with defaults; ctx.areaConfig. An action key of the same name wins in ctx.config. */
    config?: TConfig;
    /** The state keys this area owns. */
    state?: z.ZodObject;
    /** The payload schema of each event the area emits; the service names it `<area>.<event>`. */
    events?: Record<string, z.ZodType>;
    actions: Actions;
}

export interface AreaDef<N extends string, Actions extends Record<string, AnyActionDef>, TConfig extends z.ZodObject>
    extends AreaSpec<N, Actions, TConfig> {
    readonly kind: "area";
}

export function defineArea<
    const N extends string,
    Actions extends Record<string, AnyActionDef>,
    TConfig extends z.ZodObject = EmptyConfig,
>(spec: AreaSpec<N, Actions, TConfig>): AreaDef<N, Actions, TConfig> {
    return { ...spec, kind: "area" };
}

/** The ways of an action in try order, each with its needs. */
export function waysOf(
    action: AnyActionDef
): Array<{ way: WayName; needs: WayNeeds<unknown>; run: WayRun<unknown, unknown, unknown> }> {
    const entries: Array<[WayName, Way<unknown, unknown, unknown>]> = [];

    if (action.native) {
        entries.push(["native", action.native]);
    }

    for (const [name, way] of Object.entries(action.fallback ?? {})) {
        entries.push([`fallback.${name}`, way]);
    }

    return entries.map(([way, spec]) =>
        typeof spec === "function" ? { way, needs: [], run: spec } : { way, needs: spec.needs ?? [], run: spec.run }
    );
}

/** The needs of a way for these args; null when they depend on args that did not parse. */
export function needsFor(
    needs: WayNeeds<unknown>,
    args: { ok: true; value: unknown } | { ok: false }
): readonly NeedSpec[] | null {
    if (typeof needs !== "function") {
        return needs;
    }

    return args.ok ? needs(args.value) : null;
}
