import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForPath } from "@genesiscz/utils/fs/watcher";
import { logger } from "@genesiscz/utils/logger";
import { browser } from "./cdp";

const { log } = logger.scoped("chrome-devtools-headless");

const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const QUIT_TIMEOUT_MS = 3_000;

export interface HeadlessChrome {
    port: number;
    close(): Promise<void>;
}

/**
 * A HEADLESS Chrome on a throwaway profile with a debugger port Chrome picks itself. It never
 * touches the user's browser, profile or screen, which is what a check or a benchmark needs.
 */
export async function launchHeadlessChrome(
    options: { binary?: string; timeoutMs?: number; extraArgs?: string[] } = {}
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
            ...(options.extraArgs ?? []),
            "about:blank",
        ],
        { stdout: "ignore", stderr: "ignore" }
    );
    let port: number | undefined;
    const close = async () => {
        await quitChrome(chrome, port);
        try {
            rmSync(profile, { recursive: true, force: true });
        } catch (error) {
            log.debug({ error, profile }, "could not remove the throwaway Chrome profile");
        }
    };
    const timeoutMs = options.timeoutMs ?? 20_000;
    const portFile = join(profile, "DevToolsActivePort");
    if (!(await waitForPath(portFile, { timeoutMs }))) {
        await close();
        throw new Error(`headless Chrome (${binary}) did not publish DevToolsActivePort within ${timeoutMs} ms`);
    }

    port = Number((await Bun.file(portFile).text()).split("\n")[0]);
    log.info({ binary, port, profile }, "headless Chrome started");
    return { port, close };
}

/**
 * Asks Chrome to quit over CDP, and kills it only when it does not exit within 3 s. macOS Chrome keeps a copy of its
 * app bundle for each launch (`/var/folders/<user>/X/com.google.Chrome.code_sign_clone/`, about 1.4 GB, Brave has its
 * own) and deletes it only when it quits on its own: a kill signal leaves the copy behind. 102 such copies filled the
 * disk on 2026-10-08; `Browser.close` removed the copy within 2 s.
 */
async function quitChrome(chrome: Bun.Subprocess, port: number | undefined): Promise<void> {
    if (port !== undefined) {
        try {
            const conn = await browser(port);
            // Chrome drops the socket as it quits, so the reply often never comes.
            await conn.send("Browser.close", {}, { timeoutMs: QUIT_TIMEOUT_MS }).catch((error: unknown) => {
                log.debug({ error, port }, "Browser.close got no reply");
            });
            conn.close();
        } catch (error) {
            log.debug({ error, port }, "Browser.close could not reach headless Chrome");
        }

        const exited = await Promise.race([
            chrome.exited.then(() => true),
            Bun.sleep(QUIT_TIMEOUT_MS).then(() => false),
        ]);
        if (exited) {
            return;
        }

        log.warn({ port }, "headless Chrome did not quit after Browser.close; killing it leaves its app copy behind");
    }

    chrome.kill();
    await chrome.exited;
}
