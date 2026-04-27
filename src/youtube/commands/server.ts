import type { Command } from "commander";

const PLAN_4_COMMANDS = ["start", "stop", "status", "install"] as const;

export function registerServerCommand(program: Command): void {
    const cmd = program.command("server").description("Run the YouTube API server");

    for (const name of PLAN_4_COMMANDS) {
        cmd.command(name)
            .description(`Plan 4 will provide youtube server ${name}`)
            .action(() => {
                console.error(`youtube server ${name} is implemented in Plan 4.`);
                process.exitCode = 1;
            });
    }
}
