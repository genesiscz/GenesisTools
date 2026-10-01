/**
 * The YouTube-flavored door to the chrome-devtools launcher: build THIS
 * extension, prove the build is complete, then hand the launch to
 * `@app/chrome-devtools/lib/launch`. Every browser/CDP mechanic (executable
 * lookup, piped stdio, cold-profile wait, log tail on failure) lives there.
 */
import { launchHeadedWithExtension } from "@app/chrome-devtools/lib/extensions";
import { buildExtension } from "@app/youtube/commands/extension";
import { env } from "@genesiscz/utils/env.client";
import { EXTENSION_TEST_BROWSER_PORT } from "@genesiscz/utils/net/ports";

/** The ONE place this tool's endpoint default lives: an explicit URL, then $CDP_URL, then EXTENSION_TEST_BROWSER_PORT. */
export function devtoolsCdpUrl(cdpUrl?: string): string {
    return cdpUrl ?? env.extension.getCdpUrl() ?? `http://127.0.0.1:${EXTENSION_TEST_BROWSER_PORT}`;
}

export interface LaunchDevtoolsBrowserResult {
    pid: number;
    port: number;
    userDataDir: string;
    dist: string;
}

/**
 * Launches Chrome/Brave with the built YouTube extension pre-loaded and a
 * remote-debugging port open, so `tools chrome-devtools <verb> --port <EXTENSION_TEST_BROWSER_PORT>`
 * (snapshot, click, fill, eval, nav, shot, console) can drive a browser that
 * already has the extension installed — no manual chrome://extensions "Load
 * unpacked" step, no fragile pixel-coordinate clicking.
 *
 * Kill the returned pid (or its whole process tree — Chrome forks GPU/
 * renderer/utility helpers under the same --user-data-dir) when done; this
 * function does not manage the browser's lifetime beyond returning it ready.
 */
export async function launchDevtoolsBrowser(port = EXTENSION_TEST_BROWSER_PORT): Promise<LaunchDevtoolsBrowserResult> {
    // Build in-process (not via a separate `tools` invocation) so this always
    // targets the exact dist/ path buildExtension() itself resolves to — a
    // worktree checkout's own guessed-relative dist path can silently diverge
    // from where `tools youtube extension build` actually writes.
    // devReload:true also flips on IS_DEV_BUILD (side-panel.tsx), which gates
    // the advanced/model-override controls in LlmConfirmDialog — a plain build
    // hides those, which is right for production but wrong for a test browser
    // you're specifically trying to poke at.
    const dist = await buildExtension({ devReload: true });
    const launched = await launchHeadedWithExtension({ distDir: dist, port, url: "https://www.youtube.com" });
    return { pid: launched.pid, port: launched.port, userDataDir: launched.userDataDir, dist };
}
