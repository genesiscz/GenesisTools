import { createEvaluator, type EvaluationResponse, type Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import type { EvaluationProviderId } from "@genesiscz/utils/ai/evaluation/types";
import { DEFAULT_EVALUATION_PROVIDER } from "@genesiscz/utils/ai/evaluation/types";
import { OperationBudget } from "@genesiscz/utils/operation-budget";
import { z } from "zod";
import { type CalibrationRow, calibrationPolicies, calibrationReport } from "./calibration";
import { type ChooserMode, chooseCandidate } from "./chooser";
import { replayCases } from "./fixtures";
import type { Observation } from "./observation";
import { ControlSession } from "./session";

const observed = (labels: string[], context?: string): Observation => ({
    ok: true,
    app: "Chooser fixture",
    pid: 1,
    window: { id: 1, title: "Local fixture" },
    snapshot: "not-executable",
    scope: "window",
    elements: [
        ...(context ? [{ index: 0, depth: 0, role: "AXStaticText", AXValue: context }] : []),
        ...labels.map((label, index) => ({
            index: index + 1,
            depth: 0,
            role: "AXButton",
            AXTitle: label,
            actions: ["AXPress"],
        })),
    ],
});
export const chooserCases = [
    ...replayCases.map((fixture) => ({ ...fixture, split: "development" as const })),
    {
        id: "exact-refresh",
        title: "Exact refresh label",
        intent: "Refresh",
        expectedElement: 1,
        observation: observed(["Refresh", "Close"]),
        split: "held-out" as const,
    },
    {
        id: "preferences",
        title: "Preference synonym",
        intent: "Open the application's preferences",
        expectedElement: 2,
        observation: observed(["Help", "Settings", "Close"]),
        split: "held-out" as const,
    },
    {
        id: "duplicate-close",
        title: "Indistinguishable close buttons",
        intent: "Close the right panel",
        expectedElement: null,
        observation: observed(["Close", "Close"]),
        split: "held-out" as const,
    },
    {
        id: "unavailable",
        title: "No permitted target",
        intent: "Download a PDF",
        expectedElement: null,
        observation: observed(["Home", "Help"]),
        split: "held-out" as const,
    },
    {
        id: "read-confirmation",
        title: "Read confirmation panel",
        intent: "Dismiss the completed import confirmation",
        expectedElement: 2,
        observation: observed(["View report", "Dismiss"], "Import completed successfully."),
        split: "held-out" as const,
    },
];
export async function compareChoosers(options: {
    input: unknown;
    provider?: EvaluationProviderId;
    signal?: AbortSignal;
    evaluate?: Evaluator;
}) {
    const input = z
        .object({
            jev: z.boolean().default(false),
            split: z.enum(["development", "held-out", "all"]).default("held-out"),
            calibrate: z.boolean().default(false),
        })
        .strict()
        .refine((value) => !value.calibrate || (value.jev && value.split === "all"), {
            message: "Calibration requires explicit Jev opt-in and split all (development plus held-out).",
        })
        .parse(options.input);
    const modes: ChooserMode[] = input.jev ? ["exact", "jev", "auto"] : ["exact"];
    const fixtures = chooserCases.filter((item) => input.split === "all" || item.split === input.split);
    const budget = new OperationBudget({ timeoutMs: 120000, maxRequests: 30, maxActions: 0, signal: options.signal });
    let evaluator: Promise<Evaluator> | undefined;
    const calibrationRows: CalibrationRow[] = [];
    const rows: Array<{
        fixture: string;
        split: string;
        mode: ChooserMode;
        expected: number | null;
        selected: number | null;
        status: string;
        correct: boolean;
        wrongAction: boolean;
        abstained: boolean;
        requests: number;
        elapsedMs: number;
        inputTokens: number;
        outputTokens: number;
        usageKnown: boolean;
        costUsd: number | null;
        signals: Awaited<ReturnType<typeof chooseCandidate>>["signals"];
    }> = [];
    for (const fixture of fixtures) {
        for (const mode of modes) {
            budget.remaining();
            let cost = 0;
            let costKnown = true;
            let usageKnown = true;
            let recorded: EvaluationResponse | undefined;
            const session = new ControlSession({
                driver: {
                    observe: async () => fixture.observation,
                    act: async () => {
                        throw new Error("Chooser comparison never dispatches.");
                    },
                },
                limits: { timeoutMs: Math.max(1, Math.floor(budget.remaining())), maxRequests: 1, maxActions: 0 },
                signal: budget.signal,
                evaluate: async (call) => {
                    budget.take("request");
                    evaluator ??= options.evaluate
                        ? Promise.resolve(options.evaluate)
                        : createEvaluator({ provider: options.provider });
                    const result = await (await evaluator)(call);
                    recorded = result;
                    usageKnown &&= result.usage.inputTokens !== undefined && result.usage.outputTokens !== undefined;
                    const raw = result.providerMetadata?.gateway?.cost;
                    const amount = typeof raw === "number" || typeof raw === "string" ? Number(raw) : NaN;
                    costKnown &&= Number.isFinite(amount);
                    if (Number.isFinite(amount)) {
                        cost += amount;
                    }
                    return result;
                },
            });
            const result = await chooseCandidate({
                observation: fixture.observation,
                intent: fixture.intent,
                mode,
                session,
            });
            const metrics = session.report();
            const selected = result.selected?.element ?? null;
            rows.push({
                fixture: fixture.id,
                split: fixture.split,
                mode,
                expected: fixture.expectedElement,
                selected,
                status: result.status,
                correct: selected === fixture.expectedElement,
                wrongAction: selected !== null && selected !== fixture.expectedElement,
                abstained: selected === null,
                requests: metrics.requests,
                elapsedMs: metrics.elapsedMs,
                ...metrics.usage,
                usageKnown,
                costUsd: costKnown ? cost : null,
                signals: result.signals,
            });
            if (input.calibrate && mode !== "exact") {
                for (const [index, policy] of calibrationPolicies.entries()) {
                    budget.remaining();
                    const replayed = await chooseCandidate({
                        observation: fixture.observation,
                        intent: fixture.intent,
                        mode,
                        policy,
                        session: {
                            budget,
                            evaluate: async () => {
                                if (!recorded) {
                                    throw new Error("Calibration attempted an unrecorded evaluation.");
                                }
                                return recorded;
                            },
                        },
                    });
                    calibrationRows.push({
                        fixture: fixture.id,
                        split: fixture.split,
                        mode,
                        policy: index,
                        expected: fixture.expectedElement,
                        selected: replayed.selected?.element ?? null,
                        status: replayed.status,
                    });
                }
            }
        }
    }
    return {
        mode: "decision-only" as const,
        provider: input.jev ? (options.provider ?? DEFAULT_EVALUATION_PROVIDER) : null,
        rows,
        summary: modes.map((mode) => {
            const sample = rows.filter((row) => row.mode === mode);
            return {
                mode,
                cases: sample.length,
                correct: sample.filter((row) => row.correct).length,
                wrongActions: sample.filter((row) => row.wrongAction).length,
                abstentions: sample.filter((row) => row.abstained).length,
                requests: sample.reduce((sum, row) => sum + row.requests, 0),
                elapsedMs: sample.reduce((sum, row) => sum + row.elapsedMs, 0),
                inputTokens: sample.every((row) => row.usageKnown)
                    ? sample.reduce((sum, row) => sum + row.inputTokens, 0)
                    : null,
                outputTokens: sample.every((row) => row.usageKnown)
                    ? sample.reduce((sum, row) => sum + row.outputTokens, 0)
                    : null,
                costUsd: sample.every((row) => row.costUsd !== null)
                    ? sample.reduce((sum, row) => sum + (row.costUsd ?? 0), 0)
                    : null,
            };
        }),
        metrics: budget.snapshot(),
        calibration: input.calibrate ? calibrationReport(calibrationRows) : null,
        note: "Small synthetic smoke corpus. Thresholds are fixed; no real-world accuracy or speed claim. Host handoffs make no additional AI call.",
    };
}
export type ChooserComparison = Awaited<ReturnType<typeof compareChoosers>>;
