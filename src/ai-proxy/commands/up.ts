import { runAiProxyUp } from "@app/ai-proxy/lib/lifecycle";
import { out } from "@app/logger";

export async function runUpCommand(): Promise<void> {
    const result = await runAiProxyUp();

    if (!result.started && result.pid) {
        out.log.warn(result.message);
        return;
    }

    if (result.started) {
        out.log.success(result.message);
    } else {
        out.log.info(result.message);
    }
}
