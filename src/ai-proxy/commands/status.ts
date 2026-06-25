import { runAiProxyStatus } from "@app/ai-proxy/lib/lifecycle";
import { out } from "@app/logger";

export async function runStatusCommand(options: { json?: boolean }): Promise<void> {
    const status = await runAiProxyStatus();

    if (options.json) {
        out.result(status);
        return;
    }

    out.log.info(`Config:       ${status.configPath}`);
    out.log.info(`Exposure:     ${status.exposureMode}`);
    out.log.info(`Proxy:        ${status.proxyRunning ? `running (pid ${status.proxyPid})` : "stopped"}`);
    out.log.info(`Local health: ${status.localHealth ? "ok" : "fail"} — ${status.localUrl}`);

    if (status.publicUrl) {
        out.log.info(`Public URL:   ${status.publicUrl}`);
        out.log.info(`Public health:${status.publicHealth ? " ok" : " fail"}`);
        out.log.info(`Cursor URL:   ${status.cursorUrl}`);
    }

    if (status.tunnelPid) {
        out.log.info(`Tunnel pid:   ${status.tunnelPid} (not stopped by ai-proxy down)`);
    }

    out.log.info(`Logs:         ${status.logPath}`);
}
