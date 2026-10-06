import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { abortableSleep } from "@genesiscz/utils/async";
import { logger } from "@genesiscz/utils/logger";
import { findFreePort } from "@genesiscz/utils/net/free-port";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { redactBrowserText } from "./action-recording";
import { targets } from "./cdp";
import { defaultSpawnLogged, type LaunchCdpOpts, launchCdpBrowser, type SpawnLoggedFn } from "./launch";
import {
    BROWSERS,
    CDP_PORTS,
    discoverListeningCdpPorts,
    installedBrowsers,
    readDevToolsActivePortsFromDisk,
} from "./resolve-attach";

export interface RecordingBrowser {
    id: string;
    name: string;
}
export interface RecordingTab {
    port: number;
    id: string;
    title: string;
    url: string;
}
export interface OpenedRecordingBrowser {
    browserId: string;
    pid: number;
    port: number;
    userDataDir: string;
    browser: string;
    pages: number;
    logPath: string;
}
interface RecordingBrowserDependencies {
    installed?: () => RecordingBrowser[];
    freePort?: typeof findFreePort;
    spawnLogged?: SpawnLoggedFn;
    probe?: LaunchCdpOpts["probe"];
}
export function recordingBrowsers(): RecordingBrowser[] {
    const installed = new Set(installedBrowsers());
    return BROWSERS.filter((browser) => installed.has(browser.id)).map((browser) => ({
        id: browser.id,
        name: browser.app,
    }));
}
export async function recordingTabs(options: { port?: number; signal?: AbortSignal } = {}): Promise<RecordingTab[]> {
    options.signal?.throwIfAborted();
    if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) {
        throw new Error("Browser debugging port must be between 1 and 65535.");
    }
    const ports =
        options.port === undefined
            ? [...new Set([...CDP_PORTS, ...discoverListeningCdpPorts(), ...readDevToolsActivePortsFromDisk()])]
            : [options.port];
    return (
        await Promise.all(
            ports.map(async (port) => {
                try {
                    return (await targets(port, { signal: options.signal }))
                        .filter((target) => target.type === "page" && /^https?:/.test(target.url))
                        .map((target) => ({
                            port,
                            id: target.id,
                            title: redactBrowserText(target.title),
                            url: redactBrowserText(target.url),
                        }));
                } catch (error) {
                    options.signal?.throwIfAborted();
                    logger.debug({ error, port }, "recording browser endpoint unavailable");
                    return [];
                }
            })
        )
    ).flat();
}
export async function openRecordingBrowser(options: {
    browserId: string;
    url?: string;
    signal?: AbortSignal;
    dependencies?: RecordingBrowserDependencies;
}): Promise<OpenedRecordingBrowser> {
    options.signal?.throwIfAborted();
    const dependencies = options.dependencies ?? {};
    if (!(dependencies.installed ?? recordingBrowsers)().some((browser) => browser.id === options.browserId)) {
        throw new Error("Choose an installed recording browser. Refresh the browser list if it changed.");
    }
    const url = options.url?.trim() || "about:blank";
    if (url !== "about:blank" && !["http:", "https:"].includes(new URL(url).protocol)) {
        throw new Error("The recording browser can open an HTTP URL or about:blank.");
    }
    const port = await (dependencies.freePort ?? findFreePort)();
    const directory = toolDataDir("chrome-devtools", "recording-browsers", crypto.randomUUID());
    await mkdir(directory, { recursive: true });
    const logPath = join(directory, "browser.log");
    let owned: ReturnType<SpawnLoggedFn> | undefined;
    const cancelOwned = () => {
        if (owned) {
            const child = owned;
            owned = undefined;
            try {
                child.kill();
            } catch (error) {
                logger.debug({ error, pid: child.pid }, "recording browser already exited");
            }
        }
    };
    options.signal?.addEventListener("abort", cancelOwned, { once: true });
    try {
        options.signal?.throwIfAborted();
        const result = await launchCdpBrowser({
            browser: options.browserId,
            port,
            url,
            fresh: true,
            logPath,
            probe: dependencies.probe,
            spawnLogged: (command, output) => {
                options.signal?.throwIfAborted();
                owned = (dependencies.spawnLogged ?? defaultSpawnLogged)(command, output);
                options.signal?.throwIfAborted();
                return owned;
            },
            waitFor: async (settings) => {
                const deadline = Date.now() + (settings.timeoutMs ?? 30000);
                while (Date.now() < deadline) {
                    options.signal?.throwIfAborted();
                    if (await settings.probe(settings.port)) {
                        return true;
                    }
                    await abortableSleep(Math.min(500, Math.max(0, deadline - Date.now())), options.signal);
                }
                return false;
            },
        });
        options.signal?.throwIfAborted();
        if (!result.pid || !result.userDataDir) {
            throw new Error("Recording browser launch did not return its owned process and separate profile.");
        }
        logger.info(
            { browserId: options.browserId, pid: result.pid, port, logPath },
            "separate recording browser ready"
        );
        return { ...result, pid: result.pid, userDataDir: result.userDataDir, browserId: options.browserId, logPath };
    } catch (error) {
        cancelOwned();
        throw error;
    } finally {
        options.signal?.removeEventListener("abort", cancelOwned);
    }
}
