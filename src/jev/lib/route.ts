import { admittedChoice } from "@app/control/lib/decision/decisions";
import { discoverTools, type ToolInfo } from "@app/tools/lib/discovery";
import { introspectTool } from "@app/tools/lib/introspect";
import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { z } from "zod";
import { booleanProbability } from "./answers";

const DESTRUCTIVE = /^(push|rm|delete|kill|quit|restart|send|publish|deploy|drop|reset|act|hotkey|type|click)$/i;
const DESTRUCTIVE_TOOLS = new Set(["jenkins-mcp", "apoptosis"]);

export interface RouteSuggestion {
    tool: string;
    subcommand?: string;
    argv: string[];
    probability: number;
    destructive: boolean;
    admitted: boolean;
    run: boolean;
    reason: string;
}

export function isDestructive(tool: string, subcommand?: string): boolean {
    if (DESTRUCTIVE_TOOLS.has(tool)) {
        return true;
    }
    if (DESTRUCTIVE.test(tool) || (subcommand !== undefined && DESTRUCTIVE.test(subcommand))) {
        return true;
    }
    return false;
}

export function catalog(srcDir: string): ToolInfo[] {
    return discoverTools(srcDir).filter((tool) => !["Internal", "utils", "components", "lib"].includes(tool.name));
}

function bucketOf(name: string): string {
    if (/^(ai|ask|grok|claude|codex|jev|transcribe|say)/.test(name)) {
        return "ai";
    }
    if (/^(git|github)/.test(name)) {
        return "git";
    }
    if (/^(macos|control|computer-use|chrome-devtools|wakeup)/.test(name)) {
        return "macos";
    }
    if (/^(timely|timer|tz|clarity)/.test(name)) {
        return "time";
    }
    return "other";
}

export async function routeUtterance(options: {
    utterance: string;
    srcDir: string;
    evaluate: Evaluator;
    run?: boolean;
    allowDestructive?: boolean;
    tools?: ToolInfo[];
    signal?: AbortSignal;
}): Promise<RouteSuggestion> {
    const utterance = z.string().trim().min(1).max(4000).parse(options.utterance);
    let tools = options.tools ?? catalog(options.srcDir);
    if (tools.length === 0) {
        throw new Error("No tools discovered.");
    }
    if (tools.length > 240) {
        const buckets = ["ai", "git", "macos", "time", "other"] as const;
        const bucketEval = await options.evaluate({
            signal: options.signal,
            input: {
                state: { utterance, count: tools.length },
                questions: {
                    bucket: {
                        type: "choice",
                        instructions: "Which tool family matches the utterance?",
                        criteria: Object.fromEntries(buckets.map((bucket) => [bucket, bucket])),
                    },
                },
            },
        });
        const bucket = admittedChoice({ result: bucketEval, id: "bucket", allowed: [...buckets] });
        if (bucket.admitted) {
            tools = tools.filter((tool) => bucketOf(tool.name) === bucket.choice);
        }
    }
    const criteria = Object.fromEntries(tools.map((tool) => [tool.name, tool.description || tool.name]));
    const evaluation = await options.evaluate({
        signal: options.signal,
        input: {
            state: { utterance, tools: tools.map((tool) => ({ name: tool.name, description: tool.description })) },
            questions: {
                tool: {
                    type: "choice",
                    instructions: "Choose the GenesisTools command that satisfies the utterance. none if missing.",
                    criteria: { ...criteria, none: "No tool matches." },
                },
                destructive: { type: "boolean", instructions: "Would running this mutate remotes, UI, or data?" },
                needs_args: { type: "boolean", instructions: "Does the tool need a subcommand before it is useful?" },
            },
        },
    });
    const toolChoice = admittedChoice({
        result: evaluation,
        id: "tool",
        allowed: [...tools.map((tool) => tool.name), "none"],
    });
    if (!toolChoice.admitted || toolChoice.choice === "none") {
        return {
            tool: "none",
            argv: [],
            probability: toolChoice.probability,
            destructive: false,
            admitted: false,
            run: false,
            reason: toolChoice.reason,
        };
    }
    const tool = tools.find((item) => item.name === toolChoice.choice);
    if (!tool) {
        return {
            tool: toolChoice.choice,
            argv: [],
            probability: toolChoice.probability,
            destructive: false,
            admitted: false,
            run: false,
            reason: "missing_tool",
        };
    }
    let subcommand: string | undefined;
    const needsArgs = (booleanProbability(evaluation, "needs_args") ?? 0) >= 0.5;
    if (needsArgs) {
        const help = introspectTool(tool.path);
        const names =
            help?.commands
                .map((command) => command.name)
                .filter(Boolean)
                .slice(0, 80) ?? [];
        if (names.length) {
            const sub = await options.evaluate({
                signal: options.signal,
                input: {
                    state: { utterance, tool: tool.name, commands: help?.commands ?? [] },
                    questions: {
                        subcommand: {
                            type: "choice",
                            instructions: "Choose one subcommand or help.",
                            criteria: {
                                ...Object.fromEntries(names.map((name) => [name, name])),
                                help: "Show help instead of guessing.",
                            },
                        },
                    },
                },
            });
            const picked = admittedChoice({ result: sub, id: "subcommand", allowed: [...names, "help"] });
            if (picked.admitted) {
                subcommand = picked.choice;
            }
        }
    }
    const destructive =
        isDestructive(tool.name, subcommand) || (booleanProbability(evaluation, "destructive") ?? 0) >= 0.5;
    const argv = subcommand && subcommand !== "help" ? ["tools", tool.name, subcommand] : ["tools", tool.name];
    const run = Boolean(options.run) && (!destructive || Boolean(options.allowDestructive));
    return {
        tool: tool.name,
        subcommand,
        argv,
        probability: toolChoice.probability,
        destructive,
        admitted: true,
        run,
        reason: run ? "run" : destructive && options.run ? "destructive_blocked" : "print",
    };
}
