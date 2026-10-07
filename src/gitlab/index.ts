#!/usr/bin/env bun

import { commandTree } from "@app/gitlab/commands/pr";
import { buildProgram } from "@app/gitlab/commands/program";
import { errorMessage } from "@app/gitlab/lib/http";
import { rewriteArgv } from "@app/gitlab/lib/pr-argv";
import { runTool } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";

const { program } = buildProgram();

if (import.meta.main) {
    // `gitlab pr <iid> <verb>` and bare groups are rewritten in place, so runTool still sees the real process.argv.
    process.argv.splice(2, process.argv.length - 2, ...rewriteArgv(process.argv.slice(2), commandTree(program)));

    try {
        await runTool(program, { tool: "gitlab" });
    } catch (error) {
        logger.debug({ error }, "gitlab: command failed");
        out.printlnErr(`Error: ${errorMessage(error)}`);
        await out.flush();
        process.exitCode = 1;
    }
}
