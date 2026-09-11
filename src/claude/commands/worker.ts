import { registerWorkerVerbs } from "@app/ai/commands/agent/worker";
import type { Command } from "commander";
import { claudeWorkerDriver } from "../lib/worker/driver";

/**
 * The worker verbs mount under `worker` on this tool alone, because `tools claude tail`
 * already means something else (a live interactive session). Everything inside is the shared
 * registration; what makes a claude worker a claude worker lives in `claudeWorkerDriver`.
 */
export function registerWorkerCommand(program: Command): void {
    const worker = program
        .command("worker")
        .description("Drive a headless claude -p session pinned to a named account (spawn/steer/read/status/stop)");

    registerWorkerVerbs(worker, claudeWorkerDriver, { tool: "tools claude worker", subcommand: ["worker"] });
}
