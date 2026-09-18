import { fileURLToPath } from "node:url";
import { ReplEngine } from "@app/node-repl/lib/engine";
import { createServer } from "@app/node-repl/mcp/server";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const modulePath = fileURLToPath(new URL("./session.ts", import.meta.url));
export class ComputerReplEngine extends ReplEngine {
    override run(code: string, timeoutMs = this.defaultTimeoutMs) {
        const bootstrap = `globalThis.computer ??= new (await import(${SafeJSON.stringify(modulePath)})).ComputerUse();\n`;
        return super.run(bootstrap + code, timeoutMs);
    }
}
export async function startComputerReplServer(): Promise<void> {
    const engine = new ComputerReplEngine();
    const server = createServer(engine);
    const stop = () => {
        engine.dispose();
        process.exit(0);
    };
    server.onclose = stop;
    process.stdin.once("end", stop);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.once("exit", () => engine.dispose());
    await server.connect(new StdioServerTransport());
    logger.info("Independent Computer Use REPL MCP is listening; global computer is preloaded");
}
