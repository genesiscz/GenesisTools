import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForPath } from "@genesiscz/utils/fs/watcher";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("chrome-devtools-headless");

const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export interface HeadlessChrome {
    port: number;
    close(): void;
}

/**
 * A HEADLESS Chrome on a throwaway profile with a debugger port Chrome picks itself. It never
 * touches the user's browser, profile or screen, which is what a check or a benchmark needs.
 */
export async function launchHeadlessChrome(
    options: { binary?: string; timeoutMs?: number } = {}
): Promise<HeadlessChrome> {
    const binary = options.binary ?? DEFAULT_CHROME;
    const profile = mkdtempSync(join(tmpdir(), "gt-headless-chrome-"));
    const chrome = Bun.spawn(
        [
            binary,
            "--headless=new",
            "--remote-debugging-port=0",
            `--user-data-dir=${profile}`,
            "--no-first-run",
            "--no-default-browser-check",
            "about:blank",
        ],
        { stdout: "ignore", stderr: "ignore" }
    );
    const close = () => {
        chrome.kill();
        try {
            rmSync(profile, { recursive: true, force: true });
        } catch (error) {
            log.debug({ error, profile }, "could not remove the throwaway Chrome profile");
        }
    };
    const timeoutMs = options.timeoutMs ?? 20_000;
    const portFile = join(profile, "DevToolsActivePort");
    if (!(await waitForPath(portFile, { timeoutMs }))) {
        close();
        throw new Error(`headless Chrome (${binary}) did not publish DevToolsActivePort within ${timeoutMs} ms`);
    }

    const port = Number((await Bun.file(portFile).text()).split("\n")[0]);
    log.info({ binary, port, profile }, "headless Chrome started");
    return { port, close };
}
