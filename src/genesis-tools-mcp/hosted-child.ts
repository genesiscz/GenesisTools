import { runHostedChild } from "@app/mcp-manager/lib/gateway/hosted-child";
import { serveHostedGenesisTools } from "./lib/hosted";

// The genesis-tools MCP server in the gateway's child process (src/mcp-manager/lib/gateway/hosted.ts). The handler is
// imported statically, so the child sees an edit to any module it loaded and exits for the new code.
await runHostedChild(serveHostedGenesisTools);
