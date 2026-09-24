/**
 * The real login the gateway starts when a server has no usable token.
 *
 * It runs as a DETACHED child (`src/mcp-manager/index.ts auth login <server>` in its
 * own session), never inside the gateway and never through the `tools` wrapper. The
 * gateway is a supervised service and restarts whenever it crashes, is kickstarted
 * after a code change, or KeepAlive respawns it; an in-process login died with it,
 * so an approval the user had just clicked landed on a dead callback port with
 * "connection refused". Observed 2026-09-16 18:4x. A child in its own session
 * survives every one of those, and the pending-login record the parent writes with
 * `child.pid` lets the restarted gateway find it instead of opening a second window.
 *
 * Kept out of server.ts so the request handler stays a request handler, and so the
 * launcher's guards can be tested without a browser, a vault or an authorization server.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { readUnifiedConfig } from "@app/mcp-manager/utils/config.utils.js";
import { env } from "@genesiscz/utils/env";
import { watchFileFeed } from "@genesiscz/utils/fs/file-feed-watcher";
import { logger } from "@genesiscz/utils/logger";
import { sendNotification } from "@genesiscz/utils/macos/notifications";
import { serverAuth } from "../auth/policy.ts";
import { autoLoginRefusal, createLoginLauncher, type LoginLauncher } from "./auto-login.ts";
import { pendingLoginPath, readPendingLogin, takeLivePendingLogin, writePendingLogin } from "./login-state.ts";
import { gatewayRepoRoot } from "./service.ts";

/** How long the child may take to register a client and produce its URL. */
const URL_WAIT_MS = 30_000;

export function loginLogFile(server: string): string {
    return join(env.tools.getHome(), ".genesis-tools", "logs", `mcp-login-${encodeURIComponent(server)}.log`);
}

export function loginSpawnArgs(server: string, clientName?: string): string[] {
    const args = [join(gatewayRepoRoot(), "src/mcp-manager/index.ts"), "auth", "login", server, "--worker"];

    if (clientName) {
        args.push("--client-name", clientName);
    }

    return args;
}

export async function runLogin(
    server: string,
    report: (url: string, userCode?: string) => void,
    clientNameOverride?: string
): Promise<void> {
    const config = await readUnifiedConfig();
    const unified = config.mcpServers[server];

    if (!unified) {
        throw new Error(`Unknown server '${server}'`);
    }

    const refusal = autoLoginRefusal(server, unified, clientNameOverride);

    if (refusal) {
        throw new Error(refusal);
    }

    const clientName = clientNameOverride?.trim() || serverAuth(unified)?.clientName?.trim();
    const logFile = loginLogFile(server);
    mkdirSync(dirname(logFile), { recursive: true });
    const fd = openSync(logFile, "a");
    const child = spawn(process.execPath, loginSpawnArgs(server, clientName), {
        cwd: gatewayRepoRoot(),
        detached: true,
        stdio: ["ignore", fd, fd],
        env: env.withoutProxy(),
    });
    closeSync(fd);

    if (child.pid === undefined) {
        throw new Error(`auth login ${server} spawned without a pid; see ${logFile}`);
    }

    await writePendingLogin({ server, pid: child.pid });
    child.unref();
    logger.info({ server, pid: child.pid, logFile }, "gateway spawned a detached MCP login");

    const exited = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (code === 0) {
                resolve();

                return;
            }

            reject(new Error(`auth login ${server} exited with ${signal ?? `code ${code}`}; see ${logFile}`));
        });
    });
    let failure: unknown;
    exited.catch((error) => {
        failure = error;
    });

    const controller = new AbortController();
    const abortWatch = (): void => {
        if (!controller.signal.aborted) {
            controller.abort();
        }
    };
    child.once("exit", abortWatch);
    child.once("error", abortWatch);

    try {
        await watchFileFeed({
            path: pendingLoginPath(server),
            deadlineAt: Date.now() + URL_WAIT_MS,
            signal: controller.signal,
            onChange: async () => {
                if (failure) {
                    return { done: true };
                }

                const pending = readPendingLogin(server);

                if (pending?.url) {
                    report(pending.url, pending.userCode);
                    await notifyLoginUrl(server, pending.url, pending.userCode);

                    return { done: true };
                }
            },
        });
    } finally {
        child.off("exit", abortWatch);
        child.off("error", abortWatch);
        abortWatch();
    }

    await exited;
}

/** One id per server, so the second post REPLACES the first banner rather than stacking. */
function notificationId(server: string): string {
    return `mcp-gateway-login-${server}`;
}

async function notifyLogin(server: string): Promise<void> {
    await sendNotification({
        title: "MCP login needed",
        message: `${server} needs you to sign in. A browser window is opening.`,
        group: "mcp-gateway-login",
        id: notificationId(server),
    });
}

/**
 * Replace the "opening" banner with one that carries the link.
 *
 * A macOS banner set to "Temporary" fades in about five seconds, and the browser window
 * it announced is easy to close by accident. Without the URL on the notification the only
 * way back is a fresh login, which registers another OAuth client and invalidates the
 * window that may still be open. Clicking the body, or the button, re-opens the same one.
 */
async function notifyLoginUrl(server: string, url: string, userCode?: string): Promise<void> {
    await sendNotification({
        title: "MCP login needed",
        message: userCode
            ? `${server} is waiting. Open the login page and enter ${userCode}.`
            : `${server} is waiting for you to sign in. Click to open the login page.`,
        subtitle: new URL(url).host,
        group: "mcp-gateway-login",
        id: notificationId(server),
        open: url,
        actions: [{ id: "open-login", title: "Open login", open: url }],
    });
}

/** Module-level on purpose: the guards are per gateway process, not per request. */
export const gatewayLoginLauncher: LoginLauncher = createLoginLauncher({
    login: runLogin,
    notify: notifyLogin,
    pending: (server) => takeLivePendingLogin(server),
    onError: (server, error) => {
        logger.warn({ server, error }, "gateway-initiated MCP login failed");
    },
});
