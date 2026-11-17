import { resolve } from "node:path";
import { moduleDir } from "../fs/module-dir";

/** The empty bunfig every GenesisTools bun process starts with (launcher.bunfig.toml says why it is empty). */
export const LAUNCHER_BUNFIG = resolve(moduleDir(import.meta), "launcher.bunfig.toml");

/**
 * The bun flag that keeps the working folder's bunfig.toml, and so its preloads, out of a process. GenesisTools.app
 * lets a bun process skip the vault window (a remembered or auto-allowed approval) only when it carries this flag:
 * without it, a preload of the folder's bunfig.toml can delete its file and change folder before the key is asked
 * for. Only the `=` form works; Bun 1.4.2 runs the argument after a bare `--config` as the program.
 */
export function launcherConfigFlag(): string {
    return `--config=${LAUNCHER_BUNFIG}`;
}
