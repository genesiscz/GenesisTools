import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "@app/logger";
import { buildExtension } from "@app/youtube/commands/extension";

const DEFAULT_PORT = 9333;
const CHROME_CANDIDATES = [
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

async function findChrome(): Promise<string> {
    for (const path of CHROME_CANDIDATES) {
        if (await Bun.file(path).exists()) {
            return path;
        }
    }

    throw new Error(`No Chrome/Brave binary found at any of: ${CHROME_CANDIDATES.join(", ")}`);
}

async function waitForDevtools(port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (res.ok) {
                return;
            }
        } catch (error) {
            logger.debug({ error }, "devtools-browser: devtools port not ready yet, retrying");
        }
        await Bun.sleep(200);
    }

    throw new Error(`Chrome remote debugging port ${port} never came up within ${timeoutMs}ms`);
}

export interface LaunchDevtoolsBrowserResult {
    pid: number;
    port: number;
    userDataDir: string;
    dist: string;
}

/**
 * Launches Chrome/Brave with the built YouTube extension pre-loaded and a
 * remote-debugging port open, so an MCP client (see devtools-mcp-client.ts)
 * or any other CDP tool can attach to a browser that already has the
 * extension installed — no manual chrome://extensions "Load unpacked" step,
 * no fragile pixel-coordinate clicking to drive it.
 *
 * Kill the returned pid (or its whole process tree — Chrome forks GPU/
 * renderer/utility helpers under the same --user-data-dir) when done; this
 * function does not manage the browser's lifetime beyond returning it ready.
 */
export async function launchDevtoolsBrowser(port = DEFAULT_PORT): Promise<LaunchDevtoolsBrowserResult> {
    // Build in-process (not via a separate `tools` invocation) so this always
    // targets the exact dist/ path buildExtension() itself resolves to — a
    // worktree checkout's own guessed-relative dist path can silently diverge
    // from where `tools youtube extension build` actually writes.
    // devReload:true also flips on IS_DEV_BUILD (side-panel.tsx), which gates
    // the advanced/model-override controls in LlmConfirmDialog — a plain build
    // hides those, which is right for production but wrong for a test browser
    // you're specifically trying to poke at.
    const dist = await buildExtension({ devReload: true });
    for (const required of ["manifest.json", "background.js", "content-script.js", "popup/popup.html"]) {
        if (!(await Bun.file(`${dist}/${required}`).exists())) {
            throw new Error(`${dist} is missing ${required} — the build did not produce a complete extension.`);
        }
    }

    const chromeBin = await findChrome();
    const userDataDir = await mkdtemp(join(tmpdir(), "genesis-yt-devtools-chrome-"));
    const logPath = join(userDataDir, "..", `${userDataDir.split("/").pop()}.log`);

    const proc = Bun.spawn(
        [
            chromeBin,
            `--remote-debugging-port=${port}`,
            `--user-data-dir=${userDataDir}`,
            `--load-extension=${dist}`,
            `--disable-extensions-except=${dist}`,
            "--no-first-run",
            "--no-default-browser-check",
            "https://www.youtube.com",
        ],
        // stdio "ignore" on all three streams was observed to make Chrome/Brave
        // stall before opening the CDP port (never spawned renderer helpers,
        // just sat on the GPU process) — piping to a real file avoids that.
        { stdio: ["ignore", Bun.file(logPath), Bun.file(logPath)] }
    );

    try {
        // Cold profile first-run (cert store parsing, extension validation) can
        // take well over 15s — 30s gives it headroom without hanging forever on
        // a genuinely broken launch.
        await waitForDevtools(port, 30_000);
    } catch (error) {
        const log = await Bun.file(logPath)
            .text()
            .catch(() => "(log unreadable)");
        proc.kill();
        throw new Error(`${(error as Error).message}\n--- ${logPath} ---\n${log}`);
    }

    return { pid: proc.pid, port, userDataDir, dist };
}
