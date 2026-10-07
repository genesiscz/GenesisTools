import { applyTlsAcceptFlag } from "./client";

/**
 * The Jenkins MCP entry shared by `tools jenkins mcp` and the older `tools jenkins-mcp`: with
 * arguments it runs the CLI (stages, log, monitor, ...), without it serves MCP over stdio.
 */
export async function runEntry(rawArgv: string[]): Promise<void> {
    const argv = applyTlsAcceptFlag(rawArgv);

    if (argv.length > 0) {
        const { runCli } = await import("./cli");
        await runCli(argv);
    } else {
        const { runMcp } = await import("./mcp");
        await runMcp();
    }
}
