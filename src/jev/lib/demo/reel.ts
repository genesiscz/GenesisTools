import type { EvaluationResponse, Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { parseCompactJsonl } from "../compact/format";
import { compactStructural } from "../compact/structural";
import { routeUtterance } from "../route/router";

export const DEMO_NAMES = ["listen", "voice", "watch", "route", "compact", "observe", "verify", "loop"] as const;
export type DemoName = (typeof DEMO_NAMES)[number];

export interface DemoSummary {
    demo: DemoName;
    ok: boolean;
    reason: string;
    readback?: boolean;
}

export interface DemoTrace {
    demo: DemoName;
    startedAt: string;
    events: Array<{ atMs: number; kind: string; detail?: string }>;
    readback: boolean;
    ok: boolean;
}

export function demoTrace(summary: DemoSummary, startedAt = new Date().toISOString()): DemoTrace {
    return {
        demo: summary.demo,
        startedAt,
        events: [{ atMs: 0, kind: "summary", detail: summary.reason }],
        readback: summary.readback === true,
        ok:
            summary.ok &&
            (summary.readback !== false ||
                summary.demo === "verify" ||
                summary.demo === "route" ||
                summary.demo === "compact"),
    };
}

function evaluation(answers: EvaluationResponse["answers"]): EvaluationResponse {
    return {
        model: "fixture",
        answers,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        warnings: [],
        rounding: undefined,
        providerMetadata: undefined,
    };
}

export async function runDemo(name: string): Promise<DemoSummary> {
    const demo = name === "voice" ? "listen" : name;
    if (!(DEMO_NAMES as readonly string[]).includes(demo)) {
        throw new Error(`Unknown demo '${name}'. Valid: ${DEMO_NAMES.join("|")}`);
    }

    if (demo === "compact") {
        const session = [
            `{"role":"user","content":"review 409"}`,
            `{"role":"tool","name":"github","content":"${"hunk".repeat(80)}"}`,
            `{"role":"assistant","content":"done"}`,
            `{"role":"user","content":"tail"}`,
            `{"role":"assistant","content":"tail2"}`,
        ].join("\n");
        const result = compactStructural(parseCompactJsonl(session), {
            keep: 0.5,
            pin: 2,
            maxResult: 40,
            threshold: 0.1,
        });
        return {
            demo: "compact",
            ok: result.unchanged || result.reduction >= 0.1,
            reason: result.unchanged ? (result.reason ?? "unchanged") : "compacted",
        };
    }

    if (demo === "route") {
        const evaluate: Evaluator = async () =>
            evaluation({
                command: {
                    type: "choice",
                    choice: "github.review",
                    probabilities: { "github.review": 0.95, abstain: 0.05 },
                },
                destructive: { type: "boolean", probability: 0.01 },
                confirm: { type: "boolean", probability: 0.01 },
            });
        const result = await routeUtterance({
            utterance: "unresolved threads on 409",
            catalogue: {
                commit: "fixture",
                tools: [
                    {
                        name: "github",
                        oneLine: "GitHub",
                        commands: [{ path: "github review", description: "review", argHint: "", destructive: false }],
                    },
                ],
            },
            evaluate,
        });
        return { demo: "route", ok: result.printed === "tools github review 409", reason: result.reason };
    }

    return { demo: demo as DemoName, ok: true, reason: "fixture_replay", readback: demo !== "verify" };
}

export function refuseUserMail(app?: string, force?: boolean): void {
    if (app === "Mail" && !force) {
        throw new Error("Demo refuses --app Mail without --i-mean-it. Use the AppKit fixture.");
    }
}
