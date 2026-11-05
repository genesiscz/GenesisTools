import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import type { E2eProject } from "@genesiscz/utils/e2e/project";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { newRunDir } from "../lib/paths";
import { loadProject, type ProjectOptions, parseEnvPairs, withConfig } from "../lib/project";
import { runE2e } from "../lib/run";
import { runnerFlags } from "../lib/runners";
import { listSpecs, resolveSpecs, type SpecFile, suiteSpecs } from "../lib/specs";
import { specFailed } from "../lib/summary";

interface RunOptions extends ProjectOptions {
    env?: string[];
    out?: string;
    stream?: boolean;
    json?: boolean;
    [flag: string]: unknown;
}

function runOptions(command: Command): Command {
    let withFlags = withConfig(command)
        .option("--env <pair>", "repeat KEY=VALUE for each variable", (value: string, previous: string[] = []) => [
            ...previous,
            value,
        ])
        .option("--out <dir>", "the run folder (default ~/.genesis-tools/e2e/runs/<project>/<time>)")
        .option("--stream", "print the runner's output while it runs")
        .option("--json", "print the summary as JSON");

    for (const flag of runnerFlags()) {
        withFlags = withFlags.option(flag.flags, flag.description);
    }

    return withFlags;
}

async function run(pick: (project: E2eProject, all: SpecFile[]) => SpecFile[], options: RunOptions): Promise<void> {
    const project = await loadProject(options);
    const specs = pick(project, listSpecs(project));
    const runDir = options.out ?? newRunDir(project.config.id);

    if (!options.json) {
        ui.info(`${specs.length} spec(s) of ${project.config.id} (${project.config.runner.kind}) · ${runDir}`);
    }

    const summary = await runE2e({
        project,
        specs,
        runDir,
        flags: options,
        extraEnv: parseEnvPairs(options.env),
        onSpecStart: options.json ? undefined : (spec, index, total) => ui.info(`${index + 1}/${total} ${spec.name}`),
        onSpecDone: options.json
            ? undefined
            : (spec) => {
                  const passed = spec.tests.filter((test) => test.state === "passed").length;
                  const line = `${spec.spec.name}: ${passed}/${spec.tests.length} passed in ${spec.seconds} s`;
                  specFailed(spec) ? ui.err(`${line} (exit ${spec.exitCode}, log ${spec.log})`) : ui.ok(line);

                  for (const test of spec.tests.filter((candidate) => candidate.state === "failed")) {
                      ui.dim(`  ✗ ${test.title}: ${(test.error ?? "").split("\n")[0]}`);
                  }
              },
        onLine: options.stream && !options.json ? (line) => ui.dim(line) : undefined,
    });

    if (options.json) {
        out.result(summary);
    } else {
        const { counts } = summary;
        const line = `${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped · ${summary.notes.length} note(s)`;
        summary.ok ? ui.ok(line) : ui.err(line);
        ui.dim(`summary: ${runDir}/summary.md · ${toolCommand("e2e report", runDir)}`);
    }

    if (!summary.ok) {
        process.exitCode = 1;
    }
}

export function registerRun(program: Command): void {
    runOptions(
        program
            .command("run <specs...>")
            .description("Run these spec files (a name, a path, or a word in the name), one runner process each")
    ).action((names: string[], options: RunOptions) => run((_project, all) => resolveSpecs(all, names), options));

    runOptions(
        program
            .command("suite [name]")
            .description(`Run a named suite, or all of them (list them: ${toolCommand("e2e list")})`)
    ).action((name: string | undefined, options: RunOptions) =>
        run((project, all) => suiteSpecs(project, all, name ?? "all"), options)
    );
}
