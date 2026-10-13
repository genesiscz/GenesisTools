import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForPath } from "@genesiscz/utils/fs/watcher";
import { logger } from "@genesiscz/utils/logger";
import { CODE_SIGN_CLONE_FEATURE, quitOwnedBrowser, withDisabledFeatures } from "./launch";

const { log } = logger.scoped("chrome-devtools-headless");

const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export interface HeadlessChrome {
    port: number;
    close(): Promise<void>;
}

/**
 * A HEADLESS Chrome on a throwaway profile with a debugger port Chrome picks itself. It never
 * touches the user's browser, profile or screen, which is what a check or a benchmark needs.
 *
 * `userDataDir` runs it on a profile the CALLER prepared (for example a copied IndexedDB). That
 * directory must be new to every browser, and `close()` leaves it in place: only a profile this
 * function created is removed.
 */
export async function launchHeadlessChrome(
    options: { binary?: string; timeoutMs?: number; extraArgs?: string[]; userDataDir?: string } = {}
): Promise<HeadlessChrome> {
    const binary = options.binary ?? DEFAULT_CHROME;
    const ownsProfile = options.userDataDir === undefined;
    const profile = options.userDataDir ?? mkdtempSync(join(tmpdir(), "gt-headless-chrome-"));
    const args = withDisabledFeatures(
        [
            "--headless=new",
            "--remote-debugging-port=0",
            `--user-data-dir=${profile}`,
            "--no-first-run",
            "--no-default-browser-check",
            ...(options.extraArgs ?? []),
        ],
        [CODE_SIGN_CLONE_FEATURE]
    );
    const chrome = Bun.spawn([binary, ...args, "about:blank"], { stdout: "ignore", stderr: "ignore" });
    let port: number | undefined;
    const close = async () => {
        await quitChrome(chrome, port);
        if (!ownsProfile) {
            return;
        }

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

/** Before DevToolsActivePort is published there is no CDP to ask, so only then is a kill the first resort. */
async function quitChrome(chrome: Bun.Subprocess, port: number | undefined): Promise<void> {
    if (chrome.exitCode !== null || chrome.signalCode !== null) {
        return;
    }

    if (port === undefined) {
        chrome.kill();
    } else {
        await quitOwnedBrowser({ port, pid: chrome.pid, kill: () => chrome.kill(), exited: chrome.exited });
    }

    await chrome.exited;
}
