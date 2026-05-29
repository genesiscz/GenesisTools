import { resolve } from "node:path";
import { logger } from "@app/logger";
import { debounce } from "@app/utils/async";
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
        ignored: (path) => path.endsWith(".test.ts") || path.endsWith(".test.tsx"),
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
