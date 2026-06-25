import { runAiProxyDown } from "@app/ai-proxy/lib/lifecycle";
import { out } from "@app/logger";

export async function runDownCommand(): Promise<void> {
    const result = await runAiProxyDown();

    if (result.stopped) {
        out.log.success(result.message);
        return;
    }

    out.log.info(result.message);
}
