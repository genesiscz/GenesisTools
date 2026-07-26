import { runTool, suggestCommand } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
import { Command } from "commander";
import { bootstrapCommand } from "./commands/bootstrap";
import { consolidateCommand } from "./commands/consolidate";
import { evalCommand } from "./commands/evaluate";
import { filterCommand } from "./commands/filter";
import { hooksCommand, preScoreCommand, selfReviewCommand, skillCommand } from "./commands/instruct";
import { listCommand } from "./commands/list";
import { type MineOptions, mineCommand } from "./commands/mine";
import { reportCommand } from "./commands/report";
import { selectCommand } from "./commands/select";
import { specCommand } from "./commands/spec";
import { statsCommand } from "./commands/stats";
import { type FableConfig, loadFableConfig } from "./lib/config";

const program = new Command();

program
    .name("learn-from-fable")
    .description(
        "Staged pipeline distilling Fable 5's working style from local session transcripts into the Fable Pack. " +
            "Run without arguments for guidance + stats."
    );

function requireConfig(): FableConfig | undefined {
    const config = loadFableConfig();
    if (!config) {
        logger.error("No fable config yet — run bootstrap first.");
        out.log.info(suggestCommand("tools learn-from-fable", { replaceCommand: ["bootstrap"] }));
        return undefined;
    }

    return config;
}

program
    .command("bootstrap")
    .description("Check/create the fable config (asks where the pack repo lives)")
    .option("--pack-path <path>", "Pack repo location (skips the prompt)")
    .action(async (options: { packPath?: string }) => {
        await bootstrapCommand(options);
    });

program
    .command("stats", { isDefault: true })
    .description("Corpus census + mined/unmined state + stage guidance (default)")
    .option("--min-size <bytes>", "Minimum transcript size to count as a candidate", "100000")
    .option("--json", "Machine-readable output")
    .action(async (options: { minSize: string; json?: boolean }) => {
        const config = requireConfig();
        if (!config) {
            return;
        }

        await statsCommand(config, { minSize: Number(options.minSize), json: options.json });
    });

program
    .command("report")
    .description("Full pipeline report — every run, number, and proof path, rendered markdown")
    .option("--md", "Print raw markdown (for piping / saving)")
    .option("--json", "Machine-readable output")
    .action((options: { md?: boolean; json?: boolean }) => {
        const config = requireConfig();
        if (!config) {
            return;
        }

        reportCommand(config, options);
    });

program
    .command("list")
    .description("Unmined session queue with details (oldest first)")
    .option("--limit <n>", "Rows to show", "20")
    .option("--min-size <bytes>", "Minimum transcript size", "100000")
    .option("--all", "Include already-mined sessions")
    .option("--details", "Read transcript heads for branch + first prompt")
    .option("--json", "Machine-readable output (implies --details)")
    .action(async (options: { limit: string; minSize: string; all?: boolean; details?: boolean; json?: boolean }) => {
        const config = requireConfig();
        if (!config) {
            return;
        }

        await listCommand(config, {
            limit: Number(options.limit),
            minSize: Number(options.minSize),
            all: options.all,
            details: options.details,
            json: options.json,
        });
    });

program
    .command("select")
    .description("Print unmined session paths (oldest first) for piping into mine")
    .option("--limit <n>", "Max sessions", "5")
    .option("--min-size <bytes>", "Minimum transcript size", "100000")
    .option("--json", "Full candidate objects instead of paths")
    .action(async (options: { limit: string; minSize: string; json?: boolean }) => {
        const config = requireConfig();
        if (!config) {
            return;
        }

        await selectCommand(config, {
            limit: Number(options.limit),
            minSize: Number(options.minSize),
            json: options.json,
        });
    });

interface MineCliOptions {
    limit: string;
    minSize: string;
    maxWindows: string;
    maxPerSession: string;
    model?: string;
    effort?: string;
    hedgeAfter?: string;
    backend?: string;
    ccProfile?: string;
    session?: string[];
    sessionConcurrency?: string;
    json?: boolean;
}

function toMineOptions(options: MineCliOptions, dry: boolean): MineOptions {
    return {
        limit: Number(options.limit),
        minSize: Number(options.minSize),
        maxWindows: Number(options.maxWindows),
        maxPerSession: Number(options.maxPerSession),
        model: options.model,
        effort: options.effort as MineOptions["effort"],
        hedgeAfterMs: Math.round(Number(options.hedgeAfter ?? 0) * 1000),
        backend: options.backend as MineOptions["backend"],
        ccProfile: options.ccProfile,
        sessions: options.session?.length ? options.session : undefined,
        sessionConcurrency: Number(options.sessionConcurrency ?? 3),
        dry,
        json: options.json,
    };
}

function addMineFlags(cmd: ReturnType<Command["command"]>): ReturnType<Command["command"]> {
    return cmd
        .option("--limit <n>", "Max sessions this run", "3")
        .option("--min-size <bytes>", "Minimum transcript size", "100000")
        .option("--max-windows <n>", "Extractor windows sampled per session (even spread)", "6")
        .option("--max-per-session <n>", "Episode cap per session", "4")
        .option("--model <id>", "Model id (default: config models.mine)")
        .option("--backend <name>", "Runner backend: ai-proxy | grok | claude-code", "ai-proxy")
        .option("--cc-profile <name>", "claude-code backend: tools cc run profile")
        .option("--session <path...>", "Explicit session file(s), overrides selection")
        .option("--session-concurrency <n>", "Sessions mined at once (each fans out its own windows)", "3")
        .option("--effort <level>", "Reasoning effort for model calls: low | medium | high")
        .option("--hedge-after <secs>", "Re-issue an extractor call that outlives this (default 0 = off)", "0")
        .option("--json", "Machine-readable output");
}

addMineFlags(
    program.command("mine").description("Extract decision-point episodes + principle candidates (model-backed)")
).action(async (options: MineCliOptions) => {
    const config = requireConfig();
    if (!config) {
        return;
    }

    await mineCommand(config, toMineOptions(options, false));
});

addMineFlags(
    program.command("pre-mine").description("Deterministic parse + window census for the selection (no model calls)")
).action(async (options: MineCliOptions) => {
    const config = requireConfig();
    if (!config) {
        return;
    }

    await mineCommand(config, toMineOptions(options, true));
});

program
    .command("filter")
    .description("Contrastive filter: keep episodes where the reference scores high AND a bare model scores low")
    .option("--slug <slug>", "Episode source model slug (default: all raw episode files)")
    .option("--filter-bare-model <id>", "Bare model (default: config models.filterBare)")
    .option("--filter-reference-model <id>", "Judge model (default: config models.judge)")
    .option("--keep-ref <x>", "Min reference soft score", "0.85")
    .option("--keep-naive <x>", "Max bare-model soft score", "0.55")
    .option("--judge-batch <n>", "Episodes per judge call", "6")
    .option("--limit <n>", "Max episodes this run")
    .option("--effort <level>", "Reasoning effort for model calls: low | medium | high")
    .option("--json", "Machine-readable output")
    .action(
        async (options: {
            slug?: string;
            filterBareModel?: string;
            filterReferenceModel?: string;
            keepRef: string;
            keepNaive: string;
            judgeBatch: string;
            limit?: string;
            effort?: "low" | "medium" | "high";
            json?: boolean;
        }) => {
            const config = requireConfig();
            if (!config) {
                return;
            }

            await filterCommand(config, {
                slug: options.slug,
                filterBareModel: options.filterBareModel,
                filterReferenceModel: options.filterReferenceModel,
                keepRef: Number(options.keepRef),
                keepNaive: Number(options.keepNaive),
                judgeBatch: Number(options.judgeBatch),
                limit: options.limit ? Number(options.limit) : undefined,
                effort: options.effort,
                json: options.json,
            });
        }
    );

program
    .command("eval")
    .description("A/B eval: bare model vs model+fable-style skill on mined episodes, judged against the reference")
    .option("--slug <slug>", "Episode source model slug (default: all)")
    .option("--model <id>", "Eval target model (default: config models.eval)")
    .option("--judge-model <id>", "Judge model (default: config models.judge)")
    .option("--limit <n>", "Max episodes")
    .option("--judge-batch <n>", "Episodes per judge call", "6")
    .option("--filtered-only", "Only contrast-filtered episodes")
    .option("--effort <level>", "Reasoning effort for model calls: low | medium | high")
    .option("--json", "Machine-readable output")
    .action(
        async (options: {
            slug?: string;
            model?: string;
            judgeModel?: string;
            limit?: string;
            judgeBatch: string;
            filteredOnly?: boolean;
            effort?: "low" | "medium" | "high";
            json?: boolean;
        }) => {
            const config = requireConfig();
            if (!config) {
                return;
            }

            await evalCommand(config, {
                slug: options.slug,
                model: options.model,
                judgeModel: options.judgeModel,
                limit: options.limit ? Number(options.limit) : undefined,
                judgeBatch: Number(options.judgeBatch),
                filteredOnly: options.filteredOnly,
                effort: options.effort,
                json: options.json,
            });
        }
    );

program
    .command("consolidate")
    .description("Multi-model vote on unconsolidated principles: useful/useless with % confidence, N rounds")
    .option("--models <ids>", "Comma-separated voter model ids (default: config judge+eval)")
    .option("--rounds <n>", "Voting rounds", "3")
    .option("--batch-size <n>", "Principles per vote call", "20")
    .option("--survive-threshold <x>", "Useful-vote fraction to survive a round", "0.5")
    .option("--effort <level>", "Reasoning effort for model calls: low | medium | high")
    .option("--json", "Machine-readable output")
    .action(
        async (options: {
            models?: string;
            rounds: string;
            batchSize: string;
            surviveThreshold: string;
            effort?: "low" | "medium" | "high";
            json?: boolean;
        }) => {
            const config = requireConfig();
            if (!config) {
                return;
            }

            await consolidateCommand(config, {
                models: options.models,
                rounds: Number(options.rounds),
                batchSize: Number(options.batchSize),
                surviveThreshold: Number(options.surviveThreshold),
                effort: options.effort,
                json: options.json,
            });
        }
    );

program
    .command("spec")
    .description("Synthesize a FABLE-SPEC proposal from mined principles (never overwrites the canonical spec)")
    .option("--model <id>", "Model that writes the spec (default: config models.judge)")
    .option("--effort <level>", "Reasoning effort for model calls: low | medium | high")
    .option("--max-lines <n>", "Line budget for the produced document", "200")
    .option("--min-confidence <n>", "Only feed VETTED principles at or above this confidence", "70")
    .option("--batch <n>", "Candidates per merge pass (each batch merges into the running draft)", "120")
    .option(
        "--first-output <secs>",
        "Silence budget before a pass is abandoned and retried (opus answers in ~3s, grok can take 200s+)",
        "300"
    )
    .option("--consolidated-only", "Skip raw unvoted candidates; use consolidated principles only")
    .option("--no-tighten", "Skip the final pass that splits oversized bullets back into principles")
    .option("--out <path>", "Where to write the proposal (default: pack/FABLE-SPEC.<runId>.md)")
    .option("--json", "Machine-readable output")
    .action(
        async (options: {
            model?: string;
            effort?: "low" | "medium" | "high";
            maxLines: string;
            minConfidence: string;
            batch: string;
            firstOutput: string;
            consolidatedOnly?: boolean;
            tighten?: boolean;
            out?: string;
            json?: boolean;
        }) => {
            const config = requireConfig();
            if (!config) {
                return;
            }

            await specCommand(config, {
                model: options.model,
                effort: options.effort,
                maxLines: Number(options.maxLines),
                minConfidence: Number(options.minConfidence),
                batch: Number(options.batch),
                firstOutputSecs: Number(options.firstOutput),
                consolidatedOnly: options.consolidatedOnly,
                tighten: options.tighten,
                out: options.out,
                json: options.json,
            });
        }
    );

program
    .command("self-review")
    .description("Instruct-stage: live Fable audits the spec (incl. growth control) while it is still served")
    .action(() => {
        const config = requireConfig();
        if (config) {
            selfReviewCommand(config);
        }
    });

program
    .command("hooks")
    .description("Instruct-stage: propose deterministic hooks from pack data")
    .action(() => {
        const config = requireConfig();
        if (config) {
            hooksCommand(config);
        }
    });

program
    .command("skill")
    .description("Instruct-stage: regenerate fable-style SKILL.md from the spec (line budget parameterized)")
    .option("--max-lines <n>", "Skill body line budget", "150")
    .option("--sync", "Copy canonical skill to ~/.claude/skills/fable-style/")
    .action(async (options: { maxLines: string; sync?: boolean }) => {
        const config = requireConfig();
        if (config) {
            await skillCommand(config, { maxLines: Number(options.maxLines), sync: options.sync });
        }
    });

program
    .command("pre-score")
    .description("Instruct-stage: guidance for ranking unmined sessions (implementation deferred)")
    .action(() => {
        const config = requireConfig();
        if (config) {
            preScoreCommand(config);
        }
    });

await runTool(program, { tool: "learn-from-fable" });
