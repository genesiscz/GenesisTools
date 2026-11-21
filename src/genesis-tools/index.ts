#!/usr/bin/env bun
import { runTool } from "@genesiscz/utils/cli";
import type { LazyRegistrar } from "@genesiscz/utils/cli/lazy-registrars";
import { Command } from "commander";

const program = new Command()
    .name("genesis-tools")
    .description(
        "Developer tools for GenesisTools itself: what failed, crashed or ran slow, and who ran it; what of it this Mac has"
    );

const registrars: LazyRegistrar[] = [
    { names: ["action"], load: async () => (await import("./commands/action")).registerActionCommand },
    { names: ["config"], load: async () => (await import("./commands/config")).registerConfigCommand },
    { names: ["request"], load: async () => (await import("./commands/request")).registerRequestCommand },
    { names: ["serve"], load: async () => (await import("./commands/serve")).registerServeCommand },
    { names: ["env"], load: async () => (await import("./commands/env")).registerEnvCommand },
    { names: ["logs"], load: async () => (await import("./commands/logs")).registerLogsCommand },
    { names: ["probe"], load: async () => (await import("./commands/probe")).registerProbeCommand },
    { names: ["triage"], load: async () => (await import("./commands/triage")).registerTriageCommand },
    { names: ["worktree"], load: async () => (await import("./commands/worktree")).registerWorktreeCommand },
];

if (import.meta.main) {
    await runTool(program, { tool: "genesis-tools", registrars });
}
