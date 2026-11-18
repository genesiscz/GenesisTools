import {
    checkNeed,
    describeNeed,
    type NeedEnv,
    type NeedResult,
    type NeedSpec,
} from "@genesiscz/utils/genesis-tools/capability/needs";
import { logger } from "@genesiscz/utils/logger";
import type { z } from "zod";
import {
    type ActionContext,
    type ActionOutcome,
    type AnyActionDef,
    BUILD_FIXABLE_CODES,
    type Fix,
    type FixContext,
    type FixDecision,
    isPass,
    needsFor,
    passFor,
    type RunOptions,
    type SkippedWay,
    type UnavailableCode,
    type WayName,
    waysOf,
} from "./define";
import type { Area, EngineDeps } from "./registry";
import { clientsOf } from "./registry";

/** `<area>.<action>` */
export type ActionId = `${string}.${string}`;

function issuesText(error: z.ZodError): string {
    return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
}

export class ActionArgsError extends Error {
    constructor(id: string, detail: string) {
        super(`${id}: the arguments do not match: ${detail}`);
        this.name = "ActionArgsError";
    }
}

export class UnknownActionError extends Error {
    constructor(id: string, registry: Record<string, Area>) {
        const known = Object.entries(registry).flatMap(([area, def]) =>
            Object.keys(def.actions).map((a) => `${area}.${a}`)
        );
        super(`no action "${id}"; actions: ${known.join(", ")}`);
        this.name = "UnknownActionError";
    }
}

export function findAction(
    registry: Record<string, Area>,
    id: string
): { area: Area; name: string; action: AnyActionDef } {
    const dot = id.indexOf(".");
    const area = registry[id.slice(0, dot)];
    const name = id.slice(dot + 1);
    const action = dot > 0 ? area?.actions[name] : undefined;

    if (!area || !action) {
        throw new UnknownActionError(id, registry);
    }

    return { area, name, action };
}

function needEnv(deps: EngineDeps, options: { fresh: boolean; write: boolean }): NeedEnv {
    return {
        state: deps.state,
        facts: deps.facts,
        app: deps.app,
        builder: deps.builder,
        now: deps.now,
        service: deps.service,
        ...options,
    };
}

function fixOf(result: NeedResult): Fix | null {
    return result.ok ? null : result.fix;
}

const SKIP: FixDecision = { kind: "skip" };

/** Runs the fix decision of a failed need; true when the need holds afterwards. */
async function applyFix(decision: FixDecision, need: NeedSpec, deps: EngineDeps, env: NeedEnv): Promise<boolean> {
    if (decision.kind === "skip" || !deps.builder || deps.facts.isTest()) {
        return false;
    }

    if (decision.kind === "offer-build") {
        if (!deps.facts.hasTerminal() || !(await deps.builder.offerBuild(decision.part))) {
            return false;
        }
    } else {
        await deps.builder.build(decision.part);
    }

    logger.debug({ need: describeNeed(need), decision }, "genesis-tools actions: built the app for a need");
    return (await checkNeed(need, { ...env, fresh: true })).ok;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** A need's answer; a check that throws is a failed need of this way, never a failed action. */
async function checkedNeed(need: NeedSpec, env: NeedEnv): Promise<NeedResult> {
    try {
        return await checkNeed(need, env);
    } catch (error) {
        logger.warn({ need: describeNeed(need), error }, "genesis-tools actions: a need check threw");
        return { ok: false, code: "threw", reason: `the check threw: ${messageOf(error)}`, fix: null, from: "probe" };
    }
}

/** The first need of a way that fails (after its fix ran), or null when every need holds. */
async function firstFailedNeed(params: {
    way: WayName;
    needs: readonly NeedSpec[];
    action: AnyActionDef;
    args: unknown;
    config: Record<string, unknown>;
    deps: EngineDeps;
    env: NeedEnv;
}): Promise<{ need: NeedSpec; result: Extract<NeedResult, { ok: false }> } | null> {
    for (const need of params.needs) {
        const result = await checkedNeed(need, params.env);

        if (result.ok) {
            continue;
        }

        if (BUILD_FIXABLE_CODES.has(result.code) && params.action.fix) {
            const fixContext: FixContext<unknown, Record<string, unknown>> = {
                args: params.args,
                config: params.config,
                facts: params.deps.facts,
                failed: { way: params.way, need, code: result.code },
                build: (part = null) => ({ kind: "build", part }),
                offerBuild: (part = null) => ({ kind: "offer-build", part }),
                skip: () => SKIP,
            };

            try {
                if (await applyFix(params.action.fix(fixContext), need, params.deps, params.env)) {
                    continue;
                }
            } catch (error) {
                // A failed repair leaves the need unmet: this way is skipped and the next one is tried.
                logger.warn(
                    { way: params.way, need: describeNeed(need), error },
                    "genesis-tools actions: a fix failed"
                );
                return { need, result: { ...result, reason: `${result.reason}; the fix failed: ${messageOf(error)}` } };
            }
        }

        return { need, result };
    }

    return null;
}

/** The budget of one action run: the caller's override, else the action's own, else two minutes. */
export function actionBudgetMs(action: AnyActionDef, override?: number): number {
    return Math.max(1, override ?? action.timeoutMs ?? 120_000);
}

class ActionDeadlineError extends Error {}

interface RunDeadline {
    /** Aborts when the budget is spent or the caller's own signal aborts. */
    signal: AbortSignal;
    remainingMs(): number;
    dispose(): void;
}

/** One deadline for a whole run, set at its entry: the need checks, the fixes and every way share its budget. */
function runDeadline(budgetMs: number, outer: AbortSignal | undefined): RunDeadline {
    const controller = new AbortController();
    const endsAt = Date.now() + budgetMs;
    const timer = setTimeout(
        () => controller.abort(new ActionDeadlineError(`the action did not finish within ${budgetMs} ms`)),
        budgetMs
    );
    const onOuterAbort = (): void => controller.abort(outer?.reason);

    if (outer?.aborted) {
        onOuterAbort();
    } else {
        outer?.addEventListener("abort", onOuterAbort, { once: true });
    }

    return {
        signal: controller.signal,
        remainingMs: () => Math.max(0, endsAt - Date.now()),
        dispose: () => {
            clearTimeout(timer);
            outer?.removeEventListener("abort", onOuterAbort);
        },
    };
}

/** `work`, or the abort reason once `signal` aborts first. The work is not stopped here: a way reads `ctx.signal`. */
async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    const aborted = Promise.withResolvers<never>();
    const onAbort = (): void => aborted.reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });

    try {
        return await Promise.race([work, aborted.promise]);
    } finally {
        signal.removeEventListener("abort", onAbort);
    }
}

function contextFor(params: {
    registry: Record<string, Area>;
    areaName: string;
    area: Area;
    args: unknown;
    config: Record<string, unknown>;
    deps: EngineDeps;
    timeoutMs: number;
    signal: AbortSignal;
}): ActionContext<unknown, Record<string, unknown>> {
    const { registry, areaName, area, deps } = params;
    const clients = clientsOf(registry, () => deps);
    const timeoutMs = params.timeoutMs;

    return {
        ...clients,
        app: deps.app,
        args: params.args,
        config: params.config,
        areaConfig: deps.config.resolve(areaName),
        state: {
            get: (key) => deps.state.get(areaName, key),
            report: (key, value) => deps.state.report(areaName, key, value),
        },
        facts: deps.facts,
        service: deps.service ?? null,
        timeoutMs,
        signal: params.signal,
        pass: passFor,
        emit: (event, payload) => {
            const schema = area.events?.[event];

            if (!schema) {
                throw new Error(`area ${areaName} declares no event "${event}"`);
            }

            deps.events.emit({ area: areaName, event, payload: schema.parse(payload), at: deps.now().toISOString() });
        },
    } as ActionContext<unknown, Record<string, unknown>>;
}

/**
 * Runs `<area>.<action>`: the args are checked, then each way in order (native, then the fallbacks in key order) runs
 * when its needs hold; a way that returns `ctx.pass(why)` or throws is skipped with its reason. One deadline, set
 * here, covers the need checks, the fixes and the ways; once it passes no further step starts.
 */
export async function runAreaAction(
    registry: Record<string, Area>,
    id: string,
    args: unknown,
    deps: EngineDeps,
    options: RunOptions = {}
): Promise<ActionOutcome<unknown>> {
    const { area, name, action } = findAction(registry, id);
    const areaName = id.slice(0, id.indexOf("."));
    const parsedArgs = action.args.safeParse(args);

    if (!parsedArgs.success) {
        throw new ActionArgsError(id, issuesText(parsedArgs.error));
    }

    const config = deps.config.resolve(areaName, name);
    const env = needEnv(deps, { fresh: false, write: true });
    const skipped: SkippedWay[] = [];
    const skip = (way: WayName, code: UnavailableCode, reason: string, fix: Fix | null = null) => {
        skipped.push({ way, code, reason, fix });
    };
    const deadline = runDeadline(actionBudgetMs(action, options.timeoutMs), options.signal);
    /** The outcome once the deadline passed or the caller cancelled; a way that had started may still finish. */
    const ended = (way: WayName, started: boolean): ActionOutcome<unknown> => {
        const reason: unknown = deadline.signal.reason;
        const why =
            reason instanceof ActionDeadlineError ? reason.message : `the caller cancelled: ${messageOf(reason)}`;
        skip(
            way,
            "timed-out",
            started
                ? `${why}; the way had started and may still finish, so its effect is unknown`
                : `${why} while its needs were checked`
        );
        logger.debug({ id, way, started }, "genesis-tools actions: the run ended at its deadline");

        if (action.onTimeout) {
            return { status: "ran", via: way, value: action.result.parse(action.onTimeout(parsedArgs.data)), skipped };
        }

        return { status: "unreachable", skipped, manual: action.manual?.(parsedArgs.data) ?? null };
    };

    try {
        for (const { way, needs, run } of waysOf(action)) {
            if (deadline.signal.aborted) {
                return ended(way, false);
            }

            const wayNeeds = needsFor(needs, { ok: true, value: parsedArgs.data }) ?? [];
            let failed: Awaited<ReturnType<typeof firstFailedNeed>>;

            try {
                failed = await untilAborted(
                    firstFailedNeed({ way, needs: wayNeeds, action, args: parsedArgs.data, config, deps, env }),
                    deadline.signal
                );
            } catch (error) {
                if (deadline.signal.aborted) {
                    return ended(way, false);
                }

                throw error;
            }

            if (failed) {
                skip(
                    way,
                    failed.result.code,
                    `${describeNeed(failed.need)}: ${failed.result.reason}`,
                    fixOf(failed.result)
                );
                continue;
            }

            const ctx = contextFor({
                registry,
                areaName,
                area,
                args: parsedArgs.data,
                config,
                deps,
                timeoutMs: Math.max(1, deadline.remainingMs()),
                signal: deadline.signal,
            });

            try {
                const value = await untilAborted(Promise.resolve(run(ctx)), deadline.signal);

                if (isPass(value)) {
                    skip(way, "passed", value.reason);
                    continue;
                }

                const checked = action.result.safeParse(value);

                if (!checked.success) {
                    skip(way, "threw", `the result does not match the schema: ${checked.error.message}`);
                    continue;
                }

                logger.debug({ id, via: way, skipped: skipped.length }, "genesis-tools actions: ran");
                return { status: "ran", via: way, value: checked.data, skipped };
            } catch (error) {
                if (deadline.signal.aborted) {
                    return ended(way, true);
                }

                logger.debug({ id, way, error }, "genesis-tools actions: a way threw");
                skip(way, "threw", messageOf(error));
            }
        }
    } finally {
        deadline.dispose();
    }

    logger.debug({ id, skipped }, "genesis-tools actions: no way could run");
    return { status: "unreachable", skipped, manual: action.manual?.(parsedArgs.data) ?? null };
}

export interface ActionExplain {
    id: string;
    summary: string;
    ways: Array<{
        way: WayName;
        /** False when the way's needs depend on args that were not given or did not parse. */
        needsKnown: boolean;
        needs: Array<{
            need: string;
            ok: boolean;
            code?: UnavailableCode;
            reason?: string;
            fix?: Fix | null;
            from: "state" | "probe";
        }>;
    }>;
    /** The way a run would take now, judged by needs alone (a way may still pass when it runs). */
    first: WayName | null;
    config: Record<string, unknown>;
}

/**
 * The ways of an action and every need's answer on this machine, without running anything. Without `fresh` it reads
 * state and writes nothing; with it, it probes and writes what it measured into state, and nothing else.
 */
export async function explainAction(
    registry: Record<string, Area>,
    id: string,
    deps: EngineDeps,
    options: { fresh?: boolean; args?: unknown } = {}
): Promise<ActionExplain> {
    const { area, name, action } = findAction(registry, id);
    const fresh = options.fresh === true;
    const env = needEnv(deps, { fresh, write: fresh });
    const parsed = action.args.safeParse(options.args ?? {});
    const args = parsed.success ? ({ ok: true, value: parsed.data } as const) : ({ ok: false } as const);
    const ways: ActionExplain["ways"] = [];
    let first: WayName | null = null;

    for (const { way, needs } of waysOf(action)) {
        const wayNeeds = needsFor(needs, args);
        const answers: ActionExplain["ways"][number]["needs"] = [];

        for (const need of wayNeeds ?? []) {
            const result = await checkNeed(need, env);
            answers.push(
                result.ok
                    ? { need: describeNeed(need), ok: true, from: result.from }
                    : {
                          need: describeNeed(need),
                          ok: false,
                          code: result.code,
                          reason: result.reason,
                          fix: result.fix,
                          from: result.from,
                      }
            );
        }

        if (first === null && wayNeeds !== null && answers.every((answer) => answer.ok)) {
            first = way;
        }

        ways.push({ way, needsKnown: wayNeeds !== null, needs: answers });
    }

    return { id, summary: action.summary, ways, first, config: deps.config.resolve(area.area, name) };
}
