/**
 * The real login the gateway starts when a server has no usable token.
 *
 * It runs as a DETACHED child (`tools mcp-manager auth login <server>` in its own
 * session), never inside the gateway. The gateway is a supervised service and restarts
 * whenever it crashes, is kickstarted after a code change, or KeepAlive respawns it; an
 * in-process login died with it, so an approval the user had just clicked landed on a
 * dead callback port with "connection refused". Observed 2026-09-16 18:4x. A child in
 * its own session survives every one of those, and the pending-login record it writes
 * lets the restarted gateway find it instead of opening a second browser window.
 *
 * Kept out of server.ts so the request handler stays a request handler, and so the
 * launcher's guards can be tested without a browser, a vault or an authorization server.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { sendNotification } from "@genesiscz/utils/macos/notifications";
import { createLoginLauncher, type LoginLauncher } from "./auto-login.ts";
import { readPendingLogin } from "./login-state.ts";
import { gatewayRepoRoot } from "./service.ts";

/** How long the child may take to register a client and produce its URL. */
const URL_WAIT_MS = 30_000;
const URL_POLL_MS = 250;

export function loginLogFile(server: string): string {
    return join(env.tools.getHome(), ".genesis-tools", "logs", `mcp-login-${encodeURIComponent(server)}.log`);
}

async function runLogin(server: string, report: (url: string) => void): Promise<void> {
    const logFile = loginLogFile(server);
    mkdirSync(dirname(logFile), { recursive: true });
    const fd = openSync(logFile, "a");
    // `bun` explicitly and the repo's entrypoint by absolute path, for the same reason the
    // launchd plist does: this process may itself be running under launchd, with no
    // shell and no `tools` on PATH.
    const child = spawn(process.execPath, [join(gatewayRepoRoot(), "tools"), "mcp-manager", "auth", "login", server], {
        cwd: gatewayRepoRoot(),
        detached: true,
        stdio: ["ignore", fd, fd],
        // TOOLS_DETACHED tells the `tools` wrapper not to run its orphan watchdog,
        // which SIGTERMs the tool two seconds after its parent dies. Without it the
        // login died with every gateway restart, session or no session.
        env: { ...process.env, TOOLS_DETACHED: "1" },
    });
    closeSync(fd);
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
    // Surface a fast failure (bad server, DCR refused) through `exited` rather than as
    // an unhandled rejection while the URL poll below is still running.
    let failure: unknown;
    exited.catch((error) => {
        failure = error;
    });

    const deadline = Date.now() + URL_WAIT_MS;

    while (Date.now() < deadline) {
        const url = readPendingLogin(server)?.url;

        if (url) {
            report(url);
            await notifyLoginUrl(server, url);
            break;
        }

        if (failure) {
            break;
        }

        await Bun.sleep(URL_POLL_MS);
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
async function notifyLoginUrl(server: string, url: string): Promise<void> {
    await sendNotification({
        title: "MCP login needed",
        message: `${server} is waiting for you to sign in. Click to open the login page.`,
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
    pending: (server) => readPendingLogin(server),
    onError: (server, error) => {
        logger.warn({ server, error }, "gateway-initiated MCP login failed");
    },
});
