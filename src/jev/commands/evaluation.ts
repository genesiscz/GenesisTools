import { readFileSync } from "node:fs";
import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { suggestCommand } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { failPlain, withSigint } from "../lib/cli-output";
import {
    createPayload,
    createProgramStore,
    type Effect,
    languageGuide,
    type Run,
    readBundledExample,
} from "../lib/probably";
import { resolveProbablyInput, runStoredProgram } from "../lib/probably/run-program";

interface RunOptions {
    input?: string;
    replay?: string;
    save?: string;
    model?: string;
    json?: boolean;
}

function store() {
    return createProgramStore();
}

export function registerProbablyEvaluation(program: Command): void {
    const evaluation = program
        .command("evaluation")
        .aliases(["probably", "prob"])
        .description("Probably Lang lab: store and run .prob programs (Jev + chat)");

    evaluation
        .command("create")
        .description("Print the language guide and corpus; optionally save a named program")
        .option("--name <id>", "Save a program under this name")
        .option("--from <file>", "Source file to save (with --name); or a bundled example id")
        .option("--bundle <example>", "Seed from a bundled example (hello, inbox, urgent, …)")
        .option("--json", "Machine-readable guide + corpus")
        .action(async (options: { name?: string; from?: string; bundle?: string; json?: boolean }) => {
            try {
                await createAction(options);
            } catch (error) {
                failPlain(error, { command: "jev evaluation create" });
            }
        });

    evaluation
        .command("list")
        .description("List stored Probably programs")
        .option("--json", "Machine-readable list")
        .action(async (options: { json?: boolean }) => {
            try {
                const programs = store().list();

                if (options.json) {
                    out.result({ programs, rootDir: store().rootDir });
                    return;
                }

                renderCliHeader("Probably programs", store().rootDir);
                const table = createBoxTable(["NAME", "UPDATED"]);

                for (const program of programs) {
                    table.push([pc.white(program.name), truncateDisplay(program.updatedAt, 28)]);
                }

                if (programs.length === 0) {
                    ui.info(
                        suggestCommand("tools jev evaluation create", {
                            add: ["--name", "hello", "--bundle", "hello"],
                        })
                    );
                } else {
                    out.println(table.toString());
                }
            } catch (error) {
                failPlain(error, { command: "jev evaluation list" });
            }
        });

    evaluation
        .command("show")
        .description("Print a stored program's source")
        .argument("<name>", "Stored program name")
        .option("--json", "Include path and metadata")
        .action(async (name: string, options: { json?: boolean }) => {
            try {
                const program = store().get(name);

                if (options.json) {
                    out.result(program);
                    return;
                }

                out.print(program.source);
            } catch (error) {
                failPlain(error, { command: "jev evaluation show" });
            }
        });

    evaluation
        .command("rm")
        .aliases(["remove", "delete"])
        .description("Delete a stored program")
        .argument("<name>", "Stored program name")
        .action(async (name: string) => {
            try {
                store().remove(name);
                ui.ok(`Removed ${name}`);
            } catch (error) {
                failPlain(error, { command: "jev evaluation rm" });
            }
        });

    evaluation
        .command("run")
        .description("Run a stored Probably program")
        .argument("<name>", "Stored program name")
        .option(
            "--input <value>",
            'Literal text, @path, - for stdin, JSON {"input":"…"}, or a path containing / or ending .json/.jsonc/.txt'
        )
        .option("--replay <file>", "Replay a saved recording (no live model calls)")
        .option("--save <file>", "Write the Run recording (source, input, tape, output, trace)")
        .option("--model <ref>", "Override the chat model for llm/write")
        .option("--json", "Emit the full Run object on stdout (default)")
        .action(async (name: string, options: RunOptions) => {
            try {
                await withSigint(async (signal) => runAction(name, options, program, signal));
            } catch (error) {
                failPlain(error, { command: "jev evaluation run" });
            }
        });
}

async function createAction(options: { name?: string; from?: string; bundle?: string; json?: boolean }): Promise<void> {
    if (options.name) {
        let source: string;

        if (options.from) {
            source = readFileSync(options.from, "utf8");
        } else if (options.bundle) {
            source = readBundledExample(options.bundle);
        } else {
            source = readBundledExample("hello");
            ui.info("No --from/--bundle; seeded from bundled hello.prob");
        }

        const saved = store().save(options.name, source);
        out.result({
            saved: { name: saved.name, path: saved.path, bytes: saved.source.length },
            next: `tools jev evaluation run ${saved.name} --input "…"`,
        });
        return;
    }

    if (options.from || options.bundle) {
        throw new Error("--from / --bundle require --name to save a program.");
    }

    const payload = createPayload();

    if (options.json) {
        out.result(payload);
        return;
    }

    out.println(languageGuide());
    out.println("");
    renderCliHeader("Corpus", `${payload.corpus.length} bundled examples`);
    const table = createBoxTable(["FILE", "NAME", "INPUT"]);

    for (const example of payload.corpus) {
        table.push([
            pc.cyan(example.file),
            truncateDisplay(example.name, 28),
            truncateDisplay(example.input || "(none)", 48),
        ]);
    }

    out.println(table.toString());
    ui.info(
        suggestCommand("tools jev evaluation create", {
            add: ["--name", "inbox", "--bundle", "inbox"],
        })
    );
}

async function runAction(name: string, options: RunOptions, root: Command, signal: AbortSignal): Promise<void> {
    let replay: Effect[] | undefined;
    let replayInput: string | undefined;

    if (options.replay) {
        // A path the caller names, so it is validated strictly even though this tool wrote the
        // original: nothing guarantees the file on disk is still the one it produced.
        const saved = SafeJSON.parse(await Bun.file(options.replay).text(), { strict: true }) as Run;

        if (saved.version !== 1 || !Array.isArray(saved.tape)) {
            throw new Error("Unsupported or invalid recording file.");
        }

        replay = saved.tape;
        replayInput = typeof saved.input === "string" ? saved.input : "";
    }

    const resolved = options.replay
        ? {
              input:
                  options.input !== undefined ? (await resolveProbablyInput(options.input)).input : (replayInput ?? ""),
          }
        : await resolveProbablyInput(options.input);

    const result = await runStoredProgram({
        name,
        input: resolved.input,
        replay,
        provider: selectedProvider(root),
        model: options.model,
        signal,
        onEvent: (event) => {
            if (event.kind === "judge") {
                ui.dim(`[line ${event.line}] ${event.text}`);
            }
        },
    });

    if (options.save) {
        await Bun.write(options.save, SafeJSON.stringify(result, null, 2));
        ui.ok(`Saved recording to ${options.save}`);
    }

    out.result(result);
}
