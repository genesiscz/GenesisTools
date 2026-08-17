/**
 * Where this tool keeps state.
 *
 * Config and cache live under `~/.genesis-tools/spotify/` like every other tool, so
 * `GENESIS_TOOLS_HOME` relocates them and the test suite can never touch a real profile.
 * The standalone `me:spotify` skill wrote to `~/.config/me-spotify/profiles.json`; that
 * file is still read once, on first run, so an existing setup keeps working.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { Storage } from "@genesiscz/utils/storage/storage";

export const TOOL_NAME = "spotify";

const storage = new Storage(TOOL_NAME);

/**
 * `~/.genesis-tools/spotify/profiles.json` unless `SPOTIFY_CONFIG_PATH` overrides it.
 *
 * The override goes through `expandHome` for the same reason `bootstrapRoots` does: a shell
 * expands `~` before the CLI sees it, but a value set in a config file, a LaunchAgent plist
 * or a `.env` arrives literally, and Node would silently create a directory named `~`.
 */
export function registryPath(): string {
    const configured = env.spotify.getConfigPath();

    return configured ? expandHome(configured) : join(storage.getBaseDir(), "profiles.json");
}

/** `~/.genesis-tools/spotify/cache/` unless `SPOTIFY_CACHE_DIR` overrides it. */
export function cacheDir(): string {
    const configured = env.spotify.getCacheDir();

    return configured ? expandHome(configured) : storage.getCacheDir();
}

/** `~/.genesis-tools/spotify/play/` — the playback plan, progress journal and state file. */
export function playDir(): string {
    return join(storage.getBaseDir(), "play");
}

/** The skill's old registry location, imported once if this tool has none of its own. */
export function legacyRegistryPath(): string {
    return join(homedir(), ".config", "me-spotify", "profiles.json");
}

/**
 * Expand a leading `~`. A shell does this before the CLI ever sees the path, but the
 * dashboard's settings form posts whatever was typed, and `~/Downloads/export` is exactly
 * what people paste.
 */
export function expandHome(input: string): string {
    if (input === "~") {
        return homedir();
    }

    if (input.startsWith("~/")) {
        return join(homedir(), input.slice(2));
    }

    return input;
}

/**
 * Directories checked for a `me` profile when nothing is configured yet. Each must hold
 * `streaming-history/` and/or `data/`.
 *
 * `SPOTIFY_EXPORT_DIR` first, because a tool in a shared repo has no business guessing at one
 * person's directory layout: this used to name the author's own vault path, which would have
 * auto-created a `me` profile on any checkout that happened to share it.
 */
export function bootstrapRoots(): string[] {
    const configured = env.spotify.getExportDir();

    return [...(configured ? [expandHome(configured)] : []), join(homedir(), "Documents", "Spotify")];
}
