import { fileURLToPath } from "node:url";
import { ReplEngine } from "@app/node-repl/lib/engine";
import { createServer } from "@app/node-repl/mcp/server";
import { TemporaryArtifacts } from "@genesiscz/utils/fs/temporary-artifacts";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const modulePath = fileURLToPath(new URL("./session.ts", import.meta.url));
export class ComputerReplEngine extends ReplEngine {
    private readonly artifacts = new TemporaryArtifacts({ prefix: "computer-repl", maxFiles: 1 });
    private artifactDirectory?: string;
    protected override onWorkerStopped = () => {
        this.artifacts.dispose();
        this.artifactDirectory = undefined;
    };
    protected override prepareCode = (code: string) => {
        this.artifactDirectory ??= this.artifacts.allocateDirectory();
        const bootstrap = `globalThis.computer ??= new (await import(${SafeJSON.stringify(modulePath)})).ComputerUse({artifactDirectory:${SafeJSON.stringify(this.artifactDirectory)}});\n`;
        return bootstrap + code;
    };
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
