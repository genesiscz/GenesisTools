/**
 * The YouTube-flavored door to the chrome-devtools launcher: build THIS
 * extension, prove the build is complete, then hand the launch to
 * `@app/chrome-devtools/lib/launch`. Every browser/CDP mechanic (executable
 * lookup, piped stdio, cold-profile wait, log tail on failure) lives there.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchCdpBrowser } from "@app/chrome-devtools/lib/launch";
import { buildExtension } from "@app/youtube/commands/extension";

const DEFAULT_PORT = 9333;

export interface LaunchDevtoolsBrowserResult {
    pid: number;
    port: number;
    userDataDir: string;
    dist: string;
}

/**
 * Launches Chrome/Brave with the built YouTube extension pre-loaded and a
 * remote-debugging port open, so an MCP client (see mcp-client.ts) or any
 * other CDP tool can attach to a browser that already has the extension
 * installed — no manual chrome://extensions "Load unpacked" step, no fragile
 * pixel-coordinate clicking to drive it.
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
    // A partial build makes Chrome raise a BLOCKING GUI "failed to load
    // extension" dialog; until someone clicks it the browser never finishes
    // starting, which looks exactly like a hung CDP port from the outside.
    // Catch it here, before launch, rather than after a 30s timeout.
    for (const required of ["manifest.json", "background.js", "content-script.js", "popup/popup.html"]) {
        if (!(await Bun.file(`${dist}/${required}`).exists())) {
            throw new Error(`${dist} is missing ${required} — the build did not produce a complete extension.`);
        }
    }

    // A fresh dir per launch, not the shared /tmp/cdp-profile-<port>: a zombie
    // browser from an earlier run still holds its own profile, and two Chromes
    // on one --user-data-dir is its own failure mode.
    const userDataDir = await mkdtemp(join(tmpdir(), "genesis-yt-devtools-chrome-"));
    const logPath = join(userDataDir, "..", `${userDataDir.split("/").pop()}.log`);
    const launched = await launchCdpBrowser({
        port,
        url: "https://www.youtube.com",
        extension: dist,
        userDataDir,
        // logPath makes the launcher spawn the binary itself and keep its
        // stdio: an all-ignore stdio stalls Chrome before the CDP port opens,
        // and the log is the only account of a failed launch.
        logPath,
    });

    return { pid: launched.pid, port: launched.port, userDataDir, dist };
}
