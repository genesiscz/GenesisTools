/**
 * Preload script: swaps in extension-capable SQLite before any Database is
 * created in the process. Wired into the `tools` launcher (see `tools`,
 * executeTool) and into bunfig.toml's `preload` plus `[test].preload`.
 *
 * Delegates to ensureExtensionCapableSQLite() so the loader's module-level
 * state is set correctly and every later call is a clean no-op.
 *
 * Usage: bun run --preload ./src/utils/search/stores/sqlite-vec-preload.ts <entry>
 */
import { logger } from "@app/logger";
import { ensureExtensionCapableSQLite } from "./sqlite-vec-loader";

ensureExtensionCapableSQLite();
logger.debug("[sqlite-vec-preload] ensureExtensionCapableSQLite() ran at preload time");
