#!/usr/bin/env bun

import { addProviderOption } from "@genesiscz/utils/ai/evaluation/cli";
import { runTool } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
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
import { registerWake } from "./commands/wake";
import { registerWatch } from "./commands/watch";

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
registerScreen(program);
registerWatch(program);
registerLoop(program);
registerWake(program);
registerDemoReel(program);

try {
    await runTool(program, { tool: "jev" });
} catch (error) {
    const message =
        error instanceof ZodError
            ? error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("\n")
            : error instanceof Error
              ? error.message
              : "Jev command failed.";
    logger.debug({ message }, "Jev command failed");
    out.log.error(message);
    process.exitCode = 1;
}
