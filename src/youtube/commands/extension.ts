import { copyFile, mkdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { cdpPortOf } from "@app/chrome-devtools/lib/cdp";
import { reloadExtension, reloadSummary } from "@app/chrome-devtools/lib/extensions";
import { captureFrameGrid } from "@app/chrome-devtools/lib/frame-grid";
import { devtoolsCdpUrl, launchDevtoolsBrowser } from "@app/youtube/lib/devtools/browser";
import * as p from "@clack/prompts";
import { missingManifestFiles, newBuildId, writeBuildInfo } from "@genesiscz/utils/browser-extension/build-info";
import { type DevReloadTarget, startDevReloadServer } from "@genesiscz/utils/browser-extension/dev-reload/server";
import { extensionByKey } from "@genesiscz/utils/browser-extension/registry";
import { createWatcher } from "@genesiscz/utils/fs/watcher";
import { logger } from "@genesiscz/utils/logger";
import { BROWSER_DEVTOOLS_PORT, EXTENSION_TEST_BROWSER_PORT } from "@genesiscz/utils/net/ports";
import { toPosixPath } from "@genesiscz/utils/paths";
import { getWebService } from "@genesiscz/utils/ui/dashboards";
import type { Command } from "commander";
import pc from "picocolors";

/** The dev-reload WebSocket, registered as `youtube-extension` in the port registry. */
const DEV_RELOAD_PORT = getWebService("youtube-extension").port;

/** The port behind this tool's CDP endpoint: explicit flag, then $CDP_URL, then EXTENSION_TEST_BROWSER_PORT. */
function cdpPortFrom(cdpUrl: string | undefined): number {
    const raw = devtoolsCdpUrl(cdpUrl);

    try {
        return cdpPortOf(raw);
    } catch (error) {
        logger.debug(
            { raw, error, port: EXTENSION_TEST_BROWSER_PORT },
            "extension devtools: unusable CDP url, using the default port"
        );

        return EXTENSION_TEST_BROWSER_PORT;
    }
}

/** `list-tools` and `call` drove chrome-devtools-mcp; the same work now goes through our own CDP verbs. */
function mcpTombstone(verb: string): void {
    const port = String(cdpPortFrom(undefined));
    const cdp = (args: string[]) => `tools chrome-devtools ${[...args, "--port", port].join(" ")}`;
    p.log.error(`'extension devtools ${verb}' drove chrome-devtools-mcp, which this repo no longer relies on.
Drive the extension browser with tools chrome-devtools on its port instead:
  ${cdp(["snapshot", "--match", "youtube.com"])}
  ${cdp(["click", '"Summarize"', "--match", "youtube.com"])}
  ${cdp(["fill", '"<label>"', '"<text>"', "--match", "youtube.com"])}
  ${cdp(["eval", "'() => location.href'", "--match", "youtube.com"])}
  ${cdp(["nav", "https://www.youtube.com/watch?v=<id>", "--match", "youtube.com"])}
  ${cdp(["shot", "<file.png>", "--match", "youtube.com"])}
A real chrome-devtools-mcp tool is still one explicit call away: ${cdp(["mcp", "<tool>", "'<json>'"])}`);
    process.exitCode = 1;
}

export function registerExtensionCommand(program: Command): void {
    const cmd = program.command("extension").description("Build the YouTube Chrome extension");

    cmd.command("build")
        .description("Build the extension into dist/extension/")
        .option("--no-reload", "Do not reload the extension in the browser")
        .action(async (opts: { reload: boolean }) => {
            await buildExtension();
            const entry = extensionByKey("youtube");

            if (opts.reload && entry) {
                const result = await reloadExtension({ id: entry.id, page: entry.reloadPage });
                p.log.info(reloadSummary(result, entry));
            }
        });

    cmd.command("reload")
        .description("Reload the extension in the running browser over DevTools (no click)")
        .option("--port <port>", "DevTools port of the running browser", String(BROWSER_DEVTOOLS_PORT))
        .action(async (opts: { port: string }) => {
            const entry = extensionByKey("youtube");

            if (!entry) {
                return;
            }

            const result = await reloadExtension({ id: entry.id, page: entry.reloadPage, port: Number(opts.port) });
            p.log.info(reloadSummary(result, entry));

            if (!result.ok) {
                process.exitCode = 1;
            }
        });

    cmd.command("dev")
        .description("Watch + rebuild + auto-reload the extension in the browser")
        .action(async () => {
            await devExtension();
        });

    const devtools = cmd
        .command("devtools")
        .description(
            `Launch a real, extension-loaded browser with a CDP port; drive it with tools chrome-devtools <verb> --port ${EXTENSION_TEST_BROWSER_PORT}`
        );

    devtools
        .command("launch")
        .description("Build the extension and launch Chrome/Brave with it loaded + a CDP port open")
        .option("-p, --port <port>", "remote debugging port", String(EXTENSION_TEST_BROWSER_PORT))
        .action(async (opts: { port: string }) => {
            const port = Number(opts.port);

            if (!Number.isInteger(port) || port < 1 || port > 65535) {
                p.log.error(`Invalid --port ${opts.port} — expected an integer between 1 and 65535.`);
                process.exitCode = 1;
                return;
            }

            logger.info({ port }, "extension devtools: launching browser");
            const result = await launchDevtoolsBrowser(port);
            logger.info({ pid: result.pid, port: result.port, dist: result.dist }, "extension devtools: browser up");
            p.log.success(`Chrome up (pid ${result.pid}), extension loaded from ${result.dist}`);
            p.log.info(`CDP endpoint: http://127.0.0.1:${result.port}`);
            p.log.info(pc.dim(`Kill it with: kill ${result.pid}`));
        });

    for (const verb of ["list-tools", "call"]) {
        devtools
            .command(verb, { hidden: true })
            .allowUnknownOption(true)
            .allowExcessArguments(true)
            .description(
                `removed: drive the browser with tools chrome-devtools <verb> --port ${EXTENSION_TEST_BROWSER_PORT}`
            )
            .action(() => {
                logger.debug({ verb }, "extension devtools: removed MCP verb called");
                mcpTombstone(verb);
            });
    }

    devtools
        .command("get-frame-grid <outPath>")
        .description(
            "Screenshot the page and overlay a labeled coordinate grid — for locating click targets without guessing"
        )
        .option("--region <x,y,w,h>", "crop to this region first (screenshot pixel space)")
        .option("--step <n>", "grid line spacing in pixels", "40")
        .option(
            "--cdp-url <url>",
            `CDP endpoint of a running browser (default: $CDP_URL or http://127.0.0.1:${EXTENSION_TEST_BROWSER_PORT})`
        )
        .action(async (outPath: string, opts: { region?: string; step: string; cdpUrl?: string }) => {
            logger.info({ outPath, region: opts.region ?? null, step: opts.step }, "extension devtools: frame grid");
            const written = await captureFrameGrid({
                outPath,
                region: opts.region,
                gridStep: Number(opts.step),
                port: cdpPortFrom(opts.cdpUrl),
            });
            logger.debug({ written }, "extension devtools: frame grid written");
            p.log.success(`Labeled grid written to ${written}`);
        });
}

export async function buildExtension(opts: { devReload?: boolean; targets?: string[] } = {}): Promise<string> {
    const root = resolve(import.meta.dirname, "..", "extension");
    const dist = resolve(import.meta.dirname, "..", "..", "..", "dist", "extension");
    const targets = opts.targets ?? ["modules", "content-script"];
    // Two-pass: MV3 content scripts don't support ES module imports, so it
    // has to build as a self-contained IIFE. Background + popup can share
    // chunks and stay ES modules. See extension/vite.config.ts.
    for (const target of targets) {
        const proc = Bun.spawn(["bun", "--bun", "vite", "build", "-c", resolve(root, "vite.config.ts")], {
            stdio: ["inherit", "inherit", "inherit"],
            env: { ...process.env, EXT_TARGET: target, EXT_DEV: opts.devReload ? "1" : "0" },
        });
        const exit = await proc.exited;

        if (exit !== 0) {
            p.log.error(pc.red(`Build failed (target=${target})`));
            process.exitCode = exit;
            throw new Error(`Extension build failed with exit code ${exit}`);
        }
    }

    await mkdir(dist, { recursive: true });
    await copyFile(resolve(root, "manifest.json"), resolve(dist, "manifest.json"));
    await mkdir(resolve(dist, "icons"), { recursive: true });

    for (const name of ["icon16.png", "icon48.png", "icon128.png"]) {
        await copyFile(resolve(root, "icons", name), resolve(dist, "icons", name));
    }

    const missing = await missingManifestFiles(dist);

    if (missing.length > 0) {
        throw new Error(`${dist} is missing ${missing.join(", ")}: the build did not produce a complete extension`);
    }

    await writeBuildInfo(dist, newBuildId());

    p.log.success(`Built to ${dist}. Load it via chrome://extensions → Developer Mode → Load unpacked.`);
    return toPosixPath(dist);
}

async function devExtension(): Promise<void> {
    const dist = resolve(import.meta.dirname, "..", "..", "..", "dist", "extension");
    const srcDir = resolve(import.meta.dirname, "..");

    // The worker of a dev build subscribes to this (`runtime/dev-reload.ts`): content-script rebuilds
    // re-inject into open YouTube tabs (cheap), background rebuilds reload the whole extension.
    const server = startDevReloadServer({ port: DEV_RELOAD_PORT });
    p.log.info(`dev-reload WS ready on ws://127.0.0.1:${server.port}/reload`);

    // Initial build with dev-reload wired in
    await buildExtension({ devReload: true });
    p.log.info(pc.dim(`Load ${dist} in chrome://extensions once. It will auto-reload on every source change.`));

    let pendingTargets = new Set<DevReloadTarget>();
    let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
    let rebuilding = false;
    let rebuildAgain = false;

    async function rebuild(): Promise<void> {
        if (rebuilding) {
            rebuildAgain = true;
            return;
        }
        rebuilding = true;
        const targetsBatch = pendingTargets;
        pendingTargets = new Set();
        // Background change → full runtime reload, content-script change →
        // tabs reload. Both changed → the more-invasive runtime reload wins.
        const buildTargets: string[] = [];
        if (targetsBatch.has("runtime")) {
            // Runtime-classified changes (incl. vite.config.ts) can affect BOTH
            // bundles — rebuild content-script too so it never goes stale, and
            // the runtime reload re-injects it anyway.
            buildTargets.push("modules", "content-script");
        } else if (targetsBatch.has("tabs")) {
            buildTargets.push("content-script");
        }
        if (buildTargets.length === 0) {
            buildTargets.push("modules", "content-script");
        }
        const t0 = Date.now();
        try {
            await buildExtension({ devReload: true, targets: buildTargets });
            const dt = Date.now() - t0;
            const target: DevReloadTarget = targetsBatch.has("runtime") ? "runtime" : "tabs";
            p.log.success(
                pc.dim(`rebuilt ${buildTargets.join("+")} in ${dt}ms → ${target}-reload (${server.clients()} client)`)
            );
            server.broadcast(target);
        } catch (error) {
            p.log.error(pc.red(`rebuild failed: ${error instanceof Error ? error.message : String(error)}`));
        } finally {
            rebuilding = false;
            if (rebuildAgain) {
                rebuildAgain = false;
                queueRebuild();
            }
        }
    }

    function queueRebuild(): void {
        if (rebuildTimer !== null) {
            clearTimeout(rebuildTimer);
        }
        rebuildTimer = setTimeout(() => {
            rebuildTimer = null;
            void rebuild();
        }, 1000);
    }

    // Runtime = full extension reload (orphans content scripts, kills SW).
    // Tabs = re-inject content-script into open YT tabs — page NOT reloaded,
    // video keeps playing. Prefer tabs whenever the change can't have
    // affected background or popup.
    const RUNTIME_PREFIXES = [
        "extension/background",
        "extension/popup",
        "extension/shared/storage",
        "extension/manifest",
        "extension/vite.config",
    ];

    function classify(path: string): DevReloadTarget {
        // Watcher events carry OS-native separators — normalize before the
        // slash-based prefix checks so Windows paths classify correctly.
        const rel = toPosixPath(relative(srcDir, path));
        for (const prefix of RUNTIME_PREFIXES) {
            if (rel.startsWith(prefix)) {
                return "runtime";
            }
        }
        return "tabs";
    }

    p.log.info(pc.dim(`watching ${toPosixPath(srcDir)} via @parcel/watcher`));
    await createWatcher(
        srcDir,
        (events) => {
            for (const e of events) {
                if (!/\.(ts|tsx|css|json|html)$/.test(e.path)) {
                    continue;
                }
                if (toPosixPath(e.path).includes("/commands/extension.")) {
                    continue;
                }
                pendingTargets.add(classify(e.path));
            }
            if (pendingTargets.size > 0) {
                queueRebuild();
            }
        },
        { debounceMs: 200 }
    );

    // The side-panel bundles shared UI from src/utils/ui — watch it too or
    // those edits leave the dev bundle stale. Always a content-script rebuild.
    const sharedUiDir = resolve(import.meta.dirname, "..", "..", "utils", "ui");
    p.log.info(pc.dim(`watching ${toPosixPath(sharedUiDir)} via @parcel/watcher`));
    await createWatcher(
        sharedUiDir,
        (events) => {
            if (events.some((e) => /\.(ts|tsx|css|json|html)$/.test(e.path))) {
                pendingTargets.add("tabs");
                queueRebuild();
            }
        },
        { debounceMs: 200 }
    );

    // Keep the process alive; createWatcher runs in a background addon.
    await new Promise(() => {});
}
