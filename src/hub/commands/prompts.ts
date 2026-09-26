import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { addPrompt, HubPromptError, listPrompts, parseVars, removePrompt, sendPrompt } from "../lib/prompts";

/** One verb's result as JSON or text; a failure prints `{error, code, missing}` with --json and exits 1. */
async function promptVerb<T>({
    json,
    run,
    human,
}: {
    json?: boolean;
    run: () => Promise<T>;
    human: (result: T) => void;
}): Promise<void> {
    try {
        const result = await run();

        if (json) {
            out.result(result);
            return;
        }

        human(result);
    } catch (error) {
        const code = error instanceof HubPromptError ? error.code : "error";
        const missing = error instanceof HubPromptError ? error.missing : [];
        const message = error instanceof Error ? error.message : String(error);
        out.log.error(message);

        if (json) {
            out.result({ error: message, code, missing });
        }

        process.exitCode = 1;
    }
}

async function readText(words: string[], file: string | undefined): Promise<string> {
    if (file === "-") {
        return Bun.stdin.text();
    }

    if (file) {
        return Bun.file(file).text();
    }

    return words.join(" ");
}

function collect(value: string, previous: string[]): string[] {
    return [...previous, value];
}

/** `tools hub prompts`: the hub's saved prompts with `{{variables}}`, sent into a session's cmux pane. */
export function registerPromptsCommand(program: Command): void {
    const prompts = program
        .command("prompts")
        .description(
            "Saved prompts with {{variables}} (~/.genesis-tools/hub/prompts.json), sent into a session's cmux pane"
        );

    prompts
        .command("list")
        .description("Every saved prompt, most used first, with its variables")
        .option("--json", "machine-readable output")
        .action(async (opts: { json?: boolean }) => {
            await promptVerb({
                json: opts.json,
                run: async () => listPrompts(),
                human: (list) => {
                    renderCliHeader("Prompts", `${list.length} saved, most used first`);
                    const table = createBoxTable(["NAME", "USES", "VARIABLES", "TEXT"]);

                    for (const prompt of list) {
                        table.push([
                            pc.white(prompt.name),
                            String(prompt.uses),
                            prompt.variables.join(", ") || "—",
                            truncateDisplay(prompt.text.replace(/\s+/g, " "), 60),
                        ]);
                    }

                    out.println(table.toString());
                },
            });
        });

    prompts
        .command("add")
        .description("Save a prompt; {{name}} marks a variable (branch, pr, cwd, project and session fill themselves)")
        .argument("<name>", "the prompt's name")
        .argument("[text...]", "the prompt text (or --file)")
        .option("--file <path>", "read the text from a file, or - for stdin")
        .option("--description <text>", "one line on what it is for")
        .option("--replace", "overwrite a prompt of the same name (keeps its use count)")
        .option("--json", "machine-readable output")
        .action(
            async (
                name: string,
                words: string[],
                opts: { file?: string; description?: string; replace?: boolean; json?: boolean }
            ) => {
                await promptVerb({
                    json: opts.json,
                    run: async () =>
                        addPrompt({
                            name,
                            text: (await readText(words, opts.file)).trimEnd(),
                            description: opts.description,
                            replace: opts.replace,
                        }),
                    human: (prompt) => out.log.success(`saved "${prompt.name}"`),
                });
            }
        );

    prompts
        .command("remove")
        .description("Delete a saved prompt")
        .argument("<name>", "the prompt's name (a unique prefix works)")
        .option("--json", "machine-readable output")
        .action(async (name: string, opts: { json?: boolean }) => {
            await promptVerb({
                json: opts.json,
                run: () => removePrompt({ name }),
                human: (prompt) => out.log.success(`removed "${prompt.name}"`),
            });
        });

    prompts
        .command("send")
        .description(
            "Render a prompt and type it into the session's cmux pane (a multi-line prompt goes into a file and a one-line pointer is typed)"
        )
        .argument("<name>", "the prompt's name (a unique prefix works)")
        .requiredOption("--session <id>", "the session to type into (its id, or a leading part of it)")
        .option("--var <name=value>", "a variable's value; repeat for each", collect, [])
        .option("--dry-run", "render only: print what would be typed, send nothing")
        .option("--json", "machine-readable output")
        .action(async (name: string, opts: { session: string; var: string[]; dryRun?: boolean; json?: boolean }) => {
            await promptVerb({
                json: opts.json,
                run: () => sendPrompt({ name, session: opts.session, vars: parseVars(opts.var), dryRun: opts.dryRun }),
                human: (result) => {
                    if (result.dryRun) {
                        out.println(result.typed);

                        if (result.file) {
                            out.println(pc.dim(`(the file ${result.file} would hold:)\n${result.text}`));
                        }

                        return;
                    }

                    out.log.success(
                        `sent "${result.name}" to ${result.session.slice(0, 8)}${result.mode === "file" ? ` via ${result.file}` : ""}`
                    );
                },
            });
        });
}
