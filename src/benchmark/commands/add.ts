import * as p from "@clack/prompts";
import type { Command } from "commander";
import { collectKeyValue, parseKeyValuePairs } from "../lib/helpers";
import { BUILTIN_SUITES, getCustomSuites, saveCustomSuites } from "../lib/suites";
import type { AddOptions, BenchmarkCommand, BenchmarkSuite } from "../lib/types";

export async function cmdAdd(name: string, commandPairs: string[], opts: AddOptions = {}): Promise<void> {
    if (BUILTIN_SUITES.some((s) => s.name === name)) {
        p.log.error(`Cannot overwrite built-in suite "${name}".`);
        process.exit(1);
    }

    const prepareForMap = parseKeyValuePairs(opts.prepareFor ?? [], "--prepare-for");
    const concludeForMap = parseKeyValuePairs(opts.concludeFor ?? [], "--conclude-for");
    const cleanupForMap = parseKeyValuePairs(opts.cleanupFor ?? [], "--cleanup-for");

    const envForMap = new Map<string, Record<string, string>>();

    for (const entry of opts.envFor ?? []) {
        const colonIdx = entry.indexOf(":");

        if (colonIdx === -1) {
            p.log.error(`Invalid --env-for format: "${entry}". Expected "label:KEY=value".`);
            process.exit(1);
        }

        const label = entry.slice(0, colonIdx);
        const rest = entry.slice(colonIdx + 1);
        const eqIdx = rest.indexOf("=");

        if (eqIdx === -1) {
            p.log.error(`Invalid --env-for format: "${entry}". Expected "label:KEY=value".`);
            process.exit(1);
        }

        const existing = envForMap.get(label) ?? {};
        existing[rest.slice(0, eqIdx)] = rest.slice(eqIdx + 1);
        envForMap.set(label, existing);
    }

    const commands: BenchmarkCommand[] = [];

    for (const pair of commandPairs) {
        const colonIdx = pair.indexOf(":");

        if (colonIdx === -1) {
            p.log.error(`Invalid format: "${pair}". Expected "label:command".`);
            process.exit(1);
        }

        const label = pair.slice(0, colonIdx);
        const cmd: BenchmarkCommand = {
            label,
            cmd: pair.slice(colonIdx + 1),
        };

        const perCmdPrepare = prepareForMap.get(label);

        if (perCmdPrepare) {
            cmd.prepare = perCmdPrepare;
        }

        const perCmdConclude = concludeForMap.get(label);

        if (perCmdConclude) {
            cmd.conclude = perCmdConclude;
        }

        const perCmdCleanup = cleanupForMap.get(label);

        if (perCmdCleanup) {
            cmd.cleanup = perCmdCleanup;
        }

        const perCmdEnv = envForMap.get(label);

        if (perCmdEnv) {
            cmd.env = perCmdEnv;
        }

        commands.push(cmd);
    }

    if (commands.length < 2) {
        p.log.error("A benchmark suite needs at least 2 commands to compare.");
        process.exit(1);
    }

    const suite: BenchmarkSuite = { name, commands };

    if (opts.runs) {
        suite.runs = opts.runs;
    }

    if (opts.warmup !== undefined) {
        suite.warmup = opts.warmup;
    }

    if (opts.setup) {
        suite.setup = opts.setup;
    }

    if (opts.prepare) {
        suite.prepare = opts.prepare;
    }

    if (opts.conclude) {
        suite.conclude = opts.conclude;
    }

    if (opts.cleanup) {
        suite.cleanup = opts.cleanup;
    }

    if (opts.cwd) {
        suite.cwd = opts.cwd;
    }

    const suiteEnv: Record<string, string> = {};

    for (const pair of opts.env ?? []) {
        const eqIdx = pair.indexOf("=");

        if (eqIdx === -1) {
            p.log.error(`Invalid --env format: "${pair}". Expected "KEY=value".`);
            process.exit(1);
        }

        suiteEnv[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
    }

    if (Object.keys(suiteEnv).length > 0) {
        suite.env = suiteEnv;
    }

    const custom = await getCustomSuites();
    const existing = custom.findIndex((s) => s.name === name);

    if (existing >= 0) {
        custom[existing] = suite;
    } else {
        custom.push(suite);
    }

    await saveCustomSuites(custom);
    p.log.success(`Suite "${name}" saved with ${commands.length} commands.`);
}

export function registerAddCommand(program: Command): void {
    program
        .command("add")
        .description('Add a custom benchmark suite: tools benchmark add "name" "label:cmd" "label2:cmd2"')
        .argument("<name>", "Suite name")
        .argument("<commands...>", 'Commands in "label:command" format')
        .option("--runs <n>", "Default number of timing runs for this suite", (v) => parseInt(v, 10))
        .option("--warmup <n>", "Default warmup count for this suite (default: 3)", (v) => parseInt(v, 10))
        .option("--setup <cmd>", "Setup command run once before all timing runs")
        .option("--prepare <cmd>", "Prepare command run before each timing run (all commands)")
        .option("--conclude <cmd>", "Conclude command run after each timing run (all commands)")
        .option("--cleanup <cmd>", "Cleanup command run after all runs per command")
        .option("--cwd <dir>", "Working directory for benchmark commands")
        .option("--prepare-for <label=cmd>", "Per-command prepare (repeatable)", collectKeyValue, [])
        .option("--conclude-for <label=cmd>", "Per-command conclude (repeatable)", collectKeyValue, [])
        .option("--cleanup-for <label=cmd>", "Per-command cleanup (repeatable)", collectKeyValue, [])
        .option("--env <KEY=val>", "Environment variable for all commands (repeatable)", collectKeyValue, [])
        .option("--env-for <label:KEY=val>", "Per-command environment variable (repeatable)", collectKeyValue, [])
        .action(async (name: string, commands: string[], opts: AddOptions) => {
            await cmdAdd(name, commands, opts);
        });
}
