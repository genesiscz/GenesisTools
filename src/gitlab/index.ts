#!/usr/bin/env bun

import { commandTree } from "@app/gitlab/commands/pr";
import { buildProgram } from "@app/gitlab/commands/program";
import { rewriteArgv } from "@app/gitlab/lib/pr-argv";
import { runTool } from "@genesiscz/utils/cli";

const { program } = buildProgram();

if (import.meta.main) {
    // `gitlab pr <iid> <verb>` puts the MR first, and a bare group runs its default leaf (lib/pr-argv.ts).
    const tree = commandTree(program);
    await runTool(program, { tool: "gitlab", rewriteArgs: (args) => rewriteArgv(args, tree) });
}
