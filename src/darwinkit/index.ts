#!/usr/bin/env bun

import { SafeJSON } from "@app/utils/json";
import { closeDarwinKit } from "@app/utils/macos";
import { handleReadmeFlag } from "@app/utils/readme";
import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";
import { type CommandDef, commands, GROUP_LABELS, GROUP_ORDER, getCommandsByGroup } from "./lib/commands";
import { defaultFormat, formatOutput, type OutputFormat } from "./lib/format";
import { runCommandInteractive, runInteractiveMenu } from "./lib/interactive";

handleReadmeFlag(import.meta.url);

// ─── Logo ───────────────────────────────────────────────────────────────────────

const LOGO = `${pc.bold(pc.cyan("  DarwinKit"))} ${pc.dim("— Apple on-device ML from the terminal")}`;

// ─── Help Generator ─────────────────────────────────────────────────────────────

function printFullHelp(): void {
    console.log();
    console.log(LOGO);
    console.log();

    const grouped = getCommandsByGroup();

    for (const group of GROUP_ORDER) {
        const cmds = grouped.get(group);

        if (!cmds || cmds.length === 0) {
            continue;
        }

        console.log(pc.bold(pc.yellow(`  ${GROUP_LABELS[group] ?? group}`)));

        for (const cmd of cmds) {
            const positionals = cmd.params.filter((pm) => pm.positional);
            const posStr = positionals.map((pm) => (pm.required ? `<${pm.name}>` : `[${pm.name}]`)).join(" ");
            const nameCol = `    ${pc.green(cmd.name)}${posStr ? ` ${pc.dim(posStr)}` : ""}`;
            console.log(`${nameCol.padEnd(50)}${pc.dim(cmd.description)}`);
        }

        console.log();
    }

    console.log(pc.dim("  Options: --format json|pretty|raw"));
    console.log(pc.dim("  Run without args for interactive mode (TTY only)"));
    console.log();
}

// ─── Commander Setup ────────────────────────────────────────────────────────────

function buildProgram(): Command {
    const program = new Command();

    program
        .name("darwinkit")
        .description("Apple on-device ML from the terminal")
        .version("1.0.0")
        .option("--format <format>", "Output format: json, pretty, raw");

    for (const cmd of commands) {
        const sub = program.command(cmd.name).description(cmd.description);

        const positionals = cmd.params.filter((pm) => pm.positional);

        for (const param of positionals) {
            if (param.required) {
                sub.argument(`<${param.name}>`, param.description);
            } else {
                sub.argument(`[${param.name}]`, param.description);
            }
        }

        const flags = cmd.params.filter((pm) => !pm.positional);

        for (const param of flags) {
            const flag =
                param.type === "boolean"
                    ? `--${param.name}`
                    : param.type === "string[]"
                      ? `--${param.name} <values...>`
                      : `--${param.name} <${param.type}>`;
            const desc =
                param.default !== undefined
                    ? `${param.description} (default: ${SafeJSON.stringify(param.default)})`
                    : param.description;
            sub.option(flag, desc);
        }

        sub.option("--format <format>", "Output format: json, pretty, raw");

        sub.action(async (...actionArgs: unknown[]) => {
            await handleCommandAction(cmd, sub, actionArgs);
        });
    }

    return program;
}

async function handleCommandAction(cmd: CommandDef, sub: Command, actionArgs: unknown[]): Promise<void> {
    const positionals = cmd.params.filter((pm) => pm.positional);
    const opts = (actionArgs[positionals.length] ?? {}) as Record<string, unknown>;

    const args: Record<string, unknown> = {};

    for (let i = 0; i < positionals.length; i++) {
        if (actionArgs[i] !== undefined) {
            args[positionals[i].name] = actionArgs[i];
        }
    }

    for (const param of cmd.params.filter((pm) => !pm.positional)) {
        const camelName = param.name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
        const rawValue = opts[camelName] ?? opts[param.name];

        if (rawValue === undefined) {
            continue;
        }

        if (param.type === "number") {
            const num = Number(rawValue);

            if (Number.isNaN(num)) {
                console.error(`Invalid number for --${param.name}: ${rawValue}`);
                process.exit(1);
            }

            args[param.name] = num;
        } else if (param.type === "string[]") {
            args[param.name] =
                typeof rawValue === "string"
                    ? rawValue
                          .split(",")
                          .map((s: string) => s.trim())
                          .filter(Boolean)
                    : rawValue;
        } else {
            args[param.name] = rawValue;
        }
    }

    const missing = cmd.params.filter((pm) => pm.required && args[pm.name] === undefined);

    if (missing.length > 0) {
        if (process.stdout.isTTY) {
            p.intro(LOGO);
            const fmtOpt = opts.format as string | undefined;
            await runCommandInteractive(cmd, args, fmtOpt as OutputFormat | undefined);
            return;
        }

        sub.outputHelp();
        process.exit(0);
    }

    const validFormats = new Set<OutputFormat>(["json", "pretty", "raw"]);
    const formatOpt = opts.format as string | undefined;
    const format: OutputFormat =
        formatOpt && validFormats.has(formatOpt as OutputFormat) ? (formatOpt as OutputFormat) : defaultFormat();

    try {
        const result = await cmd.run(args);
        console.log(formatOutput(result, format));
    } catch (error) {
        if (process.stdout.isTTY) {
            p.log.error(error instanceof Error ? error.message : String(error));
        } else {
            console.error(error instanceof Error ? error.message : String(error));
        }

        process.exit(1);
    } finally {
        closeDarwinKit();
    }
}

// ─── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    if (process.argv.length <= 2) {
        if (process.stdout.isTTY) {
            p.intro(LOGO);
            await runInteractiveMenu();
        } else {
            printFullHelp();
        }

        return;
    }

    const program = buildProgram();

    try {
        await program.parseAsync(process.argv);
    } catch (error) {
        if (process.stdout.isTTY) {
            p.log.error(error instanceof Error ? error.message : String(error));
        } else {
            console.error(error instanceof Error ? error.message : String(error));
        }

        process.exit(1);
    }
}

main().catch((err) => {
    if (process.stdout.isTTY) {
        p.log.error(err instanceof Error ? err.message : String(err));
    } else {
        console.error(err instanceof Error ? err.message : String(err));
    }

    closeDarwinKit();
    process.exit(1);
});
