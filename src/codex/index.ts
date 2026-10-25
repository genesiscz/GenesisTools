#!/usr/bin/env bun

import { registerAgentTool } from "@app/ai/commands/agent/register";
import { runTool } from "@genesiscz/utils/cli";
import { Command } from "commander";
import { registerApprovalCommands } from "./commands/approve";
import { registerDesktopCommand } from "./commands/desktop";
import { registerLogsCommand } from "./commands/logs";
import { registerMigrateHomeCommand } from "./commands/migrate-home";
import { registerModelsCommand } from "./commands/models";
import { registerCodexMessageCommands } from "./commands/queue";
import { registerReviewCommand } from "./commands/review";
import { registerReviewsCommands } from "./commands/reviews";
import { registerRollbackCommand } from "./commands/rollback";
import { codexSpec } from "./lib/spec";

const program = new Command();

program.name("codex").description(codexSpec.description);
registerAgentTool(program, codexSpec);
registerCodexMessageCommands({ program });

// Codex's own verbs: a persistent daemon with a control channel is the only backend that can
// offer mid-turn approvals, a turn rollback, a native review, or a raw event log.
registerMigrateHomeCommand(program);
registerDesktopCommand(program);
registerRollbackCommand(program);
registerReviewCommand(program);
registerReviewsCommands(program);
registerApprovalCommands(program);
registerLogsCommand(program);
registerModelsCommand(program);

await runTool(program, { tool: "codex" });
