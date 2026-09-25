import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
    applyAlias,
    compileRoutePattern,
    type NormalizedBrowser,
    type RouterConfig,
    route,
    TABS_PATTERN,
    TOKEN_PATTERN,
} from "@genesiscz/utils/browser-router/route";
import { type TokenRecord, takeToken } from "@genesiscz/utils/browser-router/tokens";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { GENESIS_APP_BUNDLE_ID } from "@genesiscz/utils/macos/genesis-app";
import { Storage, withFileLock } from "@genesiscz/utils/storage";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";

/** Above this many links a click asks before it opens anything. */
export const TAB_CAP = 15;
/** A leading hyphen would reach `tabs open <name>` as a flag (`-v` is the root's verbose). */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function bundleFile(): string {
    return `${new Storage("browser-router").getBaseDir()}/bundles.json`;
}

export function bundleLink(name: string): string {
    return `https://genesis.tools/tabs/${name}`;
}

/** Only absolute http(s) links: a bundle opens pages, never another scheme's handler. */
export function checkBundleUrls(urls: string[]): string[] {
    if (urls.length === 0) {
        throw new Error("a bundle needs at least one http(s) link");
    }

    for (const url of urls) {
        let parsed: URL;

        try {
            parsed = new URL(url);
        } catch (error) {
            throw new Error(`${url} is not a URL (${error instanceof Error ? error.message : String(error)})`);
        }

        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new Error(`${url} is not an http(s) link`);
        }
    }

    return urls;
}

/** Read, add and write under one file lock: two `tabs save` runs must not each drop the other's bundle. */
export async function saveBundle(name: string, urls: string[]): Promise<void> {
    if (!NAME.test(name)) {
        throw new Error("bundle name must start with a letter or digit, then letters, numbers, _ or -");
    }

    checkBundleUrls(urls);
    const lock = `${bundleFile()}.lock`;
    mkdirSync(dirname(lock), { recursive: true });
    await withFileLock(lock, async () => {
        const all = readBundles();
        all[name] = urls;
        writeBundles(all);
    });
}

export function bundleUrls(name: string): string[] {
    const urls = readBundles()[name];

    if (!urls) {
        throw new Error(`no tab bundle named ${name}`);
    }

    return urls;
}

export function bundleNames(): string[] {
    return Object.keys(readBundles()).sort();
}

export interface BundlePlan {
    /** Plain pages, one new window per browser. */
    windows: { browser: NormalizedBrowser; urls: string[] }[];
    /** Links with a route of their own (a genesis.tools action, a minted link): GenesisTools.app routes each. */
    routed: string[];
    skipped: { url: string; reason: string }[];
}

type PeekToken = (id: string) => TokenRecord | null;

/**
 * Sorts a bundle's links by what a click on each would do. A link to another bundle is skipped:
 * routing stops one level down, so a bundle that contains itself cannot loop.
 */
export function planBundle(
    urls: string[],
    config: RouterConfig,
    peek: PeekToken = (id) => takeToken(id, false)
): BundlePlan {
    const plan: BundlePlan = { windows: [], routed: [], skipped: [] };

    for (const url of urls) {
        if (isBundleLink(url, config, peek)) {
            plan.skipped.push({ url, reason: "a bundle inside a bundle is not opened" });
            continue;
        }

        let decision: ReturnType<typeof route>;

        try {
            decision = route(url, config);
        } catch (error) {
            plan.skipped.push({ url, reason: error instanceof Error ? error.message : String(error) });
            continue;
        }

        if (decision.kind !== "forward") {
            plan.routed.push(url);
            continue;
        }

        if (!decision.browser || decision.openArguments.length === 0) {
            plan.skipped.push({ url, reason: "a route swallows this link" });
            continue;
        }

        const browser = decision.browser;
        const window = plan.windows.find((item) => SafeJSON.stringify(item.browser) === SafeJSON.stringify(browser));

        if (window) {
            window.urls.push(decision.url);
        } else {
            plan.windows.push({ browser, urls: [decision.url] });
        }
    }

    return plan;
}

function isBundleLink(url: string, config: RouterConfig, peek: PeekToken): boolean {
    let parsed: URL;

    try {
        parsed = new URL(url);
    } catch (error) {
        logger.debug({ error, url }, "browser-router: a bundle link is not a URL");
        return false;
    }

    for (const candidate of [parsed.href, applyAlias(parsed, config).href]) {
        if (compileRoutePattern(TABS_PATTERN).test(candidate)) {
            return true;
        }

        const token = compileRoutePattern(TOKEN_PATTERN).exec(candidate);

        if (token?.[1] && peek(token[1])?.urls) {
            return true;
        }
    }

    return false;
}

const CHROMIUM = new Set([
    "com.brave.Browser",
    "com.google.Chrome",
    "org.chromium.Chromium",
    "com.microsoft.edgemac",
    "com.vivaldi.Vivaldi",
    "Brave Browser",
    "Google Chrome",
    "Chromium",
    "Microsoft Edge",
    "Vivaldi",
]);

/**
 * `open` arguments for one new window with every link. A Chromium browser takes `--new-window`
 * through a second launch (`-n`) that hands the links to the running one. Other browsers get the
 * links as tabs in their front window.
 */
export function windowArguments(browser: NormalizedBrowser, urls: string[]): string[] {
    const app = browser.appType === "bundleId" ? ["-b", browser.name] : ["-a", browser.name];
    const background = browser.openInBackground ? ["-g"] : [];

    if (CHROMIUM.has(browser.name)) {
        return [...background, "-n", ...app, "--args", "--new-window", ...urls];
    }

    return [...background, ...app, ...urls];
}

export interface OpenBundleDeps {
    /** Runs `/usr/bin/open` with these arguments. */
    open: (args: string[]) => Promise<void>;
    /** Asks the user; false means do not open. */
    confirm: (message: string) => Promise<boolean>;
    /**
     * Runs after the confirmation and before the first launch; a throw opens nothing. A minted
     * bundle spends its use here, so a cancelled dialog leaves the link for another click.
     */
    beforeOpen?: () => Promise<void>;
    peek?: PeekToken;
}

export async function openBundle(urls: string[], config: RouterConfig, deps: OpenBundleDeps): Promise<BundlePlan> {
    if (urls.length > TAB_CAP && !(await deps.confirm(`Open ${urls.length} tabs?`))) {
        throw new Error(`${urls.length} tabs were not opened`);
    }

    const plan = planBundle(urls, config, deps.peek);
    await deps.beforeOpen?.();

    for (const window of plan.windows) {
        await deps.open(windowArguments(window.browser, window.urls));
    }

    for (const url of plan.routed) {
        await deps.open(["-b", GENESIS_APP_BUNDLE_ID, url]);
    }

    for (const skipped of plan.skipped) {
        logger.warn(skipped, "browser-router: a bundle link was not opened");
    }

    logger.debug(
        { windows: plan.windows.length, routed: plan.routed.length, skipped: plan.skipped.length },
        "browser-router: opened a tab bundle"
    );
    return plan;
}

/**
 * A dialog from `osascript`, which needs no Automation grant for `display dialog`. It gives up after
 * two minutes, so a click nobody answers does not hold the router forever.
 */
export async function confirmDialog(message: string): Promise<boolean> {
    const quoted = `"${message.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
    const script = `display dialog ${quoted} buttons {"Cancel", "Open"} default button "Open" cancel button "Cancel" with title "GenesisTools" giving up after 120`;
    const proc = Bun.spawn(["osascript", "-e", script], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    const opened = code === 0 && stdout.includes("button returned:Open") && !stdout.includes("gave up:true");
    logger.debug({ message, opened }, "browser-router: tab bundle confirmation");
    return opened;
}

function isBundleMap(value: unknown): value is Record<string, string[]> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }

    return Object.values(value).every((urls) => Array.isArray(urls) && urls.every((url) => typeof url === "string"));
}

/** Only a missing file means "no bundles"; an unreadable or malformed one throws, so a save cannot overwrite it. */
function readBundles(): Record<string, string[]> {
    const path = bundleFile();
    let text: string;

    try {
        text = readFileSync(path, "utf8");
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return {};
        }

        throw error;
    }

    const parsed: unknown = SafeJSON.parse(text, { strict: true });

    if (!isBundleMap(parsed)) {
        throw new Error(`${path} is not a map of bundle names to link lists; fix or move it aside`);
    }

    return parsed;
}

function writeBundles(bundles: Record<string, string[]>): void {
    atomicWriteFileSync(bundleFile(), `${SafeJSON.stringify(bundles, null, 2)}\n`);
}
