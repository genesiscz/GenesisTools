import logger from "@app/logger";
import { Storage } from "@app/utils/storage";

export type BrowserName = "brave" | "safari" | "chrome" | "firefox" | "edge" | "arc";

export interface OpenResult {
    url: string;
    success: boolean;
    error?: string;
}

export interface BrowserOpenOptions {
    /** Override the configured/default browser for this call */
    browser?: BrowserName;
    /** Delay in ms between batch opens (default: 300) */
    staggerMs?: number;
}

const MACOS_APPS: Record<BrowserName, string> = {
    brave: "Brave Browser",
    safari: "Safari",
    chrome: "Google Chrome",
    firefox: "Firefox",
    edge: "Microsoft Edge",
    arc: "Arc",
};

const LINUX_BINARIES: Partial<Record<BrowserName, string>> = {
    brave: "brave-browser",
    chrome: "google-chrome",
    firefox: "firefox",
    edge: "microsoft-edge",
};

export class Browser {
    private static storage = new Storage("genesis-tools");

    static readonly SUPPORTED: readonly BrowserName[] = [
        "brave",
        "safari",
        "chrome",
        "firefox",
        "edge",
        "arc",
    ] as const;

    static async getPreferred(): Promise<BrowserName | undefined> {
        return Browser.storage.getConfigValue<BrowserName>("browser");
    }

    static async setPreferred(browser: BrowserName | undefined): Promise<void> {
        if (browser === undefined) {
            const config = await Browser.storage.getConfig<Record<string, unknown>>();
            if (config && "browser" in config) {
                delete config.browser;
                await Browser.storage.setConfig(config);
            }
        } else {
            await Browser.storage.setConfigValue("browser", browser);
        }
        logger.debug(`Browser preference set to: ${browser ?? "system default"}`);
    }

    static async open(url: string, options?: BrowserOpenOptions): Promise<OpenResult> {
        const browser = options?.browser ?? (await Browser.getPreferred());
        const cmd = Browser.buildCommand(url, browser);

        try {
            const proc = Bun.spawn({ cmd, stdio: ["ignore", "ignore", "ignore"] });
            const exitCode = await proc.exited;

            if (exitCode !== 0) {
                if (browser) {
                    logger.debug(`Browser "${browser}" failed (exit ${exitCode}), falling back to OS default`);
                    return Browser.open(url);
                }
                return { url, success: false, error: `exit code ${exitCode}` };
            }
            return { url, success: true };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (browser) {
                logger.debug(`Browser "${browser}" threw: ${message}, falling back to OS default`);
                return Browser.open(url);
            }
            return { url, success: false, error: message };
        }
    }

    static async openAll(urls: string[], options?: BrowserOpenOptions): Promise<OpenResult[]> {
        if (urls.length === 0) return [];
        const staggerMs = options?.staggerMs ?? 300;
        const results: OpenResult[] = [];

        for (let i = 0; i < urls.length; i++) {
            const result = await Browser.open(urls[i], options);
            results.push(result);
            if (i < urls.length - 1 && staggerMs > 0) {
                await Bun.sleep(staggerMs);
            }
        }
        return results;
    }

    private static buildCommand(url: string, browser?: BrowserName): string[] {
        const platform = process.platform;

        if (browser) {
            if (platform === "darwin") {
                return ["open", "-a", MACOS_APPS[browser], url];
            }
            if (platform === "linux") {
                const binary = LINUX_BINARIES[browser];
                if (binary) return [binary, url];
            }
        }

        // OS default fallback
        if (platform === "darwin") return ["open", url];
        if (platform === "linux") return ["xdg-open", url];
        if (platform === "win32") return ["cmd", "/c", "start", "", url];
        return ["xdg-open", url];
    }
}
