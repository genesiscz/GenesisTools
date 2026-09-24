import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { OperationLimits } from "@genesiscz/utils/operation-budget";
import { z } from "zod";
import { actionParametersSchema, controlActions, nativeActionArguments } from "./action";
import { exactAttributeSchema, judgeOutcome, resolveIntent } from "./decisions";
import type { ControlDriver } from "./native";
import { type Candidate, candidatesFor } from "./observation";
import { authenticationBarrier } from "./recovery";
import { ControlSession } from "./session";

export const bindingSchema = z
    .object({
        identifier: z.string().min(1).max(300).optional(),
        label: z.string().min(1).max(300).optional(),
        role: z.string().min(1).max(100).optional(),
        ancestors: z.array(z.string().max(200)).max(4).optional(),
    })
    .strict()
    .refine(
        (value) => value.identifier !== undefined || value.label !== undefined,
        "A stable identifier or exact label is required."
    );
const valueKey = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/);
const postconditionSchema = z
    .object({
        expect: z.string().trim().min(1).max(4000),
        exact: z
            .object({
                identifier: z.string().min(1).max(300).optional(),
                label: z.string().min(1).max(300).optional(),
                role: z.string().min(1).max(100).optional(),
                value: z.string().max(500).optional(),
                valueRef: valueKey.optional(),
                attribute: exactAttributeSchema.optional(),
            })
            .strict()
            .refine(
                (value) => (value.value === undefined) !== (value.valueRef === undefined),
                "Supply one value or value reference."
            )
            .refine(
                (value) => value.identifier !== undefined || value.label !== undefined,
                "An exact identifier or label is required."
            )
            .optional(),
    })
    .strict();
export const workflowStepSchema = z
    .object({
        id: z.string().min(1).max(80),
        action: z.enum(controlActions),
        parameters: actionParametersSchema.optional(),
        selector: bindingSchema,
        intent: z.string().trim().min(1).max(4000),
        valueRef: valueKey.optional(),
        postcondition: postconditionSchema,
        noRetry: z.literal(true).default(true),
        context: z
            .array(z.object({ role: z.string().max(100), label: z.string().max(300) }).strict())
            .max(30)
            .optional(),
    })
    .strict()
    .refine(
        (step) =>
            ["set", "type", "paste", "select"].includes(step.action)
                ? step.valueRef !== undefined
                : step.valueRef === undefined,
        "set, type, paste and select require a value reference; other actions cannot use one."
    );
export const workflowPlanSchema = z
    .object({
        version: z.literal(1),
        app: z.string().trim().min(1).max(300),
        scope: z.enum(["window", "chrome"]).default("window"),
        windowTitle: z.string().max(500).optional(),
        steps: z.array(workflowStepSchema).min(1).max(50),
    })
    .strict()
    .refine((plan) => new Set(plan.steps.map((step) => step.id)).size === plan.steps.length, "Duplicate step IDs.");
export type WorkflowPlan = z.infer<typeof workflowPlanSchema>;
export type Binding = z.infer<typeof bindingSchema>;
export function matchingCandidates(candidates: Candidate[], selector: Binding): Candidate[] {
    return candidates.filter(
        (candidate) =>
            (selector.identifier === undefined || candidate.identifier === selector.identifier) &&
            (selector.label === undefined || candidate.label === selector.label) &&
            (selector.role === undefined || candidate.role === selector.role) &&
            (selector.ancestors === undefined ||
                (candidate.ancestors.length === selector.ancestors.length &&
                    candidate.ancestors.every((label, index) => label === selector.ancestors?.[index])))
    );
}
export function candidateBinding(candidate: Candidate): Binding {
    return bindingSchema.parse({
        identifier: candidate.identifier,
        label: candidate.label,
        role: candidate.role,
        ancestors: candidate.ancestors,
    });
}
export function parseWorkflowPlan(input: unknown): WorkflowPlan {
    const envelope = z.object({ semantic: z.unknown() }).safeParse(input);
    return workflowPlanSchema.parse(envelope.success ? envelope.data.semantic : input);
}
export function attachSemanticPlan(options: { legacy: unknown; semantic: unknown }) {
    const plan = workflowPlanSchema.parse(options.semantic);
    const legacy = z
        .object({ app: z.string(), steps: z.array(z.record(z.string(), z.unknown())) })
        .parse(options.legacy);
    if (legacy.app !== plan.app || legacy.steps.length !== plan.steps.length) {
        throw new Error("Semantic metadata must match the recorded app and every step.");
    }
    const stripped = legacy.steps.map((step, index) => {
        const spec = plan.steps[index];
        if ((step.app !== undefined && step.app !== plan.app) || step.do !== spec.action) {
            throw new Error(`Recorded step ${index + 1} changes app/action or is unsupported by semantic replay.`);
        }
        if (step.coords !== undefined || step.element !== undefined || step.snapshot !== undefined) {
            throw new Error("Recorded coordinates and snapshot indexes cannot become resilient selectors.");
        }
        const selector = bindingSchema.parse({
            identifier: step.id,
            label: step.title ?? step.desc,
            role: step.role,
        });
        const keys = ["identifier", "label", "role", "ancestors"] as const;
        if (keys.some((key) => SafeJSON.stringify(selector[key]) !== SafeJSON.stringify(spec.selector[key]))) {
            throw new Error(`Semantic selector for step ${index + 1} differs from the recorded selector.`);
        }
        const parameterNames: Record<string, string> = {
            keys: "keys",
            direction: "direction",
            pixels: "pixels",
            pages: "pages",
            action: "axAction",
            "ax-action": "axAction",
            format: "format",
            selection: "selection",
            prefix: "prefix",
            suffix: "suffix",
            button: "button",
            count: "count",
            background: "background",
        };
        const recorded: Record<string, unknown> = {};
        const metadata = new Set(["do", "app", "id", "title", "desc", "role", "text", "value", "json", "pretty"]);
        for (const [key, value] of Object.entries(step)) {
            if (metadata.has(key) || key.startsWith("_")) {
                continue;
            }
            if (key === "double") {
                recorded.count = value === true ? 2 : 1;
            } else if (parameterNames[key]) {
                const name = parameterNames[key];
                if (recorded[name] !== undefined) {
                    throw new Error(`Recorded step ${index + 1} has duplicate action parameters.`);
                }
                recorded[name] =
                    ["pixels", "pages", "count"].includes(name) && typeof value === "string" ? Number(value) : value;
            } else {
                throw new Error(
                    `Recorded step ${index + 1} has unsupported option ${key}; author an explicit workflow instead.`
                );
            }
        }
        if (spec.action === "click" || spec.action === "scroll") {
            recorded.background ??= false;
        }
        const supplied = spec.valueRef ? "supplied-value" : undefined;
        const originalArguments = nativeActionArguments({
            action: spec.action,
            value: supplied,
            parameters: actionParametersSchema.parse(recorded),
        });
        const replayArguments = nativeActionArguments({
            action: spec.action,
            value: supplied,
            parameters: spec.parameters,
        });
        if (SafeJSON.stringify(originalArguments) !== SafeJSON.stringify(replayArguments)) {
            throw new Error(`Semantic action parameters for step ${index + 1} differ from the recording.`);
        }
        return {
            do: spec.action,
            selector: spec.selector,
            parameters: spec.parameters,
            valueRef: spec.valueRef,
            _requiresSemanticReplay: true,
        };
    });
    return { app: plan.app, steps: stripped, semantic: plan };
}
export interface WorkflowTrace {
    id: string;
    binding: "exact" | "jev" | "none";
    selected?: Binding;
    resolution?: Awaited<ReturnType<typeof resolveIntent>>;
    dispatch?: { ok: boolean; error?: string; recovery?: unknown };
    judgment?: Awaited<ReturnType<typeof judgeOutcome>>;
    suppliedValueVerified?: boolean;
    status: "verified" | "stopped" | "unknown";
    reason: string;
}
export async function replayWorkflow(options: {
    plan: unknown;
    values?: Record<string, string>;
    rebind?: boolean;
    jev?: boolean;
    driver: ControlDriver;
    evaluate: Evaluator;
    signal?: AbortSignal;
    limits?: OperationLimits;
}) {
    const plan = parseWorkflowPlan(options.plan);
    const values = z.record(valueKey, z.string().max(65536)).parse(options.values ?? {});
    for (const step of plan.steps) {
        for (const ref of [step.valueRef, step.postcondition.exact?.valueRef]) {
            if (ref !== undefined && !Object.hasOwn(values, ref)) {
                throw new Error(`Missing supplied value reference: ${ref}`);
            }
        }
    }
    for (const step of plan.steps) {
        nativeActionArguments({
            action: step.action,
            parameters: step.parameters,
            value: step.valueRef === undefined ? undefined : values[step.valueRef],
        });
        if (!step.postcondition.exact && !options.jev && !options.rebind) {
            throw new Error("Semantic postconditions require explicit Jev approval (jev:true or --jev).");
        }
    }
    const session = new ControlSession(options);
    const steps: WorkflowTrace[] = [];
    const repairs: Array<{ stepId: string; selector: Binding }> = [];
    let status: "verified" | "stopped" | "unknown" = "stopped";
    let reason = "No steps executed.";
    try {
        let observation = await session.observe();
        if (
            observation.app !== plan.app ||
            observation.scope !== plan.scope ||
            (plan.windowTitle !== undefined && observation.window.title !== plan.windowTitle)
        ) {
            throw new Error("Observed window/scope does not match the workflow policy.");
        }
        for (const step of plan.steps) {
            const trace: WorkflowTrace = { id: step.id, binding: "none", status: "stopped", reason: "" };
            steps.push(trace);
            if (authenticationBarrier(observation)) {
                trace.reason = "Authentication or permission UI requires user input.";
                reason = trace.reason;
                break;
            }
            const candidates = candidatesFor({ observation, action: step.action, parameters: step.parameters });
            const exact = matchingCandidates(candidates, step.selector);
            let selected = exact.length === 1 ? exact[0] : undefined;
            if (selected) {
                trace.binding = "exact";
            } else if (exact.length === 0 && options.rebind) {
                const resolution = await resolveIntent({
                    observation,
                    action: step.action,
                    parameters: step.parameters,
                    intent: step.intent,
                    evaluate: session.evaluate,
                    signal: session.budget.signal,
                });
                trace.resolution = resolution;
                selected = resolution.selected ?? undefined;
                if (selected) {
                    trace.binding = "jev";
                    repairs.push({ stepId: step.id, selector: candidateBinding(selected) });
                }
            }
            if (!selected) {
                trace.reason =
                    exact.length > 1
                        ? "Original selector is ambiguous."
                        : "No admitted fresh target for the recorded action.";
                reason = trace.reason;
                break;
            }
            trace.selected = candidateBinding(selected);
            const result = await session.dispatch({
                observation,
                candidate: selected,
                parameters: step.parameters,
                value: step.valueRef === undefined ? undefined : values[step.valueRef],
            });
            trace.dispatch = { ok: result.result.ok, error: result.result.error, recovery: result.result.recovery };
            if (!result.result.ok || !result.after) {
                trace.status = "unknown";
                trace.reason =
                    result.observationError ??
                    result.result.error ??
                    "Dispatch or readback is uncertain; this step will not be repeated.";
                status = "unknown";
                reason = trace.reason;
                break;
            }
            // The judge's own contract says a label offering an action is not proof it happened,
            // and that the appeared/disappeared diff is the stronger evidence. It was never given
            // one here, so every semantic postcondition in a workflow was judged on labels alone
            // and landed short of the 0.95 gate: measured on Flow, witness e5 "Stop" at
            // probability 1.0 and sufficient 0.98, yet complete 0.57 and the run stopped.
            const beforeAct = observation;
            observation = result.after;
            if (step.action === "set") {
                const bound = matchingCandidates(
                    candidatesFor({ observation, action: "set" }),
                    candidateBinding(selected)
                );
                const row =
                    bound.length === 1
                        ? observation.elements.find((item) => item.index === bound[0].element)
                        : undefined;
                trace.suppliedValueVerified =
                    row !== undefined && String(row.AXValue ?? "") === values[step.valueRef ?? ""];
                if (!trace.suppliedValueVerified) {
                    trace.reason = "The supplied value could not be read back exactly.";
                    reason = trace.reason;
                    break;
                }
            }
            const exactPost = step.postcondition.exact;
            const judgment = await judgeOutcome({
                observation,
                before: beforeAct,
                expect: step.postcondition.expect,
                exact: exactPost
                    ? {
                          identifier: exactPost.identifier,
                          label: exactPost.label,
                          role: exactPost.role,
                          attribute: exactPost.attribute,
                          value: exactPost.valueRef ? values[exactPost.valueRef] : (exactPost.value ?? ""),
                      }
                    : undefined,
                evaluate: session.evaluate,
                signal: session.budget.signal,
            });
            // Exact expectations do not serialize supplied values into traces.
            trace.judgment = judgment;
            if (judgment.status !== "verified") {
                trace.reason = "Recorded postcondition is not verified; later steps were not executed.";
                reason = trace.reason;
                break;
            }
            trace.status = "verified";
            trace.reason = "Fresh postcondition verified.";
        }
        if (steps.length === plan.steps.length && steps.every((step) => step.status === "verified")) {
            status = "verified";
            reason = "All recorded steps verified.";
        }
    } catch (error) {
        logger.debug({ error }, "Resilient workflow stopped");
        reason = error instanceof Error ? error.message : "Workflow stopped.";
    }
    return { status, reason, steps, repairs, metrics: session.report() };
}
export function applyWorkflowRepairs(options: {
    plan: unknown;
    repairs: Array<{ stepId: string; selector: Binding }>;
}) {
    const plan = parseWorkflowPlan(options.plan);
    const repairs = z.array(z.object({ stepId: z.string(), selector: bindingSchema }).strict()).parse(options.repairs);
    if (
        new Set(repairs.map((repair) => repair.stepId)).size !== repairs.length ||
        repairs.some((repair) => !plan.steps.some((step) => step.id === repair.stepId))
    ) {
        throw new Error("Repairs contain duplicate or unknown steps.");
    }
    return workflowPlanSchema.parse({
        ...plan,
        steps: plan.steps.map((step) => ({
            ...step,
            selector: repairs.find((repair) => repair.stepId === step.id)?.selector ?? step.selector,
        })),
    });
}
