#!/usr/bin/env bun
import { runTool } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { Command } from "commander";
import { launchersInstallCommand } from "./commands/launchers";
import {
    providersAddCommand,
    providersDoctorCommand,
    providersListCommand,
    providersSyncCommand,
} from "./commands/providers";

function collect(value: string, previous: string[]): string[] {
    return [...previous, value];
}

const SETTINGS_HELP = "T3 Code settings file (default ~/.t3/userdata/settings.json)";
const BIN_DIR_HELP = "launcher folder (default ~/.genesis-tools/bin)";
const BACKUP_DIR_HELP = "backup folder for settings.json (default ~/.genesis-tools/t3/backups)";

const program = new Command();
program
    .name(toolCommand("t3"))
    .description("Add GenesisTools accounts to T3 Code: per-account launchers and provider instances");

const launchers = program.command("launchers").description("The scripts T3 Code runs as an agent binary");

launchers
    .command("install")
    .description("Write <alias>-tools for every agent, plus <alias>-tools@<account> for each --account")
    .option("--bin-dir <dir>", BIN_DIR_HELP)
    .option("--checkout <dir>", "GenesisTools checkout the launchers exec (default: the one whose tools is on PATH)")
    .option("--account <alias:name>", "also write a launcher pinned to this account (repeatable)", collect, [])
    .option("--json", "print the result as JSON")
    .action(launchersInstallCommand);

const providers = program.command("providers").description("T3 Code provider instances owned by GenesisTools (gt-*)");

providers
    .command("list")
    .description("Every instance with its driver, binary, embed account and whether that account exists")
    .option("--settings <path>", SETTINGS_HELP)
    .option("--json", "print the result as JSON")
    .action(providersListCommand);

providers
    .command("add <alias>")
    .description("Add or update one instance gt-<alias>-<account> (alias: claude, codex, grok)")
    .option(
        "--account <value>",
        "account name, auto, or proxy:<account>/<provider> (only for an agent whose embed launcher serves the ai-proxy)"
    )
    .option("--display-name <text>", "name T3 Code shows (default: <Agent> (<account>))")
    .option("--steer [mode]", "next | off: steer at the next boundary (Claude only)")
    .option("--settings <path>", SETTINGS_HELP)
    .option("--bin-dir <dir>", BIN_DIR_HELP)
    .option("--backup-dir <dir>", BACKUP_DIR_HELP)
    .option("--json", "print the result as JSON")
    .action(providersAddCommand);

providers
    .command("sync")
    .description("One instance per configured account of each agent (asks first; --yes outside a terminal)")
    .option("--yes", "write without asking")
    .option("--settings <path>", SETTINGS_HELP)
    .option("--bin-dir <dir>", BIN_DIR_HELP)
    .option("--backup-dir <dir>", BACKUP_DIR_HELP)
    .option("--json", "print the result as JSON")
    .action(providersSyncCommand);

providers
    .command("doctor")
    .description("Read-only checks of launchers and gt-* instances; prints fix commands")
    .option("--settings <path>", SETTINGS_HELP)
    .option("--bin-dir <dir>", BIN_DIR_HELP)
    .option("--json", "print the result as JSON")
    .action(providersDoctorCommand);

await runTool(program, { tool: "t3" });
