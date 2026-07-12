#!/usr/bin/env bun
import { logger } from "@app/logger";
import { runTool } from "@app/utils/cli";
import { Command } from "commander";
import { registerAddCommand } from "./commands/add";
import { registerBoardFromSetCommand } from "./commands/board-from-set";
import { registerInitCommand } from "./commands/init";
import { registerOperatorCommand } from "./commands/operator";
import { registerPushCommand } from "./commands/push";
import { registerWatchCommand } from "./commands/watch";

const program = new Command()
    .name("boards")
    .description(
        "Dev-dashboard annotation boards: push shot sets, create boards, listen for work. " +
            "Talks to the dev-dashboard server (default http://127.0.0.1:3042; --base / BOARDS_BASE_URL " +
            "to override) — boards live at <base>/boards/<slug>."
    );
registerInitCommand(program);
registerAddCommand(program);
registerPushCommand(program);
registerBoardFromSetCommand(program);
registerWatchCommand(program);
registerOperatorCommand(program);

await runTool(program, { tool: "boards" }).catch((err) => {
    logger.error({ err }, "boards CLI failed");
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
});
