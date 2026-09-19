import { expect, test } from "bun:test";
import { join } from "node:path";
import { evaluationSchema } from "@genesiscz/utils/ai/evaluation/evaluate";
import type { EvaluationCall } from "@genesiscz/utils/ai/evaluation/providers";
import type { EvaluationResponse, Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { aliasedPaths, aliasNote } from "./aliases";
import {
    buildCatalogue,
    type CatalogueCommand,
    type CatalogueRow,
    flattenCatalogue,
    hasDestructiveFlag,
    isDestructive,
    parseCommandEntry,
    parseFlag,
    type RouteFlag,
    type ToolCatalogue,
} from "./catalogue";
import { applyBindings, flagToken, positionalSlots, utteranceSpans } from "./flags";
import { splitPlanUtterance, zshRouteWidget } from "./plan";
import { extractArgHints, fillArgv, routeUtterance, shortlistRows, suggestBatches, suggestCatalogue } from "./router";
import { type RouteExecutor, runRoutedDecision, toolArgs } from "./run";

const SRC_DIR = join(import.meta.dir, "..", "..", "..");

function evaluation(answers: EvaluationResponse["answers"]): EvaluationResponse {
    return {
        model: "fixture",
        answers,
        usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
        warnings: [],
        rounding: undefined,
        providerMetadata: undefined,
    };
}

function distribute(keys: string[], chosen: string): Record<string, number> {
    const rest = keys.filter((key) => key !== chosen);
    const share = rest.length ? 0.05 / rest.length : 0;
    return Object.fromEntries([[chosen, rest.length ? 0.95 : 1], ...rest.map((key) => [key, share])]);
}

interface Script {
    choices?: Record<string, string>;
    booleans?: Record<string, number>;
}

/**
 * Fixture evaluator: it reads the questions the router actually asked and answers them from a
 * script, so a test pins the decision rather than the wording of a prompt. Unscripted choices
 * fall through to the safe option (none / abstain / stay) and unscripted booleans to false.
 */
function scripted(script: Script, calls: EvaluationCall[] = []): Evaluator {
    return async (call) => {
        calls.push(call);
        const input = evaluationSchema.parse(call.input);
        const answers: EvaluationResponse["answers"] = {};
        for (const [id, question] of Object.entries(input.questions)) {
            if (question.type === "choice") {
                const keys = Object.keys(question.criteria);
                const fallback = ["none", "abstain", "stay"].find((key) => keys.includes(key)) ?? keys[0];
                const choice = script.choices?.[id] ?? fallback;
                answers[id] = { type: "choice", choice, probabilities: distribute(keys, choice) };
                continue;
            }

            if (question.type === "boolean") {
                answers[id] = { type: "boolean", probability: script.booleans?.[id] ?? 0 };
                continue;
            }

            answers[id] = { type: "score", score: 0 };
        }
        return evaluation(answers);
    };
}

function flag(name: string, extra: Partial<RouteFlag> = {}): RouteFlag {
    return { name, takesValue: false, optionalValue: false, description: name, ...extra };
}

function command(path: string, extra: Partial<CatalogueCommand> = {}): CatalogueCommand {
    return {
        path,
        description: path,
        argHint: "",
        destructive: false,
        flags: [],
        flagsLoaded: true,
        hasSubcommands: false,
        ...extra,
    };
}

const FIXTURE_CATALOGUE: ToolCatalogue = {
    commit: "test",
    tools: [
        {
            name: "github",
            oneLine: "GitHub pull requests",
            commands: [
                command("github review", {
                    description: "Fetch and display GitHub PR review threads",
                    argHint: "<pr>",
                    flags: [
                        flag("unresolved-only", { short: "-u", description: "Show only unresolved threads" }),
                        flag("json", { short: "-j", description: "Output as JSON" }),
                        flag("repo", { takesValue: true, description: "Repository" }),
                    ],
                }),
                command("github pr", {
                    description: "Fetch GitHub pull request details",
                    argHint: "<input>",
                    flags: [flag("json", { short: "-j", description: "Output as JSON" })],
                }),
            ],
        },
        {
            name: "git",
            oneLine: "Git branch mechanics",
            commands: [
                command("git push", { description: "Push the branch", destructive: true }),
                command("git merged"),
            ],
        },
        {
            name: "tmux",
            oneLine: "tmux sessions",
            commands: [command("tmux list", { description: "List tmux sessions" })],
        },
    ],
};

test("catalogue introspection finds real subcommands of github, control and jev", () => {
    const catalogue = buildCatalogue({ srcDir: SRC_DIR, only: ["github", "control", "jev"] });
    const paths = flattenCatalogue(catalogue).map((row) => row.path);
    expect(paths).toContain("github review");
    expect(paths).toContain("control assist");
    expect(paths).toContain("jev route");
    expect(paths.every((path) => !path.includes("--"))).toBe(true);
    expect(paths.length).toBeGreaterThan(40);
});

test("parseCommandEntry keeps command names and rejects option lines", () => {
    expect(parseCommandEntry("pr [options] <input>")).toEqual({ name: "pr", aliases: [], argHint: "<input>" });
    expect(parseCommandEntry("experiment|typescript")).toEqual({
        name: "experiment",
        aliases: ["typescript"],
        argHint: "",
    });
    expect(parseCommandEntry("-s, --session <id>")).toBeNull();
});

test("parseFlag reads short forms and value arity", () => {
    expect(parseFlag("-u, --unresolved-only", "Show only unresolved")).toEqual({
        name: "unresolved-only",
        short: "-u",
        takesValue: false,
        optionalValue: false,
        description: "Show only unresolved",
    });
    expect(parseFlag("--repo <owner/repo>", "Repository")?.takesValue).toBe(true);
    expect(parseFlag("-w, --worktree [path]", "Worktree")?.optionalValue).toBe(true);
    expect(parseFlag("-h, --help", "help")).toBeNull();
});

test("destructive verbs and flags are recognised", () => {
    expect(isDestructive("git push")).toBe(true);
    expect(isDestructive("control act")).toBe(true);
    expect(isDestructive("stash rm")).toBe(true);
    expect(isDestructive("github review")).toBe(false);
    expect(hasDestructiveFlag(["tools", "git", "branch", "--force"])).toBe(true);
    expect(hasDestructiveFlag(["tools", "github", "review", "-u"])).toBe(false);
});

test("spans and positional slots come from the utterance and the usage line", () => {
    expect(utteranceSpans('review 409 --repo "owner/name"').map((span) => span.text)).toEqual([
        "review",
        "409",
        "repo",
        "owner/name",
    ]);
    expect(positionalSlots("[options] <pr>")).toEqual([{ name: "pr", required: true, variadic: false }]);
    expect(positionalSlots("<refs...> [message]")).toEqual([
        { name: "refs", required: true, variadic: true },
        { name: "message", required: false, variadic: false },
    ]);
    expect(flagToken(flag("unresolved-only", { short: "-u" }))).toBe("-u");
    expect(flagToken(flag("repo"))).toBe("--repo");
});

const BINDING_CASES: Array<{ utterance: string; script: Script; argv: string[] }> = [
    {
        utterance: "show unresolved review threads on PR 409",
        script: {
            choices: { command: "github.review", slot_0_pr: "409" },
            booleans: { flag_unresolved_only: 0.97, pos_0_pr: 0.96 },
        },
        argv: ["tools", "github", "review", "409", "-u"],
    },
    {
        utterance: "open pull request 137 details",
        script: { choices: { command: "github.pr", slot_0_input: "137" }, booleans: { pos_0_input: 0.95 } },
        argv: ["tools", "github", "pr", "137"],
    },
    {
        utterance: "review 409 as json",
        script: {
            choices: { command: "github.review", slot_0_pr: "409" },
            booleans: { flag_json: 0.95, pos_0_pr: 0.95 },
        },
        argv: ["tools", "github", "review", "409", "-j"],
    },
    {
        utterance: "review threads for repo owner/name on 500",
        script: {
            choices: { command: "github.review", slot_0_pr: "500", value_repo: "owner/name" },
            booleans: { flag_repo: 0.95, pos_0_pr: 0.95 },
        },
        argv: ["tools", "github", "review", "500", "--repo", "owner/name"],
    },
    {
        utterance: "list tmux sessions",
        script: { choices: { command: "tmux.list" } },
        argv: ["tools", "tmux", "list"],
    },
    {
        utterance: "push the current branch",
        script: { choices: { command: "git.push" } },
        argv: ["tools", "git", "push"],
    },
];

test("binding turns six utterances into full argv", async () => {
    for (const testCase of BINDING_CASES) {
        const decision = await routeUtterance({
            utterance: testCase.utterance,
            catalogue: FIXTURE_CATALOGUE,
            evaluate: scripted(testCase.script),
        });
        expect({ utterance: testCase.utterance, argv: decision.argv }).toEqual({
            utterance: testCase.utterance,
            argv: testCase.argv,
        });
        expect(decision.status).toBe("admitted");
        expect(decision.p).toBeGreaterThanOrEqual(0.8);
    }
});

test("every bound token is traceable to a span of the utterance", async () => {
    const utterance = "show unresolved review threads on PR 409";
    const decision = await routeUtterance({
        utterance,
        catalogue: FIXTURE_CATALOGUE,
        evaluate: scripted(BINDING_CASES[0].script),
    });
    const positional = decision.bindings.find((binding) => binding.kind === "positional");
    expect(positional?.value).toBe("409");
    expect(utterance.slice(positional?.span?.start ?? 0, positional?.span?.end ?? 0)).toBe("409");
});

test("a destructive route marks itself destructive", async () => {
    const decision = await routeUtterance({
        utterance: "push the current branch",
        catalogue: FIXTURE_CATALOGUE,
        evaluate: scripted({ choices: { command: "git.push" } }),
    });
    expect(decision.destructive).toBe(true);
});

test("unknown utterances abstain and bind nothing", async () => {
    const decision = await routeUtterance({
        utterance: "what is the weather",
        catalogue: FIXTURE_CATALOGUE,
        evaluate: scripted({}),
    });
    expect(decision.status).toBe("abstained");
    expect(decision.argv).toEqual([]);
});

test("the family pre-filter runs above 240 rows and narrows the row choice", async () => {
    const tools = Array.from({ length: 30 }, (_, toolIndex) => ({
        name: `tool${toolIndex}`,
        oneLine: `Tool ${toolIndex}`,
        commands: Array.from({ length: 10 }, (_, commandIndex) => command(`tool${toolIndex} cmd${commandIndex}`)),
    }));
    const catalogue: ToolCatalogue = { commit: "test", tools };
    expect(flattenCatalogue(catalogue).length).toBeGreaterThan(240);
    const calls: EvaluationCall[] = [];
    const decision = await routeUtterance({
        utterance: "run cmd3 of tool7",
        catalogue,
        evaluate: scripted({ choices: { family: "tool7", command: "tool7.cmd3" } }, calls),
    });
    const first = evaluationSchema.parse(calls[0].input);
    expect(Object.keys(first.questions)).toEqual(["family"]);
    const second = evaluationSchema.parse(calls[1].input);
    const commandQuestion = second.questions.command;
    const offered = commandQuestion.type === "choice" ? Object.keys(commandQuestion.criteria) : [];
    expect(offered.length).toBeLessThanOrEqual(41);
    expect(offered.every((key) => key === "abstain" || key.startsWith("tool7."))).toBe(true);
    expect(decision.command).toBe("tool7 cmd3");
    expect(decision.families).toEqual(["tool7"]);
});

test("a small catalogue asks no family question", async () => {
    const calls: EvaluationCall[] = [];
    await routeUtterance({
        utterance: "list tmux sessions",
        catalogue: FIXTURE_CATALOGUE,
        evaluate: scripted({ choices: { command: "tmux.list" } }, calls),
    });
    const first = evaluationSchema.parse(calls[0].input);
    expect(Object.keys(first.questions)).toContain("command");
});

test("--run reaches the executor exactly once for an admitted non-destructive route", async () => {
    const seen: string[][] = [];
    const executor: RouteExecutor = async (args) => {
        seen.push(args);
        throw new Error("execTool must not be reached by an unrouted path");
    };
    const decision = await routeUtterance({
        utterance: "list tmux sessions",
        catalogue: FIXTURE_CATALOGUE,
        evaluate: scripted({ choices: { command: "tmux.list" } }),
    });
    expect(decision.destructive).toBe(false);
    await expect(runRoutedDecision({ decision, execute: executor })).rejects.toThrow("must not be reached");
    expect(seen).toEqual([["tmux", "list"]]);
});

test("--run never reaches the executor for an abstained route", async () => {
    const seen: string[][] = [];
    const executor: RouteExecutor = async (args) => {
        seen.push(args);
        throw new Error("execTool must not be reached by an unrouted path");
    };
    const decision = await routeUtterance({
        utterance: "what is the weather",
        catalogue: FIXTURE_CATALOGUE,
        evaluate: scripted({}),
    });
    const outcome = await runRoutedDecision({ decision, execute: executor });
    expect(outcome).toMatchObject({ executed: false, refused: "not_admitted" });
    expect(seen).toEqual([]);
});

test("a destructive route is refused without --yes and runs with it", async () => {
    const seen: string[][] = [];
    const executor: RouteExecutor = async (args) => {
        seen.push(args);
        return { exitCode: 0 };
    };
    const decision = await routeUtterance({
        utterance: "push the current branch",
        catalogue: FIXTURE_CATALOGUE,
        evaluate: scripted({ choices: { command: "git.push" } }),
    });
    const refused = await runRoutedDecision({ decision, execute: executor });
    expect(refused).toMatchObject({ executed: false, refused: "destructive_needs_yes" });
    expect(seen).toEqual([]);

    const allowed = await runRoutedDecision({ decision, yes: true, execute: executor });
    expect(allowed).toMatchObject({ executed: true, exitCode: 0 });
    expect(seen).toEqual([["git", "push"]]);
});

test("an interactive confirm can decline a destructive route", async () => {
    const seen: string[][] = [];
    const executor: RouteExecutor = async (args) => {
        seen.push(args);
        return { exitCode: 0 };
    };
    const decision = await routeUtterance({
        utterance: "push the current branch",
        catalogue: FIXTURE_CATALOGUE,
        evaluate: scripted({ choices: { command: "git.push" } }),
    });
    const outcome = await runRoutedDecision({ decision, execute: executor, confirm: async () => false });
    expect(outcome).toMatchObject({ executed: false, refused: "destructive_declined" });
    expect(seen).toEqual([]);
});

test("--run refuses when a required argument was never bound", async () => {
    const seen: string[][] = [];
    const executor: RouteExecutor = async (args) => {
        seen.push(args);
        throw new Error("execTool must not be reached by an unrouted path");
    };
    const decision = await routeUtterance({
        utterance: "open pull request details",
        catalogue: FIXTURE_CATALOGUE,
        evaluate: scripted({ choices: { command: "github.pr" } }),
    });
    expect(decision.unbound).toContain("input: unbound-required");
    const outcome = await runRoutedDecision({ decision, execute: executor });
    expect(outcome).toMatchObject({ executed: false, refused: "missing_required_argument" });
    expect(seen).toEqual([]);
});

test("an admitted abstain reports why, not accepted", async () => {
    const decision = await routeUtterance({
        utterance: "what is the weather",
        catalogue: FIXTURE_CATALOGUE,
        evaluate: scripted({}),
    });
    expect(decision.reason).toBe("no_command_matches");
});

test("toolArgs drops the printed tools head", () => {
    expect(toolArgs(["tools", "github", "review", "409"])).toEqual(["github", "review", "409"]);
    expect(toolArgs(["github", "review"])).toEqual(["github", "review"]);
});

test("applyBindings puts positionals before flags", () => {
    expect(
        applyBindings(
            ["tools", "github", "review"],
            [
                { kind: "flag", name: "unresolved-only", token: "-u", probability: 0.9, source: "jev" },
                { kind: "positional", name: "pr", value: "409", probability: 1, source: "exact" },
            ]
        )
    ).toEqual(["tools", "github", "review", "409", "-u"]);
});

test("shortlistRows ranks the matching row first", () => {
    const rows: CatalogueRow[] = flattenCatalogue(FIXTURE_CATALOGUE);
    expect(shortlistRows("unresolved review threads on 409", rows)[0].path).toBe("github review");
    expect(shortlistRows("list tmux sessions", rows)[0].path).toBe("tmux list");
});

test("aliases surface in row summaries and rank github review", () => {
    expect(aliasNote("github review")).toContain("aliases:");
    expect(aliasedPaths("show the pr threads")).toContain("github review");
    expect(flattenCatalogue(FIXTURE_CATALOGUE).find((row) => row.path === "github review")?.oneLine).toContain(
        "aliases:"
    );
});

test("plan splitting stops at five steps and the widget writes nothing", () => {
    expect(splitPlanUtterance("list open PRs and then show unresolved threads on 409")).toEqual([
        "list open PRs",
        "show unresolved threads on 409",
    ]);
    expect(splitPlanUtterance("a then b then c then d then e then f")).toHaveLength(5);
    expect(zshRouteWidget()).toContain("zle -N jev-route");
    expect(zshRouteWidget()).not.toContain(".zshrc\n");
});

test("extractArgHints copies issue numbers", () => {
    expect(extractArgHints("threads on 409")).toEqual(["409"]);
});

test("suggest batches at most 20 names", () => {
    const batches = suggestBatches(
        Array.from({ length: 41 }, (_, index) => index),
        20
    );
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(20);
    expect(batches[2]).toHaveLength(1);
});

test("fillArgv does not invent a missing path", () => {
    expect(fillArgv("open missing-file.ts on 409", ["review"], () => false)).toEqual(["review", "409"]);
    expect(fillArgv("open present.ts", ["review"], (path) => path === "present.ts")).toEqual(["review", "present.ts"]);
});

test("suggest ranks a 20-name batch", async () => {
    const tools = Array.from({ length: 21 }, (_, index) => ({
        name: `tool${index}`,
        oneLine: `Tool ${index}`,
        commands: [command(`tool${index} run`)],
    }));
    const evaluate: Evaluator = async (call) => {
        const ids = Object.keys(evaluationSchema.parse(call.input).questions);
        expect(ids.length).toBeLessThanOrEqual(20);
        return evaluation(
            Object.fromEntries(ids.map((id) => [id, { type: "score" as const, score: id.includes("tool0") ? 2 : 0 }]))
        );
    };
    const result = await suggestCatalogue({ utterance: "run tool0", catalogue: { commit: "test", tools }, evaluate });
    expect(result[0]?.path).toBe("tool0 run");
    expect(result).toHaveLength(10);
});
