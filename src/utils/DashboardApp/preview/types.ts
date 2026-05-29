import type { DashboardBindHost } from "../types";

export interface DashboardPreviewPublicProxy {
    stop: (force?: boolean) => void;
}

export interface DashboardPreviewUiOptions {
    /** Short label for logs and startup banners (e.g. "dev-dashboard"). */
    toolLabel: string;
    viteConfigPath: string;
    /** Passed to `loadConfigFromFile` as search root. Defaults to repo root. */
    configRoot?: string;
    /** Vite project root when not set in the loaded config. */
    uiDir?: string;
    resolvePublicPort: () => Promise<number>;
    resolveInternalPort: () => Promise<number>;
    /** Called before binding the public port (e.g. stop stale listeners). */
    beforeListen?: (publicPort: number) => void | Promise<void>;
    startPublicProxy: (opts: {
        publicPort: number;
        internalPort: number;
        bindHost: DashboardBindHost;
    }) => DashboardPreviewPublicProxy | undefined;
    /** Fired after each watch-build `BUNDLE_END` (browser reload hook). */
    onClientRebuild?: () => void;
    /** Paths that require restarting Vite preview, not just client rebuild. */
    serverWatchGlobs: string[];
    resolveBindHost?: () => DashboardBindHost;
    publicUrl?: (publicPort: number) => string;
}
