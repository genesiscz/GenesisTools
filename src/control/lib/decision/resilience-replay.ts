import { evaluationSchema } from "@genesiscz/utils/ai/evaluation/evaluate";
import { createEvaluator, type EvaluationResponse, type Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import type { EvaluationProviderId } from "@genesiscz/utils/ai/evaluation/types";
import { z } from "zod";
import { assistTask } from "./assist";
import type { ControlDriver } from "./native";
import type { Observation } from "./observation";
import { replayWorkflow } from "./workflow";

export const resilienceCases = [
    { id: "stale", kind: "recovery", title: "Stale target refused before dispatch" },
    { id: "unknown", kind: "recovery", title: "Unknown delivery never retries" },
    { id: "permission", kind: "recovery", title: "Permission refusal stops" },
    { id: "cap", kind: "recovery", title: "Repeated stale UI exhausts recovery cap" },
    { id: "reordered", kind: "workflow", title: "Fields reordered; exact IDs still bind" },
    { id: "renamed", kind: "workflow", title: "Missing selector can be rebound by Jev" },
    { id: "ambiguous", kind: "workflow", title: "Duplicate original selector stops" },
] as const;
export async function replayResilience(options: {
    input: unknown;
    provider?: EvaluationProviderId;
    signal?: AbortSignal;
    evaluate?: Evaluator;
}) {
    const input = z
        .object({
            id: z.enum(["stale", "unknown", "permission", "cap", "reordered", "renamed", "ambiguous"]),
            chooser: z.enum(["oracle", "jev"]).default("oracle"),
        })
        .strict()
        .parse(options.input);
    const fixture = resilienceCases.find((item) => item.id === input.id)!;
    let revision = 0;
    let attempts = 0;
    let completed = false;
    let value = "";
    const events: Array<{ kind: string; detail: string }> = [];
    const observe = (): Observation => ({
        ok: true,
        app: "Resilience fixture",
        pid: 1,
        processLaunch: 1,
        scope: "window",
        window: { id: 1, title: "Profile" },
        snapshot: `fixture-${revision++}`,
        elements:
            fixture.kind === "recovery"
                ? [
                      {
                          index: 0,
                          depth: 0,
                          role: "AXButton",
                          AXTitle: "Save profile",
                          AXIdentifier: "save",
                          actions: ["AXPress"],
                      },
                      {
                          index: 1,
                          depth: 0,
                          role: "AXStaticText",
                          AXIdentifier: "status",
                          AXValue: completed ? "Saved" : "Not saved",
                      },
                  ]
                : [
                      {
                          index: revision % 2 ? 1 : 0,
                          depth: 0,
                          role: "AXTextField",
                          AXTitle: "Full name",
                          AXIdentifier: input.id === "renamed" ? "new-name" : "name",
                          valueSettable: true,
                          AXValue: value,
                      },
                      {
                          index: revision % 2 ? 0 : 1,
                          depth: 0,
                          role: "AXTextField",
                          AXTitle: "City",
                          AXIdentifier: input.id === "ambiguous" ? "name" : "city",
                          valueSettable: true,
                          AXValue: "",
                      },
                  ],
    });
    const driver: ControlDriver = {
        observe: async () => {
            events.push({ kind: "observe", detail: "Fresh fixture revision" });
            return observe();
        },
        act: async (call) => {
            attempts++;
            events.push({ kind: "dispatch", detail: `${call.candidate.action} → ${call.candidate.identifier}` });
            if (fixture.kind === "recovery") {
                if (input.id === "unknown") {
                    return { ok: false, dispatchState: "uncertain", error: "Fixture lost delivery acknowledgement" };
                }
                if (input.id === "permission") {
                    return {
                        ok: false,
                        dispatchState: "not_started",
                        refusal: "permission",
                        error: "Fixture permission refusal",
                    };
                }
                if (attempts === 1 || input.id === "cap") {
                    return {
                        ok: false,
                        dispatchState: "not_started",
                        refusal: "stale_observation",
                        error: "Fixture changed before dispatch",
                    };
                }
                completed = true;
            } else {
                value = call.value ?? "";
            }
            return { ok: true, after: observe() };
        },
    };
    let live: Promise<Evaluator> | undefined;
    let paidRequests = 0;
    const evaluate: Evaluator = async (call) => {
        if (input.chooser === "jev") {
            paidRequests++;
            live ??= options.evaluate
                ? Promise.resolve(options.evaluate)
                : createEvaluator({ provider: options.provider });
            return (await live)(call);
        }
        const request = evaluationSchema.parse(call.input);
        const answers: EvaluationResponse["answers"] = {};
        for (const [id, question] of Object.entries(request.questions)) {
            if (question.type === "choice") {
                const choice = id === "remedy" ? "reobserve" : "c0";
                answers[id] = {
                    type: "choice",
                    choice,
                    probabilities: Object.fromEntries(
                        Object.keys(question.criteria).map((key) => [key, key === choice ? 1 : 0])
                    ),
                };
            }
        }
        return {
            model: "fixture-oracle",
            answers,
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            warnings: [],
            rounding: undefined,
            providerMetadata: undefined,
        };
    };
    const result =
        fixture.kind === "recovery"
            ? await assistTask({
                  goal: "Save profile",
                  exact: { identifier: "status", value: "Saved" },
                  driver,
                  evaluate,
                  signal: options.signal,
                  chooser: "auto",
                  recovery: { mode: "bounded", maxRecoveries: 2 },
                  limits: { maxActions: 5, maxRequests: 5, timeoutMs: 30000 },
              })
            : await replayWorkflow({
                  plan: {
                      version: 1,
                      app: "Resilience fixture",
                      scope: "window",
                      steps: [
                          {
                              id: "name",
                              action: "set",
                              selector: { identifier: "name" },
                              intent: "Enter the supplied full name",
                              valueRef: "name",
                              postcondition: {
                                  expect: "Full name entered",
                                  exact: { identifier: input.id === "renamed" ? "new-name" : "name", valueRef: "name" },
                              },
                          },
                      ],
                  },
                  values: { name: "Example Name" },
                  rebind: input.id === "renamed",
                  driver,
                  evaluate,
                  signal: options.signal,
                  limits: { maxActions: 2, maxRequests: 2, timeoutMs: 30000 },
              });
    return {
        fixture,
        mode: "fixture-only" as const,
        chooser: input.chooser,
        result,
        events,
        dispatchAttempts: attempts,
        paidRequests,
        note:
            input.chooser === "oracle"
                ? "Oracle checks control flow only; it is not a model accuracy result."
                : "Only Jev judges; all actions affect an in-memory fixture.",
    };
}
export type ResilienceReplay = Awaited<ReturnType<typeof replayResilience>>;
