import type { CliArgs } from "@app/mcp-tsc/core/interfaces.js";
import { killAllServers, killServerForDir } from "@app/mcp-tsc/utils/ServerManager.js";

export class KillServerCommand {
    constructor(private cwd: string) {}

    async execute(argv: CliArgs): Promise<void> {
        if (argv.all) {
            // Kill all servers
            const killed = await killAllServers();
            if (killed > 0) {
                console.log(`✓ Killed ${killed} server(s)`);
            } else {
                console.log("No servers running");
            }
        } else {
            // Kill server for current directory
            const killed = await killServerForDir(this.cwd);
            if (killed) {
                console.log(`✓ Killed server for ${this.cwd}`);
            } else {
                console.log("No server running for current directory");
            }
        }
    }
}
