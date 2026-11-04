import { spawn } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { E2eHookContext, E2eProject } from "@genesiscz/utils/e2e/project";
import { E2E_ENV } from "@genesiscz/utils/e2e/spec-env";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { prepareRunner } from "./runners";
import type { RunNote, RunTarget } from "./runners/types";
import type { SpecFile } from "./specs";
import { countResults, formatSummary, type RunSummary, readResults, type SpecRun } from "./summary";

const log = logger.child({ component: "e2e.run" });

export const RESULTS_FILE = "results.jsonl";

function runSpec(options: {
    command: string[];
    cwd: string;
    environment: Record<string, string | undefined>;
    logPath: string;
    onLine?: (line: string) => void;
}): Promise<number | null> {
    return new Promise((resolve) => {
        const fd = openSync(options.logPath, "a");
        const [file, ...args] = options.command;
        const child = spawn(file, args, {
            cwd: options.cwd,
            env: options.environment,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const pump = (chunk: Buffer) => {
            appendFileSync(fd, chunk);

            for (const line of chunk.toString("utf8").split("\n")) {
                if (line.trim()) {
                    options.onLine?.(line);
                }
            }
        };
        child.stdout.on("data", pump);
        child.stderr.on("data", pump);
        child.once("close", (code) => {
            closeSync(fd);
            resolve(code);
        });
        child.once("error", (error) => {
            appendFileSync(fd, `\n[tools e2e] spawn failed: ${error.message}\n`);
            log.error({ error, command: options.command.join(" ") }, "runner spawn failed");
        });
    });
}

/**
 * Runs spec files one runner process each against one prepared target and collects everything into `runDir`: per spec
 * `<spec>/runner.log`, `<spec>/results.jsonl` (the spec process's per-test lines) and whatever the runner writes into
 * its folder; for the run what the runner keeps beside the specs, `summary.json` and `summary.md`.
 */
export async function runE2e(options: {
    project: E2eProject;
    specs: SpecFile[];
    runDir: string;
    flags: Record<string, unknown>;
    /** `KEY=VALUE` variables for every spec process, after the tool's own. */
    extraEnv: Record<string, string>;
    onSpecStart?: (spec: SpecFile, index: number, total: number) => void;
    onSpecDone?: (run: SpecRun) => void;
    onLine?: (line: string) => void;
    /** Prepares the target; default the project's runner from `RUNNERS`. A test hands in its own. */
    prepare?: (input: { project: E2eProject; flags: Record<string, unknown>; runDir: string }) => Promise<RunTarget>;
}): Promise<RunSummary> {
    const { project, runDir } = options;
    const startedAt = new Date().toISOString();
    mkdirSync(runDir, { recursive: true });
    const prepare = options.prepare ?? ((input) => prepareRunner(project.config.runner, input));
    const target = await prepare({ project, flags: options.flags, runDir });
    const environment = { ...target.environment, [E2E_ENV.project]: project.config.id, ...options.extraEnv };
    const hookContext: E2eHookContext = { runDir, specs: options.specs.map((spec) => spec.file), environment };
    const specs: SpecRun[] = [];
    let notes: RunNote[] = [];

    try {
        await project.config.hooks?.beforeRun?.(hookContext);

        for (const [index, spec] of options.specs.entries()) {
            options.onSpecStart?.(spec, index, options.specs.length);
            const dir = join(runDir, spec.name);
            mkdirSync(dir, { recursive: true });
            const logPath = join(dir, "runner.log");
            const resultsFile = join(dir, RESULTS_FILE);
            const started = performance.now();
            const command = target.command(spec, dir);
            log.info({ spec: spec.path, dir, command: command.join(" ") }, "spec start");
            const exitCode = await runSpec({
                command,
                cwd: project.cwd,
                environment: {
                    ...env.getProcessEnv(),
                    ...environment,
                    [E2E_ENV.runDir]: dir,
                    [E2E_ENV.resultsFile]: resultsFile,
                    [E2E_ENV.spec]: spec.file,
                },
                logPath,
                onLine: options.onLine,
            });
            const run: SpecRun = {
                spec,
                dir,
                exitCode,
                seconds: Math.round((performance.now() - started) / 1000),
                log: logPath,
                tests: readResults(resultsFile),
            };
            specs.push(run);
            log.info({ spec: spec.path, exitCode, tests: run.tests.length }, "spec done");
            options.onSpecDone?.(run);
        }
    } finally {
        notes = await target.finish();
    }

    const counts = countResults(specs);
    const summary: RunSummary = {
        project: project.config.id,
        runner: project.config.runner.kind,
        runDir,
        startedAt,
        finishedAt: new Date().toISOString(),
        facts: target.facts,
        specs,
        counts,
        notes,
        ok: counts.specsFailed === 0 && specs.length > 0,
    };
    writeFileSync(join(runDir, "summary.json"), SafeJSON.stringify(summary, null, 2));
    writeFileSync(join(runDir, "summary.md"), formatSummary(summary));
    await project.config.hooks?.afterRun?.({ ...hookContext, ok: summary.ok });
    return summary;
}
