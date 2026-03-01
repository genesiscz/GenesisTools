import logger from "@app/logger";
import type { WatchRuntimeOptions } from "../light/WatchRuntime";
import { runWatchRuntime } from "../light/WatchRuntime";

export async function runWatchInkApp(options: WatchRuntimeOptions): Promise<void> {
    logger.info("Ink runtime is experimental. Falling back to light runtime for this session.");
    await runWatchRuntime({ ...options, daemon: false });
}
