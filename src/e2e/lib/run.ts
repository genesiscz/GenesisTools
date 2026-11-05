import { createHash } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { E2eHookContext, E2eProject } from "@genesiscz/utils/e2e/project";
import { E2E_ENV } from "@genesiscz/utils/e2e/spec-env";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { prepareRunner } from "./runners";
import type { RunNote, RunTarget } from "./runners/types";
import type { SpecFile } from "./specs";
import { countResults, formatSummary, type RunSummary, readResults, type SpecRun } from "./summary";

const log = logger.child({ component: "e2e.run" });

export const RESULTS_FILE = "results.jsonl";

async function runSpec(options: {
    command: string[];
    cwd: string;
    environment: Record<string, string | undefined>;
    logPath: string;
    onLine?: (line: string) => void;
}): Promise<number | null> {
    const fd = openSync(options.logPath, "a");
    const pump = (chunk: Uint8Array) => {
        appendFileSync(fd, chunk);

        for (const line of Buffer.from(chunk).toString("utf8").split("\n")) {
            if (line.trim()) {
                options.onLine?.(line);
            }
        }
    };

    try {
        const result = await boundedCommand({
            command: options.command,
            cwd: options.cwd,
            environment: options.environment,
            timeoutMs: 1_800_000,
            onStdout: pump,
            onStderr: pump,
        });
        return result.status ?? 1;
    } finally {
        closeSync(fd);
    }
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
    const { project } = options;
    const runDir = resolve(options.runDir);
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
            const dir = join(
                runDir,
                `${spec.name}-${createHash("sha256").update(spec.path).digest("hex").slice(0, 16)}`
            );
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
