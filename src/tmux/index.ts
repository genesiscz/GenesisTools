#!/usr/bin/env bun

/**
 * tmux session manager — list, create, reset, attach, and snapshot tmux sessions
 * on the default socket. Extracted from `tools cmux tmux` (cmux owns workspace
 * profiles; this owns plain tmux). Shares the reusable tmux primitives in
 * `src/utils/tmux/` with the dev-dashboard server.
 *
 * Usage:
 *   tools tmux sessions [--json] [--detailed] [--prefix <str>]
 *   tools tmux create [--name <n>] [--cwd <p>] [--command <sh>] [--attach]
 *   tools tmux session reset <id> | --matching <pattern>
 *   tools tmux session attach <id-or-substring>
 *   tools tmux presets save|list|restore|delete
 */

import { out } from "@app/logger";
import { registerCreateCommand } from "@app/tmux/commands/create";
import { registerPresetsCommand } from "@app/tmux/commands/presets";
import { registerSessionCommand } from "@app/tmux/commands/session";
import { registerSessionsCommand } from "@app/tmux/commands/sessions";
import { enhanceHelp, runTool } from "@app/utils/cli";
import { handleReadmeFlag } from "@app/utils/readme";
import { Command } from "commander";

handleReadmeFlag(import.meta.url);

const program = new Command();

program
    .name("tmux")
    .description("Inspect, create, reset, attach, and snapshot tmux sessions.")
    .version("0.1.0")
    .showHelpAfterError(true)
    .option("-v, --verbose", "Enable debug logging");

registerCreateCommand(program);
registerSessionsCommand(program);
registerSessionCommand(program);
registerPresetsCommand(program);

enhanceHelp(program);

await runTool(program, { tool: "tmux" }).catch((error) => {
    out.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
