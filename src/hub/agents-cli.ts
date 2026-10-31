import { runTool } from "@genesiscz/utils/cli";
import { env } from "@genesiscz/utils/env";
import { Command } from "commander";
import { registerAgentsCommand } from "./commands/agents";
import { callHubServer } from "./server/client";

// A resident hub server (`tools hub serve`) answers a `--json` ask from its warm caches, the way the app's own calls
// are answered: the mods' agents band asks `hub agents --session <id> --json` every 30 s per session with workers,
// 0.85 s of CPU per process on 2026-10-30 (171 runs in a quiet 3 hours). With no server, or no door for these
// flags, the command does its own work below, as before. The wait is short because the own work costs under a
// second: a server that is draining for new code answered three asks in 7 to 8.5 s with a 5 s wait (2026-10-30 19:10).
if (env.tools.hubServerEnabled() && process.argv.includes("--json")) {
    const answered = await callHubServer({ argv: ["hub", ...process.argv.slice(2)], timeoutMs: 2_500 });

    if (answered) {
        await Promise.all([Bun.write(Bun.stdout, answered.stdout), Bun.write(Bun.stderr, answered.stderr)]);
        process.exit(answered.exit);
    }

    // No server: this process does its own work, and starts the server for the next ask (at most once per five
    // minutes, under the same lock the usage daemon uses). GenesisTools.app is not needed for that: a Mac without
    // the hub part gets the warm answers too. The start runs beside the work below and never fails it.
    const { ensureHubServer } = await import("./server/ensure");
    void ensureHubServer().catch(() => undefined);
}

/** `tools hub agents …` alone (see `index.ts`); `tools hub --help` still lists every command through `cli.ts`. */
const program = new Command()
    .name("hub")
    .description("The GenesisTools.app agent hub: the agents doors (sub-agents, teammates, workers, mail, counts)");

registerAgentsCommand(program);

await runTool(program, { tool: "hub" });
