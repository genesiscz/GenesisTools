import type { E2eRunnerConfig, E2eRunnerKind } from "@genesiscz/utils/e2e/project";
import { playwrightRunner } from "./playwright";
import type { E2eRunner, PrepareInput, RunnerFlag, RunTarget } from "./types";
import { wdioRunner } from "./wdio";

/** One runner per kind a project can name; a missing entry is a compile error. */
export const RUNNERS: { [K in E2eRunnerKind]: E2eRunner<K> } = {
    wdio: wdioRunner,
    playwright: playwrightRunner,
};

/** Prepares the run for the project's runner, whichever kind it names. */
export function prepareRunner<K extends E2eRunnerKind>(
    runner: E2eRunnerConfig<K>,
    input: Omit<PrepareInput<K>, "runner">
): Promise<RunTarget> {
    const implementation: E2eRunner<K> = RUNNERS[runner.kind];
    return implementation.prepare({ ...input, runner });
}

/** Every runner's flags, each once, for the commands that run specs. */
export function runnerFlags(): RunnerFlag[] {
    const all = Object.values(RUNNERS).flatMap((runner) => runner.flags);
    return [...new Map(all.map((flag) => [flag.flags, flag])).values()];
}
