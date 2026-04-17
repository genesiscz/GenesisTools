import type { PlainRunOpts } from "@app/doctor/ui/plain";
import { runPlain } from "@app/doctor/ui/plain";
import logger from "@app/logger";

export async function runTui(opts: PlainRunOpts): Promise<void> {
    logger.info("TUI not yet implemented - falling back to plain renderer");
    await runPlain(opts);
}
