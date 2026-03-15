import { closeDarwinKit } from "@app/utils/macos";
import { handleCancel, isCancelled, withCancel } from "@app/utils/prompts/clack/helpers";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { type CommandDef, commands, GROUP_LABELS, GROUP_ORDER, getCommandsByGroup, type ParamDef } from "./commands";
import { defaultFormat, formatOutput, type OutputFormat } from "./format";

/**
 * Run the full interactive menu: group -> command -> params -> execute
 */
export async function runInteractiveMenu(): Promise<void> {
    const grouped = getCommandsByGroup();

    const group = await withCancel(
        p.select({
            message: "Choose a category",
            options: GROUP_ORDER.filter((g) => {
                const cmds = grouped.get(g);
                return cmds && cmds.length > 0;
            }).map((g) => ({
                value: g,
                label: GROUP_LABELS[g] ?? g,
                hint: `${grouped.get(g)!.length} commands`,
            })),
        })
    );

    const groupCommands = grouped.get(group as string)!;

    const cmdName = await withCancel(
        p.select({
            message: "Choose a command",
            options: groupCommands.map((c) => ({
                value: c.name,
                label: c.name,
                hint: c.description,
            })),
        })
    );

    const cmd = commands.find((c) => c.name === cmdName)!;
    await runCommandInteractive(cmd);
}

/**
 * Prompt for missing params and execute a command interactively.
 * Shows usage hint first, then prompts for each missing param.
 */
export async function runCommandInteractive(
    cmd: CommandDef,
    providedArgs: Record<string, unknown> = {},
    formatOverride?: OutputFormat
): Promise<void> {
    const usage = buildUsageLine(cmd);
    p.log.info(pc.dim(usage));

    const args = { ...providedArgs };

    for (const param of cmd.params) {
        const existing = args[param.name];

        if (existing !== undefined && !(Array.isArray(existing) && existing.length === 0)) {
            continue;
        }

        if (!param.required && !process.stdout.isTTY) {
            continue;
        }

        const value = await promptForParam(param);

        if (value !== undefined) {
            args[param.name] = value;
        }
    }

    const spin = p.spinner();
    spin.start(`Running ${cmd.name}...`);

    try {
        const result = await cmd.run(args);
        spin.stop(`${cmd.name} complete`);

        const format = formatOverride ?? defaultFormat();
        const output = formatOutput(result, format);
        console.log(output);
    } catch (error) {
        spin.stop(pc.red(`${cmd.name} failed`));
        p.log.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    } finally {
        closeDarwinKit();
    }
}

async function promptForParam(param: ParamDef): Promise<unknown> {
    if (param.choices && param.choices.length > 0) {
        if (param.type === "string[]") {
            const result = await p.multiselect({
                message: `${param.name} ${pc.dim(`(${param.description})`)}`,
                options: param.choices.map((c) => ({ value: c, label: c })),
                initialValues: param.default as string[] | undefined,
            });

            if (isCancelled(result)) {
                handleCancel();
            }

            return result;
        }

        const result = await p.select({
            message: `${param.name} ${pc.dim(`(${param.description})`)}`,
            options: param.choices.map((c) => ({ value: c, label: c })),
            initialValue: param.default as string | undefined,
        });

        if (isCancelled(result)) {
            handleCancel();
        }

        return result;
    }

    if (param.type === "boolean") {
        return withCancel(
            p.confirm({
                message: `${param.name}? ${pc.dim(`(${param.description})`)}`,
                initialValue: (param.default as boolean) ?? false,
            })
        );
    }

    if (param.type === "string[]") {
        const result = await withCancel(
            p.text({
                message: `${param.name} ${pc.dim(`(${param.description}, comma-separated)`)}`,
                placeholder: param.default ? String(param.default) : undefined,
            })
        );
        const str = (result as string).trim();

        if (str === "") {
            return [];
        }

        return str
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
    }

    if (param.type === "number") {
        const result = await withCancel(
            p.text({
                message: `${param.name} ${pc.dim(`(${param.description})`)}`,
                placeholder: param.default !== undefined ? String(param.default) : undefined,
                validate: (v) => {
                    if (!param.required && v === "") {
                        return;
                    }

                    if (Number.isNaN(Number(v))) {
                        return "Must be a number";
                    }
                },
            })
        );

        const str = result as string;

        if (str === "" && param.default !== undefined) {
            return param.default;
        }

        return str === "" ? undefined : Number(str);
    }

    // string
    const result = await withCancel(
        p.text({
            message: `${param.name} ${pc.dim(`(${param.description})`)}`,
            placeholder: param.default !== undefined ? String(param.default) : undefined,
            validate: (v) => {
                if (param.required && (!v || (v as string).trim() === "")) {
                    return `${param.name} is required`;
                }
            },
        })
    );

    const str = result as string;

    if (str === "" && !param.required) {
        return param.default;
    }

    return str;
}

function buildUsageLine(cmd: CommandDef): string {
    const positionals = cmd.params.filter((pm) => pm.positional);
    const flags = cmd.params.filter((pm) => !pm.positional);
    let line = `Usage: tools darwinkit ${cmd.name}`;

    for (const param of positionals) {
        line += param.required ? ` <${param.name}>` : ` [${param.name}]`;
    }

    for (const param of flags) {
        if (param.type === "boolean") {
            line += ` [--${param.name}]`;
        } else {
            line += ` [--${param.name} <${param.type}>]`;
        }
    }

    return line;
}
