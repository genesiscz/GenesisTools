import { join } from "node:path";
import * as p from "@clack/prompts";
import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { createEvaluator, type Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { isInteractive } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { logger, out } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import type { Command } from "commander";
import { failPlain, printResult, withSigint } from "../lib/cli-output";
import { loadCatalogue } from "../lib/route/cache";
import type { ToolCatalogue } from "../lib/route/catalogue";
import { routePlan, zshRouteWidget } from "../lib/route/plan";
import { type RouteDecision, routeUtterance, suggestCatalogue } from "../lib/route/router";
import { runRoutedDecision } from "../lib/route/run";

const { log } = logger.scoped("jev-route");
const prof = profiler.scope("jev-route");

interface RouteOptions {
    src?: string;
    suggest?: boolean;
    run?: boolean;
    yes?: boolean;
    plan?: boolean;
    allowDestructive?: boolean;
    zsh?: boolean;
    refresh?: boolean;
}

function srcDir(options: RouteOptions): string {
    return options.src ?? join(import.meta.dir, "..", "..");
}

function describe(decision: RouteDecision): void {
    if (decision.status !== "admitted") {
        ui.warn(`No command admitted (${decision.reason}, p=${decision.p.toFixed(2)}).`);
        return;
    }

    ui.ok(`${decision.printed}  (p=${decision.p.toFixed(2)}${decision.destructive ? ", destructive" : ""})`);
    for (const binding of decision.bindings) {
        const span = binding.span ? ` ← "${binding.span.text}" @${binding.span.start}` : "";
        ui.kv(
            binding.kind === "flag" ? (binding.token ?? binding.name) : binding.name,
            `${binding.value ?? "yes"}${span}`
        );
    }
    for (const missing of decision.unbound) {
        ui.dim(`  unbound ${missing}`);
    }
}

async function runSuggest(options: {
    utterance: string;
    catalogue: ToolCatalogue;
    evaluate: Evaluator;
    signal: AbortSignal;
}): Promise<void> {
    const rows = await suggestCatalogue({
        utterance: options.utterance,
        catalogue: options.catalogue,
        evaluate: options.evaluate,
        signal: options.signal,
    });
    out.print(`${rows.map((row) => `tools ${row.path}`).join("\n")}\n`);
    process.exitCode = rows.length ? 0 : 1;
}

const REFUSAL_LINES: Record<string, string> = {
    not_admitted: "Nothing ran: no command was admitted for that utterance.",
    destructive_needs_yes: "Destructive route refused. Re-run with --yes.",
    destructive_declined: "Destructive route declined at the confirm prompt.",
    empty_argv: "Nothing ran: the route produced no argv.",
    missing_required_argument: "Nothing ran: a required argument of that command is not in the utterance.",
};

async function executeDecision(decision: RouteDecision, options: RouteOptions): Promise<void> {
    const interactive = isInteractive();
    const outcome = await runRoutedDecision({
        decision,
        yes: options.yes,
        ...(interactive && !options.yes
            ? {
                  confirm: async () =>
                      (await p.confirm({ message: `Run the destructive command ${decision.printed}?` })) === true,
              }
            : {}),
    });
    if (!outcome.executed) {
        ui.err(REFUSAL_LINES[outcome.refused ?? "empty_argv"] ?? `Route not executed (${outcome.refused}).`);
        process.exitCode = 1;
        return;
    }

    if (outcome.stdout) {
        out.print(`${outcome.stdout}\n`);
    }

    if (outcome.stderr) {
        ui.raw(outcome.stderr);
    }

    process.exitCode = outcome.exitCode ?? 0;
}

export function registerRoute(program: Command): void {
    program
        .command("route")
        .description("Pick a GenesisTools command for an utterance; default prints, --run executes")
        .argument("[utterance]", "What you want a tool to do")
        .option("--src [dir]", "Tools source directory to build the catalogue from")
        .option("--suggest", "Print the ten best catalogue rows instead of picking one")
        .option("--run", "Execute the printed command")
        .option("--yes", "Confirm a destructive --run")
        .option("--plan", "Split the utterance on then / and then into up to five routed steps")
        .option("--allow-destructive", "Let --plan continue past a destructive step")
        .option("--zsh", "Print a zsh widget; never writes ~/.zshrc")
        .option("--refresh", "Rebuild the catalogue cache before routing")
        .action(async (utterance: string | undefined, options: RouteOptions) => {
            if (options.zsh) {
                out.print(zshRouteWidget());
                return;
            }

            if (!utterance?.trim()) {
                failPlain(new Error("Pass an utterance, or --zsh to print the widget."));
                return;
            }

            try {
                await withSigint(async (signal) => {
                    const loaded = await loadCatalogue({ srcDir: srcDir(options), refresh: options.refresh });
                    ui.dim(
                        `catalogue ${loaded.cached ? "cached" : "rebuilt"} · ${loaded.catalogue.tools.length} tools · ${loaded.ms} ms`
                    );
                    const evaluate = await createEvaluator({ provider: selectedProvider(program) });
                    if (options.suggest) {
                        await runSuggest({ utterance, catalogue: loaded.catalogue, evaluate, signal });
                        return;
                    }

                    if (options.plan) {
                        const plan = await routePlan({
                            utterance,
                            catalogue: loaded.catalogue,
                            evaluate,
                            signal,
                            allowDestructive: options.allowDestructive,
                        });
                        for (const step of plan.steps) {
                            describe(step);
                        }

                        printResult(plan);
                        process.exitCode = plan.blocked ? 2 : 0;
                        return;
                    }

                    const decision = await routeUtterance({ utterance, catalogue: loaded.catalogue, evaluate, signal });
                    describe(decision);
                    printResult(decision);
                    if (decision.status !== "admitted") {
                        process.exitCode = 1;
                        return;
                    }

                    if (options.run) {
                        await executeDecision(decision, options);
                    }
                });
            } catch (error) {
                log.debug({ error }, "Route command failed");
                failPlain(error, { command: "route" });
            } finally {
                prof.summary("jev route");
            }
        });
}
