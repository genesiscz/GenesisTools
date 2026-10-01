import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missingManifestFiles } from "@genesiscz/utils/browser-extension/build-info";
import { logger } from "@genesiscz/utils/logger";
import { BROWSER_DEVTOOLS_PORT } from "@genesiscz/utils/net/ports";
import { browserVersion, Conn, localDebuggerUrl } from "./cdp";
import { type HeadlessChrome, launchHeadlessChrome } from "./headless";
import { launchCdpBrowser } from "./launch";

const { log } = logger.scoped("chrome-devtools-extensions");

interface TargetInfo {
    targetId: string;
    type: string;
    url: string;
}

export type ExtensionReloadResult =
    | { ok: true; message: string }
    | { ok: false; reason: "no-cdp" | "not-loaded" | "failed"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function browserConn(port: number): Promise<Conn | null> {
    if ((await browserVersion(port)) === null) {
        return null;
    }

    try {
        const version: unknown = await (
            await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5_000) })
        ).json();

        if (!isRecord(version) || typeof version.webSocketDebuggerUrl !== "string") {
            return null;
        }

        // Only this machine's socket on this port: whatever answers the port must not redirect the commands.
        return new Conn(localDebuggerUrl({ webSocketDebuggerUrl: version.webSocketDebuggerUrl }, port));
    } catch (error) {
        // The browser quit between the two reads, the read timed out, or the URL was refused.
        log.debug({ error, port }, "no usable DevTools socket on the port");
        return null;
    }
}

/** `promise`, or a rejection naming `what` after `ms`: a socket that stops answering never hangs a reload. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms);
    });

    try {
        return await Promise.race([promise, deadline]);
    } finally {
        clearTimeout(timer);
    }
}

const STEP_MS = 5_000;

export async function extensionTargets(conn: Conn, id: string): Promise<TargetInfo[]> {
    const reply = await conn.send("Target.getTargets");
    const infos = isRecord(reply) && Array.isArray(reply.targetInfos) ? reply.targetInfos : [];
    return infos
        .flatMap((info): TargetInfo[] =>
            isRecord(info) &&
            typeof info.targetId === "string" &&
            typeof info.url === "string" &&
            typeof info.type === "string"
                ? [{ targetId: info.targetId, type: info.type, url: info.url }]
                : []
        )
        .filter((info) => info.url.startsWith(`chrome-extension://${id}/`));
}

/** Resolves when `promise` settles or after `ms`, whichever is first; a reload tears down its own context. */
async function settle<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
    return Promise.race([promise, Bun.sleep(ms).then(() => "timeout" as const)]);
}

/**
 * Reloads an unpacked extension in a running browser over CDP, with no click: attach to one of its
 * contexts (a background tab of `page` when its worker is asleep), run `chrome.runtime.reload()`,
 * close the tab. The browser must serve CDP on `port`; nothing is focused.
 */
export async function reloadExtension({
    id,
    page,
    port = BROWSER_DEVTOOLS_PORT,
}: {
    id: string;
    page: string;
    port?: number;
}): Promise<ExtensionReloadResult> {
    const conn = await browserConn(port);

    if (!conn) {
        return { ok: false, reason: "no-cdp", message: `no browser serves DevTools on port ${port}` };
    }

    let created: string | null = null;

    try {
        const running = (await within(extensionTargets(conn, id), STEP_MS, "Target.getTargets")).find((info) =>
            ["service_worker", "background_page", "page"].includes(info.type)
        );
        let targetId = running?.targetId;

        if (!targetId) {
            const reply = await within(
                conn.send("Target.createTarget", { url: `chrome-extension://${id}/${page}`, background: true }),
                STEP_MS,
                "Target.createTarget"
            );
            created = isRecord(reply) && typeof reply.targetId === "string" ? reply.targetId : null;
            targetId = created ?? undefined;
            // The page needs a moment to create its context before it can evaluate.
            await Bun.sleep(500);
        }

        if (!targetId) {
            return { ok: false, reason: "failed", message: "could not open a page of the extension" };
        }

        const attached = await within(
            conn.send("Target.attachToTarget", { targetId, flatten: true }),
            STEP_MS,
            "Target.attachToTarget"
        );
        const sessionId = isRecord(attached) && typeof attached.sessionId === "string" ? attached.sessionId : undefined;
        const probe = await within(
            conn.send(
                "Runtime.evaluate",
                {
                    expression: "typeof chrome !== 'undefined' && typeof chrome.runtime?.reload === 'function'",
                    returnByValue: true,
                },
                sessionId
            ),
            STEP_MS,
            "the reload probe"
        );
        const usable = isRecord(probe) && isRecord(probe.result) && probe.result.value === true;

        if (!usable) {
            return { ok: false, reason: "not-loaded", message: `extension ${id} is not loaded in this browser` };
        }

        await settle(
            conn
                .send("Runtime.evaluate", { expression: "chrome.runtime.reload()" }, sessionId)
                .catch((error: unknown) => {
                    log.debug({ error, id }, "the reload tore down its own context, as expected");
                }),
            3000
        );
        log.info({ id, port, via: running ? running.type : "background tab" }, "extension reloaded over CDP");
        return { ok: true, message: `reloaded ${id} over DevTools on port ${port}` };
    } catch (error) {
        log.warn({ error, id, port }, "extension reload over CDP failed");
        return { ok: false, reason: "failed", message: error instanceof Error ? error.message : String(error) };
    } finally {
        if (created) {
            await settle(
                conn.send("Target.closeTarget", { targetId: created }).catch((error: unknown) => {
                    log.debug({ error }, "the reload already closed the extension tab");
                }),
                1000
            );
        }

        conn.close();
    }
}

/** A macOS browser's binary by app name, when installed. */
export function browserBinary(app: string): string | null {
    const path = `/Applications/${app}.app/Contents/MacOS/${app}`;
    return existsSync(path) ? path : null;
}

/**
 * A headless browser on a throwaway profile with one unpacked extension loaded. Brave first: current
 * Google Chrome ignores `--load-extension`.
 */
export async function launchWithExtension(distDir: string): Promise<HeadlessChrome> {
    const binary = browserBinary("Brave Browser") ?? browserBinary("Chromium") ?? undefined;
    return launchHeadlessChrome({
        binary,
        extraArgs: [`--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`],
    });
}

/** Opens a CDP connection to a browser and hands it over; the caller closes it. */
export async function connectBrowser(port: number): Promise<Conn> {
    const conn = await browserConn(port);

    if (!conn) {
        throw new Error(`no browser serves DevTools on port ${port}`);
    }

    return conn;
}

/** One line for a CLI after a build: what happened, or what to do by hand. */
export function reloadSummary(result: ExtensionReloadResult, entry: { name: string; distDir: string }): string {
    if (result.ok) {
        return `Reloaded ${entry.name} in the browser (DevTools)`;
    }

    if (result.reason === "no-cdp") {
        return `Reload ${entry.name} by hand: brave://extensions > Reload (the browser serves no DevTools port)`;
    }

    if (result.reason === "not-loaded") {
        return `${entry.name} is not loaded in this browser: brave://extensions > Load unpacked > ${entry.distDir}`;
    }

    return `Could not reload ${entry.name}: ${result.message}`;
}

export interface HeadedExtensionBrowser {
    pid: number;
    port: number;
    userDataDir: string;
}

/**
 * A visible browser with one unpacked extension loaded and a DevTools port open, on a fresh profile
 * of its own, so `tools chrome-devtools <verb> --port <port>` can drive it. The build is checked first:
 * a missing file raises Chrome's blocking "failed to load extension" dialog, which looks like a hang.
 * Kill the returned pid (Chrome forks helpers under the same profile) when done.
 */
export async function launchHeadedWithExtension({
    distDir,
    port,
    url,
}: {
    distDir: string;
    port: number;
    url?: string;
}): Promise<HeadedExtensionBrowser> {
    const missing = await missingManifestFiles(distDir);

    if (missing.length > 0) {
        throw new Error(`${distDir} is missing ${missing.join(", ")}: the build is not a complete extension`);
    }

    // A fresh dir per launch, never a shared one: a zombie browser from an earlier run still holds
    // its profile, and two browsers on one profile is its own failure mode.
    const userDataDir = await mkdtemp(join(tmpdir(), "gt-extension-browser-"));
    const launched = await launchCdpBrowser({
        port,
        url,
        extension: distDir,
        userDataDir,
        // This launch's own dir holds no logins, so it may run with the local-network checks off.
        disposableProfile: true,
        // The launcher then keeps the browser's stdio: all-ignored stdio stalls Chrome before the
        // port opens, and the log is the only account of a failed launch.
        logPath: `${userDataDir}.log`,
    });
    return { pid: launched.pid, port: launched.port, userDataDir };
}
