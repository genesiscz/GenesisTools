import type { ToolEntry } from "@app/genesis-tools-mcp/lib/server";
import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { z } from "zod";
import { NativeControlDriver } from "../lib/decision/native";
import { replayWorkflow } from "../lib/decision/workflow";
import { DEFAULT_PLAN_RUN_DEPS, executePlan, type PlanRunDeps, parsePlanDocument } from "../lib/plan-runner";
import { type ElementQueryVerb, queryElements } from "../lib/query";
import { type AxRun, runAxAsync } from "../lib/runner";

const { log } = logger.scoped("control-mcp");

/**
 * A resident MCP server serves other calls while one runs, so its native calls are the async ones:
 * the CLI's synchronous `runAx` would block the whole server for every ax-tool spawn.
 */
const runNative: AxRun = (args, timeoutMs) => runAxAsync({ args, timeoutMs });

const MCP_PLAN_DEPS: PlanRunDeps = { ...DEFAULT_PLAN_RUN_DEPS, run: runNative };

/** The workflow twin is exact-only: a semantic postcondition needs Jev, which `" + toolCommand("control workflow run --jev") + "` offers. */
const noJev: Evaluator = async () => {
    throw new Error("control_workflow_run makes no model call; use exact postconditions or the CLI with --jev");
};

const targetShape = {
    q: z.string().optional().describe("universal search: id, title, desc, value, role, subrole"),
    role: z.string().optional().describe("AXRole, fuzzy: 'button' matches AXButton"),
    title: z.string().optional(),
    desc: z.string().optional().describe("AXDescription; Chromium and SwiftUI put visible text here"),
    subrole: z.string().optional(),
    window: z.string().optional().describe("scope to the window whose title contains this"),
    depth: z.number().int().positive().max(80).optional(),
    exact: z.boolean().optional().describe("strict role/subrole matching"),
};

const findSchema = z
    .object({
        app: z.string().trim().min(1).describe("app process name"),
        ...targetShape,
        value: z.string().optional().describe("AXValue substring"),
        text: z.string().optional().describe("id, title and desc at once (OR)"),
    })
    .strict();

const getSchema = z
    .object({
        app: z.string().trim().min(1).describe("app process name"),
        ...targetShape,
        id: z.string().optional().describe("AXIdentifier"),
    })
    .strict();

const runSchema = z
    .object({
        plan: z
            .record(z.string(), z.unknown())
            .describe(
                'the plan object `" + toolCommand("control run") + "` takes: {"app":"…","steps":[{"do":"press","q":"Save"}, …]}'
            ),
        stop_on_fail: z.boolean().optional().describe("stop at the first failed step; the rest report as skipped"),
        steal_focus: z
            .boolean()
            .optional()
            .describe("let type/set/hotkey steps run while another app is frontmost; only when the user asked for it"),
        dry_run: z.boolean().optional().describe("validate and list the steps; touches no UI"),
    })
    .strict();

const workflowSchema = z
    .object({
        plan: z
            .record(z.string(), z.unknown())
            .describe(
                'a versioned workflow {"version":1,"app":"…","stopOnFail"?:bool,"steps":[{id,action,selector,intent,postcondition}]}'
            ),
        values: z
            .record(z.string(), z.string())
            .optional()
            .describe("named values the steps refer to by valueRef; they stay local and never enter the trace"),
        window_id: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("pin a native window; required when the app has several"),
        continue_on_fail: z
            .boolean()
            .optional()
            .describe("run on after a step that found no target or did not verify; never after uncertain delivery"),
        timeout_ms: z.number().int().min(1000).max(300_000).optional().describe("one deadline for the whole run"),
        max_steps: z.number().int().min(1).max(50).optional(),
    })
    .strict();

function queryEntry(
    verb: ElementQueryVerb,
    schema: typeof findSchema | typeof getSchema,
    description: string
): ToolEntry {
    return {
        description,
        inputSchema: z.toJSONSchema(schema, { io: "input" }),
        handler: async (args) => {
            const { app, ...target } = schema.parse(args);
            const result = await queryElements({ verb, app, target, run: runNative });
            log.debug({ verb, app, ok: result.ok }, "control MCP query");
            return SafeJSON.stringify(result);
        },
    };
}

/**
 * The `" + toolCommand("control") + "` tools in the shape the genesis-tools MCP registry consumes (capability
 * `control`). Every handler is a thin door over the same lib function the CLI command calls, so a
 * plan behaves the same from either door: validation before the first step, the focus-steal guard,
 * per-step ms, failedSteps and stopOnFail.
 */
export function controlToolEntries(): Record<string, ToolEntry> {
    return {
        control_workflow_run: {
            description:
                "PREFERRED for acting on a macOS app. Run a versioned see/act workflow in one pinned app window: every step is bound against a fresh AX observation the runner takes itself, dispatched with snapshot validation (the same refusals as `control act`), and verified by an exact postcondition before the next step. Stops at the first unverified step unless continue_on_fail; never repeats an uncertain mutation. Returns {status, failedSteps, skippedSteps, steps:[{id, status, reason, ms}], metrics}. Never takes focus for press/set/scroll; keyboard actions refuse while another window is frontmost. Same core as `" +
                toolCommand("control workflow run") +
                "`.",
            inputSchema: z.toJSONSchema(workflowSchema, { io: "input" }),
            handler: async (args, context) => {
                const input = workflowSchema.parse(args);
                const app = z.string().trim().min(1).parse(input.plan.app);
                const scope = z.enum(["window", "chrome"]).default("window").parse(input.plan.scope);
                const result = await replayWorkflow({
                    plan: input.plan,
                    values: input.values,
                    driver: new NativeControlDriver({ app, scope, windowId: input.window_id, prepare: "auto" }),
                    evaluate: noJev,
                    signal: context?.signal,
                    stopOnFail: input.continue_on_fail === true ? false : undefined,
                    limits: {
                        timeoutMs: input.timeout_ms ?? 120_000,
                        maxActions: input.max_steps ?? 20,
                        maxRequests: 0,
                    },
                });
                log.debug({ app, status: result.status, steps: result.steps.length }, "control MCP workflow");
                return SafeJSON.stringify(result);
            },
        },
        control_run: {
            description:
                "Run a `" +
                toolCommand("control run") +
                "` plan object inline (no temp file): {app, restore?, delayMs?, stopOnFail?, steps:[{do, q|id|role|title|desc, value|text|keys, saveAs?, retries?}]}. The whole plan is validated before the first step; wait/assert steps check conditions; type/set/hotkey steps refuse while another app is frontmost unless steal_focus. Returns {ok, failedSteps, totalSteps, stoppedAtStep, skippedSteps, steps:[{step, result, ms, attempts}]}, or {problems} for an invalid plan. Same core as `" +
                toolCommand("control run") +
                "`. Prefer control_workflow_run for anything that changes the UI.",
            inputSchema: z.toJSONSchema(runSchema, { io: "input" }),
            handler: async (args) => {
                const input = runSchema.parse(args);
                const outcome = await executePlan({
                    plan: parsePlanDocument(input.plan),
                    stopOnFail: input.stop_on_fail,
                    stealFocus: input.steal_focus,
                    dryRun: input.dry_run,
                    deps: MCP_PLAN_DEPS,
                });
                log.debug({ kind: outcome.kind }, "control MCP plan");
                return SafeJSON.stringify(outcome);
            },
        },
        control_find: queryEntry(
            "find",
            findSchema,
            "Find elements in a running macOS app by role, title, description, value or a universal query. Read-only: nothing is raised, focused or clicked. Returns {ok, app, matches:[{id, role, title, desc, value}]}. Same core as `" +
                toolCommand("control find") +
                "`."
        ),
        control_get: queryEntry(
            "get",
            getSchema,
            "Read one element's attributes (role, title, desc, value, enabled, focused) in a running macOS app. Read-only. Same core as `" +
                toolCommand("control get") +
                "`."
        ),
    };
}
