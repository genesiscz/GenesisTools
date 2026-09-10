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

    const handle = await startGatewayServer(config, { hostname: listen.host, port });
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
    stopInProcessGateways();
    ui.ok("stopped in-process gateway (launchd agents need gateway uninstall)");
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
    ui.dim(`resync with ${suggestCommand("tools mcp-manager", { replaceCommand: ["sync", "-p", "all", "-y"] })}`);
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
