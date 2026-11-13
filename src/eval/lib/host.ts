import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createEvalCommand, type EvalIo, type EvalProject } from "@genesiscz/utils/eval-engine";
import { SafeJSON } from "@genesiscz/utils/json";
import { Command } from "commander";
import { z } from "zod";

const Callable = z.custom<(...args: unknown[]) => unknown>((value) => typeof value === "function");
const ProjectShape = z.object({
    system: z.object({
        name: z.string().min(1),
        tools: z.array(z.string()),
        setup: z.instanceof(z.ZodType),
        signals: z.instanceof(z.ZodType).refine((schema) => "shape" in schema),
        signalsVersion: z.number().int().positive(),
        resolveSetup: Callable,
        connect: Callable,
    }),
    scenarios: z.union([z.array(z.unknown()), z.object({ dir: z.union([z.string(), z.instanceof(URL)]) })]),
    matrices: z.array(z.unknown()),
    harness: z.object({ judge: z.string().optional(), simulator: z.string().optional() }).optional(),
    always: z.array(z.unknown()).optional(),
    runsDir: z.string().optional(),
    concurrency: z.number().int().positive().optional(),
    maxAttempts: z.number().int().positive().optional(),
});

function isEvalProject(value: unknown): value is EvalProject {
    return ProjectShape.safeParse(value).success;
}

/** Imports exactly the trusted local module selected by the caller. Importing executes its code. */
export async function loadEvalProject(modulePath: string): Promise<EvalProject> {
    if (/^[a-z][a-z\d+.-]*:/i.test(modulePath) && !/^[a-z]:[/\\]/i.test(modulePath)) {
        throw new Error("--project must name a local file, not a URL");
    }

    const file = resolve(modulePath);
    if (!/\.(?:[cm]?[jt]s)$/.test(file) || !(await stat(file)).isFile()) {
        throw new Error("--project must name a trusted local TypeScript or JavaScript module");
    }

    const exported: unknown = await import(pathToFileURL(file).href);
    if (
        typeof exported !== "object" ||
        exported === null ||
        !("project" in exported) ||
        !isEvalProject(exported.project)
    ) {
        throw new Error("--project module must export a named project created with defineEvalProject");
    }

    return exported.project;
}

class EvalHostCommand extends Command {
    constructor(private readonly io: EvalIo) {
        super("eval");
    }

    override error(message: string): never {
        this.io.stdout(`${SafeJSON.stringify({ schema: "eval-error/1", error: "bad-option", message, issues: [] })}\n`);
        this.io.setExitCode(2);
        return this.io.exit(2);
    }
}

export function createEvalHost(io: EvalIo): Command {
    const program = new EvalHostCommand(io)
        .description("Run a trusted project's scenario evaluations. Put --project before the eval command.")
        .option("--project <module>", "trusted local module exporting a named EvalProject as project")
        .argument("[eval-args...]", "run, check, list, show, compare, runs, say or cleanup and their options")
        .enablePositionalOptions()
        .passThroughOptions()
        .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
        .exitOverride((error) => io.exit(error.exitCode));

    program.action(async (args: string[], options: { project?: string }) => {
        let project: EvalProject;
        try {
            if (!options.project) {
                throw new Error("--project <trusted-local-module> is required before the eval command");
            }

            project = await loadEvalProject(options.project);
        } catch (error) {
            io.stdout(
                `${SafeJSON.stringify({
                    schema: "eval-error/1",
                    error: "bad-option",
                    message: error instanceof Error ? error.message : String(error),
                    issues: [],
                })}\n`
            );
            io.setExitCode(2);
            return;
        }

        const command = createEvalCommand(project, { io });
        command.configureOutput({ writeOut: io.stdout, writeErr: io.stderr });
        await command.parseAsync(args.length ? args : ["--help"], { from: "user" });
    });

    return program;
}
