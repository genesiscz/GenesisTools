import type { E2eProject, E2eRunnerConfig, E2eRunnerKind } from "@genesiscz/utils/e2e/project";
import type { SpecFile } from "../specs";

/** A command-line flag one runner reads; `run` and `suite` register every runner's flags. */
export interface RunnerFlag {
    flags: string;
    description: string;
}

/** Something a run saw beside the specs (a system alert the watcher answered), for the summary. */
export interface RunNote {
    at: string;
    source: string;
    text: string;
}

export interface PrepareInput<K extends E2eRunnerKind> {
    project: E2eProject;
    runner: E2eRunnerConfig<K>;
    /** The parsed command-line options; a runner reads only the flags it declared. */
    flags: Record<string, unknown>;
    runDir: string;
}

/** One prepared run on its target: a simulator with its Appium, or a site. */
export interface RunTarget {
    /** What the summary says about the target: the device, the ports, the site. */
    facts: Record<string, string>;
    /** The variables every spec process gets (`E2E_*` from `@genesiscz/utils/e2e/spec-env`). */
    environment: Record<string, string>;
    /** The runner process for one spec, started in the project's `cwd`; `specDir` is the spec's run folder. */
    command(spec: SpecFile, specDir: string): string[];
    /** Ends what the run started beside the specs and returns what it saw. */
    finish(): Promise<RunNote[]>;
}

/**
 * How one runner kind runs a project's specs. The run loop, the run folder and the summary are the tool's; a runner
 * prepares the target and names the process per spec. A new runner is one file and one `RUNNERS` entry.
 */
export interface E2eRunner<K extends E2eRunnerKind> {
    readonly kind: K;
    readonly title: string;
    readonly flags: RunnerFlag[];
    prepare(input: PrepareInput<K>): Promise<RunTarget>;
}

export function stringFlag(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function numberFlag(value: unknown): number | undefined {
    if (value === undefined) {
        return undefined;
    }

    const parsed = Number(stringFlag(value));

    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`expected a positive integer, received ${String(value)}`);
    }

    return parsed;
}
