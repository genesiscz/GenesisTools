import { assistTask } from "@app/control/lib/decision/assist";
import type { ControlDriver } from "@app/control/lib/decision/native";
import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { z } from "zod";
import { choiceValue } from "./answers";
import { runBrowserGoal } from "./browser/goal";
import type { BrowserDriver } from "./browser/types";

export async function runGoalLoop(options: {
    goal: string;
    surface: "native" | "browser" | "auto" | "hybrid";
    evaluate: Evaluator;
    native?: { driver: ControlDriver; expect?: string };
    browser?: { driver: BrowserDriver; inputs?: Record<string, string>; url?: string };
    signal?: AbortSignal;
    maxSteps?: number;
    maxRequests?: number;
    timeoutMs?: number;
}) {
    const surface = await resolveSurface(options);
    const limits = {
        maxActions: options.maxSteps ?? (surface === "browser" ? 15 : 8),
        maxRequests: options.maxRequests ?? 20,
        timeoutMs: options.timeoutMs ?? 120000,
    };
    if (surface === "native") {
        const native = options.native;
        if (!native) {
            throw new Error("Native loop requires --app and a control driver.");
        }
        return {
            surface,
            ...(await assistTask({
                goal: options.goal,
                expect: native.expect,
                driver: native.driver,
                evaluate: options.evaluate,
                signal: options.signal,
                limits,
            })),
        };
    }
    const browser = options.browser;
    if (!browser) {
        throw new Error("Browser loop requires --url or --port.");
    }
    return {
        surface,
        ...(await runBrowserGoal({
            goal: options.goal,
            driver: browser.driver,
            evaluate: options.evaluate,
            inputs: browser.inputs,
            limits,
            signal: options.signal,
        })),
    };
}

async function resolveSurface(options: {
    surface: string;
    native?: unknown;
    browser?: unknown;
    goal: string;
    evaluate: Evaluator;
    signal?: AbortSignal;
}): Promise<"native" | "browser"> {
    const surface = z.enum(["native", "browser", "auto", "hybrid"]).parse(options.surface);
    if (surface === "native" || surface === "browser") {
        return surface;
    }
    if (surface === "auto") {
        if (options.browser) {
            return "browser";
        }
        if (options.native) {
            return "native";
        }
        throw new Error("auto surface needs --app or --url/--port.");
    }
    if (!options.native || !options.browser) {
        throw new Error("hybrid surface requires both --app and --url/--port.");
    }
    const evaluation = await options.evaluate({
        signal: options.signal,
        input: {
            state: { goal: options.goal },
            questions: {
                surface: {
                    type: "choice",
                    instructions: "Which surface should take the next step?",
                    criteria: {
                        native: "macOS Accessibility / Computer Use",
                        browser: "CDP page",
                        done: "Goal already complete",
                    },
                },
            },
        },
    });
    const choice = choiceValue(evaluation, "surface");
    if (choice === "native") {
        return "native";
    }
    if (choice === "browser") {
        return "browser";
    }
    return options.browser ? "browser" : "native";
}
