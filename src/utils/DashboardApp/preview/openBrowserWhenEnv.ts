import { spawn } from "node:child_process";
import { logger } from "@app/logger";
import { waitForUrlReady } from "../readiness";

/** Opens `url` when lifecycle set `DASHBOARD_OPEN_BROWSER=1`. */
export async function openBrowserWhenDashboardEnv(url: string, timeoutMs = 20_000): Promise<void> {
    if (process.env.DASHBOARD_OPEN_BROWSER !== "1") {
        return;
    }

    const ready = await waitForUrlReady(url, timeoutMs);

    if (!ready.ready) {
        logger.warn({ url, detail: ready.detail }, "dashboard browser open skipped — page not ready");
        return;
    }

    const [cmd, args] =
        process.platform === "darwin"
            ? (["open", [url]] as const)
            : process.platform === "win32"
              ? (["cmd", ["/c", "start", "", url]] as const)
              : (["xdg-open", [url]] as const);
    const opener = spawn(cmd, args, { stdio: "ignore", detached: true });
    opener.on("error", (err) => {
        logger.debug({ err, cmd }, "failed to auto-open browser");
    });
    opener.unref();
}
