import { out } from "@app/logger";
import type { CliArgs } from "@app/mcp-tsc/core/interfaces.js";
import { killAllServers, killServerForDir } from "@app/mcp-tsc/utils/ServerManager.js";

export class KillServerCommand {
    constructor(private cwd: string) {}

    async execute(argv: CliArgs): Promise<void> {
        if (argv.all) {
            // Kill all servers
            const killed = await killAllServers();
            if (killed > 0) {
                out.println(`✓ Killed ${killed} server(s)`);
            } else {
                out.println("No servers running");
            }
        } else {
            // Kill server for current directory
            const killed = await killServerForDir(this.cwd);
            if (killed) {
                out.println(`✓ Killed server for ${this.cwd}`);
            } else {
                out.println("No server running for current directory");
            }
        }
    }
}
