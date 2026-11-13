import { runHostedChild } from "@app/mcp-manager/lib/gateway/hosted-child";
import { logger } from "@genesiscz/utils/logger";
import { closeHostedGenesisTools, serveHostedGenesisTools } from "./lib/hosted";

// The genesis-tools MCP server in the gateway's child process (src/mcp-manager/lib/gateway/hosted.ts). The handler is
// imported statically, so the child sees an edit to any module it loaded and exits for the new code.
// The gateway stops a child with SIGTERM (`proc.kill()`): close what the loaded tool groups hold first, so a Chrome
// worker or a Waze tab never outlives it. A close that hangs gets 5 s.
let stopping = false;
const stop = (signal: string): void => {
    if (stopping) {
        return;
    }

    stopping = true;
    logger.info({ signal }, "genesis-tools hosted child: closing loaded tool groups");
    void Promise.race([closeHostedGenesisTools(), Bun.sleep(5_000)]).finally(() => process.exit(0));
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

await runHostedChild(serveHostedGenesisTools);
