#!/usr/bin/env bun

import { runTool } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
import { Command } from "commander";
import { ZodError } from "zod";
import { registerDashboard } from "./commands/dashboard";
import { registerEvaluation } from "./commands/evaluate";
import { registerExperiment } from "./commands/experiment";
import { registerLogin } from "./commands/login";

const program = new Command().name("tools jev").description("Jev evaluation tools and local experiment workbench");
registerLogin(program);
registerEvaluation(program);
registerExperiment(program);
registerDashboard(program);

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
