import { ui } from "@genesiscz/utils/cli/ui";
import type { Command } from "commander";
import { failPlain, printResult, withSigint } from "../lib/cli-output";
import { recordReel } from "../lib/demo/record";
import {
    DEMO_NAMES,
    type DemoTrace,
    parseDemoName,
    type ReelResult,
    refuseUserMail,
    runDemo,
    runReel,
    writeReelSummary,
} from "../lib/demo/reel";
import { compactResult } from "../lib/output-shape";

interface DemoOptions {
    app?: string;
    iMeanIt?: boolean;
    record?: boolean;
    dir?: string;
    json?: boolean;
}

function printChapterLines(chapters: DemoTrace[]): void {
    for (const chapter of chapters) {
        const line = `${chapter.demo}: ${chapter.reason} (${chapter.requests} fixture Jev requests)`;
        if (chapter.ok) {
            ui.ok(line);
            continue;
        }

        ui.err(line);
    }
}

async function record(options: DemoOptions, dir: string | undefined): Promise<string | undefined> {
    if (options.record !== true) {
        return undefined;
    }

    const outcome = await recordReel({ dir: dir ?? "/tmp" });
    if (outcome.ok) {
        ui.ok(`recorded to ${outcome.record}`);
    } else {
        ui.warn(outcome.record);
    }

    return outcome.record;
}

/**
 * `control demo reel --dir X` puts `--dir` on the PARENT: commander strips every option the parent
 * declares before it dispatches, so `reel`'s own `opts()` is empty and the run silently wrote no
 * artifact. Reading the parent too makes the flag work on either side of the subcommand name.
 */
function mergedOptions(command: Command): DemoOptions {
    const parent = command.parent?.opts() ?? {};
    return { ...parent, ...command.opts() };
}

async function reelAction(_flags: DemoOptions, command: Command): Promise<void> {
    const options = mergedOptions(command);
    try {
        refuseUserMail(options.app, options.iMeanIt === true);
    } catch (error) {
        failPlain(error, { command: "demo reel" });
        return;
    }

    try {
        const result: ReelResult = await withSigint((signal) =>
            runReel({ signal, ...(options.dir ? { dir: options.dir } : {}) })
        );
        const recorded = await record(options, options.dir);
        const payload: ReelResult = { ...result, ...(recorded ? { record: recorded } : {}) };
        if (options.dir) {
            await writeReelSummary(options.dir, payload);
        }

        printChapterLines(payload.chapters);
        printResult(compactResult(payload, { verbose: options.json === true }));
        if (!payload.ok) {
            process.exitCode = 1;
        }
    } catch (error) {
        failPlain(error, { command: "demo reel" });
    }
}

async function chapterAction(name: string, _flags: DemoOptions, command: Command): Promise<void> {
    const options = mergedOptions(command);
    try {
        refuseUserMail(options.app, options.iMeanIt === true);
        const demo = parseDemoName(name);
        const trace = await withSigint((signal) =>
            runDemo(demo, { signal, ...(options.dir ? { dir: options.dir } : {}) })
        );
        const recorded = await record(options, options.dir);
        printChapterLines([trace]);
        printResult(
            compactResult({ ...trace, ...(recorded ? { record: recorded } : {}) }, { verbose: options.json === true })
        );
        if (!trace.ok) {
            process.exitCode = 1;
        }
    } catch (error) {
        failPlain(error, { command: "demo", demo: name });
    }
}

function demoOptions(command: Command): Command {
    return command
        .option("--app <name>", "Rejected unless the AppKit fixture or --i-mean-it")
        .option("--i-mean-it", "Break-glass to name a real app")
        .option("--record", "Record the run with tools control capture when macOS allows it")
        .option("--dir <dir>", "Write one JSON artifact per chapter into this directory")
        .option("--json", "Keep the full evaluation payloads in the result");
}

/**
 * Two doors onto the same lib: `jev demo reel` and `jev control demo [chapter]`.
 *
 * The top-level `demo` command already belongs to `commands/evaluate.ts`, where it spends a real
 * paid Jev call on the sample input, so only the `reel` subcommand is added there and its action
 * handler is left alone. The chapter argument lives under `control demo`, which this file owns.
 */
function attachReel(demo: Command): void {
    demoOptions(
        demo.command("reel").description("Run every chapter; green only when every chapter's own readback confirmed")
    ).action(reelAction);
}

export function registerDemoReel(program: Command): void {
    const evaluationDemo =
        program.commands.find((command) => command.name() === "demo") ??
        program.command("demo").description("Fixture demo chapters; every chapter runs its real lib function");
    attachReel(evaluationDemo);

    const control =
        program.commands.find((command) => command.name() === "control") ??
        program.command("control").description("All macOS control commands using this Jev checkout");
    const demo = control
        .command("demo")
        .description("Fixture demo chapters; every chapter runs its real lib function")
        .argument("[chapter]", `Chapter: ${DEMO_NAMES.join("|")}`, "route");
    demoOptions(demo).action(chapterAction);
    attachReel(demo);
}
