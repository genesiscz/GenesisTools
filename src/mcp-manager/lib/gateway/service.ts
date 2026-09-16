/**
 * Durable supervision for the local MCP gateway.
 *
 * `ensureGatewayUp` starts an in-process, unref'd listener that dies with the CLI that
 * started it. That is correct for a one-shot command and useless for a harness: every
 * `auth login` printed "logged in" and left no gateway a second later, so the next
 * Claude Code session opened with every gateway-backed server in ConnectionRefused.
 * Observed twice on 2026-09-16.
 *
 * A launchd agent is the supervisor: KeepAlive restarts the gateway when it dies, and
 * RunAtLoad brings it back after a reboot. The gateway re-reads the unified config on
 * every request, so a config change needs no restart here and no reconnect in a harness
 * that is already connected.
 */
import { join, resolve } from "node:path";
import {
    installLaunchd,
    isLaunchdInstalled,
    plistPath,
    startLaunchd,
    uninstallLaunchd,
} from "@genesiscz/utils/DashboardApp/launchd";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { gatewayHealth } from "./health.ts";

export const GATEWAY_LAUNCHD_LABEL = "com.genesis-tools.mcp-gateway";

export function gatewayLogFile(): string {
    return join(env.tools.getHome(), ".genesis-tools", "logs", "mcp-gateway.log");
}

export function gatewayPlistPath(): string {
    return plistPath(GATEWAY_LAUNCHD_LABEL);
}

export function isGatewayServiceInstalled(): boolean {
    return isLaunchdInstalled(GATEWAY_LAUNCHD_LABEL);
}

/** This checkout's root, four levels up from lib/gateway. */
export function gatewayRepoRoot(): string {
    return resolve(import.meta.dir, "..", "..", "..", "..");
}

/**
 * `bun` is named explicitly, and the entrypoint is an absolute path into this checkout.
 *
 * Neither is decoration. A launchd agent gets no login shell, so its PATH holds only what
 * the plist sets, and `~/.bun/bin` is not in it: launching the `tools` script directly let
 * its `#!/usr/bin/env bun` shebang fail with `env: bun: No such file or directory`, and the
 * job died with exit 127 on every KeepAlive respawn. Observed 2026-09-16 16:16.
 * `resolveCommandForLaunchd` turns the bare `bun` into an absolute path and then puts its
 * directory on the agent's PATH.
 */
function gatewayCommand(): string[] {
    return ["bun", join(gatewayRepoRoot(), "tools"), "mcp-manager", "gateway", "start"];
}

export async function installGatewayService(): Promise<void> {
    await installLaunchd({
        label: GATEWAY_LAUNCHD_LABEL,
        command: gatewayCommand(),
        cwd: gatewayRepoRoot(),
        logFile: gatewayLogFile(),
    });
}

export async function uninstallGatewayService(): Promise<void> {
    await uninstallLaunchd(GATEWAY_LAUNCHD_LABEL);
}

/**
 * Wait for the gateway to answer its own health probe.
 *
 * `launchctl kickstart` returns as soon as launchd has spawned the job, which is well
 * before Bun has parsed the tool and bound the port. Reporting "up" on the kickstart's
 * exit code alone is the same false green as trusting a stale listener.
 */
export async function waitForGatewayHealth(
    listen: { host: string; port: number },
    opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<"ok" | "stranger" | "down"> {
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const intervalMs = opts.intervalMs ?? 300;
    const deadline = Date.now() + timeoutMs;
    let last: "ok" | "stranger" | "down" = "down";

    while (Date.now() < deadline) {
        last = await gatewayHealth(listen.host, listen.port);

        if (last === "ok" || last === "stranger") {
            return last;
        }

        await Bun.sleep(intervalMs);
    }

    logger.warn({ listen, timeoutMs }, "gateway did not become healthy before the deadline");

    return last;
}

/**
 * Bring the launchd-managed gateway up. Returns false when no agent is installed, so
 * the caller can fall back to an in-process listener instead of failing.
 */
export async function startGatewayService(listen: { host: string; port: number }): Promise<boolean> {
    if (!isGatewayServiceInstalled()) {
        return false;
    }

    await startLaunchd(GATEWAY_LAUNCHD_LABEL);
    const health = await waitForGatewayHealth(listen);

    if (health !== "ok") {
        logger.warn({ health, label: GATEWAY_LAUNCHD_LABEL }, "launchd gateway agent did not answer /health");
    }

    return health === "ok";
}
