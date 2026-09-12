import { readUnifiedConfig } from "@app/mcp-manager/utils/config.utils.js";
import { suggestCommand } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { logger } from "@genesiscz/utils/logger";
import { GATEWAY_HEADER } from "../lib/auth/constants.ts";
import { gatewayListen } from "../lib/auth/project.ts";
import { rotateGatewayClientToken } from "../lib/auth/secrets.ts";
import { ensureGatewayUp, gatewayHealth, stopInProcessGateways } from "../lib/gateway/ensure.ts";
import { startGatewayServer } from "../lib/gateway/server.ts";

export async function gatewayStart(opts: { port?: string; detach?: boolean } = {}): Promise<void> {
    const config = await readUnifiedConfig();
    const listen = gatewayListen(config);
    const port = opts.port ? Number(opts.port) : listen.port;
    const health = await gatewayHealth(listen.host, port);

    if (health === "ok") {
        ui.ok(`already listening on ${listen.host}:${port}`);

        return;
    }

    if (health === "stranger") {
        logger.error(`port ${port} is in use by another process`);
        process.exitCode = 1;

        return;
    }

    const handle = await startGatewayServer(config, {
        hostname: listen.host,
        port,
        readConfig: readUnifiedConfig,
    });
    ui.ok(`mcp gateway on http://${handle.hostname}:${handle.port}`);

    if (opts.detach) {
        return;
    }

    await new Promise<void>((resolve) => {
        process.on("SIGINT", () => {
            handle.stop();
            resolve();
        });
    });
}

export async function gatewayStop(): Promise<void> {
    // `started` is a module-level array in THIS process, so a fresh CLI invocation can
    // only ever stop a gateway it started itself. It printed "stopped" regardless,
    // which is the answer that made a wedged gateway look unfixable.
    const stopped = stopInProcessGateways();

    if (stopped === 0) {
        ui.warn("no gateway running in this process — nothing to stop here");
        ui.dim(`    a gateway started elsewhere is not reachable from this process`);
        ui.dim(`    check: ${suggestCommand("tools mcp-manager", { replaceCommand: ["gateway", "status"] })}`);

        return;
    }

    ui.ok(`stopped ${stopped} in-process gateway(s) (launchd agents need gateway uninstall)`);
}

export async function gatewayStatus(): Promise<void> {
    const config = await readUnifiedConfig();
    const listen = gatewayListen(config);
    const health = await gatewayHealth(listen.host, listen.port);
    ui.kv("listen", `${listen.host}:${listen.port}`);
    ui.kv("health", health);

    if (health !== "ok") {
        ui.dim(`    fix: ${suggestCommand("tools mcp-manager", { replaceCommand: ["gateway", "start"] })}`);
    }
}

export async function gatewayRotateClient(): Promise<void> {
    await rotateGatewayClientToken();
    ui.ok("rotated local gateway client token");
    // A running gateway now re-reads on mismatch, so it follows the rotation. The
    // HARNESS configs still carry the old token in their headers, and nothing else
    // rewrites them, so every harness stays 401'd until this resync runs. That is a
    // config write across every provider, so it stays an explicit user action.
    ui.warn("every harness config still carries the OLD token and will be refused until you resync");
    ui.dim(`    ${suggestCommand("tools mcp-manager", { replaceCommand: ["sync", "-p", "all", "-y"] })}`);
}

export async function gatewayStdio(serverName: string | undefined): Promise<void> {
    if (!serverName) {
        logger.error("--server required");
        process.exitCode = 1;

        return;
    }

    const config = await readUnifiedConfig();
    await ensureGatewayUp(config);
    const listen = gatewayListen(config);
    const { ensureGatewayClientToken } = await import("../lib/auth/secrets.ts");
    const token = await ensureGatewayClientToken();
    const target = `http://${listen.host}:${listen.port}/mcp/${encodeURIComponent(serverName)}`;

    logger.info({ target }, "stdio trampoline to mcp gateway");

    const { runStdioHttpRelay } = await import("../lib/gateway/stdio-relay.ts");
    await runStdioHttpRelay({
        url: target,
        headers: { [GATEWAY_HEADER]: token },
        stdin: Bun.stdin.stream(),
        stdout: Bun.stdout,
    });
}
