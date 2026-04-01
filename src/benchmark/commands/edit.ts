import * as p from "@clack/prompts";
import type { Command } from "commander";
import { collectKeyValue, parseKeyValuePairs } from "../lib/helpers";
import { BUILTIN_SUITES, getCustomSuites, saveCustomSuites } from "../lib/suites";
import type { EditOptions } from "../lib/types";

export async function cmdEdit(name: string, opts: EditOptions): Promise<void> {
    if (BUILTIN_SUITES.some((s) => s.name === name)) {
        p.log.error(`Cannot edit built-in suite "${name}".`);
        process.exit(1);
    }

    const custom = await getCustomSuites();
    const idx = custom.findIndex((s) => s.name === name);

    if (idx === -1) {
        p.log.error(`Suite "${name}" not found.`);
        process.exit(1);
    }

    const suite = custom[idx];

    if (opts.runs !== undefined) {
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

    if (opts.clearSetup) {
        delete suite.setup;
    }

    if (opts.clearPrepare) {
        delete suite.prepare;
    }

    if (opts.clearConclude) {
        delete suite.conclude;
    }

    if (opts.clearCleanup) {
        delete suite.cleanup;
    }

    if (opts.clearCwd) {
        delete suite.cwd;
    }

    if (opts.clearEnv) {
        delete suite.env;
    }

    if (opts.env && opts.env.length > 0) {
        const env: Record<string, string> = { ...suite.env };

        for (const pair of opts.env) {
            const eqIdx = pair.indexOf("=");

            if (eqIdx === -1) {
                p.log.error(`Invalid --env format: "${pair}". Expected "KEY=value".`);
                process.exit(1);
            }

            env[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
        }

        suite.env = env;
    }

    for (const pair of opts.addCmd ?? []) {
        const colonIdx = pair.indexOf(":");

        if (colonIdx === -1) {
            p.log.error(`Invalid --add-cmd format: "${pair}". Expected "label:command".`);
            process.exit(1);
        }

        const label = pair.slice(0, colonIdx);
        const existingCmd = suite.commands.find((c) => c.label === label);

        if (existingCmd) {
            existingCmd.cmd = pair.slice(colonIdx + 1);
        } else {
            suite.commands.push({ label, cmd: pair.slice(colonIdx + 1) });
        }
    }

    for (const label of opts.removeCmd ?? []) {
        const cmdIdx = suite.commands.findIndex((c) => c.label === label);

        if (cmdIdx === -1) {
            p.log.warn(`Command "${label}" not found in suite, skipping.`);
            continue;
        }

        suite.commands.splice(cmdIdx, 1);
    }

    if (suite.commands.length < 2) {
        p.log.error("A suite must have at least 2 commands. Aborting edit.");
        process.exit(1);
    }

    const prepareForMap = parseKeyValuePairs(opts.prepareFor ?? [], "--prepare-for");
    const concludeForMap = parseKeyValuePairs(opts.concludeFor ?? [], "--conclude-for");
    const cleanupForMap = parseKeyValuePairs(opts.cleanupFor ?? [], "--cleanup-for");

    for (const cmd of suite.commands) {
        const prep = prepareForMap.get(cmd.label);

        if (prep) {
            cmd.prepare = prep;
        }

        const conc = concludeForMap.get(cmd.label);

        if (conc) {
            cmd.conclude = conc;
        }

        const clean = cleanupForMap.get(cmd.label);

        if (clean) {
            cmd.cleanup = clean;
        }
    }

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

        const cmd = suite.commands.find((c) => c.label === label);

        if (!cmd) {
            p.log.warn(`Command "${label}" not found, skipping env-for.`);
            continue;
        }

        cmd.env = { ...cmd.env, [rest.slice(0, eqIdx)]: rest.slice(eqIdx + 1) };
    }

    custom[idx] = suite;
    await saveCustomSuites(custom);
    p.log.success(`Suite "${name}" updated.`);
}

export function registerEditCommand(program: Command): void {
    program
        .command("edit")
        .description("Edit an existing custom benchmark suite")
        .argument("<name>", "Suite name to edit")
        .option("--runs <n>", "Update default run count", (v) => parseInt(v, 10))
        .option("--warmup <n>", "Update default warmup count", (v) => parseInt(v, 10))
        .option("--setup <cmd>", "Update setup command")
        .option("--prepare <cmd>", "Update prepare command")
        .option("--conclude <cmd>", "Update conclude command")
        .option("--cleanup <cmd>", "Update cleanup command")
        .option("--cwd <dir>", "Update working directory")
        .option("--env <KEY=val>", "Add/update suite-level env var (repeatable)", collectKeyValue, [])
        .option("--clear-setup", "Remove the setup command")
        .option("--clear-prepare", "Remove the suite-level prepare command")
        .option("--clear-conclude", "Remove the suite-level conclude command")
        .option("--clear-cleanup", "Remove the suite-level cleanup command")
        .option("--clear-cwd", "Remove the working directory")
        .option("--clear-env", "Remove all suite-level env vars")
        .option("--add-cmd <label:cmd>", "Add or replace a command (repeatable)", collectKeyValue, [])
        .option("--remove-cmd <label>", "Remove a command by label (repeatable)", collectKeyValue, [])
        .option("--prepare-for <label=cmd>", "Set per-command prepare (repeatable)", collectKeyValue, [])
        .option("--conclude-for <label=cmd>", "Set per-command conclude (repeatable)", collectKeyValue, [])
        .option("--cleanup-for <label=cmd>", "Set per-command cleanup (repeatable)", collectKeyValue, [])
        .option("--env-for <label:KEY=val>", "Set per-command env var (repeatable)", collectKeyValue, [])
        .action(async (name: string, opts: EditOptions) => {
            await cmdEdit(name, opts);
        });
}
