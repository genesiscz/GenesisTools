/**
 * Preload script: swaps in extension-capable SQLite before any Database is
 * created in the process. Wired into the `tools` launcher (see `tools`,
 * executeTool) and into bunfig.toml's `preload`.
 *
 * Uses sqlite-vec-bootstrap (no @app/* imports) so Bun preloads keep working
 * when invoked from another cwd (tools launcher, IDE hooks).
 */
import { ensureExtensionCapableSQLiteCore } from "./sqlite-vec-bootstrap";

ensureExtensionCapableSQLiteCore();
