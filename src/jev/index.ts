#!/usr/bin/env bun

import { addProviderOption } from "@genesiscz/utils/ai/evaluation/cli";
import { registerConfig } from "@genesiscz/utils/ai/evaluation/config-cli";
import { runTool } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { logger } from "@genesiscz/utils/logger";
import { Command } from "commander";
import { ZodError } from "zod";
import { registerArena } from "./commands/arena";
import { registerCompact } from "./commands/compact";
import { registerControlLabCommands } from "./commands/control";
import { registerDashboard } from "./commands/dashboard";
import { registerDemoReel } from "./commands/demo-reel";
import { registerEvaluation } from "./commands/evaluate";
import { registerExperiment } from "./commands/experiment";
import { registerListen } from "./commands/listen";
import { registerLogin } from "./commands/login";
import { registerLoop } from "./commands/loop";
import { registerRoute } from "./commands/route";
import { registerScreen } from "./commands/screen";
import { registerSessions } from "./commands/sessions";
import { registerVerify } from "./commands/verify";
import { registerWake } from "./commands/wake";
import { registerWatch } from "./commands/watch";
import { failPlain } from "./lib/cli-output";
import { registerJevMcp } from "./mcp";

const program = new Command().name("tools jev").description("Jev evaluation tools and local experiment workbench");
addProviderOption(program);
registerLogin(program);
registerEvaluation(program);
registerExperiment(program);
registerArena(program);
registerDashboard(program);
registerControlLabCommands(program);
registerListen(program);
registerRoute(program);
registerCompact(program);
registerConfig(program, (error, context) => failPlain(error, context));
registerScreen(program);
registerSessions(program);
registerVerify(program);
registerWatch(program);
registerLoop(program);
registerWake(program);
registerDemoReel(program);
registerJevMcp(program);

const ERROR_LINE_MAX_CHARS = 400;

try {
    await runTool(program, { tool: "jev" });
} catch (error) {
    const message =
        error instanceof ZodError
            ? error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")
            : error instanceof Error
              ? error.message
              : "Jev command failed.";
    logger.error({ error }, "Jev command failed");
    const firstLine = message.split(/\r?\n/, 1)[0] ?? message;
    const shown =
        firstLine.length > ERROR_LINE_MAX_CHARS
            ? `${firstLine.slice(0, ERROR_LINE_MAX_CHARS)}… (${message.length} chars; full text in the log)`
            : firstLine;
    ui.err(shown);
    process.exitCode = 1;
}
