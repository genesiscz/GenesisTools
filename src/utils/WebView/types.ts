import type { Logger } from "pino";

/**
 * Backend selection for Bun.WebView.
 *
 * - "webkit": macOS only, uses system WKWebView, no Chromium install, no CDP.
 * - "chrome": cross-platform, drives Chromium-family via CDP.
 *
 * Defaults to "webkit" on macOS, "chrome" on everything else.
 */
export type WebViewBackend = "webkit" | "chrome";

export type ScreenshotFormat = "png" | "jpeg" | "webp";
export type ScreenshotEncoding = "base64" | "binary" | "shmem";

export interface ScreenshotOptions {
    format?: ScreenshotFormat;
    quality?: number;
    encoding?: ScreenshotEncoding;
}

/**
 * DataStore configuration.
 * - "ephemeral" (default): no persistence between instances.
 * - { directory }: persist cookies / localStorage to the given path.
 */
export type DataStoreConfig = "ephemeral" | { directory: string };

export interface WebViewOptions {
    width?: number;
    height?: number;
    url?: string;
    backend?: WebViewBackend;
    consolePipe?: boolean;
    toolName?: string;
    profileKey?: string;
    dataStore?: DataStoreConfig;
    logger?: Logger;
    timeoutMs?: number;
}

export interface NavigateOptions {
    timeoutMs?: number;
    signal?: AbortSignal;
}

export interface EvaluateOptions {
    timeoutMs?: number;
    signal?: AbortSignal;
}

export interface ScreenshotResult {
    data: string | Buffer | SharedArrayBuffer;
    format: ScreenshotFormat;
    encoding: ScreenshotEncoding;
}
