import type { Stats } from "node:fs";
import { resolve, sep } from "node:path";
import { debounce } from "@genesiscz/utils/async";
import { logger } from "@genesiscz/utils/logger";
import chokidar from "chokidar";

export interface PreviewServerWatchGlobsOptions {
    toolRoot: string;
    uiDir: string;
    /** Extra paths (files or directories) beyond the standard UI/server set. */
    extraGlobs?: string[];
    /** When set, watched for preview restart (e.g. SSE reload injector). */
    previewReloadPath?: string;
    /** Tool config at tool root (e.g. config.ts). */
    toolConfigPath?: string;
    /** Server/lib directory under tool root. Default `<toolRoot>/lib`. */
    libDir?: string;
}

/** Default globs for Vite preview middleware / API code outside `ui/src`. */
export function buildPreviewServerWatchGlobs(opts: PreviewServerWatchGlobsOptions): string[] {
    const libDir = opts.libDir ?? resolve(opts.toolRoot, "lib");
    const globs = [resolve(opts.uiDir, "vite-middleware.ts"), resolve(opts.uiDir, "vite.config.ts"), libDir];

    if (opts.previewReloadPath) {
        globs.push(opts.previewReloadPath);
    }

    if (opts.toolConfigPath) {
        globs.push(opts.toolConfigPath);
    }

    if (opts.extraGlobs) {
        globs.push(...opts.extraGlobs);
    }

    return globs;
}

const IGNORED_WATCH_DIRS = new Set(["node_modules", "dist", ".git", "__snapshots__"]);
const SERVER_SOURCE_FILE = /\.(?:ts|tsx|mts|cts)$/;

/**
 * The watched entries are whole directories, so without this every fixture,
 * markdown file and build artefact under them restarts the Vite preview. Only
 * non-test TypeScript can change the preview's server behaviour.
 */
export function isWatchedPreviewServerPath(path: string, stats?: Stats): boolean {
    if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) {
        return false;
    }

    if (path.split(sep).some((segment) => IGNORED_WATCH_DIRS.has(segment))) {
        return false;
    }

    // Directories must stay watched or nothing under them is ever seen; only
    // files are filtered by extension.
    if (stats?.isFile() && !SERVER_SOURCE_FILE.test(path)) {
        return false;
    }

    return true;
}

export function watchPreviewServerFiles(opts: {
    globs: string[];
    onChange: () => void | Promise<void>;
    debounceMs?: number;
}): () => void {
    const debounced = debounce(() => {
        void opts.onChange();
    }, opts.debounceMs ?? 400);

    const watcher = chokidar.watch(opts.globs, {
        ignoreInitial: true,
        ignored: (path, stats) => !isWatchedPreviewServerPath(path, stats),
    });

    const onFsEvent = (path: string) => {
        logger.debug({ path }, "preview: server file changed");
        debounced();
    };

    watcher.on("change", onFsEvent).on("add", onFsEvent).on("unlink", onFsEvent);

    return () => {
        void watcher.close();
    };
}
