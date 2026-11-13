// Copied from /Users/Martin/Tresors/Projects/Kalendora/src/eval-engine/cli.ts at 2026-11-12T06:18:59+01:00 at commit hash 2b9937db296fcb22d402376689d926a71fe9f165
/**
 * The command line every project gets: `run`, `say`, `check`, `list`, `runs`, `show`, `compare`, `cleanup`.
 * Every command prints exactly one JSON document on stdout (`show --text` prints text) and sets the exit code;
 * progress goes to stderr only with `--progress`.
 */
import { writeSync } from "node:fs";
import { Command, InvalidArgumentError } from "commander";
import { z } from "zod";
import { EvalConfigError, type MatrixDoc, type Scenario } from "./document";
import { selectScenarios } from "./plan";
import {
    checkEval,
    cleanupEval,
    type EvalProject,
    findMatrix,
    listEval,
    loadScenarios,
    parseAdHocScenarios,
    runEval,
    runsDirOf,
    sayEval,
    selectProjectScenarios,
} from "./project";
import { compareEvalRuns, ExitCode, renderEvalTranscript, summarizeRun } from "./report";
import { type Clock, type ProgressEvent, SystemClock } from "./schedule";
import { listRuns, loadRun, readConversation } from "./store";
import { EvalSystemError } from "./system";

/** Where the command reads and writes. Tests replace it; the default is the process. */
export interface EvalIo {
    stdout(text: string): void;
    stderr(text: string): void;
    readStdin(): Promise<string>;
    setExitCode(code: number): void;
    /** Ends the process at once. Used only after a flag error, where commander cannot continue. */
    exit(code: number): never;
    clock: Clock;
    /** Aborts a run. Default: Ctrl-C. */
    signal?: AbortSignal;
}

const ProcessIo: EvalIo = {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    readStdin: async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
            chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        }
        return Buffer.concat(chunks).toString("utf8");
    },
    setExitCode: (code) => {
        process.exitCode = code;
    },
    exit: (code) => process.exit(code),
    clock: SystemClock,
};

/** A flag error: commander cannot continue, so the JSON goes out synchronously and the process ends with 2. */
function flagErrorIo(io: EvalIo): EvalIo {
    if (io.stdout !== ProcessIo.stdout) {
        return io;
    }
    return { ...io, stdout: (text) => void writeSync(1, text) };
}

/** A commander `Command` whose parse errors print `eval-error/1` and exit with 2. */
class EvalCommand extends Command {
    private readonly onError: (message: string) => never;

    constructor(name: string | undefined, onError: (message: string) => never) {
        super(name);
        this.onError = onError;
    }

    override error(message: string): never {
        return this.onError(message.replace(/^error: /, ""));
    }

    override createCommand(name?: string): EvalCommand {
        return new EvalCommand(name, this.onError);
    }
}

function positiveInt(value: string): number {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) {
        throw new InvalidArgumentError("expected a whole number of at least 1");
    }
    return n;
}

function positiveNumber(value: string): number {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
        throw new InvalidArgumentError("expected a number above 0");
    }
    return n;
}

const RunOptions = z.object({
    matrix: z.string().optional(),
    tag: z.array(z.string()).optional(),
    model: z.array(z.string()).optional(),
    variant: z.array(z.string()).optional(),
    repeats: z.number().optional(),
    stdin: z.boolean().optional(),
    resume: z.string().optional(),
    concurrency: z.number().optional(),
    maxCostUsd: z.number().optional(),
    target: z.string().optional(),
    label: z.string().optional(),
    allCells: z.boolean().optional(),
    keepGoing: z.boolean().optional(),
    failures: z.number().optional(),
    progress: z.boolean().optional(),
});
const SayOptions = z.object({
    model: z.string(),
    variant: z.string().optional(),
    repeats: z.number().optional(),
    setup: z.string().optional(),
    target: z.string().optional(),
    concurrency: z.number().optional(),
});
const CheckOptions = z.object({
    print: z.boolean().optional(),
    stdin: z.boolean().optional(),
    matrix: z.string().optional(),
    tag: z.array(z.string()).optional(),
});
const ListOptions = z.object({ live: z.boolean().optional(), target: z.string().optional() });
const RunsOptions = z.object({ limit: z.number().optional() });
const ShowOptions = z.object({
    text: z.boolean().optional(),
    allCells: z.boolean().optional(),
    failures: z.number().optional(),
});
const CompareOptions = z.object({ last: z.number().optional() });
const CleanupOptions = z.object({ run: z.string().optional(), target: z.string().optional() });

function options<T>(schema: z.ZodType<T>, raw: unknown): T {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
        throw new EvalConfigError(
            "bad-option",
            parsed.error.issues.map((i) => `--${i.path.join(".")}: ${i.message}`).join("; ")
        );
    }
    return parsed.data;
}

const StringList = z.array(z.string());

function parseEvalOptionJson(text: string, what: string): unknown {
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new EvalConfigError(
            "bad-option",
            `${what} is not JSON: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

function byTags(scenarios: Scenario[], tags: string[] | undefined): Scenario[] {
    if (!tags?.length) {
        return scenarios;
    }
    const chosen = selectScenarios({ tags }, scenarios);
    if (!chosen.length) {
        throw new EvalConfigError("unknown-scenario", `no scenario has the tag ${tags.join(" or ")}`);
    }
    return chosen;
}

function progressLine(event: ProgressEvent): string {
    return `${JSON.stringify(event)}\n`;
}

/**
 * The command a project mounts (`kalendora eval …`). Commander, with every subcommand printing one JSON document.
 * `io` replaces the process (stdout, stdin, exit code, clock) in tests.
 */
export function createEvalCommand<TSetup, TSignals, TTool extends string, THandle, TResolved>(
    project: EvalProject<TSetup, TSignals, TTool, THandle, TResolved>,
    settings: { name?: string; description?: string; io?: Partial<EvalIo> } = {}
): Command {
    const io: EvalIo = { ...ProcessIo, ...settings.io };
    const print = (document: unknown) => io.stdout(`${JSON.stringify(document, null, 2)}\n`);
    const onError = (message: string): never => {
        const errorIo = flagErrorIo(io);
        errorIo.stdout(
            `${JSON.stringify({ schema: "eval-error/1", error: "bad-option", message, issues: [] }, null, 2)}\n`
        );
        errorIo.setExitCode(ExitCode.Usage);
        return errorIo.exit(ExitCode.Usage);
    };
    const runsDir = runsDirOf(project);

    /** Runs one command: prints its document and sets its exit code, or prints `eval-error/1`. */
    const act = async (body: () => Promise<{ document: unknown; exitCode: number } | { text: string }>) => {
        try {
            const result = await body();
            if ("text" in result) {
                io.stdout(result.text);
                io.setExitCode(ExitCode.Passed);
            } else {
                print(result.document);
                io.setExitCode(result.exitCode);
            }
        } catch (error) {
            if (error instanceof EvalConfigError) {
                print({ schema: "eval-error/1", error: error.code, message: error.message, issues: error.issues });
                io.setExitCode(ExitCode.Usage);
            } else if (error instanceof EvalSystemError) {
                print({
                    schema: "eval-error/1",
                    error: "system-unavailable",
                    kind: error.kind,
                    message: error.message,
                    issues: [],
                });
                io.setExitCode(ExitCode.NoVerdict);
            } else {
                print({
                    schema: "eval-error/1",
                    error: "internal",
                    message: error instanceof Error ? (error.stack ?? error.message) : String(error),
                    issues: [],
                });
                io.setExitCode(ExitCode.NoVerdict);
            }
        }
    };

    /** Ctrl-C aborts a run: the conversations in flight are discarded, and `--resume` plays them later. */
    const withSignal = async <T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => {
        if (io.signal) {
            return task(io.signal);
        }
        const controller = new AbortController();
        const onInterrupt = () => controller.abort();
        process.on("SIGINT", onInterrupt);
        try {
            return await task(controller.signal);
        } finally {
            process.off("SIGINT", onInterrupt);
        }
    };

    const command = new EvalCommand(settings.name ?? "eval", onError)
        .description(
            settings.description ??
                `AI evals of ${project.system.name}: scenario conversations, verdicts and transcripts`
        )
        .showHelpAfterError(false);

    command
        .command("run")
        .description(
            "Play scenarios on models and prompt variants, check every answer, write a run folder; prints eval-run/1"
        )
        .argument("[scenarios...]", "scenario ids (default with --matrix: the matrix's scenarios)")
        .option("--matrix <id>", "a matrix of the project: its scenarios, models, variants, repeats and thresholds")
        .option("--tag <tag...>", "only scenarios with one of these tags")
        .option("--model <id...>", "models to run on (overrides the matrix's)")
        .option("--variant <name...>", "prompt variants (default: the matrix's, else the system's first)")
        .option("--repeats <n>", "conversations per cell (default: the matrix's, else 1)", positiveInt)
        .option("--stdin", "read one scenario or an array of scenarios as JSON from stdin")
        .option(
            "--resume <run>",
            "continue a run: play only the conversations that have no result, with the stored plan"
        )
        .option("--concurrency <n>", "conversations open at once (default: the project's)", positiveInt)
        .option("--max-cost-usd <usd>", "open no new conversation once the finished ones cost more", positiveNumber)
        .option("--target <target>", "which deployment of the system (the project gives it meaning)")
        .option("--label <label>", "the label in the run id")
        .option("--all-cells", "print every cell, not only those that did not pass")
        .option("--keep-going", "play every step after a gate or safety failure")
        .option("--failures <n>", "how many failure lines to print (default 5)", positiveInt)
        .option("--progress", "write progress events to stderr as JSON lines")
        .action((ids: unknown, raw: unknown) =>
            act(async () => {
                const opts = options(RunOptions, raw);
                const scenarioIds = StringList.parse(ids);
                const runOptions = {
                    concurrency: opts.concurrency,
                    keepGoing: opts.keepGoing,
                    allCells: opts.allCells,
                    maxFailures: opts.failures,
                    clock: io.clock,
                    onProgress: opts.progress ? (event: ProgressEvent) => io.stderr(progressLine(event)) : undefined,
                    argv: process.argv.slice(2),
                };
                if (opts.resume) {
                    if (
                        scenarioIds.length ||
                        opts.matrix ||
                        opts.stdin ||
                        opts.tag ||
                        opts.model ||
                        opts.variant ||
                        opts.repeats ||
                        opts.label ||
                        opts.target
                    ) {
                        throw new EvalConfigError(
                            "bad-option",
                            "--resume takes the stored plan; only --concurrency, --max-cost-usd, --keep-going, --all-cells, --failures and --progress may stand beside it"
                        );
                    }
                    const summary = await withSignal((signal) =>
                        runEval(
                            project,
                            { resume: opts.resume, maxCostUsd: opts.maxCostUsd },
                            { ...runOptions, signal }
                        )
                    );
                    return { document: summary, exitCode: summary.exitCode };
                }
                const matrix: MatrixDoc | undefined = opts.matrix ? findMatrix(project, opts.matrix) : undefined;
                let scenarios: Scenario[];
                if (opts.stdin) {
                    if (scenarioIds.length) {
                        throw new EvalConfigError(
                            "bad-option",
                            "--stdin takes its scenarios from stdin; do not name ids too"
                        );
                    }
                    scenarios = parseAdHocScenarios(
                        project,
                        parseEvalOptionJson(await io.readStdin(), "stdin"),
                        "stdin"
                    );
                } else if (!scenarioIds.length && !matrix && opts.tag?.length) {
                    scenarios = await loadScenarios(project);
                } else {
                    scenarios = await selectProjectScenarios(project, { ids: scenarioIds, matrix });
                }
                scenarios = byTags(scenarios, opts.tag);
                const models = opts.model ?? matrix?.models;
                if (!models?.length) {
                    throw new EvalConfigError("bad-option", "name a model with --model, or a matrix with --matrix");
                }
                const summary = await withSignal((signal) =>
                    runEval(
                        project,
                        {
                            scenarios,
                            models,
                            variants: opts.variant ?? matrix?.variants,
                            repeats: opts.repeats ?? matrix?.repeats ?? 1,
                            passRate: matrix?.passRate,
                            maxErrorRate: matrix?.maxErrorRate,
                            maxCostUsd: opts.maxCostUsd ?? matrix?.maxCostUsd ?? null,
                            label: opts.label ?? matrix?.id ?? (scenarios.length === 1 ? scenarios[0].doc.id : "adhoc"),
                            target: opts.target,
                        },
                        { ...runOptions, signal }
                    )
                );
                return { document: summary, exitCode: summary.exitCode };
            })
        );

    command
        .command("say")
        .description("Send one user turn (several: a scripted conversation) with no expectations; prints eval-say/1")
        .argument("<text...>", "the user's messages, one argument per turn")
        .requiredOption("--model <id>", "the model to talk to")
        .option("--variant <name>", "the prompt variant (default: the system's first)")
        .option("--repeats <n>", "how many conversations", positiveInt)
        .option("--setup <json>", "the scenario setup as JSON (default: the setup schema's defaults)")
        .option("--target <target>", "which deployment of the system")
        .option("--concurrency <n>", "conversations open at once", positiveInt)
        .action((texts: unknown, raw: unknown) =>
            act(async () => {
                const opts = options(SayOptions, raw);
                const result = await withSignal((signal) =>
                    sayEval(
                        project,
                        {
                            texts: StringList.parse(texts),
                            model: opts.model,
                            variant: opts.variant,
                            repeats: opts.repeats,
                            setup: opts.setup === undefined ? undefined : parseEvalOptionJson(opts.setup, "--setup"),
                            target: opts.target,
                        },
                        { concurrency: opts.concurrency, signal, clock: io.clock }
                    )
                );
                return { document: result, exitCode: result.exitCode };
            })
        );

    command
        .command("check")
        .description("Validate scenarios and print them with their hashes; contacts nothing; prints eval-check/1")
        .argument("[scenarios...]", "scenario ids (default: every scenario)")
        .option("--print", "include each scenario's full document")
        .option("--stdin", "check one scenario or an array of scenarios from stdin")
        .option("--matrix <id>", "also plan the matrix and print its size")
        .option("--tag <tag...>", "only scenarios with one of these tags")
        .action((ids: unknown, raw: unknown) =>
            act(async () => {
                const opts = options(CheckOptions, raw);
                const scenarioIds = StringList.parse(ids);
                const matrix = opts.matrix ? findMatrix(project, opts.matrix) : undefined;
                const scenarios = opts.stdin
                    ? parseAdHocScenarios(project, parseEvalOptionJson(await io.readStdin(), "stdin"), "stdin")
                    : scenarioIds.length || matrix
                      ? await selectProjectScenarios(project, { ids: scenarioIds, matrix })
                      : await loadScenarios(project);
                return {
                    document: checkEval(project, byTags(scenarios, opts.tag), {
                        print: opts.print,
                        matrix,
                        now: new Date(io.clock.now()),
                    }),
                    exitCode: ExitCode.Passed,
                };
            })
        );

    command
        .command("list")
        .description("List the project's scenarios and matrices; prints eval-list/1")
        .option("--live", "also ask the running system for its models and prompt variants")
        .option("--target <target>", "which deployment of the system, with --live")
        .action((raw: unknown) =>
            act(async () => {
                const opts = options(ListOptions, raw);
                return {
                    document: await listEval(project, { live: opts.live, target: opts.target, signal: io.signal }),
                    exitCode: ExitCode.Passed,
                };
            })
        );

    command
        .command("runs")
        .description("List run folders, newest first, with their verdicts; prints eval-runs/1")
        .option("--limit <n>", "how many runs (default 20)", positiveInt)
        .action((raw: unknown) =>
            act(async () => {
                const opts = options(RunsOptions, raw);
                const ids = (await listRuns(runsDir)).slice(0, opts.limit ?? 20);
                const runs = [];
                for (const id of ids) {
                    const view = await loadRun(id, runsDir);
                    const summary = summarizeRun(view);
                    runs.push({
                        run: id,
                        createdAt: view.manifest.createdAt,
                        label: view.manifest.label,
                        verdict: summary.verdict,
                        exitCode: summary.exitCode,
                        ...summary.totals,
                    });
                }
                return { document: { schema: "eval-runs/1", runsDir, runs }, exitCode: ExitCode.Passed };
            })
        );

    command
        .command("show")
        .description("A run's summary (eval-run/1, folded from its records), or one transcript (eval-conversation/1)")
        .argument("<run>", "a run id or folder")
        .argument("[conversation]", "a conversation key")
        .option("--text", "print the transcript as text for a person")
        .option("--all-cells", "print every cell")
        .option("--failures <n>", "how many failure lines to print", positiveInt)
        .action((run: unknown, conversation: unknown, raw: unknown) =>
            act(async () => {
                const opts = options(ShowOptions, raw);
                const view = await loadRun(z.string().parse(run), runsDir);
                const key = z.string().optional().parse(conversation);
                if (key) {
                    const record = await readConversation(view, key);
                    return opts.text
                        ? { text: renderEvalTranscript(record) }
                        : { document: record, exitCode: ExitCode.Passed };
                }
                if (opts.text) {
                    throw new EvalConfigError("bad-option", "--text needs a conversation key");
                }
                return {
                    document: summarizeRun(view, { allCells: opts.allCells, maxFailures: opts.failures }),
                    exitCode: ExitCode.Passed,
                };
            })
        );

    command
        .command("compare")
        .description(
            "Compare two runs per scenario and cell; prints eval-compare/1 (exit 1: a cell regressed, 3: a new safety miss)"
        )
        .argument("[a]", "the earlier run")
        .argument("[b]", "the later run")
        .option("--last <n>", "compare the last two runs (only 2 is allowed)", positiveInt)
        .action((a: unknown, b: unknown, raw: unknown) =>
            act(async () => {
                const opts = options(CompareOptions, raw);
                let pair: [string, string];
                const first = z.string().optional().parse(a);
                const second = z.string().optional().parse(b);
                if (opts.last !== undefined) {
                    if (opts.last !== 2 || first || second) {
                        throw new EvalConfigError("bad-option", "use --last 2 alone, or name two runs");
                    }
                    const [newest, previous] = await listRuns(runsDir);
                    if (!newest || !previous) {
                        throw new EvalConfigError("unknown-run", `fewer than two runs in ${runsDir}`);
                    }
                    pair = [previous, newest];
                } else {
                    if (!first || !second) {
                        throw new EvalConfigError("bad-option", "name two runs, or use --last 2");
                    }
                    pair = [first, second];
                }
                const comparison = compareEvalRuns(await loadRun(pair[0], runsDir), await loadRun(pair[1], runsDir));
                return { document: comparison, exitCode: comparison.exitCode };
            })
        );

    command
        .command("cleanup")
        .description("Ask the system to remove what eval runs left behind (all runs, or one); prints eval-cleanup/1")
        .option("--run <id>", "only what this run created")
        .option("--target <target>", "which deployment of the system")
        .action((raw: unknown) =>
            act(async () => {
                const opts = options(CleanupOptions, raw);
                const result = await withSignal((signal) =>
                    cleanupEval(project, { runId: opts.run, target: opts.target, signal })
                );
                return { document: result, exitCode: ExitCode.Passed };
            })
        );

    for (const child of [command, ...command.commands]) {
        child.configureOutput({ writeOut: io.stdout, writeErr: io.stderr });
        child.exitOverride((error) => io.exit(error.exitCode));
    }
    return command;
}
