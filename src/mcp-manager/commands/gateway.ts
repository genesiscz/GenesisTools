import { readUnifiedConfig } from "@app/mcp-manager/utils/config.utils.js";
import { suggestCommand } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { logger } from "@genesiscz/utils/logger";
import { GATEWAY_HEADER } from "../lib/auth/constants.ts";
import { gatewayListen } from "../lib/auth/project.ts";
import { ensureGatewayClientToken, rotateGatewayClientToken } from "../lib/auth/secrets.ts";
import { ensureGatewayUp, gatewayHealth, stopInProcessGateways } from "../lib/gateway/ensure.ts";
import { startGatewayServer } from "../lib/gateway/server.ts";
import {
    GATEWAY_LAUNCHD_LABEL,
    gatewayLogFile,
    gatewayPlistPath,
    installGatewayService,
    isGatewayServiceInstalled,
    startGatewayService,
    uninstallGatewayService,
    waitForGatewayHealth,
} from "../lib/gateway/service.ts";
import { runStdioHttpRelay } from "../lib/gateway/stdio-relay.ts";

/** `undefined` means the caller passed something that is not a usable port. */
function resolvePort(raw: string | undefined, fallback: number): number | undefined {
    if (raw === undefined) {
        return fallback;
    }

    const parsed = Number(raw);

    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        return undefined;
    }

    return parsed;
}

export async function gatewayStart(opts: { port?: string } = {}): Promise<void> {
    const config = await readUnifiedConfig();
    const listen = gatewayListen(config);
    const port = resolvePort(opts.port, listen.port);

    if (port === undefined) {
        logger.error(`invalid --port ${opts.port}: expected an integer between 1 and 65535`);
        process.exitCode = 1;

        return;
    }

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

    // Both signals, and both listeners removed on the way out: `gateway start` is the
    // one long-lived path, so a SIGTERM from a supervisor left Bun.serve holding the
    // port while the process died around it.
    await new Promise<void>((resolve) => {
        const shutdown = (): void => {
            process.off("SIGINT", shutdown);
            process.off("SIGTERM", shutdown);
            handle.stop();
            resolve();
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
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

    // Deliberately not "stopped the gateway". This process can only stop listeners it
    // started; there is no pidfile, so a `gateway start` running in another terminal is
    // stopped by interrupting THAT terminal. A pidfile-based cross-process stop is a
    // feature, not a fix, and is not in this PR.
    ui.ok(`stopped ${stopped} gateway listener(s) started by this process`);
}

export async function gatewayStatus(): Promise<void> {
    const config = await readUnifiedConfig();
    const listen = gatewayListen(config);
    const health = await gatewayHealth(listen.host, listen.port);
    const supervised = isGatewayServiceInstalled();
    ui.kv("listen", `${listen.host}:${listen.port}`);
    ui.kv("health", health);
    ui.kv("service", supervised ? `launchd ${GATEWAY_LAUNCHD_LABEL}` : "none (dies with the CLI that started it)");

    if (health !== "ok") {
        const fix = supervised ? ["gateway", "up"] : ["gateway", "install"];
        ui.dim(`    fix: ${suggestCommand("tools mcp-manager", { replaceCommand: fix })}`);
    }
}

export async function gatewayUp(): Promise<void> {
    const config = await readUnifiedConfig();
    const listen = gatewayListen(config);
    const health = await gatewayHealth(listen.host, listen.port);

    if (health === "ok") {
        ui.ok(`already listening on ${listen.host}:${listen.port}`);

        return;
    }

    if (health === "stranger") {
        logger.error(`port ${listen.port} is in use by another process`);
        process.exitCode = 1;

        return;
    }

    if (!isGatewayServiceInstalled()) {
        logger.error("no launchd agent installed, so there is nothing to bring up in the background");
        ui.dim(`    ${suggestCommand("tools mcp-manager", { replaceCommand: ["gateway", "install"] })}`);
        process.exitCode = 1;

        return;
    }

    if (await startGatewayService(listen)) {
        ui.ok(`mcp gateway on http://${listen.host}:${listen.port}`);

        return;
    }

    logger.error("the launchd agent was started but never answered /health");
    ui.dim(`    log: ${gatewayLogFile()}`);
    process.exitCode = 1;
}

export async function gatewayInstall(): Promise<void> {
    if (process.platform !== "darwin") {
        logger.error("the launchd agent is macOS only");
        process.exitCode = 1;

        return;
    }

    const config = await readUnifiedConfig();
    const listen = gatewayListen(config);
    await installGatewayService();
    ui.ok(`installed ${GATEWAY_LAUNCHD_LABEL}`);
    ui.dim(`    plist ${gatewayPlistPath()}`);
    ui.dim(`    log   ${gatewayLogFile()}`);

    const health = await waitForGatewayHealth(listen);

    if (health === "ok") {
        ui.ok(`mcp gateway on http://${listen.host}:${listen.port}`);

        return;
    }

    logger.error(`the agent is loaded but /health says ${health}`);
    process.exitCode = 1;
}

export async function gatewayUninstall(): Promise<void> {
    if (!isGatewayServiceInstalled()) {
        ui.warn("no launchd agent installed");

        return;
    }

    await uninstallGatewayService();
    ui.ok(`removed ${GATEWAY_LAUNCHD_LABEL}`);
    // Deliberately not "the gateway is stopped": launchctl unload ends the job, but a
    // gateway someone started by hand in a terminal is a different process and survives.
    ui.dim("    a gateway started by hand in a terminal is unaffected");
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
    const token = await ensureGatewayClientToken();
    const target = `http://${listen.host}:${listen.port}/mcp/${encodeURIComponent(serverName)}`;

    logger.info({ target }, "stdio trampoline to mcp gateway");

    await runStdioHttpRelay({
        url: target,
        headers: { [GATEWAY_HEADER]: token },
        stdin: Bun.stdin.stream(),
        stdout: Bun.stdout,
    });
}
