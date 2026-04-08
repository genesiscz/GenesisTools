import { getDaemonStatus } from "@app/daemon/lib/launchd";

export async function waitForDaemonRestart(
    oldPid: number | null,
    timeoutMs: number,
): Promise<{ running: boolean; pid: number | null } | null> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        await Bun.sleep(1000);

        const status = await getDaemonStatus();

        if (status.running && status.pid && status.pid !== oldPid) {
            return status;
        }
    }

    return null;
}
