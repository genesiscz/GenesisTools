import { copyFile, mkdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { logger, out } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { createWatcher } from "@app/utils/fs/watcher";
import { toPosixPath } from "@app/utils/paths";
import { launchDevtoolsBrowser } from "../../../.claude/skills/chrome-extension-dev/scripts/devtools-browser";
import { captureFrameGrid } from "../../../.claude/skills/chrome-extension-dev/scripts/devtools-frame-grid";
import { withDevtoolsClient } from "../../../.claude/skills/chrome-extension-dev/scripts/devtools-mcp-client";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";

const DEV_RELOAD_PORT = 9877;
type DevReloadTarget = "tabs" | "runtime";

export function registerExtensionCommand(program: Command): void {
    const cmd = program.command("extension").description("Build the YouTube Chrome extension");

    cmd.command("build")
        .description("Build the extension into dist/extension/")
        .action(async () => {
            await buildExtension();
        });

    cmd.command("dev")
        .description("Watch + rebuild + auto-reload the extension in the browser")
        .action(async () => {
            await devExtension();
        });

    const devtools = cmd
        .command("devtools")
        .description("Drive a real, extension-loaded browser via chrome-devtools-mcp as our own MCP client");

    devtools
        .command("launch")
        .description("Build the extension and launch Chrome/Brave with it loaded + a CDP port open")
        .option("-p, --port <port>", "remote debugging port", "9333")
        .action(async (opts: { port: string }) => {
            const result = await launchDevtoolsBrowser(Number(opts.port));
            p.log.success(`Chrome up (pid ${result.pid}), extension loaded from ${result.dist}`);
            p.log.info(`CDP endpoint: http://127.0.0.1:${result.port}`);
            p.log.info(pc.dim(`Kill it with: kill ${result.pid}`));
        });

    devtools
        .command("list-tools")
        .description("List every tool chrome-devtools-mcp exposes")
        .option("--cdp-url <url>", "CDP endpoint of a running browser", "http://127.0.0.1:9333")
        .action(async (opts: { cdpUrl: string }) => {
            await withDevtoolsClient(async (client) => {
                const { tools } = await client.listTools();
                out.result(
                    SafeJSON.stringify(
                        tools.map((t) => ({ name: t.name, description: t.description })),
                        { strict: true }
                    )
                );
            }, { cdpUrl: opts.cdpUrl });
        });

    devtools
        .command("call <toolName> [argsJson]")
        .description("Call one chrome-devtools-mcp tool directly, e.g. `call navigate_page '{\"url\":\"...\",\"type\":\"url\"}'`")
        .option("--cdp-url <url>", "CDP endpoint of a running browser", "http://127.0.0.1:9333")
        .action(async (toolName: string, argsJson: string | undefined, opts: { cdpUrl: string }) => {
            const args = argsJson ? SafeJSON.parse(argsJson, { strict: true }) : {};
            await withDevtoolsClient(async (client) => {
                const result = await client.callTool({ name: toolName, arguments: args as Record<string, unknown> });
                out.result(SafeJSON.stringify(result, { strict: true }));
            }, { cdpUrl: opts.cdpUrl });
        });

    devtools
        .command("get-frame-grid <outPath>")
        .description("Screenshot the page and overlay a labeled coordinate grid — for locating click targets without guessing")
        .option("--region <x,y,w,h>", "crop to this region first (screenshot pixel space)")
        .option("--step <n>", "grid line spacing in pixels", "40")
        .option("--cdp-url <url>", "CDP endpoint of a running browser", "http://127.0.0.1:9333")
        .action(async (outPath: string, opts: { region?: string; step: string; cdpUrl: string }) => {
            await withDevtoolsClient(async (client) => {
                const written = await captureFrameGrid(client, {
                    outPath,
                    region: opts.region,
                    gridStep: Number(opts.step),
                });
                p.log.success(`Labeled grid written to ${written}`);
            }, { cdpUrl: opts.cdpUrl });
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

    p.log.success(`Built to ${dist}. Load it via chrome://extensions → Developer Mode → Load unpacked.`);
    return toPosixPath(dist);
}

async function devExtension(): Promise<void> {
    const dist = resolve(import.meta.dirname, "..", "..", "..", "dist", "extension");
    const srcDir = resolve(import.meta.dirname, "..");

    // WebSocket the extension's background service worker subscribes to. Each
    // message names which reload path to take — content-script rebuilds only
    // need to refresh open YT tabs (cheap), background rebuilds need a full
    // `chrome.runtime.reload()`.
    const clients = new Set<Bun.ServerWebSocket<unknown>>();
    const server = Bun.serve({
        port: DEV_RELOAD_PORT,
        hostname: "127.0.0.1",
        fetch(req, srv) {
            if (srv.upgrade(req)) {
                return undefined;
            }
            return new Response("dev-reload up", { status: 200 });
        },
        websocket: {
            open(ws) {
                clients.add(ws);
                p.log.info(pc.green(`extension SW connected (${clients.size} client)`));
            },
            close(ws) {
                clients.delete(ws);
                p.log.info(pc.dim(`extension SW disconnected (${clients.size} client)`));
            },
            message(_ws, msg) {
                // Ignore keepalive pings the SW sends every 20s to keep itself
                // alive under MV3's idle-shutdown policy.
                if (typeof msg === "string" && msg === "ping") {
                    return;
                }
            },
        },
    });
    p.log.info(`dev-reload WS ready on ws://127.0.0.1:${server.port}/reload`);

    function broadcast(target: DevReloadTarget): void {
        for (const ws of clients) {
            try {
                ws.send(target);
            } catch (error) {
                // A dead socket stays dead — drop it so the client count stays honest.
                clients.delete(ws);
                logger.warn({ error, target }, "extension dev-reload: ws send failed, dropping client");
            }
        }
    }

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
            buildTargets.push("modules");
        }
        if (targetsBatch.has("tabs")) {
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
                pc.dim(`rebuilt ${buildTargets.join("+")} in ${dt}ms → ${target}-reload (${clients.size} client)`)
            );
            broadcast(target);
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
        "extension/dev-reload",
        "extension/shared/storage",
        "extension/manifest",
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
